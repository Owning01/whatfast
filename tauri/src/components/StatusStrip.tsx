import { createSignal, For, onCleanup, Show } from "solid-js";
import { Plus, X } from "lucide-solid";
import type { AppModel } from "../state/app";
import { openFile } from "../lib/bridge";
import { AttachmentKind } from "../lib/types";
import { formatTime } from "../lib/format";
import { MessageContent } from "./MessageBubble";
import { IconButton } from "./Primitives";
import { t } from "../lib/i18n";

const STATUS_STEP_MS = 3_000;

export function StatusStrip(props: { model: AppModel }) {
  const { state, actions } = props.model;
  const [viewer, setViewer] = createSignal<{ groupIndex: number; messageIndex: number } | null>(null);
  const [textStatus, setTextStatus] = createSignal("");
  const [textColor, setTextColor] = createSignal("#0f766e");

  async function publishPhotoStatus() {
    const paths = await openFile({
      multiple: false,
      directory: false,
      title: t("status.choosePhoto"),
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (paths && typeof paths === "string") {
      actions.publishStatus(paths, "image", AttachmentKind.Document);
    }
  }

  function publishText() {
    if (!textStatus().trim()) return;
    actions.publishTextStatus(textStatus(), textColor());
    setTextStatus("");
  }

  function openGroup(index: number) {
    setViewer({ groupIndex: index, messageIndex: 0 });
  }

  function closeViewer() {
    setViewer(null);
    actions.markStatusesRead();
  }

  const currentGroup = () => {
    const open = viewer();
    if (!open) return undefined;
    return state.statuses[open.groupIndex];
  };
  const advance = () => {
    const open = viewer();
    const group = currentGroup();
    if (!open || !group) return;
    if (open.messageIndex + 1 < group.messages.length) {
      setViewer({ groupIndex: open.groupIndex, messageIndex: open.messageIndex + 1 });
      return;
    }
    if (open.groupIndex + 1 < state.statuses.length) {
      setViewer({ groupIndex: open.groupIndex + 1, messageIndex: 0 });
      return;
    }
    closeViewer();
  };

  const statusCount = () => state.statuses.length;

  return (
    <>
      <div class="status-strip" role="list" aria-label="Status updates">
        <button type="button" class="status-ring status-own" onClick={() => void publishPhotoStatus()}>
          <span class="status-avatar">Me</span>
          <span class="status-add"><Plus size={11} /></span>
        </button>
        <For each={state.statuses}>
          {(group, index) => (
            <button
              type="button"
              class="status-ring"
              role="listitem"
              aria-label={`${group.senderName || group.senderPhoneNumber || "Contact"} ${t("status.ring")}`}
              onClick={() => openGroup(index())}
            >
              <span class="status-avatar status-unseen">{avatarLabel(group.senderName || group.senderPhoneNumber)}</span>
            </button>
          )}
        </For>
      </div>
      <form
        class="status-text-form"
        onSubmit={(event) => {
          event.preventDefault();
          publishText();
        }}
      >
        <input
          type="text"
          value={textStatus()}
          placeholder={t("status.textPlaceholder") === "status.textPlaceholder" ? "Write a text status…" : t("status.textPlaceholder")}
          aria-label="Text status"
          onInput={(event) => setTextStatus(event.currentTarget.value)}
        />
        <input
          type="color"
          value={textColor()}
          aria-label="Status background color"
          onInput={(event) => setTextColor(event.currentTarget.value)}
        />
        <button type="submit" class="secondary-button" disabled={!textStatus().trim()}>Post</button>
      </form>

      <Show when={viewer()}>
        {(open) => {
          const group = () => state.statuses[open().groupIndex];
          const message = () => group()?.messages[open().messageIndex];
          let timer: number | undefined;
          timer = window.setInterval(advance, STATUS_STEP_MS);
          onCleanup(() => {
            if (timer !== undefined) window.clearInterval(timer);
          });
          return (
            <div class="status-viewer" role="dialog" aria-modal="true" aria-label="Status viewer">
              <div class="status-viewer-top">
                <div class="status-progress">
                  <For each={group()?.messages}>
                    {(_, index) => (
                      <span class={`status-progress-segment ${index() < open().messageIndex ? "done" : index() === open().messageIndex ? "active" : ""}`} />
                    )}
                  </For>
                </div>
                <div class="status-viewer-meta">
                  <span class="status-avatar status-unseen">{avatarLabel(group()?.senderName || group()?.senderPhoneNumber || "")}</span>
                  <div class="status-viewer-copy">
                    <strong>{group()?.senderName || group()?.senderPhoneNumber || "Status"}</strong>
                    <span>{message() ? formatTime(message()!.timestampMs) : ""}</span>
                  </div>
                  <IconButton label={t("status.close")} onClick={closeViewer}><X size={20} /></IconButton>
                </div>
              </div>
              <div
                class="status-viewer-content"
                style={message() && state.statusColors[message()!.id] ? { background: state.statusColors[message()!.id] } : undefined}
              >
                <Show when={message() && group()}>
                  <MessageContent
                    message={message()!}
                    model={props.model}
                    chatId={state.statusesChatId || "status@broadcast"}
                  />
                </Show>
              </div>
              <Show when={statusCount() > 1}>
                <button
                  type="button"
                  class="status-nav status-prev"
                  aria-label={t("status.prev")}
                  onClick={() => {
                    const open = viewer();
                    if (!open) return;
                    if (open.messageIndex > 0) {
                      setViewer({ groupIndex: open.groupIndex, messageIndex: open.messageIndex - 1 });
                    } else if (open.groupIndex > 0) {
                      const previous = state.statuses[open.groupIndex - 1];
                      setViewer({ groupIndex: open.groupIndex - 1, messageIndex: Math.max(0, (previous?.messages.length ?? 1) - 1) });
                    }
                  }}
                />
                <button
                  type="button"
                  class="status-nav status-next"
                  aria-label={t("status.next")}
                  onClick={advance}
                />
              </Show>
            </div>
          );
        }}
      </Show>
    </>
  );
}

function avatarLabel(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || "?";
}
