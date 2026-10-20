mod native_notifications;
mod proto;

#[allow(dead_code)]
mod bridge;
#[allow(dead_code)]
mod paths;
mod sticker;

#[cfg(target_os = "linux")]
use std::process::{Child, Command};
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use proto::{rpc_request, rpc_response};
use serde::Serialize;
use image::{AnimationDecoder as _, GenericImageView as _};
use tauri::{
    Emitter as _, Manager as _,
    ipc::Channel,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_window_state::AppHandleExt as _;
use tokio::sync::{Mutex, oneshot};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
// A descriptor refresh can precede one retry, and each backend transfer is
// bounded at ten minutes. Keep the shell alive long enough to receive the
// backend's authoritative result instead of orphaning an in-flight media RPC.
const ATTACHMENT_TIMEOUT: Duration = Duration::from_secs(22 * 60);
const MAX_PASTED_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PASTED_IMAGE_PIXELS: u64 = 16_000_000;
const MAX_PASTED_IMAGE_EDGE: u32 = 8_192;
// Desktop-core owned temporary caches. Files here exist only between a pick
// (paste or recording) and the completed send, so both discard and crash
// cleanup must cover every root, not just the pasted-image one.
const STAGED_CACHE_DIRS: [&str; 3] = ["pasted-images", "voice-notes", "staged-outgoing"];
// Media the user picked is copied here before the backend ever sees it, so
// the webview can only hand over files the core has already inspected.
const STAGED_OUTGOING_DIR: &str = "staged-outgoing";
const MAX_STAGED_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_STAGED_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_STAGED_IMAGE_EDGE: u32 = 8_192;
const MAX_STAGED_IMAGE_PIXELS: u64 = 16_000_000;
// A chat muted "indefinitely" is stored as a far-future instant so the same
// column covers both cases. 9999-12-31T23:59:59.999Z in Unix milliseconds.
const INDEFINITE_MUTE_UNTIL_MS: i64 = 253_402_300_799_000;

const MAX_PENDING_REQUESTS: usize = 512;
const MAX_RESTART_ATTEMPTS: u32 = 5;
const STABLE_EPOCH: Duration = Duration::from_secs(30);

type PendingResult = Result<proto::RpcResponse, CommandError>;

struct PendingRequest {
    epoch: u64,
    sender: oneshot::Sender<PendingResult>,
}

struct ActiveClient {
    epoch: u64,
    client: Arc<bridge::BackendClient>,
}

#[derive(Default)]
struct TransportState {
    active: Option<ActiveClient>,
    pending: HashMap<u64, PendingRequest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendEvent {
    /// Monotonic sequence supplied by the Go backend. Shell-generated events
    /// use zero and never advance the backend sequence tracker.
    sequence: u64,
    #[serde(flatten)]
    event: FrontendEventKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
enum FrontendEventKind {
    ConnectionChanged(proto::ConnectionChanged),
    PairingQr(proto::PairingQr),
    SyncProgress(proto::SyncProgress),
    SyncStatusChanged(proto::SyncStatusChanged),
    HistoryCoverageChanged(proto::HistoryCoverageChanged),
    ChatUpserted(proto::ChatUpserted),
    MessageUpserted(Box<proto::MessageUpserted>),
    ReceiptUpdated(proto::ReceiptUpdated),
    Problem(proto::BackendProblem),
    ReactionUpdated(proto::ReactionUpdated),
    RecentReactionsRepaired(proto::RecentReactionsRepaired),
    ChatMerged(proto::ChatMerged),
    TypingChanged(proto::TypingChanged),
    StickersChanged(proto::StickersChanged),
    BridgeLifecycle(BridgeLifecycle),
    PinnedMessagesChanged(proto::PinnedMessagesChanged),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeLifecycle {
    epoch: u64,
    state: &'static str,
    attempt: u32,
    max_attempts: u32,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceCaptureConfig {
    power_mode: &'static str,
    capture_kind: &'static str,
    scroll_ms: u64,
    launched_at_ms: u64,
}

fn performance_capture_config_from_env() -> Option<PerformanceCaptureConfig> {
    let idle = std::env::var_os("WHATFAST_PERF_IDLE_READY").is_some();
    if !idle && std::env::var_os("WHATFAST_PERF_OUTPUT").is_none() {
        return None;
    }
    let power_mode = match std::env::var("WHATFAST_PERF_MODE").as_deref() {
        Ok("battery") => "battery",
        _ => "normal",
    };
    let scroll_ms = std::env::var("WHATFAST_PERF_SCROLL_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30_000);
    let launched_at_ms = std::env::var("WHATFAST_PERF_LAUNCHED_AT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    Some(PerformanceCaptureConfig {
        power_mode,
        capture_kind: if idle { "idle" } else { "renderer" },
        scroll_ms,
        launched_at_ms,
    })
}

#[tauri::command]
fn get_performance_capture_config() -> Option<PerformanceCaptureConfig> {
    performance_capture_config_from_env()
}

impl FrontendEvent {
    fn local(event: FrontendEventKind) -> Self {
        Self { sequence: 0, event }
    }

    fn problem(code: &str, message: String) -> Self {
        Self::local(FrontendEventKind::Problem(proto::BackendProblem {
            code: code.into(),
            message,
            fatal: false,
        }))
    }
}

impl From<proto::BackendEvent> for Option<FrontendEvent> {
    fn from(event: proto::BackendEvent) -> Self {
        use proto::backend_event::Event;
        let sequence = event.sequence;
        let event = match event.event? {
            Event::ConnectionChanged(value) => FrontendEventKind::ConnectionChanged(value),
            Event::PairingQr(value) => FrontendEventKind::PairingQr(value),
            Event::SyncProgress(value) => FrontendEventKind::SyncProgress(value),
            Event::SyncStatusChanged(value) => FrontendEventKind::SyncStatusChanged(value),
            Event::HistoryCoverageChanged(value) => {
                FrontendEventKind::HistoryCoverageChanged(value)
            }
            Event::ChatUpserted(value) => FrontendEventKind::ChatUpserted(value),
            Event::MessageUpserted(value) => FrontendEventKind::MessageUpserted(Box::new(value)),
            Event::ReceiptUpdated(value) => FrontendEventKind::ReceiptUpdated(value),
            Event::Problem(value) => FrontendEventKind::Problem(value),
            Event::ReactionUpdated(value) => FrontendEventKind::ReactionUpdated(value),
            Event::RecentReactionsRepaired(value) => {
                FrontendEventKind::RecentReactionsRepaired(value)
            }
            Event::ChatMerged(value) => FrontendEventKind::ChatMerged(value),
            Event::TypingChanged(value) => FrontendEventKind::TypingChanged(value),
            Event::StickersChanged(value) => FrontendEventKind::StickersChanged(value),
            Event::PinnedMessagesChanged(value) => FrontendEventKind::PinnedMessagesChanged(value),
        };
        Some(FrontendEvent { sequence, event })
    }
}

#[derive(Debug, Default)]
struct EventSequence {
    last: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum SequenceObservation {
    Accept,
    Gap { expected: u64, received: u64 },
    Invalid,
    Stale,
}

impl EventSequence {
    fn observe(&mut self, received: u64) -> SequenceObservation {
        if received == 0 {
            return SequenceObservation::Invalid;
        }
        if received <= self.last {
            return SequenceObservation::Stale;
        }
        let expected = self.last.saturating_add(1);
        let observation = if received > expected {
            SequenceObservation::Gap { expected, received }
        } else {
            SequenceObservation::Accept
        };
        self.last = received;
        observation
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopApplication {
    id: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopApplications {
    supported: bool,
    browsers: Vec<DesktopApplication>,
    file_managers: Vec<DesktopApplication>,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct LinuxDesktopApplication {
    option: DesktopApplication,
    browser: bool,
    file_manager: bool,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct IsolatedXdgConfig {
    root: PathBuf,
    config_home: PathBuf,
    data_home: PathBuf,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self::new("transport", message, true)
    }

    fn epoch_changed(epoch: u64) -> Self {
        Self::new(
            "backend_epoch_changed",
            format!("backend epoch {epoch} ended before replying"),
            true,
        )
    }

    fn reconnecting() -> Self {
        Self::new(
            "backend_reconnecting",
            "the WhatsApp backend is reconnecting",
            true,
        )
    }

    fn shutting_down() -> Self {
        Self::new(
            "app_shutting_down",
            "the application is shutting down",
            false,
        )
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self::new("protocol", message, false)
    }

    fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message, false)
    }

    fn open_failed(message: impl Into<String>) -> Self {
        Self::new("open_failed", message, false)
    }
}

impl From<proto::RpcError> for CommandError {
    fn from(error: proto::RpcError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        }
    }
}

type BridgeService = Arc<BridgeServiceInner>;

struct BridgeServiceInner {
    fake: bool,
    next_request_id: AtomicU64,
    epoch: AtomicU64,
    stopping: AtomicBool,
    /// Set when the supervisor gives up after MAX_RESTART_ATTEMPTS
    /// (retryExhausted) and stops without an active client. The user-driven
    /// `reconnect` command is the recovery path: it resets this flag and
    /// starts a fresh epoch with a new supervisor loop.
    exhausted: AtomicBool,
    transport: StdMutex<TransportState>,
    subscribers: Arc<Mutex<Vec<Channel<FrontendEvent>>>>,
}

impl BridgeServiceInner {
    fn start(fake: bool) -> anyhow::Result<Arc<Self>> {
        let client = Arc::new(bridge::BackendClient::start(fake)?);
        let subscribers = Arc::new(Mutex::new(Vec::<Channel<FrontendEvent>>::new()));
        let service = Arc::new(Self {
            fake,
            next_request_id: AtomicU64::new(1),
            epoch: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
            exhausted: AtomicBool::new(false),
            transport: StdMutex::new(TransportState {
                active: Some(ActiveClient {
                    epoch: 1,
                    client: client.clone(),
                }),
                pending: HashMap::new(),
            }),
            subscribers,
        });
        let supervisor = service.clone();
        tauri::async_runtime::spawn(async move {
            supervisor.run_supervisor(client, 1).await;
        });
        Ok(service)
    }

    async fn subscribe(&self, channel: Channel<FrontendEvent>) {
        self.subscribers.lock().await.push(channel);
    }

    async fn request(
        &self,
        request: rpc_request::Request,
        timeout: Duration,
    ) -> Result<rpc_response::Result, CommandError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        if request_id == 0 || request_id == u64::MAX {
            return Err(CommandError::transport("request IDs exhausted"));
        }

        let (sender, receiver) = oneshot::channel::<PendingResult>();
        {
            let mut transport = self
                .transport
                .lock()
                .expect("bridge transport lock poisoned");
            if self.stopping.load(Ordering::Acquire) {
                return Err(CommandError::shutting_down());
            }
            if transport.pending.len() >= MAX_PENDING_REQUESTS {
                return Err(CommandError::transport("too many pending backend requests"));
            }
            let Some(active) = transport.active.as_ref() else {
                return Err(CommandError::reconnecting());
            };
            let epoch = active.epoch;
            let client = active.client.clone();
            transport
                .pending
                .insert(request_id, PendingRequest { epoch, sender });
            if let Err(error) = client.send(request_id, request) {
                transport.pending.remove(&request_id);
                return Err(CommandError::transport(error.to_string()));
            }
        }

        let response = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => return Err(error),
            Ok(Err(_)) => {
                return Err(CommandError::transport(
                    "the backend stopped before replying",
                ));
            }
            Err(_) => {
                self.transport
                    .lock()
                    .expect("bridge transport lock poisoned")
                    .pending
                    .remove(&request_id);
                return Err(CommandError::transport("the backend request timed out"));
            }
        };

        match response.result {
            Some(rpc_response::Result::Error(error)) => Err(error.into()),
            Some(result) => Ok(result),
            None => Err(CommandError::protocol("backend response had no result")),
        }
    }

    async fn run_supervisor(
        self: Arc<Self>,
        mut client: Arc<bridge::BackendClient>,
        mut epoch: u64,
    ) {
        let mut attempts = 0;
        loop {
            let started = Instant::now();
            let exit = self.listen_epoch(client.clone(), epoch).await;
            self.end_epoch(epoch, CommandError::epoch_changed(epoch))
                .await;
            if self.stopping.load(Ordering::Acquire) {
                return;
            }
            if exit.kind == bridge::BridgeExitKind::Fatal {
                self.lifecycle(epoch, "fatal", attempts, exit.message).await;
                return;
            }
            if started.elapsed() >= STABLE_EPOCH {
                attempts = 0;
            }

            loop {
                if attempts >= MAX_RESTART_ATTEMPTS {
                    // The supervisor stops here with no active client, so the
                    // app would stay dead without recovery. Mark the terminal
                    // state; the user-driven `reconnect` command resets this
                    // flag and restarts the supervisor on a new epoch.
                    self.exhausted.store(true, Ordering::Release);
                    self.lifecycle(epoch, "retryExhausted", attempts, exit.message.clone())
                        .await;
                    return;
                }
                attempts += 1;
                self.lifecycle(epoch, "reconnecting", attempts, exit.message.clone())
                    .await;
                tokio::time::sleep(restart_delay(attempts)).await;
                if self.stopping.load(Ordering::Acquire) {
                    return;
                }
                match bridge::BackendClient::start(self.fake) {
                    Ok(next) => {
                        epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
                        client = Arc::new(next);
                        self.transport
                            .lock()
                            .expect("bridge transport lock poisoned")
                            .active = Some(ActiveClient {
                            epoch,
                            client: client.clone(),
                        });
                        self.lifecycle(epoch, "reconnected", attempts, String::new())
                            .await;
                        self.exhausted.store(false, Ordering::Release);
                        break;
                    }
                    Err(error) => {
                        let message = error.to_string();
                        if bridge::classify_exit(&message) == bridge::BridgeExitKind::Fatal {
                            self.lifecycle(epoch, "fatal", attempts, message).await;
                            return;
                        }
                    }
                }
            }
        }
    }

    async fn listen_epoch(
        &self,
        client: Arc<bridge::BackendClient>,
        epoch: u64,
    ) -> bridge::BridgeExit {
        let incoming = client.incoming.clone();
        let mut event_sequence = EventSequence::default();
        let mut terminal_reason = None;
        while let Ok(message) = incoming.recv().await {
            match message {
                bridge::BridgeMessage::Envelope(envelope) => match envelope.body {
                    Some(proto::envelope::Body::Response(response)) => {
                        if let Some(rpc_response::Result::Error(error)) = response.result.as_ref()
                            && !error.retryable
                            && (error.code == "unsupported_protocol"
                                || error.code.contains("corrupt"))
                        {
                            terminal_reason = Some(error.message.clone());
                        }
                        let pending = self
                            .transport
                            .lock()
                            .expect("bridge transport lock poisoned")
                            .pending
                            .remove(&envelope.request_id);
                        if let Some(pending) = pending.filter(|pending| pending.epoch == epoch) {
                            let _ = pending.sender.send(Ok(response));
                        }
                    }
                    Some(proto::envelope::Body::Event(event)) if envelope.request_id == 0 => {
                        if let Some(proto::backend_event::Event::Problem(problem)) =
                            event.event.as_ref()
                            && problem.fatal
                        {
                            terminal_reason = Some(problem.message.clone());
                        }
                        match event_sequence.observe(event.sequence) {
                            SequenceObservation::Invalid => {
                                self.send(FrontendEvent::problem(
                                    "event_sequence_invalid",
                                    "Backend emitted an unsequenced event; refresh may be required"
                                        .into(),
                                ))
                                .await;
                                // Tell the UI to refetch list_chats plus any
                                // open message windows; only the event body is
                                // handled below, never the sequence recovery.
                                self.lifecycle(
                                    epoch,
                                    "resyncRequired",
                                    0,
                                    "Backend emitted an unsequenced event; refetch list_chats and open message windows".into(),
                                )
                                .await;
                                continue;
                            }
                            SequenceObservation::Stale => {
                                // A duplicate delivery carries no new state,
                                // but the UI still needs the resync signal in
                                // case it missed the original event.
                                self.lifecycle(
                                    epoch,
                                    "resyncRequired",
                                    0,
                                    "Backend re-emitted an already-seen event; refetch list_chats and open message windows if state looks stale".into(),
                                )
                                .await;
                                continue;
                            }
                            SequenceObservation::Gap { expected, received } => {
                                self.send(FrontendEvent::problem(
                                    "event_sequence_gap",
                                    format!(
                                        "Backend event gap (expected {expected}, received {received}); refresh may be required"
                                    ),
                                ))
                                .await;
                                self.lifecycle(
                                    epoch,
                                    "resyncRequired",
                                    0,
                                    format!(
                                        "Backend event gap (expected {expected}, received {received}); refetch list_chats and open message windows"
                                    ),
                                )
                                .await;
                            }
                            SequenceObservation::Accept => {}
                        }
                        if let Some(event) = Option::<FrontendEvent>::from(event) {
                            self.send(event).await;
                        }
                    }
                    _ => {}
                },
                bridge::BridgeMessage::Exited(mut exit) => {
                    if let Some(reason) = terminal_reason {
                        exit.kind = bridge::BridgeExitKind::Fatal;
                        exit.message = reason;
                    }
                    return exit;
                }
            }
        }
        bridge::BridgeExit {
            kind: bridge::BridgeExitKind::Transient,
            message: "backend event stream closed".into(),
        }
    }

    async fn end_epoch(&self, epoch: u64, error: CommandError) {
        let mut transport = self
            .transport
            .lock()
            .expect("bridge transport lock poisoned");
        if transport
            .active
            .as_ref()
            .is_some_and(|active| active.epoch == epoch)
        {
            transport.active = None;
        }
        reject_epoch_requests(&mut transport, epoch, error);
    }

    async fn lifecycle(&self, epoch: u64, state: &'static str, attempt: u32, message: String) {
        self.send(FrontendEvent::local(FrontendEventKind::BridgeLifecycle(
            BridgeLifecycle {
                epoch,
                state,
                attempt,
                max_attempts: MAX_RESTART_ATTEMPTS,
                message,
            },
        )))
        .await;
    }

    async fn send(&self, event: FrontendEvent) {
        send_event(&self.subscribers, event).await;
    }

    fn begin_shutdown(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        let epoch = self.epoch.load(Ordering::Acquire);
        let mut transport = self
            .transport
            .lock()
            .expect("bridge transport lock poisoned");
        if let Some(active) = transport.active.take() {
            active.client.shutdown();
        }
        reject_epoch_requests(&mut transport, epoch, CommandError::shutting_down());
    }
}

impl Drop for BridgeServiceInner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
    }
}

fn restart_delay(attempt: u32) -> Duration {
    Duration::from_millis(250_u64.saturating_mul(1_u64 << attempt.saturating_sub(1).min(4)))
}

fn reject_epoch_requests(transport: &mut TransportState, epoch: u64, error: CommandError) {
    let ids: Vec<_> = transport
        .pending
        .iter()
        .filter_map(|(id, pending)| (pending.epoch == epoch).then_some(*id))
        .collect();
    for id in ids {
        if let Some(pending) = transport.pending.remove(&id) {
            let _ = pending.sender.send(Err(error.clone()));
        }
    }
}

async fn send_event(subscribers: &Mutex<Vec<Channel<FrontendEvent>>>, event: FrontendEvent) {
    subscribers
        .lock()
        .await
        .retain(|subscriber| subscriber.send(event.clone()).is_ok());
}

macro_rules! expect_response {
    ($result:expr, $variant:ident) => {
        match $result {
            rpc_response::Result::$variant(value) => Ok(value),
            _ => Err(CommandError::protocol(concat!(
                "backend returned the wrong response for ",
                stringify!($variant)
            ))),
        }
    };
}

macro_rules! rpc_commands {
    ($(
        $name:ident($($argument:ident: $argument_type:ty),* $(,)?) -> $response:ty {
            $request:expr, $timeout:expr => $variant:ident
        }
    )*) => {
        $(
            #[tauri::command]
            async fn $name(
                state: tauri::State<'_, BridgeService>,
                $($argument: $argument_type),*
            ) -> Result<$response, CommandError> {
                let result = state.request($request, $timeout).await?;
                expect_response!(result, $variant)
            }
        )*
    };
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_client_message_id(client_message_id: String) -> Result<String, CommandError> {
    let parsed = uuid::Uuid::parse_str(&client_message_id).map_err(|_| {
        CommandError::invalid_argument("client_message_id must be a canonical UUID v4")
    })?;
    if parsed.get_version_num() != 4 || parsed.hyphenated().to_string() != client_message_id {
        return Err(CommandError::invalid_argument(
            "client_message_id must be a canonical UUID v4",
        ));
    }
    Ok(client_message_id)
}

fn validate_attachment_kind(
    kind: i32,
    caption: &str,
    voice_note: bool,
) -> Result<proto::AttachmentKind, CommandError> {
    let kind = proto::AttachmentKind::try_from(kind)
        .map_err(|_| CommandError::invalid_argument("unknown attachment kind"))?;
    match kind {
        proto::AttachmentKind::Unspecified => Err(CommandError::invalid_argument(
            "attachment kind is required",
        )),
        proto::AttachmentKind::Audio if !caption.is_empty() => Err(CommandError::invalid_argument(
            "audio messages do not support captions",
        )),
        proto::AttachmentKind::Audio => Ok(kind),
        proto::AttachmentKind::Document | proto::AttachmentKind::Video if voice_note => Err(
            CommandError::invalid_argument("voice_note is only valid for audio attachments"),
        ),
        proto::AttachmentKind::Document | proto::AttachmentKind::Video => Ok(kind),
    }
}

fn canonical_media_file(data_dir: &Path, requested: &Path) -> Result<PathBuf, CommandError> {
    let media_root = std::fs::canonicalize(data_dir.join("media")).map_err(|error| {
        CommandError::invalid_argument(format!("media cache is unavailable: {error}"))
    })?;
    let target = std::fs::canonicalize(requested).map_err(|error| {
        CommandError::invalid_argument(format!("media file is unavailable: {error}"))
    })?;
    if !target.starts_with(&media_root) {
        return Err(CommandError::invalid_argument(
            "media path is outside the managed cache",
        ));
    }
    let metadata = std::fs::metadata(&target)
        .map_err(|error| CommandError::invalid_argument(format!("inspect media file: {error}")))?;
    if !metadata.is_file() {
        return Err(CommandError::invalid_argument(
            "media path does not identify a file",
        ));
    }
    Ok(target)
}

fn configure_asset_protocol_scope(
    scope: &tauri::scope::fs::Scope,
    data_dir: &Path,
) -> tauri::Result<()> {
    // Media may contain managed subdirectories, while avatar cache files are
    // always written directly under `avatars`. Keep the avatar grant
    // non-recursive so a rendered profile photo does not broaden filesystem
    // access beyond the backend-owned cache.
    scope.allow_directory(data_dir.join("media"), true)?;
    scope.allow_directory(data_dir.join("avatars"), false)?;
    // The staging caches hold the copy of the picture the user is about to
    // send, plus the clipboard paste and the recorded voice note. They are
    // part of the profile directory, so the webview may render them and
    // nothing else.
    scope.allow_directory(data_dir.join(STAGED_OUTGOING_DIR), true)?;
    scope.allow_directory(data_dir.join("pasted-images"), true)?;
    scope.allow_directory(data_dir.join("voice-notes"), true)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_application_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        directories.push(PathBuf::from(data_home).join("applications"));
    } else if let Some(home) = std::env::var_os("HOME") {
        directories.push(PathBuf::from(home).join(".local/share/applications"));
    }
    let data_dirs =
        std::env::var_os("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    directories.extend(std::env::split_paths(&data_dirs).map(|path| path.join("applications")));
    directories
}

#[cfg(target_os = "linux")]
fn collect_desktop_files(root: &Path, relative: &Path, files: &mut Vec<(String, PathBuf)>) {
    let directory = root.join(relative);
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_desktop_files(root, &relative.join(entry.file_name()), files);
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("desktop")
        {
            continue;
        }
        let id = relative
            .join(entry.file_name())
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "-");
        files.push((id, path));
    }
}

#[cfg(target_os = "linux")]
fn parse_linux_desktop_application(id: String, contents: &str) -> Option<LinuxDesktopApplication> {
    let mut in_desktop_entry = false;
    let mut name = "";
    let mut kind = "";
    let mut exec = "";
    let mut mime_types = "";
    let mut categories = "";
    let mut hidden = false;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line == "[Desktop Entry]" {
            in_desktop_entry = true;
            continue;
        }
        if line.starts_with('[') {
            if in_desktop_entry {
                break;
            }
            continue;
        }
        if !in_desktop_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "Name" => name = value.trim(),
            "Type" => kind = value.trim(),
            "Exec" => exec = value.trim(),
            "MimeType" => mime_types = value,
            "Categories" => categories = value,
            "Hidden" => hidden = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }

    if hidden || kind != "Application" || name.is_empty() || exec.is_empty() {
        return None;
    }
    let handles = |haystack: &str, needle: &str| {
        haystack
            .split(';')
            .any(|value| value.trim().eq_ignore_ascii_case(needle))
    };
    let browser = handles(mime_types, "x-scheme-handler/http")
        || handles(mime_types, "x-scheme-handler/https")
        || handles(categories, "WebBrowser");
    let file_manager = handles(mime_types, "inode/directory") || handles(categories, "FileManager");
    if !browser && !file_manager {
        return None;
    }

    Some(LinuxDesktopApplication {
        option: DesktopApplication {
            id,
            name: name.to_owned(),
        },
        browser,
        file_manager,
    })
}

#[cfg(target_os = "linux")]
fn linux_desktop_applications() -> Vec<LinuxDesktopApplication> {
    let mut applications = HashMap::<String, LinuxDesktopApplication>::new();
    for directory in linux_application_directories() {
        let mut files = Vec::new();
        collect_desktop_files(&directory, Path::new(""), &mut files);
        for (id, desktop_file) in files {
            if applications.contains_key(&id) {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&desktop_file) else {
                continue;
            };
            if let Some(application) = parse_linux_desktop_application(id.clone(), &contents) {
                applications.insert(id, application);
            }
        }
    }
    let mut applications = applications.into_values().collect::<Vec<_>>();
    applications.sort_by(|left, right| {
        left.option
            .name
            .to_lowercase()
            .cmp(&right.option.name.to_lowercase())
            .then_with(|| left.option.id.cmp(&right.option.id))
    });
    applications
}

#[cfg(target_os = "linux")]
fn selected_linux_application(
    application_id: &str,
    browser: bool,
) -> Result<LinuxDesktopApplication, CommandError> {
    linux_desktop_applications()
        .into_iter()
        .find(|application| {
            application.option.id == application_id
                && if browser {
                    application.browser
                } else {
                    application.file_manager
                }
        })
        .ok_or_else(|| {
            CommandError::invalid_argument(format!(
                "the selected {} is no longer installed",
                if browser { "browser" } else { "file manager" }
            ))
        })
}

#[cfg(target_os = "linux")]
fn niri_window_ids(desktop_id: &str) -> Vec<String> {
    let id = desktop_id
        .strip_suffix(".desktop")
        .unwrap_or(desktop_id)
        .to_lowercase();
    let mut ids = vec![id.clone()];
    if let Some(short_id) = id.rsplit('.').next()
        && short_id != id
    {
        ids.push(short_id.to_owned());
    }
    ids
}

#[cfg(target_os = "linux")]
fn focus_niri_application(desktop_id: &str) {
    if !std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .any(|desktop| desktop.eq_ignore_ascii_case("niri"))
    {
        return;
    }
    let expected_ids = niri_window_ids(desktop_id);
    let Ok(output) = Command::new("niri").args(["msg", "-j", "windows"]).output() else {
        return;
    };
    let Ok(windows) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) else {
        return;
    };
    let selected = windows
        .into_iter()
        .filter_map(|window| {
            let id = window.get("id")?.as_u64()?;
            let app_id = window.get("app_id")?.as_str()?.to_lowercase();
            expected_ids
                .iter()
                .any(|expected| expected == &app_id)
                .then_some(id)
        })
        .max();
    if let Some(id) = selected {
        let _ = Command::new("niri")
            .args(["msg", "action", "focus-window", "--id", &id.to_string()])
            .status();
    }
}

#[cfg(target_os = "linux")]
fn reap_child(mut child: Child, cleanup: Option<PathBuf>, desktop_id: Option<String>) {
    let _ = std::thread::Builder::new()
        .name("whatfast-desktop-launcher".into())
        .spawn(move || {
            if let Some(desktop_id) = desktop_id {
                std::thread::sleep(Duration::from_millis(500));
                focus_niri_application(&desktop_id);
            }
            let _ = child.wait();
            if let Some(cleanup) = cleanup {
                let _ = std::fs::remove_dir_all(cleanup);
            }
        });
}

#[cfg(target_os = "linux")]
fn isolated_xdg_config(
    application_id: &str,
    browser: bool,
) -> Result<IsolatedXdgConfig, CommandError> {
    if !application_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(CommandError::invalid_argument(
            "the selected desktop application has an invalid id",
        ));
    }
    let root = std::env::temp_dir().join(format!("whatfast-xdg-{}", uuid::Uuid::new_v4()));
    let config_home = root.join("config");
    let data_home = root.join("data");
    let applications = data_home.join("applications");
    std::fs::create_dir_all(&applications)
        .map_err(|error| CommandError::open_failed(format!("create XDG config: {error}")))?;
    const WRAPPER_ID: &str = "whatfast-selected.desktop";
    let associations = if browser {
        format!(
            "[Default Applications]\nx-scheme-handler/http={WRAPPER_ID};\nx-scheme-handler/https={WRAPPER_ID};\n"
        )
    } else {
        format!("[Default Applications]\ninode/directory={WRAPPER_ID};\n")
    };
    let mime_types = if browser {
        "x-scheme-handler/http;x-scheme-handler/https;"
    } else {
        "inode/directory;"
    };
    let argument = if browser { "%u" } else { "%f" };
    let wrapper = format!(
        "[Desktop Entry]\nType=Application\nName=Whatfast selected handler\nNoDisplay=true\nExec=env --unset=XDG_CONFIG_HOME --unset=XDG_DATA_HOME gtk-launch {application_id} {argument}\nMimeType={mime_types}\n"
    );
    std::fs::create_dir(&config_home)
        .and_then(|()| {
            std::fs::write(config_home.join("mimeapps.list"), associations)?;
            std::fs::write(applications.join(WRAPPER_ID), wrapper)
        })
        .map_err(|error| {
            let _ = std::fs::remove_dir_all(&root);
            CommandError::open_failed(format!("write XDG config: {error}"))
        })?;
    Ok(IsolatedXdgConfig {
        root,
        config_home,
        data_home,
    })
}

#[cfg(target_os = "linux")]
fn launch_linux_application(
    application_id: &str,
    argument: &str,
    browser: bool,
) -> Result<(), CommandError> {
    let application = if application_id.is_empty() {
        None
    } else {
        Some(selected_linux_application(application_id, browser)?)
    };
    let xdg_config = application
        .as_ref()
        .map(|_| isolated_xdg_config(application_id, browser))
        .transpose()?;
    let mut command = Command::new("xdg-open");
    command.arg(argument);
    if let Some(config) = &xdg_config {
        command
            .env("XDG_CONFIG_HOME", &config.config_home)
            .env("XDG_DATA_HOME", &config.data_home);
    }
    let child = command.spawn().map_err(|error| {
        if let Some(config) = &xdg_config {
            let _ = std::fs::remove_dir_all(&config.root);
        }
        CommandError::open_failed(format!(
            "launch {} with xdg-open: {error}",
            if browser { "browser" } else { "file manager" }
        ))
    })?;
    reap_child(
        child,
        xdg_config.map(|config| config.root),
        application.map(|application| application.option.id),
    );
    Ok(())
}

#[tauri::command]
fn list_desktop_applications() -> DesktopApplications {
    #[cfg(target_os = "linux")]
    {
        let applications = linux_desktop_applications();
        DesktopApplications {
            supported: true,
            browsers: applications
                .iter()
                .filter(|application| application.browser)
                .map(|application| application.option.clone())
                .collect(),
            file_managers: applications
                .iter()
                .filter(|application| application.file_manager)
                .map(|application| application.option.clone())
                .collect(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    DesktopApplications {
        supported: false,
        browsers: Vec::new(),
        file_managers: Vec::new(),
    }
}

fn validated_external_url(url: &str) -> Result<String, CommandError> {
    let parsed = tauri::Url::parse(url)
        .map_err(|error| CommandError::invalid_argument(format!("invalid URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::invalid_argument(
            "only HTTP and HTTPS links can be opened",
        ));
    }
    Ok(parsed.into())
}

#[tauri::command]
fn open_external_url(
    app: tauri::AppHandle,
    url: String,
    application_id: String,
) -> Result<(), CommandError> {
    let url = validated_external_url(&url)?;
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        launch_linux_application(&application_id, &url, true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = application_id;
        app.opener()
            .open_url(url, None::<String>)
            .map_err(|error| CommandError::open_failed(format!("open link: {error}")))
    }
}

#[tauri::command]
async fn subscribe_backend(
    state: tauri::State<'_, BridgeService>,
    on_event: Channel<FrontendEvent>,
) -> Result<(), CommandError> {
    state.subscribe(on_event).await;
    Ok(())
}

#[tauri::command]
fn open_media_path(app: tauri::AppHandle, path: String) -> Result<(), CommandError> {
    let target = canonical_media_file(&paths::data_dir(), Path::new(&path))?;
    let target = target
        .to_str()
        .ok_or_else(|| CommandError::invalid_argument("media path must be valid UTF-8"))?
        .to_owned();
    app.opener()
        .open_path(target, None::<String>)
        .map_err(|error| CommandError::open_failed(format!("open media file: {error}")))
}

#[tauri::command]
fn reveal_media_path(
    app: tauri::AppHandle,
    path: String,
    application_id: String,
) -> Result<(), CommandError> {
    let target = canonical_media_file(&paths::data_dir(), Path::new(&path))?;
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        let directory = target.parent().ok_or_else(|| {
            CommandError::invalid_argument("media file has no containing directory")
        })?;
        let directory = directory
            .to_str()
            .ok_or_else(|| CommandError::invalid_argument("media directory must be valid UTF-8"))?;
        launch_linux_application(&application_id, directory, false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = application_id;
        app.opener()
            .reveal_item_in_dir(target)
            .map_err(|error| CommandError::open_failed(format!("reveal media file: {error}")))
    }
}

/// Reduce a caller-supplied name to a single safe path component.
///
/// The frontend derives this from a WhatsApp file name, which is remote input:
/// it may contain separators, `..`, control characters, or nothing usable at
/// all. Everything outside a conservative allowlist becomes `_` so a saved
/// download can only ever land directly inside the chosen directory.
fn sanitize_download_name(requested: &str, fallback_extension: Option<&str>) -> String {
    let base = Path::new(requested)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let mut cleaned: String = base
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ' | '(' | ')')
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() {
        cleaned = match fallback_extension {
            Some(extension) => format!("whatfast-file.{extension}"),
            None => "whatfast-file".to_owned(),
        };
    }
    // Leave room for the " (n)" de-duplication suffix within common limits.
    cleaned.truncate(200);
    cleaned
}

/// Pick a name inside `directory` that does not already exist.
fn unique_destination(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 2..1_000 {
        let attempt = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(attempt);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(file_name)
}

fn pasted_image_extension(
    bytes: &[u8],
    declared_mime_type: &str,
) -> Result<&'static str, CommandError> {
    let format = image::guess_format(bytes).map_err(|_| {
        CommandError::invalid_argument("clipboard image data is not a supported image")
    })?;
    let (extension, expected_mime_type) = match format {
        image::ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        image::ImageFormat::Png => ("png", "image/png"),
        image::ImageFormat::Gif => ("gif", "image/gif"),
        image::ImageFormat::WebP => ("webp", "image/webp"),
        _ => {
            return Err(CommandError::invalid_argument(
                "clipboard images must be JPEG, PNG, GIF, or WebP",
            ));
        }
    };
    if !declared_mime_type.is_empty() && declared_mime_type != expected_mime_type {
        return Err(CommandError::invalid_argument(
            "clipboard image type does not match its contents",
        ));
    }
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| CommandError::invalid_argument("clipboard image dimensions are invalid"))?;
    if width == 0
        || height == 0
        || width > MAX_PASTED_IMAGE_EDGE
        || height > MAX_PASTED_IMAGE_EDGE
        || u64::from(width) * u64::from(height) > MAX_PASTED_IMAGE_PIXELS
    {
        return Err(CommandError::invalid_argument(
            "clipboard image dimensions are too large",
        ));
    }
    Ok(extension)
}

fn stage_pasted_image_blocking(
    data_dir: &Path,
    bytes: Vec<u8>,
    declared_mime_type: String,
) -> Result<String, CommandError> {
    if bytes.is_empty() || bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(CommandError::invalid_argument(
            "clipboard image must be between 1 byte and 32 MiB",
        ));
    }
    let extension = pasted_image_extension(&bytes, &declared_mime_type)?;
    let directory = data_dir.join("pasted-images");
    std::fs::create_dir_all(&directory).map_err(|error| {
        CommandError::open_failed(format!("create pasted image cache: {error}"))
    })?;
    let path = directory.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| CommandError::open_failed(format!("create pasted image: {error}")))?;
    if let Err(error) = std::io::Write::write_all(&mut file, &bytes) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(CommandError::open_failed(format!(
            "write pasted image: {error}"
        )));
    }
    drop(file);
    match path.to_str() {
        Some(path) => Ok(path.to_owned()),
        None => {
            let _ = std::fs::remove_file(&path);
            Err(CommandError::open_failed(
                "pasted image path is not valid UTF-8",
            ))
        }
    }
}

#[tauri::command]
async fn stage_voice_note(bytes: Vec<u8>, mime_type: String) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        stage_voice_note_blocking(&paths::data_dir(), bytes, &mime_type)
    })
    .await
    .map_err(|error| CommandError::transport(format!("voice note worker failed: {error}")))?
}

fn stage_voice_note_blocking(
    data_dir: &Path,
    bytes: Vec<u8>,
    mime_type: &str,
) -> Result<String, CommandError> {
    if bytes.is_empty() || bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(CommandError::invalid_argument(
            "voice note must be between 1 byte and 32 MiB",
        ));
    }
    let extension = match mime_type.to_ascii_lowercase().as_str() {
        "audio/ogg" | "audio/ogg;codecs=opus" | "application/ogg" => "ogg",
        "audio/webm" | "audio/webm;codecs=opus" => "webm",
        _ => "webm",
    };
    let directory = data_dir.join("voice-notes");
    std::fs::create_dir_all(&directory).map_err(|error| {
        CommandError::open_failed(format!("create voice-note cache: {error}"))
    })?;
    let path = directory.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| CommandError::open_failed(format!("create voice note: {error}")))?;
    if let Err(error) = std::io::Write::write_all(&mut file, &bytes) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(CommandError::open_failed(format!(
            "write voice note: {error}"
        )));
    }
    drop(file);
    match path.to_str() {
        Some(path) => Ok(path.to_owned()),
        None => {
            let _ = std::fs::remove_file(&path);
            Err(CommandError::open_failed(
                "voice-note path is not valid UTF-8",
            ))
        }
    }
}

#[tauri::command]
async fn stage_clipboard_image(app: tauri::AppHandle) -> Result<String, CommandError> {
    // Clipboard image reads can block (and on Linux may deadlock the GTK main
    // thread), so keep both the native read and PNG normalization on a worker.
    tauri::async_runtime::spawn_blocking(move || {
        let clipboard_image = app.clipboard().read_image().map_err(|error| {
            CommandError::new(
                "clipboard_no_image",
                format!("The clipboard does not contain an image: {error}"),
                false,
            )
        })?;
        let width = clipboard_image.width();
        let height = clipboard_image.height();
        if width == 0
            || height == 0
            || width > MAX_PASTED_IMAGE_EDGE
            || height > MAX_PASTED_IMAGE_EDGE
            || u64::from(width) * u64::from(height) > MAX_PASTED_IMAGE_PIXELS
        {
            return Err(CommandError::invalid_argument(
                "clipboard image dimensions are too large",
            ));
        }
        let rgba = clipboard_image.rgba().to_vec();
        let buffer = image::RgbaImage::from_raw(width, height, rgba).ok_or_else(|| {
            CommandError::invalid_argument("clipboard image pixels are malformed")
        })?;
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(buffer)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .map_err(|error| {
                CommandError::open_failed(format!("encode clipboard image: {error}"))
            })?;
        stage_pasted_image_blocking(
            &paths::data_dir(),
            encoded.into_inner(),
            "image/png".to_owned(),
        )
    })
    .await
    .map_err(|error| CommandError::transport(format!("clipboard image worker failed: {error}")))?
}

fn discard_staged_image_blocking(data_dir: &Path, path: &Path) -> Result<(), CommandError> {
    let target = std::fs::canonicalize(path).map_err(|error| {
        CommandError::invalid_argument(format!("staged file is unavailable: {error}"))
    })?;
    // A staged file may belong to any owned cache root (pasted images or
    // recorded voice notes). Accept it only when it resolves inside one of
    // them, so the webview can never delete arbitrary user files.
    let inside_cache = STAGED_CACHE_DIRS.iter().any(|name| {
        std::fs::canonicalize(data_dir.join(name))
            .map(|root| target.starts_with(root))
            .unwrap_or(false)
    });
    if !inside_cache || !target.is_file() {
        return Err(CommandError::invalid_argument(
            "path is outside the staged file caches",
        ));
    }
    let parent = target.parent().map(Path::to_path_buf);
    std::fs::remove_file(&target)
        .map_err(|error| CommandError::open_failed(format!("remove staged file: {error}")))?;
    // Staged outgoing media lives in a per-file directory. Remove it once the
    // file is gone so the cache does not accumulate empty folders.
    if let Some(parent) = parent
        && parent.starts_with(data_dir.join(STAGED_OUTGOING_DIR))
    {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

#[tauri::command]
async fn discard_staged_image(path: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        discard_staged_image_blocking(&paths::data_dir(), Path::new(&path))
    })
    .await
    .map_err(|error| CommandError::transport(format!("clipboard cleanup worker failed: {error}")))?
}

fn clear_staged_files(data_dir: &Path) {
    for name in STAGED_CACHE_DIRS {
        let directory = data_dir.join(name);
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file() {
                let _ = std::fs::remove_file(entry.path());
            } else if file_type.is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// A file the desktop core accepted for sending, together with the staged
/// path the backend must read from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedMedia {
    path: String,
    file_name: String,
    mime_type: String,
    size: u64,
    width: u32,
    height: u32,
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_owned();
    let capped: String = trimmed.chars().take(120).collect();
    if capped.is_empty() {
        "media".to_owned()
    } else {
        capped
    }
}

fn image_mime_type(format: image::ImageFormat) -> Option<&'static str> {
    match format {
        image::ImageFormat::Jpeg => Some("image/jpeg"),
        image::ImageFormat::Png => Some("image/png"),
        image::ImageFormat::Gif => Some("image/gif"),
        image::ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

/// Animated images cannot be cropped without dropping frames, so the editor
/// refuses them instead of silently flattening the animation.
fn is_animated_image(bytes: &[u8], format: image::ImageFormat) -> bool {
    match format {
        image::ImageFormat::Gif => {
            let Ok(decoder) = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)) else {
                return false;
            };
            decoder.into_frames().count() > 1
        }
        image::ImageFormat::WebP => bytes
            .windows(4)
            .any(|window| window == b"ANIM" || window == b"ANMF"),
        _ => false,
    }
}

fn read_file_header(path: &Path) -> Result<Vec<u8>, CommandError> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path)
        .map_err(|error| CommandError::invalid_argument(format!("media file is unavailable: {error}")))?;
    let mut header = vec![0_u8; 32];
    let read = file
        .read(&mut header)
        .map_err(|error| CommandError::open_failed(format!("read media header: {error}")))?;
    header.truncate(read);
    Ok(header)
}

/// Validate a user-picked media file and copy it into the core-owned staging
/// area. The staged path is the only thing the backend is ever allowed to
/// read for an outgoing attachment.
fn stage_outgoing_media_blocking(
    data_dir: &Path,
    path: &str,
    kind: &str,
) -> Result<StagedMedia, CommandError> {
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err(CommandError::invalid_argument("media path must be absolute"));
    }
    let metadata = std::fs::symlink_metadata(source).map_err(|error| {
        CommandError::invalid_argument(format!("media file is unavailable: {error}"))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(CommandError::invalid_argument(
            "media path must not be a symbolic link",
        ));
    }
    if !metadata.is_file() {
        return Err(CommandError::invalid_argument(
            "media path must be a regular file",
        ));
    }
    let size = metadata.len();
    if size == 0 {
        return Err(CommandError::invalid_argument("media file is empty"));
    }
    let wants_image = matches!(kind, "image" | "sticker");
    let limit = if wants_image {
        MAX_STAGED_IMAGE_BYTES
    } else {
        MAX_STAGED_DOCUMENT_BYTES
    };
    if size > limit {
        return Err(CommandError::invalid_argument(format!(
            "media file exceeds the {} byte limit",
            limit
        )));
    }

    let header = read_file_header(source)?;
    let format = image::guess_format(&header).map_err(|_| {
        CommandError::invalid_argument("media file is not a supported image")
    })?;
    let mime_type = image_mime_type(format).ok_or_else(|| {
        CommandError::invalid_argument("only JPEG, PNG, GIF, and WebP images are supported")
    })?;
    if wants_image {
        let (width, height) = image::ImageReader::open(source)
            .map_err(|error| {
                CommandError::invalid_argument(format!("media file is not readable: {error}"))
            })?
            .into_dimensions()
            .map_err(|error| {
                CommandError::invalid_argument(format!("media dimensions are invalid: {error}"))
            })?;
        if width == 0
            || height == 0
            || width > MAX_STAGED_IMAGE_EDGE
            || height > MAX_STAGED_IMAGE_EDGE
            || u64::from(width) * u64::from(height) > MAX_STAGED_IMAGE_PIXELS
        {
            return Err(CommandError::invalid_argument(
                "media dimensions are too large",
            ));
        }
    }

    let file_name = sanitize_file_name(
        source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("media"),
    );
    let directory = data_dir
        .join(STAGED_OUTGOING_DIR)
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory).map_err(|error| {
        CommandError::open_failed(format!("create outgoing media cache: {error}"))
    })?;
    let target = directory.join(&file_name);
    if let Err(error) = std::fs::copy(source, &target) {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(CommandError::open_failed(format!(
            "copy media into the staging cache: {error}"
        )));
    }
    let (width, height) = if wants_image {
        image::ImageReader::open(&target)
            .ok()
            .and_then(|reader| reader.into_dimensions().ok())
            .unwrap_or((0, 0))
    } else {
        (0, 0)
    };
    Ok(StagedMedia {
        path: target.to_string_lossy().into_owned(),
        file_name,
        mime_type: mime_type.to_owned(),
        size,
        width,
        height,
    })
}

#[tauri::command]
async fn stage_outgoing_media(path: String, kind: String) -> Result<StagedMedia, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        stage_outgoing_media_blocking(&paths::data_dir(), &path, &kind)
    })
    .await
    .map_err(|error| CommandError::transport(format!("media staging worker failed: {error}")))?
}

/// Only files the core staged (or recorded) may be handed to the backend.
fn staged_media_path(data_dir: &Path, requested: &str) -> Result<PathBuf, CommandError> {
    let target = Path::new(requested);
    if !target.is_absolute() {
        return Err(CommandError::invalid_argument("media path must be absolute"));
    }
    let canonical = std::fs::canonicalize(target).map_err(|error| {
        CommandError::invalid_argument(format!("media file is unavailable: {error}"))
    })?;
    for name in [STAGED_OUTGOING_DIR, "pasted-images", "voice-notes"] {
        let Ok(root) = std::fs::canonicalize(data_dir.join(name)) else {
            continue;
        };
        if canonical.starts_with(&root) {
            return Ok(canonical);
        }
    }
    Err(CommandError::invalid_argument(
        "media must be staged by the desktop before it can be sent",
    ))
}

/// Crop and rotate a picture, then stage the result for sending.
///
/// The crop rectangle is expressed in the pixels of the ROTATED picture, so
/// the desktop can draw it directly on the preview it shows. The rotation is
/// clockwise and must be one of 0, 90, 180 or 270 degrees.
#[tauri::command]
async fn edit_image(
    path: String,
    rotation: u32,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
) -> Result<StagedMedia, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        edit_image_blocking(
            &paths::data_dir(),
            &path,
            rotation,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
        )
    })
    .await
    .map_err(|error| CommandError::transport(format!("image editor worker failed: {error}")))?
}

fn edit_image_blocking(
    data_dir: &Path,
    path: &str,
    rotation: u32,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
) -> Result<StagedMedia, CommandError> {
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err(CommandError::invalid_argument("image path must be absolute"));
    }
    let metadata = std::fs::symlink_metadata(source).map_err(|error| {
        CommandError::invalid_argument(format!("image file is unavailable: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CommandError::invalid_argument(
            "image path must be a regular file",
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_STAGED_IMAGE_BYTES {
        return Err(CommandError::invalid_argument(
            "image must be between 1 byte and 32 MiB",
        ));
    }
    let header = read_file_header(source)?;
    let format = image::guess_format(&header)
        .map_err(|_| CommandError::invalid_argument("image format is not supported"))?;
    let mime_type = image_mime_type(format).ok_or_else(|| {
        CommandError::invalid_argument("only JPEG, PNG, GIF, and WebP images can be edited")
    })?;
    if is_animated_image(&header, format) {
        return Err(CommandError::invalid_argument(
            "animated images cannot be edited",
        ));
    }
    let decoded = image::open(source).map_err(|error| {
        CommandError::invalid_argument(format!("image could not be decoded: {error}"))
    })?;
    let rotated = match rotation {
        0 => decoded,
        90 => decoded.rotate90(),
        180 => decoded.rotate180(),
        270 => decoded.rotate270(),
        _ => {
            return Err(CommandError::invalid_argument(
                "rotation must be 0, 90, 180 or 270 degrees",
            ));
        }
    };
    let (source_width, source_height) = rotated.dimensions();
    if crop_width == 0 || crop_height == 0 {
        return Err(CommandError::invalid_argument("crop must cover at least one pixel"));
    }
    if crop_x + crop_width > source_width || crop_y + crop_height > source_height {
        return Err(CommandError::invalid_argument(
            "crop falls outside the rotated image",
        ));
    }
    let cropped = image::imageops::crop_imm(
        &rotated,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
    )
    .to_image();

    let extension = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::WebP => "webp",
        _ => "jpg",
    };
    let file_name = format!("edited.{extension}");
    let directory = data_dir
        .join(STAGED_OUTGOING_DIR)
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory).map_err(|error| {
        CommandError::open_failed(format!("create edited image cache: {error}"))
    })?;
    let target = directory.join(&file_name);
    if let Err(error) = cropped.save(&target) {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(CommandError::open_failed(format!(
            "write edited image: {error}"
        )));
    }
    let size = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    let (width, height) = cropped.dimensions();
    Ok(StagedMedia {
        path: target.to_string_lossy().into_owned(),
        file_name,
        mime_type: mime_type.to_owned(),
        size,
        width,
        height,
    })
}

/// Copy one cached media file into a user-chosen directory.
///
/// Both ends are validated: the source must resolve inside the backend-managed
/// media cache, and the destination must be an existing directory the user
/// picked. Neither is allowed to be an arbitrary path from the webview.
#[tauri::command]
async fn save_media_as(
    source_path: String,
    destination_dir: String,
    file_name: String,
) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        save_media_as_blocking(source_path, destination_dir, file_name)
    })
    .await
    .map_err(|error| CommandError::transport(format!("save worker failed: {error}")))?
}

fn save_media_as_blocking(
    source_path: String,
    destination_dir: String,
    file_name: String,
) -> Result<String, CommandError> {
    let source = canonical_media_file(&paths::data_dir(), Path::new(&source_path))?;
    let directory = std::fs::canonicalize(Path::new(&destination_dir)).map_err(|error| {
        CommandError::invalid_argument(format!("save location is unavailable: {error}"))
    })?;
    if !directory.is_dir() {
        return Err(CommandError::invalid_argument(
            "save location is not a directory",
        ));
    }

    let fallback_extension = source.extension().and_then(|value| value.to_str());
    let safe_name = sanitize_download_name(&file_name, fallback_extension);
    let destination = unique_destination(&directory, &safe_name);
    std::fs::copy(&source, &destination)
        .map_err(|error| CommandError::open_failed(format!("save file: {error}")))?;

    // `copy` carries the cache's restrictive 0600 mode across. A file the user
    // deliberately exported belongs to them under the usual default instead.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o644));
    }

    destination
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| CommandError::open_failed("saved path is not valid UTF-8"))
}

fn restart_app(app: tauri::AppHandle) -> ! {
    app.restart()
}

// Tauri's generated response adapter cannot serialize Rust's never type. Keep
// the divergent operation explicit, while exposing a unit-returning IPC shim
// under the public `restart_app` command name.
#[tauri::command(rename = "restart_app")]
async fn restart_app_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, BridgeService>,
) -> Result<(), CommandError> {
    state.begin_shutdown();
    restart_app(app)
}

#[tauri::command]
async fn show_message_notification(
    app: tauri::AppHandle,
    service: tauri::State<'_, native_notifications::NativeNotificationService>,
    title: String,
    body: String,
    chat_id: String,
    message_id: String,
) -> Result<(), CommandError> {
    service
        .show(
            app,
            title,
            body,
            native_notifications::NotificationTarget {
                chat_id,
                message_id,
            },
        )
        .await
        .map_err(CommandError::open_failed)
}

#[tauri::command]
fn take_notification_activations(
    store: tauri::State<'_, native_notifications::NotificationActivationStore>,
) -> Vec<native_notifications::NotificationTarget> {
    store.take()
}

rpc_commands! {
    hello() -> proto::HelloResponse {
        rpc_request::Request::Hello(proto::HelloRequest {
                desktop_version: env!("CARGO_PKG_VERSION").into(),
                minimum_protocol_version: bridge::PROTOCOL_VERSION,
                maximum_protocol_version: bridge::PROTOCOL_VERSION,
            }), CONTROL_TIMEOUT => Hello
    }
    get_auth_state() -> proto::AuthStateResponse {
        rpc_request::Request::GetAuthState(proto::GetAuthStateRequest {}),
        CONTROL_TIMEOUT => AuthState
    }
    start_pairing() -> proto::StartPairingResponse {
        rpc_request::Request::StartPairing(proto::StartPairingRequest {}),
        WRITE_TIMEOUT => StartPairing
    }
    get_sync_status() -> proto::SyncStatusResponse {
        rpc_request::Request::GetSyncStatus(proto::GetSyncStatusRequest {}),
        CONTROL_TIMEOUT => SyncStatus
    }
    request_older_history(chat_id: String) -> proto::RequestOlderHistoryResponse {
        rpc_request::Request::RequestOlderHistory(proto::RequestOlderHistoryRequest { chat_id }),
        WRITE_TIMEOUT => RequestOlderHistory
    }
    get_chat_history_coverage(chat_id: String) -> proto::GetChatHistoryCoverageResponse {
        rpc_request::Request::GetChatHistoryCoverage(proto::GetChatHistoryCoverageRequest { chat_id }),
        READ_TIMEOUT => GetChatHistoryCoverage
    }
    get_history_overview() -> proto::GetHistoryOverviewResponse {
        rpc_request::Request::GetHistoryOverview(proto::GetHistoryOverviewRequest {}),
        READ_TIMEOUT => GetHistoryOverview
    }
    get_integrity_status() -> proto::GetIntegrityStatusResponse {
        rpc_request::Request::GetIntegrityStatus(proto::GetIntegrityStatusRequest {}),
        READ_TIMEOUT => GetIntegrityStatus
    }
    repair_local_cache() -> proto::RepairLocalCacheResponse {
        rpc_request::Request::RepairLocalCache(proto::RepairLocalCacheRequest {}),
        WRITE_TIMEOUT => RepairLocalCache
    }
    list_chats(cursor: String, limit: u32) -> proto::ListChatsResponse {
        rpc_request::Request::ListChats(proto::ListChatsRequest { cursor, limit }),
        READ_TIMEOUT => ListChats
    }
    list_messages(
        chat_id: String,
        before_timestamp_ms: i64,
        before_message_id: String,
        limit: u32,
    ) -> proto::ListMessagesResponse {
        rpc_request::Request::ListMessages(proto::ListMessagesRequest {
                chat_id,
                before_timestamp_ms,
                before_message_id,
                limit,
            }), READ_TIMEOUT => ListMessages
    }
    open_message_window(chat_id: String) -> proto::OpenMessageWindowResponse {
        rpc_request::Request::OpenMessageWindow(proto::OpenMessageWindowRequest { chat_id }),
        READ_TIMEOUT => OpenMessageWindow
    }
    list_messages_after(
        chat_id: String,
        after_timestamp_ms: i64,
        after_message_id: String,
        limit: u32,
    ) -> proto::ListMessagesAfterResponse {
        rpc_request::Request::ListMessagesAfter(proto::ListMessagesAfterRequest {
                chat_id,
                after_timestamp_ms,
                after_message_id,
                limit,
            }), READ_TIMEOUT => ListMessagesAfter
    }
    search_local(query: String) -> proto::SearchLocalResponse {
        rpc_request::Request::SearchLocal(proto::SearchLocalRequest { query }),
        READ_TIMEOUT => SearchLocal
    }
    open_contact(contact_jid: String) -> proto::OpenContactResponse {
        rpc_request::Request::OpenContact(proto::OpenContactRequest { contact_jid }),
        READ_TIMEOUT => OpenContact
    }
    list_messages_around(
        chat_id: String,
        message_id: String,
    ) -> proto::ListMessagesAroundResponse {
        rpc_request::Request::ListMessagesAround(proto::ListMessagesAroundRequest {
                chat_id,
                message_id,
            }), READ_TIMEOUT => ListMessagesAround
    }
    send_text(
        client_message_id: String,
        chat_id: String,
        text: String,
        reply_to_message_id: String,
        mentioned_jids: Vec<String>,
        reply_to_chat_id: String,
    ) -> proto::SendTextResponse {
        rpc_request::Request::SendText(proto::SendTextRequest {
                client_message_id: validate_client_message_id(client_message_id)?,
                chat_id,
                text,
                reply_to_message_id,
                mentioned_jids,
                reply_to_chat_id,
            }), WRITE_TIMEOUT => SendText
    }
    send_image(
        client_message_id: String,
        chat_id: String,
        image_path: String,
        caption: String,
        reply_to_message_id: String,
        reply_to_chat_id: String,
    ) -> proto::SendImageResponse {
        rpc_request::Request::SendImage(proto::SendImageRequest {
                client_message_id: validate_client_message_id(client_message_id)?,
                chat_id,
                image_path: staged_media_path(&paths::data_dir(), &image_path)?
                    .to_string_lossy()
                    .into_owned(),
                caption,
                reply_to_message_id,
                reply_to_chat_id,
            }), ATTACHMENT_TIMEOUT => SendImage
    }
}

/// User-driven reconnect. Besides forwarding the Reconnect RPC on a live
/// epoch, this is the recovery path after the supervisor emits
/// retryExhausted: that state leaves no active client and stops the
/// supervisor loop, so a plain RPC would only fail with
/// backend_reconnecting. Here the backoff is reset and a new epoch with a
/// fresh backend client is handed to a new supervisor loop.
#[tauri::command]
async fn reconnect(
    state: tauri::State<'_, BridgeService>,
) -> Result<proto::ReconnectResponse, CommandError> {
    if state.exhausted.swap(false, Ordering::AcqRel) {
        if state.stopping.load(Ordering::Acquire) {
            return Err(CommandError::shutting_down());
        }
        let next = match bridge::BackendClient::start(state.fake) {
            Ok(next) => next,
            Err(error) => {
                state.exhausted.store(true, Ordering::Release);
                return Err(CommandError::transport(error.to_string()));
            }
        };
        let epoch = state.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let client = Arc::new(next);
        state
            .transport
            .lock()
            .expect("bridge transport lock poisoned")
            .active = Some(ActiveClient {
            epoch,
            client: client.clone(),
        });
        state
            .lifecycle(
                epoch,
                "reconnecting",
                1,
                "manual reconnect after retryExhausted".into(),
            )
            .await;
        let supervisor: BridgeService = (*state).clone();
        tauri::async_runtime::spawn(async move {
            supervisor.run_supervisor(client, epoch).await;
        });
        return Ok(proto::ReconnectResponse { started: true });
    }
    let result = state
        .request(
            rpc_request::Request::Reconnect(proto::ReconnectRequest {}),
            CONTROL_TIMEOUT,
        )
        .await?;
    expect_response!(result, Reconnect)
}

#[tauri::command]
async fn send_sticker(
    state: tauri::State<'_, BridgeService>,
    client_message_id: String,
    chat_id: String,
    image_path: String,
    reply_to_message_id: String,
    reply_to_chat_id: String,
) -> Result<proto::SendStickerResponse, CommandError> {
    let client_message_id = validate_client_message_id(client_message_id)?;
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        sticker::prepare(std::path::Path::new(&image_path))
    })
    .await
    .map_err(|error| CommandError::transport(format!("sticker worker failed: {error}")))?
    .map_err(CommandError::protocol)?;

    let result = state
        .request(
            rpc_request::Request::SendSticker(proto::SendStickerRequest {
                client_message_id,
                chat_id,
                webp_data: prepared.webp_data,
                reply_to_message_id,
                reply_to_chat_id,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendSticker)
}

rpc_commands! {
    list_stickers() -> proto::ListStickersResponse {
        rpc_request::Request::ListStickers(proto::ListStickersRequest {}),
        READ_TIMEOUT => ListStickers
    }
    send_sticker_from_library(
        client_message_id: String,
        chat_id: String,
        sticker_id: String,
        reply_to_message_id: String,
        reply_to_chat_id: String,
    ) -> proto::SendStickerFromLibraryResponse {
        rpc_request::Request::SendStickerFromLibrary(proto::SendStickerFromLibraryRequest {
                client_message_id: validate_client_message_id(client_message_id)?,
                chat_id,
                sticker_id,
                reply_to_message_id,
                reply_to_chat_id,
            }), WRITE_TIMEOUT => SendStickerFromLibrary
    }
    shutdown() -> proto::ShutdownResponse {
        rpc_request::Request::Shutdown(proto::ShutdownRequest {}),
        CONTROL_TIMEOUT => Shutdown
    }
    get_message_image(
        chat_id: String,
        message_id: String,
    ) -> proto::GetMessageImageResponse {
        rpc_request::Request::GetMessageImage(proto::GetMessageImageRequest {
            chat_id,
            message_id,
        }), ATTACHMENT_TIMEOUT => GetMessageImage
    }
    get_message_attachment(
        chat_id: String,
        message_id: String,
    ) -> proto::GetMessageAttachmentResponse {
        rpc_request::Request::GetMessageAttachment(proto::GetMessageAttachmentRequest {
            chat_id,
            message_id,
        }), ATTACHMENT_TIMEOUT => GetMessageAttachment
    }
}

#[tauri::command]
// Keep the command's flat arguments aligned with the frontend and proto wire
// fields; nesting only this send kind would make the Tauri ABI inconsistent.
#[allow(clippy::too_many_arguments)]
async fn send_attachment(
    state: tauri::State<'_, BridgeService>,
    client_message_id: String,
    chat_id: String,
    file_path: String,
    kind: i32,
    caption: String,
    reply_to_message_id: String,
    voice_note: bool,
    reply_to_chat_id: String,
) -> Result<proto::SendAttachmentResponse, CommandError> {
    let client_message_id = validate_client_message_id(client_message_id)?;
    let kind = validate_attachment_kind(kind, &caption, voice_note)?;
    let file_path = staged_media_path(&paths::data_dir(), &file_path)?
        .to_string_lossy()
        .into_owned();
    let result = state
        .request(
            rpc_request::Request::SendAttachment(proto::SendAttachmentRequest {
                client_message_id,
                chat_id,
                file_path,
                kind: kind as i32,
                caption,
                reply_to_message_id,
                voice_note,
                reply_to_chat_id,
            }),
            ATTACHMENT_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendAttachment)
}

// Archive, mute and block are chat settings the linked-device transport does
// not expose as app-state, so the backend stores them per desktop profile.
// The commands mirror the frontend's vocabulary and translate it into the
// single boolean RPC the protocol carries.
#[tauri::command]
async fn archive_chat(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::SetChatArchiveResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SetChatArchive(proto::SetChatArchiveRequest {
                chat_id,
                archived: true,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetChatArchive)
}

#[tauri::command]
async fn unarchive_chat(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::SetChatArchiveResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SetChatArchive(proto::SetChatArchiveRequest {
                chat_id,
                archived: false,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetChatArchive)
}

/// `duration_ms` is the mute length: `None` mutes the chat indefinitely and
/// `Some(0)` is treated as an indefinite mute as well.
#[tauri::command]
async fn mute_chat(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    duration_ms: Option<i64>,
) -> Result<proto::SetChatMuteResponse, CommandError> {
    let mute_until_ms = match duration_ms {
        Some(duration) if duration > 0 => now_millis().saturating_add(duration),
        Some(duration) if duration < 0 => {
            return Err(CommandError::invalid_argument(
                "mute duration must not be negative",
            ));
        }
        _ => INDEFINITE_MUTE_UNTIL_MS,
    };
    let result = state
        .request(
            rpc_request::Request::SetChatMute(proto::SetChatMuteRequest {
                chat_id,
                mute_until_ms,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetChatMute)
}

#[tauri::command]
async fn unmute_chat(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::SetChatMuteResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SetChatMute(proto::SetChatMuteRequest {
                chat_id,
                mute_until_ms: 0,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetChatMute)
}

#[tauri::command]
async fn block_chat(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::SetChatBlockResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SetChatBlock(proto::SetChatBlockRequest {
                chat_id,
                blocked: true,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetChatBlock)
}

#[tauri::command]
async fn unblock_chat(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::SetChatBlockResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SetChatBlock(proto::SetChatBlockRequest {
                chat_id,
                blocked: false,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetChatBlock)
}

rpc_commands! {
    mark_read(chat_id: String, through_message_id: String) -> proto::MarkReadResponse {
        rpc_request::Request::MarkRead(proto::MarkReadRequest {
                chat_id,
                through_message_id,
            }), WRITE_TIMEOUT => MarkRead
    }
    get_chat_avatar(chat_id: String) -> proto::GetChatAvatarResponse {
        rpc_request::Request::GetChatAvatar(proto::GetChatAvatarRequest { chat_id }),
        READ_TIMEOUT => GetChatAvatar
    }
    send_reaction(
        chat_id: String,
        message_id: String,
        emoji: String,
    ) -> proto::SendReactionResponse {
        rpc_request::Request::SendReaction(proto::SendReactionRequest {
                chat_id,
                message_id,
                emoji,
                client_reaction_id: uuid::Uuid::new_v4().to_string(),
            }), WRITE_TIMEOUT => SendReaction
    }
    get_chat_info(chat_id: String) -> proto::GetChatInfoResponse {
        rpc_request::Request::GetChatInfo(proto::GetChatInfoRequest { chat_id }),
        READ_TIMEOUT => GetChatInfo
    }
    get_participant_avatar(participant_id: String) -> proto::GetParticipantAvatarResponse {
        rpc_request::Request::GetParticipantAvatar(proto::GetParticipantAvatarRequest {
                participant_id,
            }), READ_TIMEOUT => GetParticipantAvatar
    }
    repair_recent_reactions(chat_id: String) -> proto::RepairRecentReactionsResponse {
        rpc_request::Request::RepairRecentReactions(proto::RepairRecentReactionsRequest {
                chat_id,
            }), WRITE_TIMEOUT => RepairRecentReactions
    }
    set_typing(chat_id: String, composing: bool) -> proto::SetTypingResponse {
        rpc_request::Request::SetTyping(proto::SetTypingRequest {
                chat_id,
                typing: composing,
            }), WRITE_TIMEOUT => SetTyping
    }
    create_poll(
        client_message_id: String,
        chat_id: String,
        question: String,
        options: Vec<String>,
        selectable_options_count: u32,
    ) -> proto::CreatePollResponse {
        rpc_request::Request::CreatePoll(proto::CreatePollRequest {
                client_message_id: validate_client_message_id(client_message_id)?,
                chat_id,
                question,
                options,
                selectable_options_count,
            }), WRITE_TIMEOUT => CreatePoll
    }
    vote_poll(
        chat_id: String,
        poll_message_id: String,
        selected_options: Vec<String>,
    ) -> proto::VotePollResponse {
        rpc_request::Request::VotePoll(proto::VotePollRequest {
                chat_id,
                poll_message_id,
                selected_options,
            }), WRITE_TIMEOUT => VotePoll
    }
    set_message_pin(
        chat_id: String,
        message_id: String,
        pinned: bool,
    ) -> proto::SetMessagePinResponse {
        rpc_request::Request::SetMessagePin(proto::SetMessagePinRequest {
                chat_id,
                message_id,
                pinned,
            }), WRITE_TIMEOUT => SetMessagePin
    }
    list_pinned_messages(chat_id: String) -> proto::ListPinnedMessagesResponse {
        rpc_request::Request::ListPinnedMessages(proto::ListPinnedMessagesRequest { chat_id }),
        READ_TIMEOUT => ListPinnedMessages
    }
    forward_message(
        client_message_id: String,
        source_chat_id: String,
        message_id: String,
        target_chat_id: String,
    ) -> proto::ForwardMessageResponse {
        rpc_request::Request::ForwardMessage(proto::ForwardMessageRequest {
                client_message_id: validate_client_message_id(client_message_id)?,
                source_chat_id,
                message_id,
                target_chat_id,
            }), WRITE_TIMEOUT => ForwardMessage
    }
    edit_message(
        chat_id: String,
        message_id: String,
        text: String,
    ) -> proto::EditMessageResponse {
        rpc_request::Request::EditMessage(proto::EditMessageRequest {
                chat_id,
                message_id,
                text,
            }), WRITE_TIMEOUT => EditMessage
    }
    delete_message(
        chat_id: String,
        message_id: String,
        delete_for_everyone: bool,
    ) -> proto::DeleteMessageResponse {
        rpc_request::Request::DeleteMessage(proto::DeleteMessageRequest {
                chat_id,
                message_id,
                delete_for_everyone,
            }), WRITE_TIMEOUT => DeleteMessage
    }
    list_statuses() -> proto::ListStatusesResponse {
        rpc_request::Request::ListStatuses(proto::ListStatusesRequest {}), READ_TIMEOUT => ListStatuses
    }
    subscribe_newsletter(invite_key: String) -> proto::SubscribeNewsletterResponse {
        rpc_request::Request::SubscribeNewsletter(proto::SubscribeNewsletterRequest { invite_key }), WRITE_TIMEOUT => SubscribeNewsletter
    }
    list_newsletters() -> proto::ListNewslettersResponse {
        rpc_request::Request::ListNewsletters(proto::ListNewslettersRequest {}), READ_TIMEOUT => ListNewsletters
    }
    list_newsletter_messages(jid: String, limit: i32) -> proto::ListNewsletterMessagesResponse {
        rpc_request::Request::ListNewsletterMessages(proto::ListNewsletterMessagesRequest { jid, limit }), READ_TIMEOUT => ListNewsletterMessages
    }
    unsubscribe_newsletter(jid: String) -> proto::UnsubscribeNewsletterResponse {
        rpc_request::Request::UnsubscribeNewsletter(proto::UnsubscribeNewsletterRequest { jid }), WRITE_TIMEOUT => UnsubscribeNewsletter
    }
    set_chat_pin(chat_id: String, pinned: bool) -> proto::SetChatPinResponse {
        rpc_request::Request::SetChatPin(proto::SetChatPinRequest { chat_id, pinned }), WRITE_TIMEOUT => SetChatPin
    }
    logout() -> proto::LogoutResponse {
        rpc_request::Request::Logout(proto::LogoutRequest {}),
        WRITE_TIMEOUT => Logout
    }
}

#[tauri::command]
fn complete_performance_capture(
    app: tauri::AppHandle,
    payload: serde_json::Value,
) -> Result<(), CommandError> {
    let output = std::env::var_os("WHATFAST_PERF_OUTPUT")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| CommandError::invalid_argument("performance capture is not enabled"))?;
    let parent = output
        .parent()
        .ok_or_else(|| CommandError::invalid_argument("performance output has no parent"))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        CommandError::open_failed(format!("create performance output directory: {error}"))
    })?;
    let temporary = output.with_extension(format!("{}.tmp", std::process::id()));
    let mut encoded = serde_json::to_vec_pretty(&payload).map_err(|error| {
        CommandError::invalid_argument(format!("encode performance result: {error}"))
    })?;
    encoded.push(b'\n');
    std::fs::write(&temporary, encoded)
        .map_err(|error| CommandError::open_failed(format!("write performance result: {error}")))?;
    std::fs::rename(&temporary, &output).map_err(|error| {
        CommandError::open_failed(format!("publish performance result: {error}"))
    })?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn mark_performance_idle_ready() -> Result<(), CommandError> {
    let output = std::env::var_os("WHATFAST_PERF_IDLE_READY")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| CommandError::invalid_argument("idle performance capture is not enabled"))?;
    std::fs::write(output, b"ready\n").map_err(|error| {
        CommandError::open_failed(format!("write idle performance readiness: {error}"))
    })
}

fn create_tray(app: &tauri::App) -> tauri::Result<TrayIcon<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Abrir Whatfast", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Cerrar", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("bundle icon must be configured");
    TrayIconBuilder::with_id("whatfast-tray")
        .icon(icon)
        .tooltip("Whatfast")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => focus_main_window(app),
            "quit" => {
                // WhatsApp Desktop quits gracefully: request a backend
                // Shutdown and reap the child before exiting the shell.
                // CloseRequested above only hides to the tray.
                app.state::<BridgeService>().begin_shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                focus_main_window(tray.app_handle());
            }
        })
        .build(app)
}

fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let args = std::env::args().collect::<Vec<_>>();
    let performance_config = performance_capture_config_from_env();
    let isolated_performance_process = performance_config.is_some()
        || std::env::var("WHATFAST_PERF_ISOLATED").as_deref() == Ok("1");
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(native_notifications::NotificationActivationStore::from_args(&args))
        .manage(native_notifications::NativeNotificationService::default());
    if !isolated_performance_process {
        // This must be the first plugin: a second process must exit before the
        // setup hook starts another sidecar against the same data directory.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(target) = native_notifications::target_from_args(&args) {
                app.state::<native_notifications::NotificationActivationStore>()
                    .push(target.clone());
                let _ = app.emit("notification-activated", target);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(move |window, event| {
            if !isolated_performance_process
                && window.label() == "main"
                && matches!(event, WindowEvent::CloseRequested { .. })
            {
                let WindowEvent::CloseRequested { api, .. } = event else {
                    return;
                };
                api.prevent_close();
                // The close button only hides to the tray, so persist the
                // window geometry here — the destroy event that normally
                // triggers the window-state plugin only fires on real quit.
                // VISIBLE is excluded: the window is being hidden right now,
                // and restoring a "hidden" window on next launch would start
                // the app invisibly in the tray.
                use tauri_plugin_window_state::StateFlags as State;
                let flags = State::SIZE | State::POSITION | State::MAXIMIZED | State::DECORATIONS | State::FULLSCREEN;
                let _ = window.app_handle().save_window_state(flags);
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            if !isolated_performance_process {
                app.manage(create_tray(app)?);
            }
            // Files here are needed only between a paste or recording and its
            // completed send. Anything present at process start is residue
            // from a crash.
            clear_staged_files(&paths::data_dir());
            configure_asset_protocol_scope(&app.asset_protocol_scope(), &paths::data_dir())?;
            let fake = std::env::args().any(|argument| argument == "--fake-backend");
            app.manage(BridgeServiceInner::start(fake)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            subscribe_backend,
            list_desktop_applications,
            open_external_url,
            open_media_path,
            reveal_media_path,
            save_media_as,
            stage_clipboard_image,
            discard_staged_image,
            stage_outgoing_media,
            edit_image,
            show_message_notification,
            take_notification_activations,
            restart_app_command,
            hello,
            get_auth_state,
            start_pairing,
            reconnect,
            get_sync_status,
            request_older_history,
            get_chat_history_coverage,
            get_history_overview,
            get_integrity_status,
            repair_local_cache,
            list_chats,
            list_messages,
            open_message_window,
            list_messages_after,
            search_local,
            open_contact,
            list_messages_around,
            send_text,
            send_image,
            send_sticker,
            list_stickers,
            send_sticker_from_library,
            send_attachment,
            get_message_image,
            get_message_attachment,
            mark_read,
            get_chat_avatar,
            send_reaction,
            get_chat_info,
            get_participant_avatar,
            repair_recent_reactions,
            set_typing,
            create_poll,
            vote_poll,
            set_message_pin,
            list_pinned_messages,
            forward_message,
            edit_message,
            delete_message,
            list_statuses,
            subscribe_newsletter,
            list_newsletters,
            list_newsletter_messages,
            unsubscribe_newsletter,
            set_chat_pin,
            archive_chat,
            unarchive_chat,
            mute_chat,
            unmute_chat,
            block_chat,
            unblock_chat,
            stage_voice_note,
            logout,
            shutdown,
            complete_performance_capture,
            mark_performance_idle_ready,
            get_performance_capture_config,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Whatfast");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app.state::<BridgeService>().begin_shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_image_crops_and_rotates_into_the_staging_cache() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("photo.png");
        let mut buffer = image::RgbImage::new(40, 20);
        for (x, y, pixel) in buffer.enumerate_pixels_mut() {
            pixel.0 = [(x % 256) as u8, (y % 256) as u8, 40];
        }
        image::DynamicImage::ImageRgb8(buffer).save(&source).unwrap();

        // A quarter turn turns 40x20 into 20x40, and the crop is expressed in
        // the pixels of the rotated picture.
        let staged = edit_image_blocking(
            root.path(),
            source.to_str().unwrap(),
            90,
            0,
            0,
            10,
            20,
        )
        .unwrap();
        assert_eq!((staged.width, staged.height), (10, 20));
        assert!(
            Path::new(&staged.path).starts_with(root.path().join(STAGED_OUTGOING_DIR)),
            "edited image must land in the staging cache: {}",
            staged.path
        );
        let decoded = image::open(&staged.path).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (10, 20));
    }

    #[test]
    fn edit_image_refuses_a_crop_outside_the_rotated_picture() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("photo.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::new(40, 20))
            .save(&source)
            .unwrap();
        let error = edit_image_blocking(root.path(), source.to_str().unwrap(), 0, 0, 0, 100, 100)
            .expect_err("a crop outside the picture must be refused");
        assert!(
            error.message.contains("crop falls outside"),
            "unexpected error: {}",
            error.message
        );
    }

    #[test]
    fn staged_media_path_accepts_only_core_owned_caches() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join(STAGED_OUTGOING_DIR).join("batch");
        std::fs::create_dir_all(&staging).unwrap();
        let staged = staging.join("photo.jpg");
        std::fs::write(&staged, b"test").unwrap();
        let outside = root.path().join("secret.txt");
        std::fs::write(&outside, b"test").unwrap();

        assert!(staged_media_path(root.path(), staged.to_str().unwrap()).is_ok());
        assert!(staged_media_path(root.path(), outside.to_str().unwrap()).is_err());
        assert!(staged_media_path(root.path(), "relative.jpg").is_err());
    }

    #[test]
    fn event_sequence_accepts_ordered_events_and_reports_gaps() {
        let mut sequence = EventSequence::default();
        assert_eq!(
            sequence.observe(5),
            SequenceObservation::Gap {
                expected: 1,
                received: 5,
            }
        );
        assert_eq!(sequence.observe(5), SequenceObservation::Stale);
        assert_eq!(sequence.observe(0), SequenceObservation::Invalid);
        assert_eq!(
            sequence.observe(7),
            SequenceObservation::Gap {
                expected: 6,
                received: 7,
            }
        );
        assert_eq!(sequence.observe(8), SequenceObservation::Accept);
    }

    #[test]
    fn restart_backoff_is_exponential_and_capped() {
        let delays: Vec<_> = (1..=8).map(restart_delay).collect();
        assert_eq!(delays[0], Duration::from_millis(250));
        assert_eq!(delays[1], Duration::from_millis(500));
        assert_eq!(delays[4], Duration::from_secs(4));
        assert_eq!(delays[7], Duration::from_secs(4));
        assert_eq!(MAX_RESTART_ATTEMPTS, 5);
        assert_eq!(MAX_PENDING_REQUESTS, 512);
    }

    #[test]
    fn epoch_change_rejects_each_matching_request_once_and_keeps_new_epoch() {
        let mut transport = TransportState::default();
        let mut receivers = Vec::new();
        for (request_id, epoch) in [(1, 7), (2, 7), (3, 8)] {
            let (sender, receiver) = oneshot::channel();
            transport
                .pending
                .insert(request_id, PendingRequest { epoch, sender });
            receivers.push((epoch, receiver));
        }

        reject_epoch_requests(&mut transport, 7, CommandError::epoch_changed(7));
        assert_eq!(transport.pending.len(), 1);
        assert!(transport.pending.contains_key(&3));
        for (epoch, mut receiver) in receivers {
            if epoch == 7 {
                let error = receiver.try_recv().unwrap().unwrap_err();
                assert_eq!(error.code, "backend_epoch_changed");
                assert!(error.retryable);
            } else {
                assert!(matches!(
                    receiver.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ));
            }
        }

        // Repeating the cleanup cannot complete or retain an old request.
        reject_epoch_requests(&mut transport, 7, CommandError::epoch_changed(7));
        assert_eq!(transport.pending.len(), 1);
    }

    #[test]
    fn canonical_media_file_enforces_the_managed_cache_boundary() {
        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        let nested = media.join("attachments");
        std::fs::create_dir_all(&nested).unwrap();
        let inside = nested.join("message.bin");
        std::fs::write(&inside, b"managed media").unwrap();

        assert_eq!(
            canonical_media_file(root.path(), &inside).unwrap(),
            std::fs::canonicalize(&inside).unwrap()
        );
        assert!(canonical_media_file(root.path(), &media).is_err());

        let outside = root.path().join("outside.bin");
        std::fs::write(&outside, b"outside media").unwrap();
        assert!(canonical_media_file(root.path(), &outside).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_media_file_rejects_symlinks_that_escape_the_cache() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        std::fs::create_dir_all(&media).unwrap();
        let outside = root.path().join("outside.bin");
        std::fs::write(&outside, b"outside media").unwrap();
        let link = media.join("escaped.bin");
        symlink(&outside, &link).unwrap();

        assert!(canonical_media_file(root.path(), &link).is_err());
    }

    #[test]
    fn asset_protocol_scope_allows_only_managed_media_and_direct_avatar_files() {
        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        let media_nested = media.join("attachments");
        let avatars = root.path().join("avatars");
        let avatar_nested = avatars.join("unexpected");
        std::fs::create_dir_all(&media_nested).unwrap();
        std::fs::create_dir_all(&avatar_nested).unwrap();

        let media_file = media_nested.join("message.bin");
        let avatar_file = avatars.join("profile.jpg");
        let nested_avatar_file = avatar_nested.join("profile.jpg");
        let unrelated_file = root.path().join("client.db");
        for path in [
            &media_file,
            &avatar_file,
            &nested_avatar_file,
            &unrelated_file,
        ] {
            std::fs::write(path, b"test").unwrap();
        }

        let app = tauri::test::mock_app();
        let scope = app.asset_protocol_scope();
        configure_asset_protocol_scope(&scope, root.path()).unwrap();

        assert!(scope.is_allowed(&media_file));
        assert!(scope.is_allowed(&avatar_file));
        assert!(!scope.is_allowed(&nested_avatar_file));
        assert!(!scope.is_allowed(&unrelated_file));
    }

    #[test]
    fn frontend_event_serialization_preserves_backend_sequence() {
        let event = Option::<FrontendEvent>::from(proto::BackendEvent {
            sequence: 42,
            event: Some(proto::backend_event::Event::ConnectionChanged(
                proto::ConnectionChanged {
                    detail: "connected".into(),
                    ..Default::default()
                },
            )),
        })
        .unwrap();
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["sequence"], 42);
        assert_eq!(value["type"], "connectionChanged");
        assert_eq!(value["payload"]["detail"], "connected");

        let warning = serde_json::to_value(FrontendEvent::problem(
            "event_sequence_gap",
            "refresh required".into(),
        ))
        .unwrap();
        assert_eq!(warning["sequence"], 0);
        assert_eq!(warning["type"], "problem");
        assert_eq!(warning["payload"]["code"], "event_sequence_gap");
    }

    #[test]
    fn external_url_validation_accepts_only_web_links() {
        assert_eq!(
            validated_external_url("https://example.com/a/long/path?query=kept").unwrap(),
            "https://example.com/a/long/path?query=kept"
        );
        assert!(validated_external_url("http://localhost:1420").is_ok());
        for invalid in [
            "file:///etc/passwd",
            "mailto:someone@example.com",
            "javascript:alert(1)",
            "not a url",
        ] {
            let error = validated_external_url(invalid).unwrap_err();
            assert_eq!(error.code, "invalid_argument");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_application_parser_classifies_linux_handlers() {
        let browser = parse_linux_desktop_application(
            "example-browser.desktop".into(),
            "[Desktop Entry]\nType=Application\nName=Example Browser\nExec=example %u\nCategories=Network;WebBrowser;\n",
        )
        .unwrap();
        assert!(browser.browser);
        assert!(!browser.file_manager);
        assert_eq!(browser.option.name, "Example Browser");

        let file_manager = parse_linux_desktop_application(
            "example-files.desktop".into(),
            "[Desktop Entry]\nType=Application\nName=Example Files\nExec=example-files %U\nMimeType=inode/directory;\n",
        )
        .unwrap();
        assert!(!file_manager.browser);
        assert!(file_manager.file_manager);

        assert!(
            parse_linux_desktop_application(
                "hidden.desktop".into(),
                "[Desktop Entry]\nType=Application\nName=Hidden\nExec=hidden\nHidden=true\nCategories=WebBrowser;\n",
            )
            .is_none()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn isolated_xdg_config_overrides_only_the_requested_handler() {
        let browser = isolated_xdg_config("firefox.desktop", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(browser.config_home.join("mimeapps.list")).unwrap(),
            "[Default Applications]\nx-scheme-handler/http=whatfast-selected.desktop;\nx-scheme-handler/https=whatfast-selected.desktop;\n"
        );
        let browser_wrapper = std::fs::read_to_string(
            browser
                .data_home
                .join("applications/whatfast-selected.desktop"),
        )
        .unwrap();
        assert!(browser_wrapper.contains("gtk-launch firefox.desktop %u"));
        assert!(browser_wrapper.contains("--unset=XDG_CONFIG_HOME"));
        std::fs::remove_dir_all(browser.root).unwrap();

        let file_manager = isolated_xdg_config("thunar.desktop", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(file_manager.config_home.join("mimeapps.list")).unwrap(),
            "[Default Applications]\ninode/directory=whatfast-selected.desktop;\n"
        );
        let file_manager_wrapper = std::fs::read_to_string(
            file_manager
                .data_home
                .join("applications/whatfast-selected.desktop"),
        )
        .unwrap();
        assert!(file_manager_wrapper.contains("gtk-launch thunar.desktop %f"));
        std::fs::remove_dir_all(file_manager.root).unwrap();

        assert!(isolated_xdg_config("../not-safe.desktop", true).is_err());
        assert_eq!(
            niri_window_ids("org.gnome.Nautilus.desktop"),
            ["org.gnome.nautilus", "nautilus"]
        );
    }

    #[test]
    fn attachment_validation_matches_backend_contract() {
        assert!(
            validate_attachment_kind(proto::AttachmentKind::Document as i32, "caption", false)
                .is_ok()
        );
        assert!(
            validate_attachment_kind(proto::AttachmentKind::Video as i32, "caption", false).is_ok()
        );
        assert!(validate_attachment_kind(proto::AttachmentKind::Audio as i32, "", true).is_ok());
        for error in [
            validate_attachment_kind(proto::AttachmentKind::Unspecified as i32, "", false)
                .unwrap_err(),
            validate_attachment_kind(999, "", false).unwrap_err(),
            validate_attachment_kind(proto::AttachmentKind::Audio as i32, "caption", false)
                .unwrap_err(),
            validate_attachment_kind(proto::AttachmentKind::Document as i32, "", true).unwrap_err(),
        ] {
            assert_eq!(error.code, "invalid_argument");
            assert!(!error.retryable);
        }
    }

    #[test]
    fn client_message_id_validation_preserves_only_canonical_v4_ids() {
        let client_message_id = "9d50a8b6-70ca-43db-94f0-2f65e9f71816".to_string();
        assert_eq!(
            validate_client_message_id(client_message_id.clone()).unwrap(),
            client_message_id
        );

        for invalid in [
            "",
            "not-a-uuid",
            "9D50A8B6-70CA-43DB-94F0-2F65E9F71816",
            "9d50a8b6-70ca-13db-94f0-2f65e9f71816",
        ] {
            let error = validate_client_message_id(invalid.to_string()).unwrap_err();
            assert_eq!(error.code, "invalid_argument");
            assert!(!error.retryable);
        }
    }

    #[test]
    fn download_names_are_reduced_to_one_safe_component() {
        assert_eq!(sanitize_download_name("holiday.jpg", None), "holiday.jpg");
        assert_eq!(
            sanitize_download_name("../../etc/passwd", None),
            "passwd".to_string()
        );
        assert_eq!(
            sanitize_download_name("/absolute/path/report.pdf", None),
            "report.pdf"
        );
        // Assert the security-relevant invariant rather than an exact string,
        // because `file_name()` splits on `\` only on Windows: whatever survives
        // must be a single component with no separators or shell metacharacters,
        // however the host platform tokenised the input.
        let sanitized = sanitize_download_name("a/b\\c:d*e?.txt", None);
        assert!(!sanitized.contains('/'));
        assert!(!sanitized.contains('\\'));
        assert!(!sanitized.contains(':'));
        assert!(!sanitized.contains('*'));
        assert!(!sanitized.contains('?'));
        assert!(!sanitized.contains(".."));
        assert!(sanitized.ends_with(".txt"));
        assert_eq!(
            sanitize_download_name("", Some("webp")),
            "whatfast-file.webp"
        );
        assert_eq!(sanitize_download_name("...", None), "whatfast-file");
        assert!(!sanitize_download_name(&"x".repeat(500), None).is_empty());
        assert!(sanitize_download_name(&"x".repeat(500), None).len() <= 200);
    }

    #[test]
    fn pasted_images_are_validated_staged_privately_and_discarded() {
        let root = tempfile::tempdir().unwrap();
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let bytes = encoded.into_inner();

        let path = PathBuf::from(
            stage_pasted_image_blocking(root.path(), bytes.clone(), "image/png".to_string())
                .unwrap(),
        );
        assert!(path.starts_with(root.path().join("pasted-images")));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        discard_staged_image_blocking(root.path(), &path).unwrap();
        assert!(!path.exists());
        assert!(
            stage_pasted_image_blocking(root.path(), Vec::new(), "image/png".to_string()).is_err()
        );
        assert!(stage_pasted_image_blocking(root.path(), bytes, "image/jpeg".to_string()).is_err());
    }

    #[test]
    fn pasted_image_cleanup_rejects_paths_outside_its_cache() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("pasted-images");
        std::fs::create_dir_all(&staged).unwrap();
        let outside = root.path().join("keep.png");
        std::fs::write(&outside, b"not staged").unwrap();
        assert!(discard_staged_image_blocking(root.path(), &outside).is_err());
        assert!(outside.exists());

        let residue = staged.join("crashed-send.png");
        std::fs::write(&residue, b"stale").unwrap();
        clear_staged_files(root.path());
        assert!(!residue.exists());
        assert!(outside.exists());
    }

    #[test]
    fn voice_notes_are_staged_privately_discarded_and_cleaned_up() {
        let root = tempfile::tempdir().unwrap();
        let path = PathBuf::from(
            stage_voice_note_blocking(root.path(), vec![1, 2, 3, 4], "audio/ogg;codecs=opus")
                .unwrap(),
        );
        assert!(path.starts_with(root.path().join("voice-notes")));
        assert_eq!(path.extension().and_then(|value| value.to_str()), Some("ogg"));
        assert_eq!(std::fs::read(&path).unwrap(), vec![1, 2, 3, 4]);

        discard_staged_image_blocking(root.path(), &path).unwrap();
        assert!(!path.exists());

        let residue = root.path().join("voice-notes").join("crashed-send.webm");
        std::fs::write(&residue, b"stale").unwrap();
        clear_staged_files(root.path());
        assert!(!residue.exists());
    }

    #[test]
    fn saving_twice_does_not_overwrite_the_first_file() {
        let directory = tempfile::tempdir().unwrap();
        let first = unique_destination(directory.path(), "photo.jpg");
        assert_eq!(first, directory.path().join("photo.jpg"));
        std::fs::write(&first, b"one").unwrap();

        let second = unique_destination(directory.path(), "photo.jpg");
        assert_eq!(second, directory.path().join("photo (2).jpg"));
        std::fs::write(&second, b"two").unwrap();

        let third = unique_destination(directory.path(), "photo.jpg");
        assert_eq!(third, directory.path().join("photo (3).jpg"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
    }

    #[test]
    fn saving_rejects_a_source_outside_the_managed_media_cache() {
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("id_rsa");
        std::fs::write(&secret, b"private").unwrap();

        let error = save_media_as_blocking(
            secret.to_string_lossy().into_owned(),
            outside.path().to_string_lossy().into_owned(),
            "id_rsa".to_string(),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_argument");
    }
}
