import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { bridge, discardStagedImage, normalizeBridgeError, openFile, openUrl, revealMediaPath, stageOutgoingMedia } from "../lib/bridge";
import { messageText } from "../lib/format";
import { BoundedSet, boundWindowAround } from "../lib/performance";
import {
  mergeSpotlightChatUsage,
  recordSpotlightChatUse,
} from "../lib/spotlight";
import { ParticipantAvatarQueue } from "../lib/participant-avatar-queue";
import { clearMergedPollVotes } from "../lib/chat-merge";
import { clonePollContent, optimisticPollVote, preservePendingPollIntent } from "../lib/polls";
import {
  ensureNotificationPermission,
  listenForNotificationActions,
  sendMessageNotification,
} from "../lib/notifications";
import {
  NotificationActivationQueue,
  notificationTargetAvailability,
} from "../lib/notification-routing";
import { isChatActuallyVisible, shouldNotify } from "../lib/notification-policy";
import {
  AttachmentKind,
  ChatKind,
  ConnectionState,
  SyncPhase,
  HistoryCoverageState,
  type Chat,
  type ChatInfo,
  type ChatParticipant,
  type ContactSearchResult,
  type FrontendEvent,
  type Message,
  type MessageSearchResult,
  type Reaction,
  type SearchResults,
  type StagedMedia,
  type SyncStatus,
  type HistoryCoverage,
  type HistoryOverview,
  type IntegrityStatus,
  MUTE_UNTIL_INDEFINITE,
  type PinnedMessage,
  type StatusGroup,
  type Newsletter,
} from "../lib/types";
import { pairingStartupDecision } from "./pairing";
import { shouldApplySyncStatus, syncStatusActive } from "./sync";
import {
  activeConversationIds,
  backendLifecycleDecision,
  bootstrapFailureDecision,
  RequestGeneration,
  RestartEpochQueue,
  runBoundedRetry,
} from "./backend-lifecycle";
import { createPreferences } from "./preferences";
import { optimisticUnreadCount, shouldRestoreOptimisticUnread } from "./unread";
import {
  MAX_ACTIVE_MESSAGES,
  cloneDraft,
  draftIsEmpty,
  encodeMentions,
  mediaKey,
  mergeChats,
  reconcileAuthoritativeChats,
  mergeMessages,
  readRecentChats,
  rememberRecentChat,
  sortChats,
  sortMessages,
  trimMessages,
  upsertSortedMessage,
  writeRecentChats,
} from "./app-helpers";
import {
  closeTabInWorkspace,
  conversationsToEvict,
  cycleSwitcher as cycleSwitcherHighlight,
  emptyPane,
  moveTabBetweenPanes,
  openSwitcher as buildSwitcher,
  openTab,
  paneContainingChat,
  readWorkspaceSnapshot,
  recentChatCandidates,
  remapPaneChatId,
  selectTab,
  uniqueChatPanes,
  writeWorkspaceSnapshot,
  type Pane,
  type Switcher,
} from "./workspace";

export type { Pane, Switcher } from "./workspace";

export type Screen = "starting" | "pairing" | "chats" | "fatal";
export type ChatFilter = "all" | "unread" | "favorites" | "groups" | "archived" | "channels";

export interface Mention {
  displayName: string;
  jid: string;
}

export interface Draft {
  text: string;
  replyToMessageId: string;
  replyToChatId: string;
  replyPreviewText: string;
  replySenderName: string;
  editingMessageId: string;
  mentions: Mention[];
}

export interface ForwardDialogState {
  sourceChatId: string;
  messageId: string;
}

export interface MessageSelection {
  chatId: string;
  messageIds: string[];
}

export type FileSendMode = "image" | "sticker" | "attachment";

export interface FileSendConfirmationState {
  chatId: string;
  paths: string[];
  mode: FileSendMode;
  attachmentKind: AttachmentKind;
  voiceNote: boolean;
  temporaryPaths?: string[];
}

export interface TypingPresence {
  senderId: string;
  senderName: string;
  recording: boolean;
  expiresAt: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

export interface ImageViewerState {
  path: string;
  caption: string;
  sticker: boolean;
}

/** One conversation's message window, keyed by chat id so two panes can each hold one. */
export interface ConversationState {
  chatId: string;
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadMessageId: string;
  highlightedMessageId: string;
  liveMessageVersion: number;
  historyCoverage: HistoryCoverage | null;
}

import type { StickerPack } from "../lib/types";

/**
 * Re-exported so sticker-tray components can keep importing the pack shape
 * from the state module as before.
 */
export type { StickerPack } from "../lib/types";

export interface StickersState {
  packs: StickerPack[];
  loading: boolean;
  error: string;
}

export interface AppState {
  screen: Screen;
  connection: number;
  connectionDetail: string;
  ownUserId: string;
  backendVersion: string;
  qrCode: string;
  qrExpiresAtMs: number;
  syncChats: number;
  syncMessages: number;
  syncActive: boolean;
  syncStatus: SyncStatus;
  historyOverview: HistoryOverview | null;
  integrityStatus: IntegrityStatus | null;
  integrityChecking: boolean;
  historySyncJob: {
    running: boolean;
    scope: "chat" | "all";
    chatId: string;
    totalChats: number;
    completedChats: number;
    messagesAdded: number;
    detail: string;
  };
  chats: Chat[];
  totalChats: number;
  nextChatCursor: string;
  loadingChats: boolean;
  chatFilter: ChatFilter;
  /** Derived from, and kept in sync with, the focused pane's `activeChatId`. */
  selectedChatId: string;
  conversations: Record<string, ConversationState>;
  panes: Pane[];
  focusedPaneId: string;
  switcher: Switcher | null;
  drafts: Record<string, Draft>;
  sending: boolean;
  typing: Record<string, Record<string, TypingPresence>>;
  pinnedMessages: Record<string, PinnedMessage[]>;
  pendingPollVotes: Record<string, boolean>;
  searchQuery: string;
  searchResults: SearchResults | null;
  searchLoading: boolean;
  searchError: string;
  chatInfo: ChatInfo | null;
  chatInfoOpen: boolean;
  chatInfoLoading: boolean;
  chatInfoError: string;
  participantAvatars: Record<string, string>;
  imageFailures: Record<string, string>;
  attachmentFailures: Record<string, string>;
  imageViewer: ImageViewerState | null;
  forwardDialog: ForwardDialogState | null;
  selection: MessageSelection | null;
  statuses: StatusGroup[];
  statusesChatId: string;
  /** Background color per local text-status message id (memory only). */
  statusColors: Record<string, string>;
  /** Locally starred message ids, persisted to localStorage. */
  starred: Record<string, boolean>;
  newsletters: Newsletter[];
  selectedNewsletter: Newsletter | null;
  newsletterPosts: Message[];
  newsletterLoading: boolean;
  fileSendConfirmation: FileSendConfirmationState | null;
  settingsOpen: boolean;
  stickers: StickersState;
  logoutConfirmation: boolean;
  tabAnnouncement: string;
  toasts: Toast[];
  fatalError: string;
}

const emptyDraft = (): Draft => ({
  text: "",
  replyToMessageId: "",
  replyToChatId: "",
  replyPreviewText: "",
  replySenderName: "",
  editingMessageId: "",
  mentions: [],
});
/** Cap on simultaneously hydrated conversations; least-recently-focused ones are evicted. */
const MAX_HYDRATED_CONVERSATIONS = 8;
const MAX_AVATAR_ATTEMPTS = 4_096;
const MAX_PARTICIPANT_AVATARS = 512;
const MAX_MEDIA_FAILURES = 512;

function emptyConversation(chatId: string): ConversationState {
  return {
    chatId,
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasOlder: false,
    hasNewer: false,
    firstUnreadMessageId: "",
    highlightedMessageId: "",
    liveMessageVersion: 0,
    historyCoverage: null,
  };
}

const FAVORITES_KEY = "whatfast-favorites";
const STARRED_KEY = "whatfast-starred";

function readStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function writeStringSet(key: string, ids: Set<string> | Record<string, boolean> | readonly string[]) {
  try {
    const list = Array.isArray(ids) ? ids : ids instanceof Set ? [...ids] : Object.keys(ids).filter((id) => (ids as Record<string, boolean>)[id]);
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // localStorage is best-effort (private mode); in-memory state still works.
  }
}

function readStarred(): Record<string, boolean> {
  const starred: Record<string, boolean> = {};
  for (const id of readStringSet(STARRED_KEY)) starred[id] = true;
  return starred;
}

/** Re-apply local-only favorites onto a chat list from any source. */
function applyFavorites(chats: Chat[]): Chat[] {
  const favorites = readStringSet(FAVORITES_KEY);
  if (favorites.size === 0) return chats;
  return chats.map((chat) => (favorites.has(chat.id) && !chat.favorite ? { ...chat, favorite: true } : chat));
}

export interface AppModelLifecycleHooks {
  /** Release queued deep links/notification activations once backend state is hydrated. */
  backendReady?(): void;
}

export function createAppModel(lifecycleHooks: AppModelLifecycleHooks = {}) {
  const { preferences, prefActions } = createPreferences();
  const restoredWorkspace = readWorkspaceSnapshot();
  const initialPanes = restoredWorkspace?.panes ?? [emptyPane("pane-1")];
  const initialFocusedPaneId = restoredWorkspace?.focusedPaneId ?? initialPanes[0]!.id;
  const initialSelectedChatId =
    initialPanes.find((pane) => pane.id === initialFocusedPaneId)?.activeChatId ?? "";

  const [state, setState] = createStore<AppState>({
    screen: "starting",
    connection: ConnectionState.Starting,
    connectionDetail: "",
    ownUserId: "",
    backendVersion: "",
    qrCode: "",
    qrExpiresAtMs: 0,
    syncChats: 0,
    syncMessages: 0,
    syncActive: false,
    syncStatus: {
      phase: SyncPhase.NotStarted,
      revision: 0,
      chatsProcessed: 0,
      messagesProcessed: 0,
      messagesReceived: 0,
      messagesDecoded: 0,
      messagesFailed: 0,
      whatsAppProgress: 0,
      startedAtMs: 0,
      completedAtMs: 0,
      detail: "Sync has not started",
    },
    historyOverview: null,
    integrityStatus: null,
    integrityChecking: false,
    historySyncJob: {
      running: false,
      scope: "chat",
      chatId: "",
      totalChats: 0,
      completedChats: 0,
      messagesAdded: 0,
      detail: "",
    },
    chats: [],
    totalChats: 0,
    nextChatCursor: "",
    loadingChats: false,
    chatFilter: "all",
    selectedChatId: initialSelectedChatId,
    conversations: {},
    panes: initialPanes,
    focusedPaneId: initialFocusedPaneId,
    switcher: null,
    drafts: {},
    sending: false,
    typing: {},
    pinnedMessages: {},
    pendingPollVotes: {},
    searchQuery: "",
    searchResults: null,
    searchLoading: false,
    searchError: "",
    chatInfo: null,
    chatInfoOpen: false,
    chatInfoLoading: false,
    chatInfoError: "",
    participantAvatars: {},
    imageFailures: {},
    attachmentFailures: {},
    imageViewer: null,
    forwardDialog: null,
    selection: null,
    statuses: [],
    statusesChatId: "",
    statusColors: {},
    starred: readStarred(),
    newsletters: [],
    selectedNewsletter: null,
    newsletterPosts: [],
    newsletterLoading: false,
    fileSendConfirmation: null,
    settingsOpen: false,
    stickers: { packs: [], loading: false, error: "" },
    logoutConfirmation: false,
    tabAnnouncement: "",
    toasts: [],
    fatalError: "",
  });

  let searchGeneration = 0;
  let searchTimer: number | undefined;
  let syncRefreshTimer: number | undefined;
  let typingTimer: number | undefined;
  let typingChatId = "";
  let eventGapResyncing = false;
  let restartResyncing = false;
  const restartEpochs = new RestartEpochQueue();
  const chatListGeneration = new RequestGeneration();
  const chatInfoGeneration = new RequestGeneration();
  let disposed = false;
  let toastId = 0;
  let statusRefreshTimer: number | undefined;
  const pendingImages = new Set<string>();
  const pollVoteGenerations = new Map<string, number>();
  const pinGenerations = new Map<string, number>();
  const pendingAttachments = new Set<string>();
  const pendingAvatars = new Set<string>();
  const attemptedAvatars = new BoundedSet<string>(MAX_AVATAR_ATTEMPTS);
  const participantAvatarKeys = new BoundedSet<string>(MAX_PARTICIPANT_AVATARS);
  const failedImageKeys = new BoundedSet<string>(MAX_MEDIA_FAILURES);
  const failedAttachmentKeys = new BoundedSet<string>(MAX_MEDIA_FAILURES);
  const backendChatRevisions = new Map<string, number>();
  /** Per-chat load generations so a stale in-flight fetch cannot clobber a fresher one. */
  const conversationGenerations = new Map<string, number>();
  const historyResultWaiters = new Map<string, {
    afterRevision: number;
    resolve: (coverage: HistoryCoverage) => void;
    reject: (error: Error) => void;
    timer: number;
  }>();
  let cancelHistorySync = false;
  /** Monotonic across evictions so a reopened chat can never reuse an in-flight token. */
  let conversationGenerationSequence = 0;
  /** Drives LRU eviction once more than `MAX_HYDRATED_CONVERSATIONS` chats are hydrated. */
  const conversationLastFocusedAt = new Map<string, number>();
  /** A brand-new conversation emits its message immediately before its chat row. */
  const pendingNotifications = new Map<string, Message>();
  const notifiedMessages = new Set<string>();
  let fileSendQueue: Promise<void> = Promise.resolve();
  let disposeNotificationActions: (() => void) | undefined;
  const notificationActivations = new NotificationActivationQueue(openNotificationTarget);
  const participantAvatarQueue = new ParticipantAvatarQueue({
    fetchAvatar: async (participantId) => (await bridge.getParticipantAvatar(participantId)).avatarPath,
    onHydrated: (participantId, avatarPath) => {
      const evicted = participantAvatarKeys.add(participantId);
      batch(() => {
        if (evicted) setState("participantAvatars", evicted, undefined!);
        setState("participantAvatars", participantId, avatarPath);
      });
    },
  });

  function markBackendReady() {
    notificationActivations.markReady();
    lifecycleHooks.backendReady?.();
  }

  function applySyncStatus(status: SyncStatus | null | undefined) {
    if (!status || !shouldApplySyncStatus(state.syncStatus, status)) return;
    batch(() => {
      setState("syncStatus", status);
      setState("syncChats", status.chatsProcessed);
      setState("syncMessages", status.messagesProcessed);
      setState("syncActive", syncStatusActive(status));
    });
  }

  async function bootstrap() {
    try {
      try {
        const dispose = await listenForNotificationActions((target) => {
          notificationActivations.enqueue(target);
        });
        if (disposed) dispose();
        else disposeNotificationActions = dispose;
      } catch (error) {
        // Notifications are optional desktop integration. A missing or broken
        // platform service must not prevent the messaging bridge from starting.
        console.warn("Could not register notification actions", error);
      }
      await bridge.subscribeBackend(handleEvent);
      const hello = await bridge.hello();
      const [auth, sync] = await Promise.all([
        bridge.getAuthState(),
        bridge.getSyncStatus(),
      ]);
      applySyncStatus(sync.status);
      batch(() => {
        setState("backendVersion", hello.backendVersion);
        setState("connection", auth.connectionState);
        setState("ownUserId", auth.ownUserId);
      });
      const pairing = pairingStartupDecision(auth);
      setState("screen", pairing.screen);
      if (pairing.startPairing) {
        await bridge.startPairing();
        return;
      }
      if (preferences.notificationsEnabled) {
        void ensureNotificationPermission().catch((error) => {
          console.warn("Could not initialize notifications", error);
        });
      }
      // Statuses arrive without a push event, so poll the store periodically
      // to keep the ring strip fresh without relying on reconnect.
      statusRefreshTimer = window.setInterval(() => {
        void loadStatuses();
      }, 45_000);
      await loadChats(true);
      await restoreWorkspaceConversations();
      markBackendReady();
    } catch (error) {
      const bridgeError = normalizeBridgeError(error);
      if (bootstrapFailureDecision(bridgeError) === "reconnecting") {
        batch(() => {
          setState("connection", ConnectionState.Reconnecting);
          setState("connectionDetail", "Waiting for the WhatsApp backend to restart");
        });
      } else {
        fatal(bridgeError.message);
      }
    }
  }

  /** Hydrate whichever chats the restored (or freshly created) panes are showing. */
  async function restoreWorkspaceConversations() {
    const chatIds = [...new Set(state.panes.map((pane) => pane.activeChatId).filter(Boolean))];
    await Promise.all(
      chatIds.map((chatId) => {
        touchConversationFocus(chatId);
        return Promise.all([loadConversation(chatId), loadPinnedMessages(chatId)]).catch(() => undefined);
      }),
    );
  }

  async function refreshPairing() {
    try {
      const response = await bridge.startPairing();
      if (response.started) return;
      const auth = await bridge.getAuthState();
      if (auth.paired) {
        batch(() => {
          setState("connection", auth.connectionState);
          setState("ownUserId", auth.ownUserId);
          setState("screen", "chats");
          setState("qrCode", "");
          setState("qrExpiresAtMs", 0);
        });
        await loadChats(true);
        return;
      }
      toast("Pairing is already active. A fresh QR code will appear automatically.", "info");
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function reconnect() {
    if (
      state.connection === ConnectionState.Connected ||
      state.connection === ConnectionState.Connecting
    ) return;
    batch(() => {
      setState("connection", ConnectionState.Connecting);
      setState("connectionDetail", "Connecting on your request");
    });
    try {
      const response = await bridge.reconnect();
      if (response.started) return;
      const auth = await bridge.getAuthState();
      batch(() => {
        setState("connection", auth.connectionState);
        setState(
          "connectionDetail",
          auth.connectionState === ConnectionState.Connected
            ? ""
            : "Reconnect is already running or this device is not linked",
        );
      });
    } catch (error) {
      batch(() => {
        setState("connection", ConnectionState.Offline);
        setState("connectionDetail", "Reconnect failed");
      });
      notifyError(error);
    }
  }

  async function loadChats(reset = false, supersede = false, throwOnError = false) {
    if (state.loadingChats && !supersede) return;
    if (!reset && !state.nextChatCursor) return;
    const generation = chatListGeneration.begin();
    setState("loadingChats", true);
    try {
      const cursor = reset ? "" : state.nextChatCursor;
      const response = await bridge.listChats(cursor, 100);
      if (!chatListGeneration.isCurrent(generation)) return;
      // Merge into the current snapshot even on a first-page refresh: a live
      // upsert or already-loaded tail page may have arrived while this request
      // was in flight.
      const merged = applyFavorites(mergeChats(state.chats, response.chats));
      batch(() => {
        setState("chats", reconcile(sortChats(merged), { key: "id" }));
        setState("totalChats", response.totalCount);
        setState("nextChatCursor", response.nextCursor);
      });
    } catch (error) {
      if (chatListGeneration.isCurrent(generation)) {
        if (throwOnError) throw error;
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (chatListGeneration.isCurrent(generation)) setState("loadingChats", false);
    }
  }

  async function loadAllChatsAuthoritative() {
    const generation = chatListGeneration.begin();
    const revisionsBefore = new Map(backendChatRevisions);
    setState("loadingChats", true);
    try {
      const authoritative: Chat[] = [];
      let cursor = "";
      let totalCount = 0;
      do {
        const response = await bridge.listChats(cursor, 100);
        if (!chatListGeneration.isCurrent(generation)) {
          throw new Error("Chat refresh was superseded");
        }
        authoritative.push(...response.chats);
        totalCount = response.totalCount;
        cursor = response.nextCursor;
      } while (cursor);

      // Preserve only live upserts that raced this exact snapshot. Everything
      // else is replaced by the complete authoritative backend list.
      batch(() => {
        setState(
          "chats",
          reconcile(
            reconcileAuthoritativeChats(
              applyFavorites(authoritative),
              state.chats,
              revisionsBefore,
              backendChatRevisions,
            ),
            { key: "id" },
          ),
        );
        setState("totalChats", totalCount);
        setState("nextChatCursor", "");
      });
    } finally {
      if (chatListGeneration.isCurrent(generation)) setState("loadingChats", false);
    }
  }

  // ---------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------

  /** Never returns undefined so components can render before a chat has loaded. */
  function conversation(chatId: string): ConversationState {
    return state.conversations[chatId] ?? Object.freeze(emptyConversation(chatId));
  }

  function ensureConversation(chatId: string) {
    if (!state.conversations[chatId]) setState("conversations", chatId, emptyConversation(chatId));
  }

  function bumpConversationGeneration(chatId: string): number {
    const next = ++conversationGenerationSequence;
    conversationGenerations.set(chatId, next);
    return next;
  }

  function isCurrentGeneration(chatId: string, generation: number): boolean {
    return conversationGenerations.get(chatId) === generation;
  }

  function touchConversationFocus(chatId: string) {
    if (!chatId) return;
    conversationLastFocusedAt.set(chatId, Date.now());
  }

  function isChatVisible(chatId: string): boolean {
    const compactSplit = window.matchMedia?.("(max-width: 900px)").matches ?? false;
    return isChatActuallyVisible(state.panes, state.focusedPaneId, chatId, compactSplit);
  }

  /** Evict conversations that are no longer open anywhere, then trim to the LRU cap. */
  function pruneConversations() {
    const openChatIds = new Set(state.panes.flatMap((pane) => pane.tabChatIds));
    const visibleChatIds = new Set(state.panes.map((pane) => pane.activeChatId).filter(Boolean));
    const evicted = conversationsToEvict(
      Object.keys(state.conversations),
      openChatIds,
      conversationLastFocusedAt,
      MAX_HYDRATED_CONVERSATIONS,
      visibleChatIds,
    );
    if (evicted.length === 0) return;
    batch(() => {
      for (const chatId of evicted) {
        setState("conversations", chatId, undefined!);
        conversationGenerations.delete(chatId);
        conversationLastFocusedAt.delete(chatId);
      }
    });
  }

  /** Fetch (or refetch) a chat's message window and write it into `state.conversations`. */
  async function loadConversation(
    chatId: string,
    aroundMessageId = "",
    throwOnError = false,
    authoritativeLatest = false,
  ) {
    if (!chatId) return;
    ensureConversation(chatId);
    const generation = bumpConversationGeneration(chatId);
    batch(() => {
      setState("conversations", chatId, "loading", true);
      // A new canonical/around window supersedes pagination already in flight.
      setState("conversations", chatId, "loadingOlder", false);
      setState("conversations", chatId, "loadingNewer", false);
    });
    try {
      if (aroundMessageId) {
        const response = await bridge.listMessagesAround(chatId, aroundMessageId);
        if (!isCurrentGeneration(chatId, generation)) return;
        const highlightId = response.anchorMessageId || aroundMessageId;
        const merged = sortMessages(
          mergeMessages(state.conversations[chatId]?.messages ?? [], response.messages),
        );
        const requestedAnchorIndex = merged.findIndex((message) => message.id === highlightId);
        const anchorIndex = requestedAnchorIndex >= 0 ? requestedAnchorIndex : merged.length - 1;
        const bounded = boundWindowAround(merged, MAX_ACTIVE_MESSAGES, anchorIndex);
        batch(() => {
          setState(
            "conversations",
            chatId,
            "messages",
            reconcile(bounded.items, { key: "id" }),
          );
          setState("conversations", chatId, "hasOlder", response.hasOlder || bounded.droppedBefore);
          setState("conversations", chatId, "hasNewer", response.hasNewer || bounded.droppedAfter);
          setState(
            "conversations",
            chatId,
            "highlightedMessageId",
            requestedAnchorIndex >= 0 ? highlightId : "",
          );
        });
        window.setTimeout(() => {
          if (state.conversations[chatId]?.highlightedMessageId === highlightId) {
            setState("conversations", chatId, "highlightedMessageId", "");
          }
        }, 3_000);
      } else if (authoritativeLatest) {
        const response = await bridge.listMessages(chatId, 0, "", 50);
        if (!isCurrentGeneration(chatId, generation)) return;
        const messages = sortMessages(response.messages);
        const firstUnreadMessageId = state.conversations[chatId]?.firstUnreadMessageId ?? "";
        batch(() => {
          setState(
            "conversations",
            chatId,
            "messages",
            reconcile(messages, { key: "id" }),
          );
          setState("conversations", chatId, "hasOlder", response.hasMore);
          setState("conversations", chatId, "hasNewer", false);
          setState(
            "conversations",
            chatId,
            "firstUnreadMessageId",
            messages.some((message) => message.id === firstUnreadMessageId)
              ? firstUnreadMessageId
              : "",
          );
        });
      } else {
        const response = await bridge.openMessageWindow(chatId);
        if (!isCurrentGeneration(chatId, generation)) return;
        const merged = sortMessages(
          mergeMessages(state.conversations[chatId]?.messages ?? [], response.messages),
        );
        const bounded = boundWindowAround(merged, MAX_ACTIVE_MESSAGES, merged.length - 1);
        batch(() => {
          setState(
            "conversations",
            chatId,
            "messages",
            reconcile(bounded.items, { key: "id" }),
          );
          setState("conversations", chatId, "hasOlder", response.hasOlder || bounded.droppedBefore);
          setState("conversations", chatId, "hasNewer", response.hasNewer || bounded.droppedAfter);
          setState("conversations", chatId, "firstUnreadMessageId", response.firstUnreadMessageId);
        });
      }
      void markChatRead(chatId);
      void loadAvatar(chatId);
      void loadHistoryCoverage(chatId);
    } catch (error) {
      if (isCurrentGeneration(chatId, generation)) {
        if (throwOnError) throw error;
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (isCurrentGeneration(chatId, generation)) setState("conversations", chatId, "loading", false);
    }
  }

  async function loadOlder(chatId = state.selectedChatId) {
    const current = state.conversations[chatId];
    const first = current?.messages[0];
    if (!current || !first || !current.hasOlder || current.loadingOlder) return;
    const generation = conversationGenerations.get(chatId);
    setState("conversations", chatId, "loadingOlder", true);
    try {
      const response = await bridge.listMessages(chatId, first.timestampMs, first.id, 50);
      if (!state.conversations[chatId] || conversationGenerations.get(chatId) !== generation) return;
      const merged = mergeMessages(response.messages, state.conversations[chatId]!.messages);
      const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
      batch(() => {
        setState("conversations", chatId, "messages", reconcile(trimMessages(merged, "newer"), { key: "id" }));
        setState("conversations", chatId, "hasOlder", response.hasMore);
        if (trimmed) setState("conversations", chatId, "hasNewer", true);
      });
    } catch (error) {
      if (conversationGenerations.get(chatId) === generation) {
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (state.conversations[chatId] && conversationGenerations.get(chatId) === generation) {
        setState("conversations", chatId, "loadingOlder", false);
      }
    }
  }

  async function loadHistoryCoverage(chatId = state.selectedChatId) {
    if (!chatId) return;
    try {
      const response = await bridge.getChatHistoryCoverage(chatId);
      const coverage = response.coverage;
      if (!coverage || !state.conversations[chatId]) return;
      const current = state.conversations[chatId]!.historyCoverage;
      if (!current || coverage.revision >= current.revision) {
        setState("conversations", chatId, "historyCoverage", coverage);
      }
    } catch {
      // Conversation loading remains useful even when coverage metadata fails.
    }
  }

  async function loadHistoryOverview() {
    try {
      const response = await bridge.getHistoryOverview();
      if (response.overview) setState("historyOverview", response.overview);
    } catch {
      // The per-chat surface remains authoritative if the overview is unavailable.
    }
  }

  async function loadIntegrityStatus() {
    setState("integrityChecking", true);
    try {
      const response = await bridge.getIntegrityStatus();
      setState("integrityStatus", response.status);
    } catch (error) {
      toast(`Could not check local storage: ${normalizeBridgeError(error).message}`);
    } finally {
      setState("integrityChecking", false);
    }
  }

  async function repairLocalCache() {
    setState("integrityChecking", true);
    try {
      const response = await bridge.repairLocalCache();
      setState("integrityStatus", response.status);
      const openChats = activeConversationIds(state.panes);
      const refreshed = await Promise.allSettled([
        loadAllChatsAuthoritative(),
        ...openChats.map((chatId) => loadConversation(chatId, "", true, true)),
      ]);
      const failed = refreshed.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
      toast("Local message cache checked and repaired", "info");
    } catch (error) {
      toast(`Could not repair local storage: ${normalizeBridgeError(error).message}`);
    } finally {
      setState("integrityChecking", false);
    }
  }

  async function requestOlderHistory(chatId = state.selectedChatId) {
    const conversation = state.conversations[chatId];
    if (!conversation || conversation.historyCoverage?.state === HistoryCoverageState.Requesting) return;
    try {
      const response = await bridge.requestOlderHistory(chatId);
      if (response.coverage && state.conversations[chatId]) {
        const current = state.conversations[chatId]!.historyCoverage;
        if (!current || response.coverage.revision >= current.revision) {
          setState("conversations", chatId, "historyCoverage", response.coverage);
        }
      }
    } catch (error) {
      toast(normalizeBridgeError(error).message);
      void loadHistoryCoverage(chatId);
    }
  }

  async function requestHistoryBatchAndWait(chatId: string): Promise<HistoryCoverage> {
    const snapshot = await bridge.getChatHistoryCoverage(chatId);
    const before = snapshot.coverage?.revision ?? 0;
    const completion = new Promise<HistoryCoverage>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        historyResultWaiters.delete(chatId);
        reject(new Error("Timed out waiting for WhatsApp history"));
      }, 35_000);
      historyResultWaiters.set(chatId, { afterRevision: before, resolve, reject, timer });
    });
    try {
      const response = await bridge.requestOlderHistory(chatId);
      if (response.coverage && state.conversations[chatId]) {
        const current = state.conversations[chatId]!.historyCoverage;
        if (!current || response.coverage.revision >= current.revision) {
          setState("conversations", chatId, "historyCoverage", response.coverage);
        }
      }
      return await completion;
    } catch (error) {
      const waiter = historyResultWaiters.get(chatId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        historyResultWaiters.delete(chatId);
      }
      throw error;
    }
  }

  async function syncChatHistory(chatId: string, nested = false): Promise<number> {
    let added = 0;
    if (!nested) {
      if (state.historySyncJob.running) return 0;
      cancelHistorySync = false;
      setState("historySyncJob", {
        running: true, scope: "chat", chatId, totalChats: 1,
        completedChats: 0, messagesAdded: 0, detail: "Preparing chat history sync",
      });
    }
    try {
      while (!cancelHistorySync) {
        const snapshot = await bridge.getChatHistoryCoverage(chatId);
        const coverage = snapshot.coverage;
        if (!coverage || coverage.state === HistoryCoverageState.Exhausted || coverage.state === HistoryCoverageState.NoAnchor) break;
        if (coverage.state === HistoryCoverageState.Stalled) break;
        setState("historySyncJob", "detail", `Requesting older messages for ${state.chats.find((chat) => chat.id === chatId)?.title || "chat"}`);
        const result = await requestHistoryBatchAndWait(chatId);
        added += result.lastAddedCount;
        setState("historySyncJob", "messagesAdded", (count) => count + result.lastAddedCount);
        if (result.state !== HistoryCoverageState.MoreAvailable) break;
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
      return added;
    } catch (error) {
      if (nested) throw error;
      toast(normalizeBridgeError(error).message);
      setState("historySyncJob", "detail", `History sync stopped: ${normalizeBridgeError(error).message}`);
      return added;
    } finally {
      if (!nested) {
        setState("historySyncJob", "completedChats", 1);
        setState("historySyncJob", "running", false);
        setState("historySyncJob", "detail", cancelHistorySync ? "History sync cancelled" : `History sync finished · ${added} messages added`);
        void loadHistoryOverview();
      }
    }
  }

  async function syncAllChatHistory() {
    if (state.historySyncJob.running) return;
    cancelHistorySync = false;
    setState("historySyncJob", {
      running: true, scope: "all", chatId: "", totalChats: 0,
      completedChats: 0, messagesAdded: 0, detail: "Loading complete chat list",
    });
    try {
      const chatIds: string[] = [];
      let cursor = "";
      do {
        const page = await bridge.listChats(cursor, 100);
        for (const chat of page.chats) if (!chatIds.includes(chat.id)) chatIds.push(chat.id);
        cursor = page.nextCursor;
      } while (cursor && !cancelHistorySync);
      setState("historySyncJob", "totalChats", chatIds.length);
      for (const chatId of chatIds) {
        if (cancelHistorySync) break;
        try {
          await syncChatHistory(chatId, true);
        } catch (error) {
          setState("historySyncJob", "detail", `Skipped one chat: ${normalizeBridgeError(error).message}`);
        }
        setState("historySyncJob", "completedChats", (count) => count + 1);
      }
    } finally {
      setState("historySyncJob", "running", false);
      setState(
        "historySyncJob",
        "detail",
        cancelHistorySync
          ? "History sync cancelled"
          : `All chats checked · ${state.historySyncJob.messagesAdded.toLocaleString()} messages added`,
      );
      void loadHistoryOverview();
    }
  }

  function stopHistorySync() {
    cancelHistorySync = true;
    setState("historySyncJob", "detail", "Stopping after the current request");
  }

  async function loadNewer(chatId = state.selectedChatId) {
    const current = state.conversations[chatId];
    const last = current?.messages.at(-1);
    if (!current || !last || !current.hasNewer || current.loadingNewer) return;
    const generation = conversationGenerations.get(chatId);
    setState("conversations", chatId, "loadingNewer", true);
    try {
      const response = await bridge.listMessagesAfter(chatId, last.timestampMs, last.id, 50);
      if (!state.conversations[chatId] || conversationGenerations.get(chatId) !== generation) return;
      const merged = mergeMessages(state.conversations[chatId]!.messages, response.messages);
      const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
      batch(() => {
        setState("conversations", chatId, "messages", reconcile(trimMessages(merged, "older"), { key: "id" }));
        setState("conversations", chatId, "hasNewer", response.hasMore);
        if (trimmed) setState("conversations", chatId, "hasOlder", true);
      });
    } catch (error) {
      if (conversationGenerations.get(chatId) === generation) {
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (state.conversations[chatId] && conversationGenerations.get(chatId) === generation) {
        setState("conversations", chatId, "loadingNewer", false);
      }
    }
  }

  async function jumpToLatest(chatId = state.selectedChatId) {
    if (!chatId) return;
    await loadConversation(chatId, "", false, true);
  }

  // ---------------------------------------------------------------------
  // Panes and tabs
  // ---------------------------------------------------------------------

  function syncSelectedChatId() {
    const pane = state.panes.find((candidate) => candidate.id === state.focusedPaneId);
    const selectedChatId = pane?.activeChatId ?? "";
    if (state.selectedChatId && state.selectedChatId !== selectedChatId) {
      participantAvatarQueue.cancelScope(state.selectedChatId);
    }
    if (state.selectedChatId !== selectedChatId) {
      chatInfoGeneration.invalidate();
      setState("chatInfoLoading", false);
      setState("chatInfoError", "");
    }
    setState("selectedChatId", selectedChatId);
  }

  function writePane(paneId: string, pane: Pane) {
    setState("panes", (candidate) => candidate.id === paneId, {
      tabChatIds: pane.tabChatIds,
      activeChatId: pane.activeChatId,
    });
  }

  function persistWorkspace() {
    writeWorkspaceSnapshot({
      panes: state.panes.map((pane) => ({ ...pane, tabChatIds: [...pane.tabChatIds] })),
      focusedPaneId: state.focusedPaneId,
    });
  }

  /**
   * Load a chat into a pane's active tab and focus that pane. Selecting a
   * chat already open somewhere in the pane just focuses it; otherwise it
   * replaces the active slot so sidebar clicks do not pile up tabs — use
   * `openInNewTab` to open deliberately alongside the current tab.
   */
  async function selectChat(chatId: string, aroundMessageId = "", paneId = state.focusedPaneId) {
    // Message windows are chat-scoped while scroll restoration is pane-scoped.
    // Focus an existing owner pane instead of duplicating a chat and letting an
    // exact pin/search target replace both panes' shared window.
    const ownerPane = paneContainingChat(state.panes, chatId);
    const targetPaneId = ownerPane?.id ?? paneId;
    const pane = state.panes.find((candidate) => candidate.id === targetPaneId);
    if (!chatId || !pane) return;
    const alreadyHydrated = Boolean(state.conversations[chatId]);
    stopTyping();
    batch(() => {
      writePane(targetPaneId, selectTab(pane, chatId));
      setState("focusedPaneId", targetPaneId);
      syncSelectedChatId();
      setState("chatInfoOpen", false);
      setState("chatInfo", null);
      setState("settingsOpen", false);
      setState("searchQuery", "");
      setState("searchResults", null);
    });
    ensureDraft(chatId);
    rememberRecentChat(chatId);
    recordSpotlightChatUse(chatId);
    touchConversationFocus(chatId);
    pruneConversations();
    persistWorkspace();
    if (aroundMessageId || !alreadyHydrated) {
      await loadConversation(chatId, aroundMessageId);
    } else {
      // Open tabs receive live upserts even while inactive. Reuse that bounded
      // window instead of flashing a loading state and doing an avoidable RPC
      // every time the user cycles through tabs.
      void markChatRead(chatId);
      void loadAvatar(chatId);
    }
    void loadPinnedMessages(chatId);
  }

  async function loadPinnedMessages(chatId: string, throwOnError = false) {
    try {
      const response = await bridge.listPinnedMessages(chatId);
      setState("pinnedMessages", chatId, response.pins);
    } catch (error) {
      if (throwOnError) throw error;
      toast(normalizeBridgeError(error).message);
    }
  }

  /** Close the focused pane's active tab, if any — a convenience over `closeTab`. */
  function closeChat(paneId = state.focusedPaneId) {
    const pane = state.panes.find((candidate) => candidate.id === paneId);
    if (pane?.activeChatId) closeTab(pane.activeChatId, paneId);
  }

  async function openInNewTab(chatId: string, paneId = state.focusedPaneId) {
    const ownerPane = paneContainingChat(state.panes, chatId);
    const targetPaneId = ownerPane?.id ?? paneId;
    const pane = state.panes.find((candidate) => candidate.id === targetPaneId);
    if (!chatId || !pane) return;
    const alreadyHydrated = Boolean(state.conversations[chatId]);
    batch(() => {
      writePane(targetPaneId, openTab(pane, chatId));
      setState("focusedPaneId", targetPaneId);
      syncSelectedChatId();
    });
    ensureDraft(chatId);
    rememberRecentChat(chatId);
    recordSpotlightChatUse(chatId);
    touchConversationFocus(chatId);
    pruneConversations();
    persistWorkspace();
    if (!alreadyHydrated) await loadConversation(chatId);
  }

  function closeTab(chatId: string, paneId = state.focusedPaneId) {
    const result = closeTabInWorkspace(state.panes, chatId, paneId);
    batch(() => {
      setState("panes", reconcile(result.panes, { key: "id" }));
      if (result.removedPaneId && state.focusedPaneId === result.removedPaneId) {
        setState("focusedPaneId", state.panes[0]?.id ?? "");
      }
      syncSelectedChatId();
    });
    if (typingChatId === chatId) stopTyping();
    pruneConversations();
    persistWorkspace();
  }

  function moveTab(chatId: string, fromPaneId: string, toPaneId: string, index: number) {
    const fromPane = state.panes.find((candidate) => candidate.id === fromPaneId);
    const toPane = state.panes.find((candidate) => candidate.id === toPaneId);
    if (!fromPane || !toPane || !fromPane.tabChatIds.includes(chatId)) return;
    const moved = moveTabBetweenPanes(state.panes, chatId, fromPaneId, toPaneId, index);
    batch(() => {
      setState("panes", reconcile(moved, { key: "id" }));
      setState("focusedPaneId", toPaneId);
      syncSelectedChatId();
    });
    touchConversationFocus(chatId);
    pruneConversations();
    persistWorkspace();
  }

  function announceTabAction(message: string) {
    setState("tabAnnouncement", "");
    queueMicrotask(() => setState("tabAnnouncement", message));
  }

  function focusPane(paneId: string) {
    if (state.focusedPaneId === paneId || !state.panes.some((pane) => pane.id === paneId)) return;
    setState("focusedPaneId", paneId);
    syncSelectedChatId();
    const active = state.panes.find((pane) => pane.id === paneId)?.activeChatId;
    if (active) touchConversationFocus(active);
    persistWorkspace();
  }

  /** Create the second pane, or simply focus it when the workspace is already split. */
  function splitPane() {
    if (state.panes.length >= 2) {
      const other = state.panes.find((pane) => pane.id !== state.focusedPaneId);
      if (other) focusPane(other.id);
      return;
    }
    const newPaneId = state.panes.some((pane) => pane.id === "pane-1") ? "pane-2" : "pane-1";
    batch(() => {
      setState("panes", (panes) => [...panes, emptyPane(newPaneId)]);
      setState("focusedPaneId", newPaneId);
      syncSelectedChatId();
    });
    persistWorkspace();
  }

  /** The workspace always keeps at least one pane; closing the only pane is a no-op. */
  function closePane(paneId: string) {
    if (state.panes.length <= 1 || !state.panes.some((pane) => pane.id === paneId)) return;
    const remaining = state.panes.filter((pane) => pane.id !== paneId);
    batch(() => {
      setState("panes", remaining);
      if (state.focusedPaneId === paneId) setState("focusedPaneId", remaining[0]!.id);
      syncSelectedChatId();
    });
    pruneConversations();
    persistWorkspace();
  }

  // ---------------------------------------------------------------------
  // Chat switcher (Ctrl+Tab, goal G4)
  // ---------------------------------------------------------------------

  function openSwitcher(reverse: boolean) {
    const candidates = recentChatCandidates(
      readRecentChats(),
      (chatId) => state.chats.some((chat) => chat.id === chatId),
      state.chats.map((chat) => chat.id),
      state.selectedChatId,
    );
    const selectedIsFirst = Boolean(state.selectedChatId) && candidates[0] === state.selectedChatId;
    const switcher = buildSwitcher(candidates, reverse, selectedIsFirst);
    if (!switcher) return;
    batch(() => {
      setState("chatInfoOpen", false);
      setState("chatInfo", null);
      setState("settingsOpen", false);
      setState("imageViewer", null);
      setState("switcher", switcher);
    });
  }

  function cycleSwitcher(reverse: boolean) {
    if (!state.switcher) return;
    setState("switcher", cycleSwitcherHighlight(state.switcher, reverse));
  }

  function commitSwitcher() {
    const switcher = state.switcher;
    setState("switcher", null);
    const chatId = switcher?.chatIds[switcher.highlighted];
    if (chatId) void selectChat(chatId);
  }

  function cancelSwitcher() {
    setState("switcher", null);
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  function updateSearch(query: string) {
    setState("searchQuery", query);
    setState("searchError", "");
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    const generation = ++searchGeneration;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      batch(() => {
        setState("searchResults", null);
        setState("searchLoading", false);
      });
      return;
    }
    setState("searchLoading", true);
    searchTimer = window.setTimeout(async () => {
      try {
        const results = await bridge.searchLocal(trimmed);
        if (generation !== searchGeneration) return;
        setState("searchResults", results);
      } catch (error) {
        if (generation !== searchGeneration) return;
        setState("searchError", normalizeBridgeError(error).message);
      } finally {
        if (generation === searchGeneration) setState("searchLoading", false);
      }
    }, 150);
  }

  function clearSearch() {
    searchGeneration += 1;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    batch(() => {
      setState("searchQuery", "");
      setState("searchResults", null);
      setState("searchLoading", false);
      setState("searchError", "");
    });
  }

  async function openContact(result: ContactSearchResult) {
    if (result.chatId) {
      await selectChat(result.chatId);
      return;
    }
    try {
      const response = await bridge.openContact(result.contactJid);
      if (!response.chat) throw new Error("The contact did not produce a chat");
      upsertChat(response.chat);
      await selectChat(response.chat.id);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function openMessageResult(result: MessageSearchResult) {
    if (result.chat) upsertChat(result.chat);
    setState("chatFilter", result.archived ? "archived" : "all");
    await selectChat(result.chatId, result.messageId);
  }

  // ---------------------------------------------------------------------
  // Composer / drafts
  // ---------------------------------------------------------------------

  function setDraftText(text: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    ensureDraft(chatId);
    setState("drafts", chatId, "text", text);
    scheduleTyping(chatId, text.trim().length > 0);
  }

  function replyTo(messageId: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
    ensureDraft(chatId);
    batch(() => {
      setState("drafts", chatId, "replyToMessageId", messageId);
      setState("drafts", chatId, "replyToChatId", chatId);
      setState("drafts", chatId, "replyPreviewText", message ? messageText(message) : "");
      setState("drafts", chatId, "replySenderName", message?.fromMe ? "You" : message?.senderName || "");
    });
  }

  function cancelReply(chatId = state.selectedChatId) {
    if (chatId && state.drafts[chatId]) {
      batch(() => {
        setState("drafts", chatId, "replyToMessageId", "");
        setState("drafts", chatId, "replyToChatId", "");
        setState("drafts", chatId, "replyPreviewText", "");
        setState("drafts", chatId, "replySenderName", "");
      });
    }
  }

  async function replyPrivately(message: Message, sourceChatId = message.chatId) {
    const sourceChat = state.chats.find((chat) => chat.id === sourceChatId);
    if (
      sourceChat?.kind !== ChatKind.Group ||
      message.fromMe ||
      message.revoked ||
      !message.senderId
    ) return;
    try {
      const response = await bridge.openContact(message.senderId);
      if (!response.chat) throw new Error("The sender did not produce a direct chat");
      const target = {
        ...response.chat,
        title: message.senderName || response.chat.title || message.senderPhoneNumber,
      };
      upsertChat(target);
      ensureDraft(target.id);
      batch(() => {
        setState("drafts", target.id, "replyToMessageId", message.id);
        setState("drafts", target.id, "replyToChatId", sourceChatId);
        setState("drafts", target.id, "replyPreviewText", messageText(message));
        setState("drafts", target.id, "replySenderName", message.senderName || message.senderPhoneNumber);
        setState("drafts", target.id, "editingMessageId", "");
        setState("drafts", target.id, "mentions", []);
      });
      await selectChat(target.id);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  function editMessage(messageId: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
    if (!message?.fromMe || message.revoked || !message.content || !("text" in message.content)) return;
    const text = message.content.text.text;
    ensureDraft(chatId);
    batch(() => {
      setState("drafts", chatId, "text", text);
      setState("drafts", chatId, "replyToMessageId", "");
      setState("drafts", chatId, "replyToChatId", "");
      setState("drafts", chatId, "replyPreviewText", "");
      setState("drafts", chatId, "replySenderName", "");
      setState("drafts", chatId, "editingMessageId", messageId);
      setState("drafts", chatId, "mentions", []);
    });
  }

  function cancelEdit(chatId = state.selectedChatId) {
    if (!chatId || !state.drafts[chatId]) return;
    setState("drafts", chatId, emptyDraft());
    scheduleTyping(chatId, false);
  }

  async function deleteMessage(messageId: string, deleteForEveryone: boolean, chatId = state.selectedChatId) {
    if (!chatId) return;
    const messages = state.conversations[chatId]?.messages;
    const index = messages?.findIndex((candidate) => candidate.id === messageId) ?? -1;
    const message = index >= 0 ? messages?.[index] : undefined;
    if (!message) return;
    if (deleteForEveryone && !message.fromMe) {
      toast("Only your own messages can be deleted for everyone");
      return;
    }
    const previous = message;
    updateMessage(chatId, messageId, (current) => ({ ...current, revoked: true, content: null }));
    try {
      const response = await bridge.deleteMessage(chatId, messageId, deleteForEveryone);
      if (response.message) upsertMessage(response.message, false);
    } catch (error) {
      updateMessage(chatId, messageId, () => previous);
      toast(normalizeBridgeError(error).message);
    }
  }

  function toggleMessageSelection(messageId: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    const current = state.selection;
    if (current && current.chatId !== chatId) {
      setState("selection", { chatId, messageIds: [messageId] });
      return;
    }
    const selected = current?.messageIds.includes(messageId) ?? false;
    if (selected) {
      const remaining = current!.messageIds.filter((id) => id !== messageId);
      setState("selection", remaining.length > 0 ? { chatId, messageIds: remaining } : null);
    } else {
      setState("selection", { chatId, messageIds: [...(current?.messageIds ?? []), messageId] });
    }
  }

  function enterMessageSelection(chatId: string) {
    if (state.selection) return;
    setState("selection", { chatId, messageIds: [] });
  }

  function clearMessageSelection() {
    setState("selection", null);
  }

  async function loadStatuses() {
    try {
      const response = await bridge.listStatuses();
      batch(() => {
        setState("statuses", response.groups);
        setState("statusesChatId", response.chatId);
      });
    } catch (error) {
      // Statuses are best-effort; the strip simply stays empty on failure.
      console.error("Could not load statuses", error);
    }
  }

  function markStatusesRead() {
    if (state.statusesChatId) void markChatRead(state.statusesChatId);
    // Keep the rings visible so statuses stay reachable; the viewer just
    // acknowledges them on the backend.
  }

  function publishStatus(path: string, mode: FileSendMode, attachmentKind: AttachmentKind, voiceNote = false) {
    if (!state.statusesChatId || !path) return;
    // The picked file belongs to the user: it is staged by the core and the
    // staged copy is discarded after the send. The original is never touched.
    void requestFileSend([path], mode, attachmentKind, voiceNote, state.statusesChatId);
  }

  async function loadNewsletters() {
    try {
      const response = await bridge.listNewsletters();
      setState("newsletters", response.newsletters);
      const selected = state.selectedNewsletter;
      if (selected) {
        const refreshed = response.newsletters.find((item) => item.jid === selected.jid);
        setState("selectedNewsletter", refreshed ?? null);
      }
    } catch {
      // Best-effort; the channels tab simply stays empty on failure.
    }
  }

  async function selectNewsletter(jid: string) {
    const newsletter = state.newsletters.find((item) => item.jid === jid);
    if (!newsletter) return;
    setState("selectedNewsletter", newsletter);
    setState("newsletterPosts", []);
    setState("newsletterLoading", true);
    try {
      const response = await bridge.listNewsletterMessages(jid, 25);
      setState("newsletterPosts", response.messages);
    } catch (error) {
      notifyError(error);
    } finally {
      setState("newsletterLoading", false);
    }
  }

  function closeNewsletter() {
    setState("selectedNewsletter", null);
    setState("newsletterPosts", []);
  }

  async function subscribeNewsletter(inviteKey: string) {
    if (!inviteKey.trim()) return;
    try {
      const response = await bridge.subscribeNewsletter(inviteKey.trim());
      if (!response.newsletter) return;
      setState("newsletters", (items) => [...items.filter((item) => item.jid !== response.newsletter!.jid), response.newsletter!]);
      await selectNewsletter(response.newsletter.jid);
    } catch (error) {
      notifyError(error);
    }
  }

  async function unsubscribeNewsletter(jid: string) {
    try {
      await bridge.unsubscribeNewsletter(jid);
      setState("newsletters", (items) => items.filter((item) => item.jid !== jid));
      if (state.selectedNewsletter?.jid === jid) closeNewsletter();
    } catch (error) {
      notifyError(error);
    }
  }

  async function setChatPinned(chatId: string, pinned: boolean) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return;
    const previous = chat.pinned;
    const optimistic = reconcile(
      sortChats(state.chats.map((item) => (item.id === chatId ? { ...item, pinned } : item))),
      { key: "id" },
    );
    setState("chats", optimistic);
    try {
      const response = await bridge.setChatPin(chatId, pinned);
      if (response.chat) upsertChat(response.chat);
    } catch (error) {
      const rollback = reconcile(
        sortChats(state.chats.map((item) => (item.id === chatId ? { ...item, pinned: previous } : item))),
        { key: "id" },
      );
      setState("chats", rollback);
      notifyError(error);
    }
  }

  /** Optimistic archive flag with rollback on failure (same pattern as setChatPinned). */
  async function setChatArchived(chatId: string, archived: boolean) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return;
    const previous = chat.archived;
    setState("chats", (candidate) => candidate.id === chatId, "archived", archived);
    try {
      const response = archived ? await bridge.archiveChat(chatId) : await bridge.unarchiveChat(chatId);
      if (response.chat) upsertChat(response.chat);
    } catch (error) {
      setState("chats", (candidate) => candidate.id === chatId, "archived", previous);
      notifyError(error);
    }
  }

  /** Optimistic mute flag with optional expiry and rollback on failure. Null means muted indefinitely. */
  async function setChatMuted(chatId: string, muted: boolean, durationMs: number | null = null) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return;
    const previousMuted = chat.muted;
    const previousMuteUntilMs = chat.muteUntilMs ?? 0;
    const muteUntilMs = muted
      ? typeof durationMs === "number" && durationMs > 0
        ? Date.now() + durationMs
        : MUTE_UNTIL_INDEFINITE
      : 0;
    batch(() => {
      setState("chats", (candidate) => candidate.id === chatId, "muted", muted);
      setState("chats", (candidate) => candidate.id === chatId, "muteUntilMs", muteUntilMs);
    });
    try {
      const response = muted ? await bridge.muteChat(chatId, durationMs) : await bridge.unmuteChat(chatId);
      if (response.chat) upsertChat(response.chat);
    } catch (error) {
      batch(() => {
        setState("chats", (candidate) => candidate.id === chatId, "muted", previousMuted);
        setState("chats", (candidate) => candidate.id === chatId, "muteUntilMs", previousMuteUntilMs);
      });
      notifyError(error);
    }
  }

  /** Optimistic block flag with rollback on failure (same pattern as setChatPinned). */
  async function setChatBlocked(chatId: string, blocked: boolean) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return;
    const previous = chat.blocked ?? false;
    setState("chats", (candidate) => candidate.id === chatId, "blocked", blocked);
    try {
      const response = blocked ? await bridge.blockChat(chatId) : await bridge.unblockChat(chatId);
      if (response.chat) upsertChat(response.chat);
    } catch (error) {
      setState("chats", (candidate) => candidate.id === chatId, "blocked", previous);
      notifyError(error);
    }
  }

  function toggleFavorite(chatId: string) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return;
    const next = !chat.favorite;
    setState("chats", (candidate) => candidate.id === chatId, "favorite", next);
    const favorites = readStringSet(FAVORITES_KEY);
    if (next) favorites.add(chatId);
    else favorites.delete(chatId);
    writeStringSet(FAVORITES_KEY, favorites);
  }

  function toggleStar(messageId: string) {
    if (typeof messageId !== "string" || messageId.trim().length === 0) return;
    const next = !state.starred[messageId];
    if (next) setState("starred", messageId, true);
    else setState("starred", messageId, undefined!);
    writeStringSet(STARRED_KEY, state.starred);
  }

  function isStarred(messageId: string): boolean {
    return Boolean(state.starred[messageId]);
  }

  /** Linked-device scope cannot change this server-side; keep it informational. */
  function setDisappearingTimer(chatId: string, seconds: number) {
    if (state.chatInfo?.chat?.id === chatId) {
      setState("chatInfo", "disappearingTimerSeconds", seconds);
    }
    toast("Disappearing timer is read-only on a linked device", "info");
  }

  /** Local-only group management: linked-device scope has no group RPC. */
  async function createGroup(name: string, participantChatIds: string[] = []) {
    const title = (name ?? "").trim() || "New group";
    const randomPart =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}`;
    const id = `chat-local-group-${randomPart}`;
    const chat: Chat = {
      id,
      kind: ChatKind.Group,
      title,
      avatarPath: "",
      lastMessagePreview: "Group created locally",
      lastMessageTimestampMs: Date.now(),
      unreadCount: 0,
      muted: false,
      pinned: false,
      archived: false,
      phoneNumber: "",
      contactName: "",
      pushName: "",
      businessName: "",
      lastMessageFromMe: false,
      transportJid: `${id}@g.us`,
    };
    void participantChatIds;
    setState("chats", reconcile(sortChats([...state.chats, chat]), { key: "id" }));
    setState("conversations", id, {
      chatId: id,
      messages: [],
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      hasOlder: false,
      hasNewer: false,
      firstUnreadMessageId: "",
      highlightedMessageId: "",
      liveMessageVersion: 0,
      historyCoverage: null,
    });
    toast("Group management is limited on a linked device: group created locally", "info");
    await selectChat(id);
  }

  async function leaveGroup(chatId: string) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return;
    setState("chats", (candidate) => candidate.id === chatId, "archived", true);
    toast("Group management is limited on a linked device: left locally (archived)", "info");
  }

  async function addParticipant(chatId: string, contactJid: string) {
    if (state.chatInfo?.chat?.id === chatId && contactJid.trim()) {
      const jid = contactJid.trim();
      const exists = state.chatInfo.participants.some((participant) => participant.participantId === jid);
      if (!exists) {
        setState("chatInfo", "participants", (participants) => [
          ...participants,
          {
            participantId: jid,
            displayName: jid.split("@")[0] ?? jid,
            phoneNumber: "",
            isAdmin: false,
            isSuperAdmin: false,
            isMe: false,
          },
        ]);
        setState("chatInfo", "participantCount", (count) => count + 1);
      }
    }
    toast("Group management is limited on a linked device: participant added locally", "info");
  }

  /** Text status kept in memory; reuses the existing viewer + markStatusesRead. */
  function publishTextStatus(text: string, backgroundColor: string) {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      toast("Status text cannot be empty");
      return;
    }
    const MAX_STATUS_LENGTH = 700;
    const capped = trimmed.length > MAX_STATUS_LENGTH ? trimmed.slice(0, MAX_STATUS_LENGTH) : trimmed;
    if (capped.length < trimmed.length) {
      toast("Status text truncated to 700 characters", "info");
    }
    const id = `local-status-${Date.now()}`;
    const message: Message = {
      id,
      chatId: state.statusesChatId || "status@broadcast",
      senderId: state.ownUserId || "me@s.whatsapp.net",
      senderName: "You",
      fromMe: true,
      timestampMs: Date.now(),
      status: 2,
      edited: false,
      revoked: false,
      expiresAtMs: 0,
      senderPhoneNumber: "",
      senderAvatarPath: "",
      reactions: [],
      replyToMessageId: "",
      replyToChatId: "",
      forwardingScore: 0,
      mentionTexts: [],
      content: { text: { text: capped, linkPreview: null } },
    };
    setState("statusColors", id, backgroundColor);
    const ownIndex = state.statuses.findIndex((group) => group.senderId === message.senderId);
    if (ownIndex >= 0) {
      setState("statuses", ownIndex, "messages", (messages) => [...messages, message]);
    } else {
      setState("statuses", (groups) => [
        {
          senderId: message.senderId,
          senderName: "You",
          senderPhoneNumber: "",
          messages: [message],
        },
        ...groups,
      ]);
    }
    toast("Text status published locally", "info");
  }

  /** Local-only channel creation for the browser mock (badge "local"). */
  function createLocalChannel(name: string, description = "") {
    const title = name.trim();
    if (!title) {
      toast("Channel name cannot be empty");
      return;
    }
    const jid = `local-${Date.now()}@newsletter`;
    const newsletter: Newsletter = {
      jid,
      name: title,
      subscribedAtMs: Date.now(),
      muted: false,
      local: true,
      description,
    };
    setState("newsletters", (items) => [...items, newsletter]);
    toast("Channel created locally (linked-device scope has no channel RPC)", "info");
  }

  function toggleNewsletterMute(jid: string) {
    const newsletter = state.newsletters.find((item) => item.jid === jid);
    if (!newsletter) return;
    setState("newsletters", (item) => item.jid === jid, "muted", !newsletter.muted);
  }

  function callsUnsupported() {
    toast("Calls not supported (WA-03/WA-04): whatsmeow has no VoIP; scope exception", "info");
  }

  async function deleteSelection(deleteForEveryone: boolean, chatId = state.selectedChatId) {
    const selection = state.selection;
    if (!selection || selection.chatId !== chatId || selection.messageIds.length === 0) return;
    const ids = [...selection.messageIds];
    const previous = new Map<string, Message>();
    for (const messageId of ids) {
      const messages = state.conversations[chatId]?.messages;
      const message = messages?.find((candidate) => candidate.id === messageId);
      if (!message) continue;
      if (deleteForEveryone && !message.fromMe) continue;
      previous.set(messageId, message);
      updateMessage(chatId, messageId, (current) => ({ ...current, revoked: true, content: null }));
    }
    setState("selection", null);
    const failures: string[] = [];
    for (const messageId of ids) {
      try {
        const response = await bridge.deleteMessage(chatId, messageId, deleteForEveryone);
        if (response.message) upsertMessage(response.message, false);
      } catch (error) {
        const rollback = previous.get(messageId);
        if (rollback) updateMessage(chatId, messageId, () => rollback);
        failures.push(normalizeBridgeError(error).message);
      }
    }
    if (failures.length > 0) toast(`Some messages could not be deleted: ${failures[0]}`);
  }

  function startForward(messageId: string, sourceChatId = state.selectedChatId) {
    if (!sourceChatId) return;
    setState("forwardDialog", { sourceChatId, messageId });
  }

  function cancelForward() {
    setState("forwardDialog", null);
  }

  async function forwardMessage(targetChatIds: string[]) {
    const source = state.forwardDialog;
    const targets = [...new Set(targetChatIds.filter(Boolean))];
    if (!source || targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((targetChatId) =>
        bridge.forwardMessage(source.sourceChatId, source.messageId, targetChatId),
      ),
    );
    let forwarded = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        forwarded++;
        if (result.value.message) upsertMessage(result.value.message, true);
      }
    }
    if (forwarded > 0) {
      setState("forwardDialog", null);
      toast(`Forwarded to ${forwarded} ${forwarded === 1 ? "chat" : "chats"}`, "info");
    }
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) toast(normalizeBridgeError(failed.reason).message);
  }

  function addMention(
    participant: ChatParticipant,
    tokenStart: number,
    tokenEnd: number,
    chatId = state.selectedChatId,
  ) {
    const draft = state.drafts[chatId];
    if (!chatId || !draft) return;
    const displayName = participant.displayName || participant.phoneNumber;
    const next = `${draft.text.slice(0, tokenStart)}@${displayName} ${draft.text.slice(tokenEnd)}`;
    batch(() => {
      setState("drafts", chatId, "text", next);
      setState("drafts", chatId, "mentions", (mentions) => [
        ...mentions.filter((mention) => mention.jid !== participant.participantId),
        { displayName, jid: participant.participantId },
      ]);
    });
  }

  async function sendCurrentText(chatId = state.selectedChatId) {
    const draft = state.drafts[chatId];
    if (!chatId || !draft || state.sending) return;
    const text = draft.text.trim();
    if (!text) return;
    if (new TextEncoder().encode(text).length > 65_536) {
      toast("Messages can be at most 65,536 bytes");
      return;
    }
    const previous = cloneDraft(draft);
    const editingMessageId = previous.editingMessageId;
    const encoded = encodeMentions(text, previous.mentions);
    batch(() => {
      setState("sending", true);
      setState("drafts", chatId, emptyDraft());
    });
    scheduleTyping(chatId, false);
    try {
      const response = editingMessageId
        ? await bridge.editMessage(chatId, editingMessageId, text)
        : await bridge.sendText(
            chatId,
            encoded.text,
            previous.replyToMessageId,
            encoded.jids,
            previous.replyToChatId,
          );
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      if (draftIsEmpty(state.drafts[chatId])) setState("drafts", chatId, previous);
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("sending", false);
    }
  }

  async function createPoll(question: string, options: string[], selectableOptionsCount: number, chatId = state.selectedChatId) {
    if (!chatId) return;
    try {
      const response = await bridge.createPoll(chatId, question, options, selectableOptionsCount);
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function votePoll(message: Message, selectedOptions: string[], chatId = message.chatId) {
    if (!message.content || !("poll" in message.content)) return;
    const key = mediaKey(chatId, message.id);
    const generation = (pollVoteGenerations.get(key) ?? 0) + 1;
    pollVoteGenerations.set(key, generation);
    const stateKey = `${chatId}:${message.id}`;
    const previous = clonePollContent(message.content.poll);
    const optimistic = optimisticPollVote(previous, selectedOptions);
    setState("conversations", chatId, "messages", (candidate) => candidate.id === message.id, "content", { poll: optimistic });
    setState("pendingPollVotes", stateKey, true);
    const isCurrent = () => pollVoteGenerations.get(key) === generation;
    try {
      const response = await bridge.votePoll(chatId, message.id, selectedOptions);
      if (isCurrent() && response.message) {
        setState("pendingPollVotes", stateKey, undefined!);
        upsertMessage(response.message, true);
      }
    } catch (error) {
      if (isCurrent()) {
        setState("conversations", chatId, "messages", (candidate) => candidate.id === message.id, "content", { poll: previous });
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (isCurrent()) setState("pendingPollVotes", stateKey, undefined!);
    }
  }

  async function setMessagePin(messageId: string, pinned: boolean, chatId = state.selectedChatId) {
    if (!chatId) return;
    const key = mediaKey(chatId, messageId);
    const generation = (pinGenerations.get(key) ?? 0) + 1;
    pinGenerations.set(key, generation);
    try {
      await bridge.setMessagePin(chatId, messageId, pinned);
      if (pinGenerations.get(key) === generation) await loadPinnedMessages(chatId);
    } catch (error) {
      if (pinGenerations.get(key) === generation) toast(normalizeBridgeError(error).message);
    }
  }

  async function sendImage(path: string, chatId = state.selectedChatId) {
    await enqueueFileSend(chatId, path, "image");
  }

  async function sendSticker(path: string, chatId = state.selectedChatId) {
    await enqueueFileSend(chatId, path, "sticker");
  }

  async function sendAttachment(
    path: string,
    kind: AttachmentKind,
    voiceNote = false,
    chatId = state.selectedChatId,
  ) {
    await enqueueFileSend(chatId, path, "attachment", kind, voiceNote);
  }

  /**
   * Prepare a batch of files for sending.
   *
   * Unless the caller already staged the file (the clipboard paste and the
   * recorded voice note live in their own caches), every picked file is
   * handed to the desktop core first, which inspects it and copies it into
   * the profile staging area. The backend only ever reads staged files.
   */
  async function requestFileSend(
    paths: string[],
    mode: FileSendMode,
    attachmentKind: AttachmentKind = AttachmentKind.Document,
    voiceNote = false,
    chatId = state.selectedChatId,
    temporaryPaths: string[] = [],
    alreadyStaged = false,
  ): Promise<boolean> {
    const selectedPaths = paths.filter(Boolean);
    if (!chatId || selectedPaths.length === 0 || state.sending || state.fileSendConfirmation) return false;
    let stagedPaths = selectedPaths;
    if (!alreadyStaged) {
      const kind = mode === "image" ? "image" : mode === "sticker" ? "sticker" : "attachment";
      try {
        const staged: StagedMedia[] = [];
        for (const path of selectedPaths) {
          staged.push(await stageOutgoingMedia(path, kind));
        }
        stagedPaths = staged.map((media) => media.path);
      } catch (error) {
        notifyError(error);
        return false;
      }
    }
    setState("fileSendConfirmation", {
      chatId,
      paths: stagedPaths,
      mode,
      attachmentKind,
      voiceNote,
      temporaryPaths: temporaryPaths.filter((path) => selectedPaths.includes(path)),
    });
    return true;
  }

  function cancelFileSend() {
    const request = state.fileSendConfirmation;
    const temporaryPaths = [...(request?.temporaryPaths ?? [])];
    setState("fileSendConfirmation", null);
    discardTemporaryFiles(temporaryPaths);
    discardTemporaryFiles(request?.paths ?? []);
  }

  async function confirmFileSend() {
    const request = state.fileSendConfirmation;
    if (!request) return;
    setState("fileSendConfirmation", null);
    await enqueueFileBatch(request);
  }

  function enqueueFileSend(
    chatId: string,
    path: string,
    mode: FileSendMode,
    attachmentKind: AttachmentKind = AttachmentKind.Document,
    voiceNote = false,
  ): Promise<void> {
    return enqueueFileBatch({
      chatId,
      paths: [path],
      mode,
      attachmentKind,
      voiceNote,
    });
  }

  function enqueueFileBatch(request: FileSendConfirmationState): Promise<void> {
    const operation = fileSendQueue.then(async () => {
      while (state.sending) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      await sendFileBatch(request);
    });
    fileSendQueue = operation.catch(() => undefined);
    return operation;
  }

  async function sendFileBatch(request: FileSendConfirmationState) {
    const { chatId, paths, mode, attachmentKind, voiceNote, temporaryPaths = [] } = request;
    const draft = state.drafts[chatId] ?? emptyDraft();
    if (!chatId || paths.length === 0 || state.sending) return;
    const previous = cloneDraft(draft);
    const supportsCaption =
      mode === "image" ||
      (mode === "attachment" && attachmentKind !== AttachmentKind.Audio);
    const retainedDraft = supportsCaption
      ? emptyDraft()
      : {
          ...cloneDraft(previous),
          replyToMessageId: "",
          replyToChatId: "",
          replyPreviewText: "",
          replySenderName: "",
        };
    batch(() => {
      setState("sending", true);
      setState("drafts", chatId, retainedDraft);
    });
    scheduleTyping(chatId, false);
    const failures: Array<{ path: string; error: unknown }> = [];
    let sent = 0;
    try {
      for (let index = 0; index < paths.length; index++) {
        const path = paths[index]!;
        // WhatsApp sends each selected file as its own message. Apply the
        // current caption/reply only to the first one, matching album-style
        // multi-file sending without duplicating the caption on every item.
        const context = index === 0 ? previous : emptyDraft();
        try {
          const response =
            mode === "image"
              ? await bridge.sendImage(chatId, path, context.text.trim(), context.replyToMessageId, context.replyToChatId)
              : mode === "sticker"
                ? await bridge.sendSticker(chatId, path, context.replyToMessageId, context.replyToChatId)
                : await bridge.sendAttachment(
                    chatId,
                    path,
                    attachmentKind,
                    attachmentKind === AttachmentKind.Audio ? "" : context.text.trim(),
                    context.replyToMessageId,
                    voiceNote,
                    context.replyToChatId,
                  );
          if (response.message) upsertMessage(response.message, true);
          sent++;
        } catch (error) {
          failures.push({ path, error });
        }
      }
      if (failures.length === 0 && paths.length > 1) {
        toast(`Sent ${sent} files`, "info");
      } else if (failures.length > 0) {
        const currentDraft = state.drafts[chatId];
        const draftWasUntouched =
          supportsCaption
            ? draftIsEmpty(currentDraft)
            : currentDraft?.text === retainedDraft.text &&
              currentDraft?.editingMessageId === retainedDraft.editingMessageId &&
              currentDraft?.replyToMessageId === retainedDraft.replyToMessageId;
        if (failures[0]?.path === paths[0] && draftWasUntouched) {
          setState("drafts", chatId, previous);
        }
        const firstError = normalizeBridgeError(failures[0]!.error).message;
        toast(
          paths.length === 1
            ? firstError
            : `Sent ${sent} of ${paths.length} files. ${failures.length} failed: ${firstError}`,
        );
      }
    } finally {
      setState("sending", false);
      discardTemporaryFiles([...new Set([...temporaryPaths, ...paths])]);
    }
  }

  function discardTemporaryFiles(paths: string[]) {
    for (const path of paths) {
      void discardStagedImage(path).catch((error) => {
        console.warn("Could not remove temporary attachment", error);
      });
    }
  }

  // ---------------------------------------------------------------------
  // Media hydration
  // ---------------------------------------------------------------------

  async function hydrateImage(
    message: Message,
    retry = false,
    requireFull = false,
    chatId = message.chatId,
  ) {
    if (!(message.content && "image" in message.content)) return;
    const image = message.content.image;
    if (image.localPath) return image.localPath;
    if (image.thumbnailPath && !requireFull) return image.thumbnailPath;
    if (!image.downloadable) return image.thumbnailPath || undefined;
    const key = mediaKey(chatId, message.id);
    if (pendingImages.has(key) || pendingImages.size >= 4) return;
    if (state.imageFailures[key] && !retry) return;
    pendingImages.add(key);
    if (retry) {
      failedImageKeys.delete(key);
      setState("imageFailures", key, undefined!);
    }
    try {
      const response = await bridge.getMessageImage(chatId, message.id);
      updateMessage(chatId, message.id, (current) => {
        if (!(current.content && "image" in current.content)) return current;
        return {
          ...current,
          content: {
            image: {
              ...current.content.image,
              localPath: response.imagePath,
              thumbnailPath: response.thumbnailPath,
            },
          },
        };
      });
      return response.imagePath || response.thumbnailPath || undefined;
    } catch (error) {
      const evicted = failedImageKeys.add(key);
      batch(() => {
        if (evicted) setState("imageFailures", evicted, undefined!);
        setState("imageFailures", key, normalizeBridgeError(error).message);
      });
    } finally {
      pendingImages.delete(key);
    }
  }

  async function hydrateAttachment(message: Message, retry = false, chatId = message.chatId) {
    if (!(message.content && "attachment" in message.content)) return;
    const attachment = message.content.attachment;
    if (attachment.localPath) return attachment.localPath;
    if (!attachment.downloadable) return;
    const key = mediaKey(chatId, message.id);
    if (pendingAttachments.has(key) || pendingAttachments.size >= 3) return;
    if (state.attachmentFailures[key] && !retry) return;
    pendingAttachments.add(key);
    if (retry) {
      failedAttachmentKeys.delete(key);
      setState("attachmentFailures", key, undefined!);
    }
    try {
      const response = await bridge.getMessageAttachment(chatId, message.id);
      updateMessage(chatId, message.id, (current) => {
        if (!(current.content && "attachment" in current.content)) return current;
        return {
          ...current,
          content: {
            attachment: { ...current.content.attachment, localPath: response.localPath },
          },
        };
      });
      return response.localPath || undefined;
    } catch (error) {
      const evicted = failedAttachmentKeys.add(key);
      batch(() => {
        if (evicted) setState("attachmentFailures", evicted, undefined!);
        setState("attachmentFailures", key, normalizeBridgeError(error).message);
      });
    } finally {
      pendingAttachments.delete(key);
    }
  }

  /**
   * Open a downloaded document in the platform default application. A stale
   * cache path is cleared and fetched once more before surfacing the failure;
   * this covers users cleaning the cache between history load and click.
   */
  async function openAttachment(message: Message, chatId = message.chatId) {
    if (!(message.content && "attachment" in message.content)) return;
    const originalAttachment = message.content.attachment;
    let current = message;
    let path: string | undefined = originalAttachment.localPath || undefined;
    if (path) {
      try {
        await bridge.openMediaPath(path);
        return;
      } catch {
        updateMessage(chatId, message.id, (stored) => {
          if (!(stored.content && "attachment" in stored.content)) return stored;
          return {
            ...stored,
            content: { attachment: { ...stored.content.attachment, localPath: "" } },
          };
        });
        current = {
          ...message,
          content: {
            attachment: { ...originalAttachment, localPath: "" },
          },
        };
      }
    }
    path = await hydrateAttachment(current, true, chatId);
    if (!path) {
      const failure = state.attachmentFailures[mediaKey(chatId, message.id)];
      if (failure) toast(failure);
      return;
    }
    try {
      await bridge.openMediaPath(path);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  const chatAvatarQueue: string[] = [];
  const MAX_CONCURRENT_CHAT_AVATARS = 4;

  function processChatAvatarQueue() {
    while (pendingAvatars.size < MAX_CONCURRENT_CHAT_AVATARS && chatAvatarQueue.length > 0) {
      const nextChatId = chatAvatarQueue.shift();
      if (!nextChatId) break;
      void fetchChatAvatar(nextChatId);
    }
  }

  async function fetchChatAvatar(chatId: string) {
    pendingAvatars.add(chatId);
    try {
      const response = await bridge.getChatAvatar(chatId);
      if (response.avatarPath) {
        setState("chats", (candidate) => candidate.id === chatId, "avatarPath", response.avatarPath);
      }
    } catch {
      // Avatar privacy/availability failures do not interrupt messaging.
    } finally {
      pendingAvatars.delete(chatId);
      processChatAvatarQueue();
    }
  }

  function loadAvatar(chatId: string) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat || chat.avatarPath || pendingAvatars.has(chatId) || attemptedAvatars.has(chatId)) return;
    attemptedAvatars.add(chatId);
    chatAvatarQueue.push(chatId);
    processChatAvatarQueue();
  }

  function loadParticipantAvatar(participantId: string, rosterId: string) {
    if (!participantId || !rosterId || state.participantAvatars[participantId]) return () => undefined;
    return participantAvatarQueue.subscribe(participantId, rosterId);
  }

  // ---------------------------------------------------------------------
  // Chat info / settings overlays (single instance over the pane group)
  // ---------------------------------------------------------------------

  async function showChatInfo() {
    const chatId = state.selectedChatId;
    if (!chatId) return;
    const generation = chatInfoGeneration.begin();
    batch(() => {
      setState("chatInfoOpen", true);
      setState("chatInfoLoading", true);
      setState("chatInfoError", "");
      setState("settingsOpen", false);
    });
    try {
      const info = await bridge.getChatInfo(chatId);
      if (state.selectedChatId !== chatId || !chatInfoGeneration.isCurrent(generation)) return;
      setState("chatInfo", info);
      if (info.chat) upsertChat(info.chat);
    } catch (error) {
      if (chatInfoGeneration.isCurrent(generation)) {
        setState("chatInfoError", normalizeBridgeError(error).message);
      }
    } finally {
      if (chatInfoGeneration.isCurrent(generation)) setState("chatInfoLoading", false);
    }
  }

  async function ensureMentionDirectory() {
    const chatId = state.selectedChatId;
    if (!chatId || state.chatInfo?.chat?.id === chatId || state.chatInfoLoading) return;
    const generation = chatInfoGeneration.begin();
    setState("chatInfoLoading", true);
    try {
      const info = await bridge.getChatInfo(chatId);
      if (state.selectedChatId === chatId && chatInfoGeneration.isCurrent(generation)) {
        setState("chatInfo", info);
      }
    } catch {
      // Mention suggestions are optional; the main chat-info panel exposes retry UI.
    } finally {
      if (chatInfoGeneration.isCurrent(generation)) setState("chatInfoLoading", false);
    }
  }

  function hideChatInfo() {
    setState("chatInfoOpen", false);
  }

  async function react(messageId: string, emoji: string, chatId = state.selectedChatId) {
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    try {
      const response = await bridge.sendReaction(message.chatId, message.id, emoji);
      if (response.reaction) applyReaction(response.reaction, response.removed);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  function openImage(path: string, caption: string, sticker: boolean) {
    setState("imageViewer", { path, caption, sticker });
  }

  function closeImage() {
    setState("imageViewer", null);
  }

  function setFilter(filter: ChatFilter) {
    setState("chatFilter", filter);
    if (filter !== "all") void loadRemainingChats();
  }

  async function loadRemainingChats() {
    // The wire cursor currently pages the unified chat list. Hydrate the rest
    // in the background so a local filter cannot claim to be empty merely
    // because all of its matches are beyond the first page.
    let previousCursor = "";
    for (let page = 0; page < 100 && state.nextChatCursor; page += 1) {
      // The virtualizer may already be fetching the next page when a filter is
      // selected. Wait for that owner instead of treating its temporary
      // loading guard as a repeated cursor and abandoning the full hydrate.
      while (state.loadingChats) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      const cursor = state.nextChatCursor;
      if (cursor === previousCursor) return;
      previousCursor = cursor;
      await loadChats(false);
    }
  }

  function toggleSettings(open = !state.settingsOpen) {
    batch(() => {
      setState("settingsOpen", open);
      if (open) setState("chatInfoOpen", false);
    });
  }

  // ---------------------------------------------------------------------
  // Stickers
  // ---------------------------------------------------------------------

  async function loadStickers() {
    setState("stickers", "loading", true);
    try {
      const response = await bridge.listStickers();
      batch(() => {
        setState("stickers", "packs", response.packs);
        setState("stickers", "error", "");
      });
    } catch (error) {
      setState("stickers", "error", normalizeBridgeError(error).message);
    } finally {
      setState("stickers", "loading", false);
    }
  }

  async function sendStickerFromPack(stickerId: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    try {
      const response = await bridge.sendStickerFromLibrary(chatId, stickerId);
      if (response.message) upsertMessage(response.message, true);
      else toast("Sticker library is not available in this build yet");
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  // ---------------------------------------------------------------------
  // Downloads (goal G7)
  // ---------------------------------------------------------------------

  /**
   * Copy one cached media file out to the user's save location. With no
   * configured directory the picker stands in, which is what the settings
   * panel means by "Ask every time".
   */
  async function saveMediaAs(sourcePath: string, suggestedName: string) {
    if (!sourcePath) {
      toast("That file has not been downloaded yet");
      return;
    }
    try {
      let destinationDir = preferences.downloadDir;
      if (!destinationDir) {
        const chosen = await openFile({
          directory: true,
          title: "Choose where to save this file",
        });
        if (!chosen) return;
        destinationDir = chosen;
      }
      const savedPath = await bridge.saveMediaAs(sourcePath, destinationDir, suggestedName);
      toast(`Saved to ${savedPath}`, "info");
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function revealMedia(sourcePath: string) {
    if (!sourcePath) {
      toast("That file has not been downloaded yet");
      return;
    }
    try {
      await revealMediaPath(sourcePath, preferences.linuxFileManagerApp);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function openExternalLink(url: string) {
    try {
      await openUrl(url, preferences.linuxBrowserApp);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function setNotificationsEnabled(enabled: boolean) {
    if (!enabled) {
      prefActions.update("notificationsEnabled", false);
      return;
    }
    try {
      if (await ensureNotificationPermission(true)) {
        prefActions.update("notificationsEnabled", true);
      } else {
        prefActions.update("notificationsEnabled", false);
        toast("Notifications were not enabled by the operating system");
      }
    } catch (error) {
      prefActions.update("notificationsEnabled", false);
      toast(`Could not enable notifications: ${normalizeBridgeError(error).message}`);
    }
  }

  function dispose() {
    disposed = true;
    cancelHistorySync = true;
    for (const waiter of historyResultWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new Error("Application disposed"));
    }
    historyResultWaiters.clear();
    disposeNotificationActions?.();
    disposeNotificationActions = undefined;
    if (statusRefreshTimer !== undefined) {
      window.clearInterval(statusRefreshTimer);
      statusRefreshTimer = undefined;
    }
    participantAvatarQueue.clear();
  }

  async function logout() {
    try {
      stopTyping();
      await bridge.logout();
      chatListGeneration.invalidate();
      chatInfoGeneration.invalidate();
      batch(() => {
        setState("logoutConfirmation", false);
        setState("screen", "pairing");
        setState("chats", []);
        setState("loadingChats", false);
        setState("conversations", {});
        setState("pinnedMessages", {});
        setState("pendingPollVotes", {});
        setState("panes", [emptyPane("pane-1")]);
        setState("focusedPaneId", "pane-1");
        setState("selectedChatId", "");
        setState("drafts", {});
        setState("participantAvatars", {});
        setState("imageFailures", {});
        setState("attachmentFailures", {});
      });
      conversationGenerations.clear();
      conversationLastFocusedAt.clear();
      attemptedAvatars.clear();
      participantAvatarQueue.clear();
      participantAvatarKeys.clear();
      pollVoteGenerations.clear();
      pinGenerations.clear();
      failedImageKeys.clear();
      failedAttachmentKeys.clear();
      persistWorkspace();
      await bridge.startPairing();
    } catch (error) {
      fatal(`Logout could not be completed safely: ${normalizeBridgeError(error).message}`);
    }
  }

  function handleEvent(event: FrontendEvent) {
    switch (event.type) {
      case "connectionChanged":
        batch(() => {
          setState("connection", event.payload.state);
          setState("connectionDetail", event.payload.detail);
          if (event.payload.state === ConnectionState.LoggedOut) {
            setState("screen", "pairing");
            setState("qrCode", "");
            setState("qrExpiresAtMs", 0);
          } else if (event.payload.state === ConnectionState.Connected) {
            setState("screen", "chats");
            setState("qrCode", "");
            setState("qrExpiresAtMs", 0);
          }
        });
        if (event.payload.state === ConnectionState.Connected) {
          void loadHistoryOverview();
          void loadStatuses();
          void loadChats(true).then(async () => {
            await restoreWorkspaceConversations();
            markBackendReady();
          });
        }
        break;
      case "pairingQr":
        batch(() => {
          setState("qrCode", event.payload.code);
          setState("qrExpiresAtMs", event.payload.expiresAtMs);
          setState("screen", "pairing");
        });
        break;
      case "syncProgress":
        if (state.syncStatus.revision === 0) {
          batch(() => {
            setState("syncChats", (value) => value + event.payload.chatsProcessed);
            setState("syncMessages", (value) => value + event.payload.messagesProcessed);
            setState("syncActive", !event.payload.complete);
          });
        }
        if (event.payload.complete) {
          if (syncRefreshTimer !== undefined) window.clearTimeout(syncRefreshTimer);
          syncRefreshTimer = undefined;
          void loadChats(true);
        } else if (syncRefreshTimer === undefined) {
          syncRefreshTimer = window.setTimeout(() => {
            syncRefreshTimer = undefined;
            void loadChats(true);
          }, 500);
        }
        break;
      case "syncStatusChanged":
        applySyncStatus(event.payload.status);
        if (event.payload.status?.phase === SyncPhase.Complete) {
          if (syncRefreshTimer !== undefined) window.clearTimeout(syncRefreshTimer);
          syncRefreshTimer = undefined;
          void loadChats(true);
        }
        break;
      case "historyCoverageChanged":
        if (event.payload.coverage) {
          const coverage = event.payload.coverage;
          const conversation = state.conversations[coverage.chatId];
          const current = conversation?.historyCoverage;
          if (conversation && (!current || coverage.revision >= current.revision)) {
            batch(() => {
              setState("conversations", coverage.chatId, "historyCoverage", coverage);
              if (coverage.lastAddedCount > 0) {
                setState("conversations", coverage.chatId, "hasOlder", true);
              }
            });
            if (coverage.lastAddedCount > 0) void loadOlder(coverage.chatId);
            void loadHistoryOverview();
          }
          const waiter = historyResultWaiters.get(coverage.chatId);
          if (
            waiter &&
            coverage.revision > waiter.afterRevision &&
            coverage.state !== HistoryCoverageState.Requesting
          ) {
            window.clearTimeout(waiter.timer);
            historyResultWaiters.delete(coverage.chatId);
            waiter.resolve(coverage);
          }
        }
        break;
      case "chatUpserted":
        if (event.payload.chat) {
          const chat = event.payload.chat;
          backendChatRevisions.set(chat.id, (backendChatRevisions.get(chat.id) ?? 0) + 1);
          upsertChat(chat);
          const pending = pendingNotifications.get(chat.id);
          if (pending) {
            pendingNotifications.delete(chat.id);
            void notifyForMessage(pending, chat);
          }
        }
        break;
      case "messageUpserted":
        if (event.payload.message) {
          const message = event.payload.message;
          window.__WHATFAST_PERF_EVENT_RECEIVED__?.(message.id, performance.now());
          const chat = state.chats.find((candidate) => candidate.id === message.chatId);
          if (chat) void notifyForMessage(message, chat);
          else if (!message.fromMe) pendingNotifications.set(message.chatId, message);
          upsertMessage(message, true);
          clearTypingForMessage(message);
        }
        break;
      case "receiptUpdated":
        {
          const conversation = state.conversations[event.payload.chatId];
          const index = conversation?.messages.findIndex((message) => message.id === event.payload.messageId);
          if (conversation && index !== undefined && index >= 0) {
            setState("conversations", event.payload.chatId, "messages", index, "status", event.payload.status);
          }
        }
        break;
      case "reactionUpdated":
        if (event.payload.reaction) applyReaction(event.payload.reaction, event.payload.removed);
        break;
      case "chatMerged":
        notificationActivations.mergeChatId(event.payload.oldChatId, event.payload.newChatId);
        mergeChatId(event.payload.oldChatId, event.payload.newChatId);
        break;
      case "typingChanged":
        updateTyping(event.payload);
        break;
      case "pinnedMessagesChanged":
        void loadPinnedMessages(event.payload.chatId);
        break;
      case "problem":
        if (event.payload.fatal) fatal(event.payload.message);
        else {
          toast(event.payload.message);
          if (
            event.payload.code === "event_sequence_gap" ||
            event.payload.code === "event_sequence_invalid"
          ) {
            void resyncAfterEventGap();
          }
        }
        break;
      case "bridgeLifecycle":
        {
          const decision = backendLifecycleDecision(event.payload);
          if (decision.phase === "reconnecting") {
            notificationActivations.markNotReady();
            batch(() => {
              setState("connection", ConnectionState.Reconnecting);
              setState("connectionDetail", decision.detail);
            });
          } else if (decision.phase === "resync") {
            batch(() => {
              setState("connection", ConnectionState.Reconnecting);
              setState("connectionDetail", "Refreshing chats after backend restart");
            });
            void resyncAfterBackendRestart(decision.epoch);
          } else {
            fatal(decision.message);
          }
        }
        break;
      case "recentReactionsRepaired":
        if (event.payload.recoveredReactions > 0 && state.conversations[event.payload.chatId]) {
          void loadConversation(event.payload.chatId);
        }
        break;
    }
  }

  function upsertChat(chat: Chat) {
    // Status updates and channel subscriptions live in their own surfaces
    // (status rings / the channels tab) and must never become chat rows.
    if (isHiddenConversation(chat)) return;
    const existing = state.chats.find((candidate) => candidate.id === chat.id);
    // Preserve locally-known flags when an incoming upsert does not carry
    // them (undefined): a partial event must never clear an optimistic or
    // previously-loaded archived/muted/favorite/pinned/blocked/muteUntilMs.
    let merged: Chat = chat;
    if (existing) {
      merged = { ...merged };
      if ((merged.archived as boolean | undefined) === undefined) merged.archived = existing.archived;
      if ((merged.muted as boolean | undefined) === undefined) merged.muted = existing.muted;
      if ((merged.pinned as boolean | undefined) === undefined) merged.pinned = existing.pinned;
      if (merged.favorite === undefined) merged.favorite = existing.favorite;
      if (merged.blocked === undefined) merged.blocked = existing.blocked;
      if (merged.muteUntilMs === undefined) merged.muteUntilMs = existing.muteUntilMs;
      if (existing.favorite && !merged.favorite) merged.favorite = true;
    }
    setState("chats", reconcile(sortChats(mergeChats(state.chats, [merged])), { key: "id" }));
  }

  async function notifyForMessage(message: Message, chat: Chat) {
    const key = mediaKey(message.chatId, message.id);
    if (notifiedMessages.has(key)) return;
    if (
      !shouldNotify({
        enabled: preferences.notificationsEnabled,
        visible: document.visibilityState === "visible",
        chatVisible: isChatVisible(message.chatId),
        muted: chat.muted,
        incoming: !message.fromMe && !message.edited && !message.revoked,
      })
    ) return;
    notifiedMessages.add(key);
    if (notifiedMessages.size > 1_000) {
      const oldest = notifiedMessages.values().next().value;
      if (oldest) notifiedMessages.delete(oldest);
    }
    try {
      await sendMessageNotification(chat, message, preferences.notificationPreviews);
    } catch (error) {
      // A desktop notification failure must never interrupt event reduction.
      console.warn("Could not show incoming message notification", error);
    }
  }

  async function openNotificationTarget({ chatId, messageId }: { chatId: string; messageId: string }) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (notificationTargetAvailability(Boolean(chat), false) === "missing-chat") {
      toast("This conversation is no longer available");
      return;
    }
    await selectChat(chatId, messageId);
    const available = notificationTargetAvailability(
      true,
      Boolean(state.conversations[chatId]?.messages.some((message) => message.id === messageId)),
    );
    if (available === "available") return;
    toast("That message is no longer available. Showing the latest messages instead.", "info");
    await loadConversation(chatId);
  }

  async function resyncAfterEventGap() {
    if (eventGapResyncing) return;
    eventGapResyncing = true;
    try {
      const openChatIds = activeConversationIds(state.panes);
      const refreshes = await Promise.allSettled([
        ...openChatIds.flatMap((chatId) => [
          loadConversation(chatId, "", true, true),
          loadPinnedMessages(chatId, true),
        ]),
        loadAllChatsAuthoritative(),
      ]);
      const failed = refreshes.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
      toast("Chat state refreshed after a missed backend event", "info");
    } catch (error) {
      toast(`Could not refresh after the event gap: ${normalizeBridgeError(error).message}`);
    } finally {
      eventGapResyncing = false;
    }
  }

  function resyncAfterBackendRestart(epoch: number) {
    restartEpochs.push(epoch);
    if (restartResyncing) return;
    restartResyncing = true;
    void (async () => {
      try {
        for (let pendingEpoch = restartEpochs.take(); pendingEpoch; pendingEpoch = restartEpochs.take()) {
          try {
            await runBoundedRetry(async (attempt) => {
              setState("connectionDetail", `Refreshing state (${attempt}/3)`);
              // Hello is the protocol gate for every fresh process epoch. No
              // other RPC may race it on a newly restarted bridge.
              const hello = await bridge.hello();
              const auth = await bridge.getAuthState();
              const openChatIds = activeConversationIds(state.panes);
              // Finish every read from this attempt before retrying. This
              // prevents a slow, older pin response from overwriting a newer
              // attempt after Promise.all rejects early.
              const refreshes = await Promise.allSettled([
                loadAllChatsAuthoritative(),
                ...openChatIds.flatMap((chatId) => [
                  loadConversation(chatId, "", true, true),
                  loadPinnedMessages(chatId, true),
                ]),
              ]);
              const failed = refreshes.find(
                (result): result is PromiseRejectedResult => result.status === "rejected",
              );
              if (failed) throw failed.reason;
              batch(() => {
                setState("backendVersion", hello.backendVersion);
                setState("connection", auth.connectionState);
                setState("ownUserId", auth.ownUserId);
                setState("screen", pairingStartupDecision(auth).screen);
              });
            }, 3);
            batch(() => {
              setState("connectionDetail", "");
              setState("fatalError", "");
            });
            markBackendReady();
            toast(`Backend reconnected and refreshed (epoch ${pendingEpoch})`, "info");
          } catch (error) {
            const bridgeError = normalizeBridgeError(error);
            if (bridgeError.code !== "backend_epoch_changed") {
              batch(() => {
                setState("connection", ConnectionState.Reconnecting);
                setState("connectionDetail", "State refresh failed after 3 attempts");
              });
              toast(`Backend reconnected but refresh failed: ${bridgeError.message}`);
            }
          }
        }
      } finally {
        restartResyncing = false;
        // An epoch can be queued by a handler resumed in the same microtask as
        // the loop exits. Re-enter once so that edge cannot strand it.
        const trailingEpoch = restartEpochs.take();
        if (trailingEpoch) resyncAfterBackendRestart(trailingEpoch);
      }
    })();
  }

  function upsertMessage(message: Message, live: boolean) {
    const chatId = message.chatId;
    const conversationState = state.conversations[chatId];
    if (!conversationState) return; // The chat is not open in any pane.
    const existingIndex = conversationState.messages.findIndex((candidate) => candidate.id === message.id);
    const isNew = existingIndex < 0;
    // A full-state vote request may cross an older response/event in flight.
    // Keep the newest optimistic intent visible until its own command settles;
    // that command's generation guard then accepts only its authoritative DTO.
    if (existingIndex >= 0) message = preservePendingPollIntent(conversationState.messages[existingIndex]!, message, state.pendingPollVotes[`${chatId}:${message.id}`] ?? false);
    const merged = upsertSortedMessage(conversationState.messages, message, existingIndex);
    const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
    setState("conversations", chatId, "messages", reconcile(trimMessages(merged, "older"), { key: "id" }));
    if (trimmed) setState("conversations", chatId, "hasOlder", true);
    if (live && isNew) {
      setState("conversations", chatId, "liveMessageVersion", (version) => version + 1);
      if (!message.fromMe && document.visibilityState === "visible" && isChatVisible(chatId)) {
        queueMicrotask(() => void markChatRead(chatId));
      }
    }
  }

  function updateMessage(chatId: string, id: string, update: (message: Message) => Message) {
    const messages = state.conversations[chatId]?.messages;
    if (!messages) return;
    const index = messages.findIndex((message) => message.id === id);
    if (index >= 0) setState("conversations", chatId, "messages", index, update(messages[index]!));
  }

  function applyReaction(reaction: Reaction, removed: boolean) {
    updateMessage(reaction.chatId, reaction.messageId, (message) => {
      const reactions = message.reactions.filter((item) => item.senderId !== reaction.senderId);
      if (!removed && reaction.emoji) reactions.push(reaction);
      reactions.sort((left, right) => left.timestampMs - right.timestampMs);
      return { ...message, reactions };
    });
  }

  function remapMessagesChatId(messages: readonly Message[], newId: string): Message[] {
    return messages.map((message) => (message.chatId === newId ? message : { ...message, chatId: newId }));
  }

  function mergeConversationsForChatMerge(
    oldConversation: ConversationState | undefined,
    newConversation: ConversationState | undefined,
    newId: string,
  ): ConversationState | undefined {
    if (!oldConversation && !newConversation) return undefined;
    const base = newConversation ?? emptyConversation(newId);
    const oldMessages = oldConversation ? remapMessagesChatId(oldConversation.messages, newId) : [];
    const messages = sortMessages(mergeMessages(base.messages, oldMessages));
    const historyCoverage = base.historyCoverage
      ? { ...base.historyCoverage, chatId: newId }
      : oldConversation?.historyCoverage
        ? { ...oldConversation.historyCoverage, chatId: newId }
        : null;
    return { ...base, chatId: newId, messages, historyCoverage };
  }

  function mergeChatId(oldId: string, newId: string) {
    const oldDraft = state.drafts[oldId];
    const oldChat = state.chats.find((chat) => chat.id === oldId);
    const newChat = state.chats.find((chat) => chat.id === newId);
    const chats = state.chats.filter((chat) => chat.id !== oldId && chat.id !== newId);
    if (oldChat || newChat) chats.push({ ...oldChat, ...newChat, id: newId } as Chat);

    const mergedConversation = mergeConversationsForChatMerge(
      state.conversations[oldId],
      state.conversations[newId],
      newId,
    );
    const remappedPanes = uniqueChatPanes(
      state.panes.map((pane) => remapPaneChatId(pane, oldId, newId)),
    );
    const oldTyping = state.typing[oldId];
    const currentTyping = state.typing[newId];
    const canonicalPins = (state.pinnedMessages[newId] ?? []).map((pin) => ({
      ...pin,
      message: pin.message ? { ...pin.message, chatId: newId } : null,
    }));
    const remainingPendingPollVotes = clearMergedPollVotes(state.pendingPollVotes, oldId);

    batch(() => {
      setState("chats", reconcile(sortChats(chats), { key: "id" }));
      if (mergedConversation) setState("conversations", newId, mergedConversation);
      setState("conversations", oldId, undefined!);
      setState("panes", reconcile(remappedPanes, { key: "id" }));
      if (oldDraft && !state.drafts[newId]) setState("drafts", newId, oldDraft);
      setState("drafts", oldId, undefined!);
      if (oldTyping) setState("typing", newId, { ...oldTyping, ...currentTyping });
      setState("typing", oldId, undefined!);
      setState("pinnedMessages", newId, canonicalPins);
      setState("pinnedMessages", oldId, undefined!);
      setState("pendingPollVotes", remainingPendingPollVotes);
      if (state.chatInfo?.chat?.id === oldId) setState("chatInfo", "chat", "id", newId);
      syncSelectedChatId();
    });

    conversationLastFocusedAt.set(
      newId,
      Math.max(conversationLastFocusedAt.get(oldId) ?? 0, conversationLastFocusedAt.get(newId) ?? 0),
    );
    conversationLastFocusedAt.delete(oldId);
    conversationGenerations.delete(oldId);
    for (const generations of [pollVoteGenerations, pinGenerations]) {
      for (const key of generations.keys()) {
        if (key.startsWith(`${oldId}\u0000`)) generations.delete(key);
      }
    }
    if (typingChatId === oldId) typingChatId = newId;
    const recent = readRecentChats().map((id) => (id === oldId ? newId : id));
    writeRecentChats([...new Set(recent)]);
    mergeSpotlightChatUsage(oldId, newId);
    persistWorkspace();
    // Active pin lists omit unpin tombstones, so old and canonical lists must
    // never be merged locally. Hydrate the authoritative canonical set.
    void loadPinnedMessages(newId);
  }

  function updateTyping(payload: {
    chatId: string;
    senderId: string;
    senderName: string;
    typing: boolean;
    recording: boolean;
  }) {
    if (!payload.typing) {
      if (state.typing[payload.chatId]?.[payload.senderId]) {
        setState("typing", payload.chatId, payload.senderId, undefined!);
      }
      return;
    }
    if (!state.typing[payload.chatId]) setState("typing", payload.chatId, {});
    setState("typing", payload.chatId, payload.senderId, {
      senderId: payload.senderId,
      senderName: payload.senderName,
      recording: payload.recording,
      expiresAt: Date.now() + 10_000,
    });
    window.setTimeout(() => {
      const current = state.typing[payload.chatId]?.[payload.senderId];
      if (current && current.expiresAt <= Date.now()) {
        setState("typing", payload.chatId, payload.senderId, undefined!);
      }
    }, 10_100);
  }

  function clearTypingForMessage(message: Message) {
    if (message.fromMe) return;
    const chatTyping = state.typing[message.chatId];
    if (!chatTyping) return;
    if (chatTyping[message.senderId]) setState("typing", message.chatId, message.senderId, undefined!);
  }

  function typingLabel(chatId: string): string {
    const active = Object.values(state.typing[chatId] ?? {}).filter(
      (presence) => presence && presence.expiresAt > Date.now(),
    );
    if (active.length === 0) return "";
    if (active.length === 1) {
      const presence = active[0]!;
      const action = presence.recording ? "recording audio…" : "typing…";
      return presence.senderName ? `${presence.senderName} is ${action}` : action;
    }
    const names = active
      .slice(0, 2)
      .map((presence) => presence.senderName)
      .filter(Boolean);
    return names.length > 0 ? `${names.join(" and ")} are typing…` : `${active.length} people are typing…`;
  }

  function scheduleTyping(chatId: string, composing: boolean) {
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
    if (!chatId) return;
    if (typingChatId && typingChatId !== chatId) {
      void bridge.setTyping(typingChatId, false).catch(() => undefined);
    }
    typingChatId = composing ? chatId : "";
    void bridge.setTyping(chatId, composing).catch(() => undefined);
    if (composing) {
      typingTimer = window.setTimeout(() => {
        if (typingChatId === chatId) scheduleTyping(chatId, true);
      }, 8_000);
    }
  }

  function stopTyping() {
    if (typingTimer !== undefined) {
      window.clearTimeout(typingTimer);
      typingTimer = undefined;
    }
    const chatId = typingChatId;
    typingChatId = "";
    if (chatId) void bridge.setTyping(chatId, false).catch(() => undefined);
  }

  async function markChatRead(chatId: string) {
    const conversationState = state.conversations[chatId];
    const lastIncoming = conversationState ? [...conversationState.messages].reverse().find((message) => !message.fromMe) : undefined;
    if (!chatId || !lastIncoming) return;
    const previous = state.chats.find((chat) => chat.id === chatId)?.unreadCount ?? 0;
    const optimistic = optimisticUnreadCount(previous, conversationState!.hasNewer);
    const backendRevision = backendChatRevisions.get(chatId) ?? 0;
    if (optimistic !== previous) {
      setState("chats", (chat) => chat.id === chatId, "unreadCount", optimistic);
    }
    try {
      await bridge.markRead(chatId, lastIncoming.id);
    } catch {
      // A backend chat upsert can arrive before a rejected RPC when one receipt
      // group persisted and a later group failed, or when a successful response
      // was lost. Do not overwrite that authoritative count with stale state.
      const current = state.chats.find((chat) => chat.id === chatId)?.unreadCount;
      if (
        shouldRestoreOptimisticUnread(
          current,
          optimistic,
          backendRevision,
          backendChatRevisions.get(chatId) ?? 0,
        )
      ) {
        setState("chats", (chat) => chat.id === chatId, "unreadCount", previous);
      }
    }
  }

  function markChatUnread(chatId: string) {
    if (!chatId) return;
    setState("chats", (chat) => chat.id === chatId, "unreadCount", (count) => Math.max(1, count + 1));
  }

  function ensureDraft(chatId: string) {
    if (!state.drafts[chatId]) setState("drafts", chatId, emptyDraft());
  }

  function toast(message: string, kind: Toast["kind"] = "error") {
    const id = ++toastId;
    setState("toasts", (toasts) => [...toasts.slice(-3), { id, message, kind }]);
    window.setTimeout(() => dismissToast(id), 6_000);
  }

  function notifyError(error: unknown) {
    toast(normalizeBridgeError(error).message);
  }

  function dismissToast(id: number) {
    setState("toasts", (toasts) => toasts.filter((toast) => toast.id !== id));
  }

  function fatal(message: string) {
    batch(() => {
      setState("screen", "fatal");
      setState("fatalError", message);
    });
  }

  function filteredChats(): Chat[] {
    const list = state.chats.filter((chat) => {
      if (isHiddenConversation(chat)) return false;
      if (state.chatFilter === "archived") return chat.archived;
      if (chat.archived) return false;
      if (state.chatFilter === "unread") return chat.unreadCount > 0;
      if (state.chatFilter === "favorites") return Boolean(chat.favorite);
      if (state.chatFilter === "groups") return chat.kind === ChatKind.Group;
      if (state.chatFilter === "channels") return false;
      return true;
    });

    return list.slice().sort((left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.lastMessageTimestampMs - left.lastMessageTimestampMs ||
      left.id.localeCompare(right.id)
    );
  }

  function selectedChat(): Chat | undefined {
    return state.chats.find((chat) => chat.id === state.selectedChatId);
  }

  function isHiddenConversation(chat: Chat): boolean {
    const transport = chat.transportJid;
    return transport === "status@broadcast" || transport.endsWith("@newsletter");
  }

  function activeDraft(chatId = state.selectedChatId): Draft {
    return state.drafts[chatId] ?? emptyDraft();
  }

  return {
    state,
    preferences,
    prefActions,
    actions: {
      bootstrap,
      refreshPairing,
      reconnect,
      loadChats,
      conversation,
      selectChat,
      closeChat,
      openInNewTab,
      closeTab,
      moveTab,
      announceTabAction,
      focusPane,
      splitPane,
      closePane,
      loadOlder,
      loadHistoryCoverage,
      loadHistoryOverview,
      loadIntegrityStatus,
      repairLocalCache,
      requestOlderHistory,
      syncChatHistory,
      syncAllChatHistory,
      stopHistorySync,
      loadNewer,
      jumpToLatest,
      openSwitcher,
      cycleSwitcher,
      commitSwitcher,
      cancelSwitcher,
      updateSearch,
      clearSearch,
      openContact,
      openMessageResult,
      setDraftText,
      replyTo,
      replyPrivately,
      cancelReply,
    editMessage,
    cancelEdit,
    deleteMessage,
    toggleMessageSelection,
    enterMessageSelection,
    clearMessageSelection,
    deleteSelection,
    loadStatuses,
    markStatusesRead,
    markChatRead,
    markChatUnread,
    publishStatus,
    publishTextStatus,
    loadNewsletters,
    selectNewsletter,
    closeNewsletter,
    subscribeNewsletter,
    unsubscribeNewsletter,
    createLocalChannel,
    toggleNewsletterMute,
    setChatPinned,
    setChatArchived,
    setChatMuted,
    setChatBlocked,
    toggleFavorite,
    toggleStar,
    isStarred,
    setDisappearingTimer,
    createGroup,
    leaveGroup,
    addParticipant,
    callsUnsupported,
    startForward,
      cancelForward,
      forwardMessage,
      addMention,
      sendCurrentText,
      createPoll,
      votePoll,
      setMessagePin,
      loadPinnedMessages,
      sendImage,
      sendSticker,
      sendAttachment,
      requestFileSend,
      confirmFileSend,
      cancelFileSend,
      hydrateImage,
      hydrateAttachment,
      openAttachment,
      loadAvatar,
      loadParticipantAvatar,
      loadStickers,
      sendStickerFromPack,
      saveMediaAs,
      revealMedia,
      openExternalLink,
      setNotificationsEnabled,
      showChatInfo,
      ensureMentionDirectory,
      hideChatInfo,
      react,
      openImage,
      closeImage,
      setFilter,
      toggleSettings,
      logout,
      stopTyping,
      typingLabel,
      filteredChats,
      selectedChat,
      notifyError,
      activeDraft,
      dismissToast,
      dispose,
      setLogoutConfirmation: (value: boolean) => setState("logoutConfirmation", value),
    },
  };
}

export type AppModel = ReturnType<typeof createAppModel>;
