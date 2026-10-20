import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import {
  CalendarDays,
  Check,
  CheckCheck,
  Clock3,
  ContactRound,
  Copy,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  FolderDown,
  FolderOpen,
  Forward,
  Images,
  ListChecks,
  MapPin,
  Megaphone,
  MessageSquareReply,
  Pause,
  Pencil,
  PhoneCall,
  Play,
  Plus,
  Pin,
  RefreshCcw,
  SmilePlus,
  Star,
  Timer,
  Trash2,
  TriangleAlert,
  UserPlus,
  UserRoundArrowLeft,
  Wallet,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import {
  ChatKind,
  MessageStatus,
  type AttachmentContent,
  type ImageContent,
  type LinkPreview,
  type Message,
  type PollContent,
  type PollVoter,
  type Reaction,
  type TextContent,
} from "../lib/types";
import {
  formatBytes,
  formatCountdown,
  formatDuration,
  formatTime,
  hueFor,
  messageText,
  safeHttpUrl,
} from "../lib/format";
import { assetUrl } from "../lib/bridge";
import { t } from "../lib/i18n";
import { parsePollFallback } from "../lib/unsupported";
import {
  parseWhatsAppText,
  type WhatsAppInlineSegment,
  type WhatsAppInlineStyle,
  type WhatsAppTextBlock,
} from "../lib/whatsapp-formatting";
import { EmojiPicker } from "./EmojiPicker";
import { Avatar } from "./Avatar";
import { IconButton, Spinner } from "./Primitives";
import { ThemeIcon } from "./ThemeIcon";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const RECENT_REACTION_KEY = "whatfast-recent-emoji";
const EDIT_WINDOW_MS = 20 * 60_000;
interface MessageBubbleProps {
  message: Message;
  model: AppModel;
  /** The conversation this bubble belongs to — never derive this from
   * `state.selectedChatId`, since a second pane can be showing a different
   * chat at the same time. */
  chatId: string;
  highlighted?: boolean;
  /** Message selection mode is active for this conversation. */
  selectable?: boolean;
  /** Whether this bubble is part of the active selection. */
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
  /** Set by `Conversation` for the first message of a group burst; the sender
   * name is printed once per burst, above the bubble, like WhatsApp Desktop.
   * One-to-one chats never show it — the conversation header already names
   * the contact. */
  showSenderName?: boolean;
  quotedMessage?: Message;
  replyCount?: number;
  firstReplyMessageId?: string;
  onScrollToMessage: (messageId: string) => void;
}

export function MessageBubble(props: MessageBubbleProps) {
  const { actions } = props.model;
  const [reactionOpen, setReactionOpen] = createSignal(false);
  const [reactionExpanded, setReactionExpanded] = createSignal(false);
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = createSignal<"" | "everyone" | "me">("");
  const [popoverAbove, setPopoverAbove] = createSignal(true);
  const [messageContextMenu, setMessageContextMenu] = createSignal<{ x: number; y: number } | null>(null);
  let reactionPopoverRef: HTMLDivElement | undefined;
  let deletePopoverRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!messageContextMenu()) return;
    const close = () => setMessageContextMenu(null);
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKeydown);
    onCleanup(() => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKeydown);
    });
  });

  const quoted = () => props.quotedMessage;
  const replySourceTitle = () =>
    props.model.state.chats.find((chat) => chat.id === props.message.replyToChatId)?.title;
  const groupChat = () =>
    props.model.state.chats.find((chat) => chat.id === props.chatId)?.kind === ChatKind.Group;
  const replyCount = () => props.replyCount ?? 0;
  const reactionGroups = createMemo(() => groupReactions(props.message.reactions));
  const savableMedia = createMemo(() => savableMediaInfo(props.message));

  createEffect(() => {
    const message = props.message;
    if (message.content && "image" in message.content) void actions.hydrateImage(message, false, false, props.chatId);
  });

  // The popover is clipped to `.message-scroller` (it uses layout/paint
  // containment), so a row near the top of the pane must flip its picker to
  // open downward instead of the default upward placement — G2.
  createEffect(() => {
    if (!reactionOpen() && !deleteOpen()) {
      setPopoverAbove(true);
      return;
    }
    requestAnimationFrame(() => {
      // Solid keeps the last ref value after a `<Show>` turns off, so the
      // node may already be detached — never measure it in that case.
      const popover = reactionOpen() ? reactionPopoverRef : deletePopoverRef;
      if (!popover || !popover.isConnected) return;
      const scroller = popover.closest<HTMLElement>(".message-scroller");
      if (!scroller) return;
      const popoverRect = popover.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      setPopoverAbove(popoverRect.top >= scrollerRect.top);
    });
  });

  // The edit window is a deadline, not a snapshot: `Date.now()` is not
  // reactive, so the button is driven by a signal that flips when the window
  // closes.
  const [editWindowOpen, setEditWindowOpen] = createSignal(false);
  createEffect(() => {
    const message = props.message;
    const editable =
      message.fromMe &&
      !message.revoked &&
      message.content !== null &&
      "text" in message.content;
    if (!editable) {
      setEditWindowOpen(false);
      return;
    }
    const remaining = message.timestampMs + EDIT_WINDOW_MS - Date.now();
    if (remaining <= 0) {
      setEditWindowOpen(false);
      return;
    }
    setEditWindowOpen(true);
    const timer = window.setTimeout(() => setEditWindowOpen(false), remaining);
    onCleanup(() => window.clearTimeout(timer));
  });

  // A per-message disappearing timer, when the backend ever populates it.
  const [clockNowMs, setClockNowMs] = createSignal(Date.now());
  createEffect(() => {
    if (!props.message.expiresAtMs) return;
    setClockNowMs(Date.now());
    const timer = window.setInterval(() => setClockNowMs(Date.now()), 60_000);
    onCleanup(() => window.clearInterval(timer));
  });
  const expiresInMs = createMemo(() => {
    const expiresAtMs = props.message.expiresAtMs;
    if (!expiresAtMs) return 0;
    return Math.max(0, expiresAtMs - clockNowMs());
  });

  function toggleReactionPopover() {
    setDeleteOpen(false);
    setDeleteConfirmTarget("");
    setReactionOpen((open) => {
      const next = !open;
      if (!next) setReactionExpanded(false);
      return next;
    });
  }

  function toggleDeletePopover() {
    setReactionOpen(false);
    setReactionExpanded(false);
    setDeleteConfirmTarget("");
    setDeleteOpen((open) => !open);
  }

  function requestDelete(target: "everyone" | "me") {
    setDeleteConfirmTarget(target);
  }

  function confirmDelete() {
    const target = deleteConfirmTarget();
    if (!target) return;
    const message = props.message;
    setDeleteOpen(false);
    setDeleteConfirmTarget("");
    void actions.deleteMessage(message.id, target === "everyone", props.chatId);
  }

  function handleBubbleClick(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest("button, a, audio, video, input, .message-actions, .popover, .message-select-check")) {
      return;
    }
    if (props.selectable) {
      props.onToggleSelect?.(props.message.id);
    } else if (event.ctrlKey || event.metaKey) {
      actions.enterMessageSelection(props.chatId);
      props.onToggleSelect?.(props.message.id);
    }
  }

  function copyMessageText() {
    const text = messageText(props.message);
    if (!text) return;
    void navigator.clipboard.writeText(text);
  }

  function pickReaction(emoji: string) {
    setReactionOpen(false);
    setReactionExpanded(false);
    void actions.react(props.message.id, emoji, props.chatId);
  }

  return (
    <div
      class={`message-bubble-stack ${props.showSenderName ? "with-sender" : ""}`}
      style={{ "--sender-hue": `${hueFor(props.message.senderId || props.message.senderName)}` }}
      data-message-id={props.message.id}
      onClick={handleBubbleClick}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMessageContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <Show when={props.showSenderName && props.message.senderName}>
        <div class="message-sender"><span>{props.message.senderName}</span></div>
      </Show>
      <div class={`message-bubble ${props.highlighted ? "highlight" : ""} ${props.selected ? "selected" : ""}`}>
        <Show when={props.selectable}>
          <button
            type="button"
            class={`message-select-check ${props.selected ? "selected" : ""}`}
            aria-label={props.selected ? t("message.deselect") : t("message.select")}
            aria-pressed={props.selected}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleSelect?.(props.message.id);
            }}
          >
            <Show when={props.selected}><Check size={13} /></Show>
          </button>
        </Show>

        <Show when={props.message.forwardingScore > 0}>
          <div class="forwarded-label">
            <Forward size={13} />
            <span>{props.message.forwardingScore >= 5 ? "Forwarded many times" : props.message.forwardingScore > 1 ? `Forwarded ${props.message.forwardingScore} times` : "Forwarded"}</span>
          </div>
        </Show>

        <Show when={props.message.replyToMessageId}>
          <button
            type="button"
            class="quoted-message"
            onClick={() => {
              if (props.message.replyToChatId && props.message.replyToChatId !== props.chatId) {
                void actions.selectChat(props.message.replyToChatId, props.message.replyToMessageId);
              } else {
                props.onScrollToMessage(props.message.replyToMessageId);
              }
            }}
          >
            <strong>{quoted()?.fromMe ? "You" : quoted()?.senderName || replySourceTitle() || "Original message"}</strong>
            <span>
              {quoted()
                ? messageText(quoted()!)
                : replySourceTitle()
                  ? `Quoted message in ${replySourceTitle()}`
                  : "Message outside the loaded history"}
            </span>
          </button>
        </Show>

        <MessageContent message={props.message} model={props.model} chatId={props.chatId} />

        <div class="message-meta">
          <Show when={props.message.expiresAtMs > 0}>
            <span class="message-expires" title={t("message.expiresIn")}>
              <Timer size={11} />
              {formatCountdown(expiresInMs())}
            </span>
          </Show>
          <Show when={props.message.edited}><span>edited</span></Show>
          <Show when={actions.isStarred(props.message.id)}>
            <Star size={11} class="star-badge" aria-label="Starred" />
          </Show>
          <span>{formatTime(props.message.timestampMs)}</span>
          <Show when={props.message.fromMe}><MessageStatusIcon status={props.message.status} /></Show>
        </div>

        <Show when={reactionGroups().length > 0}>
          <div class="reaction-row" aria-label="Reactions">
            <For each={reactionGroups()}>
              {(group) => (
                <button
                  type="button"
                  class={`reaction-chip ${group.reactions.some((reaction) => reaction.fromMe) ? "mine" : ""}`}
                  title={group.reactions.map(reactionName).join(", ")}
                  onClick={() => {
                    const mine = group.reactions.some((reaction) => reaction.fromMe);
                    void actions.react(props.message.id, mine ? "" : group.emoji, props.chatId);
                  }}
                >
                  <span>{group.emoji}</span>
                  <Show when={group.reactions.length > 1}><span>{group.reactions.length}</span></Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={replyCount() > 0}>
          <button
            type="button"
            class="reply-count"
            onClick={() => {
              if (props.firstReplyMessageId) props.onScrollToMessage(props.firstReplyMessageId);
            }}
          >
            {replyCount()} {replyCount() === 1 ? "reply" : "replies"}
          </button>
        </Show>

        <div class="message-actions" aria-label="Message actions">
          <IconButton label={t("message.react")} active={reactionOpen()} onClick={toggleReactionPopover}>
            <ThemeIcon icon={SmilePlus} name="smile" size={15} />
          </IconButton>
          <IconButton label={t("message.reply")} onClick={() => actions.replyTo(props.message.id, props.chatId)}>
            <ThemeIcon icon={MessageSquareReply} name="reply" size={15} />
          </IconButton>
          <Show when={groupChat() && !props.message.fromMe && !props.message.revoked && props.message.senderId}>
            <IconButton label={t("message.replyPrivately")} onClick={() => void actions.replyPrivately(props.message, props.chatId)}>
              <ThemeIcon icon={UserRoundArrowLeft} name="reply-private" size={15} />
            </IconButton>
          </Show>
          <Show when={props.message.content && !props.message.revoked}>
            <IconButton label={t("message.forward")} onClick={() => actions.startForward(props.message.id, props.chatId)}>
              <ThemeIcon icon={Forward} name="forward" size={15} />
            </IconButton>
          </Show>
          <Show when={messageText(props.message)}>
            <IconButton label={t("message.copy")} onClick={copyMessageText}>
              <ThemeIcon icon={Copy} name="copy" size={15} />
            </IconButton>
          </Show>
          <Show when={editWindowOpen()}>
            <IconButton label={t("message.edit")} onClick={() => actions.editMessage(props.message.id, props.chatId)}>
              <ThemeIcon icon={Pencil} name="edit" size={15} />
            </IconButton>
          </Show>
          <Show when={props.message.content && !props.message.revoked}>
            <IconButton
              label={props.model.state.pinnedMessages[props.chatId]?.some((pin) => pin.messageId === props.message.id) ? t("message.unpin") : t("message.pin")}
              onClick={() => void actions.setMessagePin(props.message.id, !props.model.state.pinnedMessages[props.chatId]?.some((pin) => pin.messageId === props.message.id), props.chatId)}
            ><ThemeIcon icon={Pin} name="pin" size={15} /></IconButton>
          </Show>
          <Show when={props.message.content && !props.message.revoked}>
            <IconButton
              label={actions.isStarred(props.message.id) ? "No destacar" : "Destacar"}
              onClick={() => actions.toggleStar(props.message.id)}
            >
              <Star size={15} class={actions.isStarred(props.message.id) ? "star-active" : ""} />
            </IconButton>
          </Show>
          <Show when={!props.message.revoked}>
            <IconButton label={t("message.delete")} active={deleteOpen()} onClick={toggleDeletePopover}>
              <ThemeIcon icon={Trash2} name="trash" size={15} />
            </IconButton>
          </Show>
          <Show when={savableMedia()}>
            {(media) => (
              <>
                <IconButton label="Show in file manager" onClick={() => void actions.revealMedia(media().path)}>
                  <FolderOpen size={15} />
                </IconButton>
                <IconButton label="Save to folder" onClick={() => void actions.saveMediaAs(media().path, media().name)}>
                  <FolderDown size={15} />
                </IconButton>
              </>
            )}
          </Show>
        </div>

        <Show when={deleteOpen()}>
          <div
            ref={deletePopoverRef}
            class="popover delete-popover"
            style={popoverAbove() ? undefined : { bottom: "auto", top: "calc(100% + 8px)" }}
          >
            <Show
              when={!deleteConfirmTarget()}
              fallback={
                <>
                  <p class="delete-confirm-text">
                    {deleteConfirmTarget() === "everyone"
                      ? t("message.deleteConfirmEveryone")
                      : t("message.deleteConfirmMe")}
                  </p>
                  <div class="delete-confirm-actions">
                    <button type="button" class="secondary-button" onClick={() => setDeleteConfirmTarget("")}>{t("message.cancel")}</button>
                    <button type="button" class="danger-button" onClick={confirmDelete}>{t("message.delete")}</button>
                  </div>
                </>
              }
            >
              <button
                type="button"
                class="delete-option"
                onClick={() => requestDelete("me")}
              >{t("message.deleteForMe")}</button>
              <Show when={props.message.fromMe}>
                <button
                  type="button"
                  class="delete-option"
                  onClick={() => requestDelete("everyone")}
                >{t("message.deleteForEveryone")}</button>
              </Show>
            </Show>
          </div>
        </Show>

        <Show when={reactionOpen()}>
          <div
            ref={reactionPopoverRef}
            class={`popover ${reactionExpanded() ? "emoji-picker" : "reaction-picker"}`}
            style={popoverAbove() ? undefined : { bottom: "auto", top: "calc(100% + 8px)" }}
          >
            <Show
              when={reactionExpanded()}
              fallback={
                <>
                  <div class="reaction-quick-row">
                    <For each={QUICK_REACTIONS}>
                      {(emoji) => (
                        <button
                          type="button"
                          class="emoji-button"
                          style={{ width: "35px", height: "35px" }}
                          onClick={() => pickReaction(emoji)}
                        >
                          {emoji}
                        </button>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    class="reaction-picker-expand"
                    aria-label="More reactions"
                    onClick={() => setReactionExpanded(true)}
                  >
                    <Plus size={16} />
                  </button>
                </>
              }
            >
              <EmojiPicker onPick={pickReaction} recentKey={RECENT_REACTION_KEY} />
            </Show>
          </div>
        </Show>

        <Show when={messageContextMenu()}>
          {(menu) => (
            <Portal>
              <div
                class="context-menu-backdrop"
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": "999998",
                  background: "transparent",
                }}
                onMouseDown={() => setMessageContextMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMessageContextMenu(null);
                }}
              />
              <div
                class="chat-context-menu message-context-menu"
                style={{
                  position: "fixed",
                  left: `${Math.min(menu().x, window.innerWidth - 240)}px`,
                  top: `${Math.min(menu().y, window.innerHeight - 340)}px`,
                  "z-index": "999999",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  class="context-menu-quick-reactions"
                  style={{
                    display: "flex",
                    "justify-content": "space-around",
                    padding: "4px 6px 8px 6px",
                    "border-bottom": "1px solid var(--border)",
                    "margin-bottom": "4px",
                  }}
                >
                  <For each={QUICK_REACTIONS}>
                    {(emoji) => (
                      <button
                        type="button"
                        class="quick-reaction-btn"
                        style={{
                          background: "none",
                          border: "none",
                          "font-size": "20px",
                          cursor: "pointer",
                          padding: "2px 4px",
                          "border-radius": "4px",
                          transition: "transform 0.1s ease",
                        }}
                        onClick={() => {
                          setMessageContextMenu(null);
                          pickReaction(emoji);
                        }}
                      >
                        {emoji}
                      </button>
                    )}
                  </For>
                </div>

                <button
                  type="button"
                  class="chat-context-item"
                  onClick={() => {
                    setMessageContextMenu(null);
                    actions.replyTo(props.message.id, props.chatId);
                  }}
                >
                  <MessageSquareReply size={15} />
                  <span>{t("message.reply")}</span>
                </button>
                <button
                  type="button"
                  class="chat-context-item"
                  onClick={() => {
                    setMessageContextMenu(null);
                    toggleReactionPopover();
                  }}
                >
                  <SmilePlus size={15} />
                  <span>{t("message.react")}</span>
                </button>
                <button
                  type="button"
                  class="chat-context-item"
                  onClick={() => {
                    setMessageContextMenu(null);
                    actions.toggleStar(props.message.id);
                  }}
                >
                  <Star size={15} />
                  <span>{actions.isStarred(props.message.id) ? "No destacar" : "Destacar"}</span>
                </button>
                <Show when={props.message.content && !props.message.revoked}>
                  <button
                    type="button"
                    class="chat-context-item"
                    onClick={() => {
                      setMessageContextMenu(null);
                      actions.startForward(props.message.id, props.chatId);
                    }}
                  >
                    <Forward size={15} />
                    <span>{t("message.forward")}</span>
                  </button>
                </Show>
                <Show when={props.message.content && !props.message.revoked}>
                  <button
                    type="button"
                    class="chat-context-item"
                    onClick={() => {
                      setMessageContextMenu(null);
                      const isPinned = props.model.state.pinnedMessages[props.chatId]?.some((pin) => pin.messageId === props.message.id);
                      void actions.setMessagePin(props.message.id, !isPinned, props.chatId);
                    }}
                  >
                    <Pin size={15} />
                    <span>{props.model.state.pinnedMessages[props.chatId]?.some((pin) => pin.messageId === props.message.id) ? t("message.unpin") : t("message.pin")}</span>
                  </button>
                </Show>
                <Show when={editWindowOpen()}>
                  <button
                    type="button"
                    class="chat-context-item"
                    onClick={() => {
                      setMessageContextMenu(null);
                      actions.editMessage(props.message.id, props.chatId);
                    }}
                  >
                    <Pencil size={15} />
                    <span>{t("message.edit")}</span>
                  </button>
                </Show>
                <Show when={messageText(props.message)}>
                  <button
                    type="button"
                    class="chat-context-item"
                    onClick={() => {
                      setMessageContextMenu(null);
                      copyMessageText();
                    }}
                  >
                    <Copy size={15} />
                    <span>{t("message.copy")}</span>
                  </button>
                </Show>
                <Show when={!props.message.revoked}>
                  <div class="chat-context-divider" />
                  <button
                    type="button"
                    class="chat-context-item danger"
                    onClick={() => {
                      setMessageContextMenu(null);
                      toggleDeletePopover();
                    }}
                  >
                    <Trash2 size={15} />
                    <span>{t("message.delete")}</span>
                  </button>
                </Show>
              </div>
            </Portal>
          )}
        </Show>
      </div>
    </div>
  );
}

export function MessageContent(props: { message: Message; model: AppModel; chatId: string }) {
  const content = () => props.message.content;
  return (
    <Show when={!props.message.revoked} fallback={<p class="message-text"><em>{t("message.deleted")}</em></p>}>
      <Show when={content()} fallback={<p class="message-text">Message</p>}>
        {(value) => (
          <>
            <Show when={"text" in value()}>
              <TextMessage
                content={(value() as { text: TextContent }).text}
                mentions={props.message.mentionTexts}
                onOpenLink={props.model.actions.openExternalLink}
              />
            </Show>
            <Show when={"image" in value()}><ImageMessage message={props.message} model={props.model} chatId={props.chatId} /></Show>
            <Show when={"attachment" in value()}>
              <AttachmentMessage
                message={props.message}
                attachment={(value() as { attachment: AttachmentContent }).attachment}
                model={props.model}
                chatId={props.chatId}
              />
            </Show>
            <Show when={"contacts" in value()}>
              <For each={(value() as { contacts: { contacts: { displayName: string; vcard: string }[] } }).contacts.contacts}>
                {(contact) => (
                  <div class="contact-card">
                    <span class="contact-icon"><ContactRound size={22} /></span>
                    <span class="contact-meta">
                      <strong>{contact.displayName || "Contact"}</strong>
                      <span>Shared contact</span>
                    </span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={"location" in value()}>
              {(() => {
                const location = (value() as { location: { latitude: number; longitude: number; name: string; address: string; url: string; live: boolean } }).location;
                const target =
                  safeHttpUrl(location.url) ||
                  `https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}`;
                return (
                  <button
                    type="button"
                    class="location-card"
                    onClick={() => void props.model.actions.openExternalLink(target)}
                  >
                    <span class="location-icon"><MapPin size={22} /></span>
                    <span class="location-meta">
                      <strong>{location.name || (location.live ? "Live location" : "Location")}</strong>
                      <span>{location.address || `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`}</span>
                    </span>
                  </button>
                );
              })()}
            </Show>
            <Show when={"poll" in value()}><PollMessage message={props.message} poll={(value() as { poll: PollContent }).poll} model={props.model} chatId={props.chatId} /></Show>
            <Show when={"unsupported" in value()}><UnsupportedMessage content={(value() as { unsupported: { fallbackText: string; typeName: string } }).unsupported} /></Show>
          </>
        )}
      </Show>
    </Show>
  );
}

function PollMessage(props: { message: Message; poll: PollContent; model: AppModel; chatId: string }) {
  const [showVotes, setShowVotes] = createSignal(false);
  const selected = () => props.poll.options.filter((option) => option.selectedByMe).map((option) => option.name);
  const hasVotes = () => props.poll.options.some((option) => option.voteCount > 0);
  function choose(name: string) {
    if (props.poll.selectableOptionsCount === 0) return;
    const current = new Set(selected());
    if (props.poll.selectableOptionsCount === 1) {
      void props.model.actions.votePoll(props.message, current.has(name) ? [] : [name], props.chatId);
    } else {
      current.has(name) ? current.delete(name) : current.add(name);
      if (current.size <= props.poll.selectableOptionsCount) void props.model.actions.votePoll(props.message, [...current], props.chatId);
    }
  }
  const pending = () => props.model.state.pendingPollVotes[`${props.chatId}:${props.message.id}`] ?? false;
  return <section class={`poll-card ${pending() ? "pending" : ""}`} aria-label="Poll" aria-busy={pending()}>
    <header><ListChecks size={20} /><strong>{props.poll.question}</strong></header>
    <For each={props.poll.options}>{(option) =>
      <div class="poll-option-group">
        <button type="button" disabled={props.poll.selectableOptionsCount === 0 || pending()} class={`poll-option ${option.selectedByMe ? "selected" : ""}`} aria-pressed={option.selectedByMe} onClick={() => choose(option.name)}>
          <span aria-hidden="true" />
          <span class="poll-option-label">{option.name}</span>
          <Show when={option.voters.length > 0}>
            <span class="poll-voter-thumbnails" aria-label={`${option.voters.length} known voters`}>
              <For each={option.voters.slice(0, 4)}>{(voter) => <PollVoterAvatar voter={voter} model={props.model} chatId={props.chatId} size={22} />}</For>
              <Show when={option.voters.length > 4}><span class="poll-voter-overflow">+{option.voters.length - 4}</span></Show>
            </span>
          </Show>
          <strong>{option.voteCount}</strong>
        </button>
      </div>
    }</For>
    <Show when={hasVotes()}>
      <button type="button" class="poll-view-votes" aria-expanded={showVotes()} onClick={() => setShowVotes((shown) => !shown)}>
        {showVotes() ? "Hide votes" : "View votes"}
      </button>
    </Show>
    <Show when={showVotes()}>
      <div class="poll-vote-details">
        <For each={props.poll.options}>{(option) => (
          <Show when={option.voteCount > 0}>
            <section>
              <strong>{option.name}</strong>
              <For each={option.voters}>{(voter) => (
                <div class="poll-voter-row">
                  <PollVoterAvatar voter={voter} model={props.model} chatId={props.chatId} size={28} />
                  <span>{voter.fromMe ? "You" : voter.displayName || voter.userId.split("@")[0]}</span>
                </div>
              )}</For>
              <Show when={option.voteCount > option.voters.length}>
                <small>{option.voteCount - option.voters.length} older {option.voteCount - option.voters.length === 1 ? "vote" : "votes"} without identity data</small>
              </Show>
            </section>
          </Show>
        )}</For>
      </div>
    </Show>
    <small>{pending() ? "Saving vote…" : props.poll.selectableOptionsCount === 0 ? "Poll results snapshot" : `${props.poll.totalVoters} ${props.poll.totalVoters === 1 ? "voter" : "voters"} · choose up to ${props.poll.selectableOptionsCount}`}</small>
  </section>;
}

function PollVoterAvatar(props: { voter: PollVoter; model: AppModel; chatId: string; size: number }) {
  createEffect(() => {
    if (props.voter.avatarPath) return;
    const cancel = props.model.actions.loadParticipantAvatar(props.voter.userId, props.chatId);
    onCleanup(cancel);
  });
  const name = () => props.voter.fromMe ? "You" : props.voter.displayName || props.voter.userId.split("@")[0] || "Voter";
  return (
    <Avatar
      class="poll-voter-avatar"
      name={name()}
      path={props.voter.avatarPath || props.model.state.participantAvatars[props.voter.userId]}
      size={props.size}
    />
  );
}

function UnsupportedMessage(props: { content: { fallbackText: string; typeName: string } }) {
  const poll = () => parsePollFallback(props.content.fallbackText);
  const typeName = () => props.content.typeName;
  const fallbackText = () => props.content.fallbackText;
  return (
    <Switch>
      <Match when={typeName() === "poll"}>
        <section class="poll-card" aria-label={poll().results ? "Poll results" : "Poll"}>
          <header><ListChecks size={20} /><strong>{poll().title}</strong></header>
          <For each={poll().options}>
            {(option) => <div class="poll-option"><span aria-hidden="true" />{option}</div>}
          </For>
          <small>{poll().results ? "Poll results snapshot" : "Voting is not available in this build"}</small>
        </section>
      </Match>
      <Match when={typeName() === "pin"}>
        <div class="system-message-card"><Pin size={17} /><span>{fallbackText() || "Pinned message updated"}</span></div>
      </Match>
      <Match when={typeName() === "group_invite"}>
        <SystemMessageLine
          icon={UserPlus}
          label={t("message.systemGroupInvite")}
          detail={systemDetail(fallbackText(), "after-colon")}
        />
      </Match>
      <Match when={typeName() === "event"}>
        <SystemMessageLine
          icon={CalendarDays}
          label={t("message.systemEvent")}
          detail={systemDetail(fallbackText(), "after-colon")}
        />
      </Match>
      <Match when={typeName() === "ephemeral_setting"}>
        <SystemMessageLine
          icon={Timer}
          label={t("message.systemEphemeral")}
          detail={systemDetail(fallbackText(), "after-icon")}
        />
      </Match>
      <Match when={typeName() === "call"}>
        <SystemMessageLine
          icon={PhoneCall}
          label={t("message.systemCall")}
          detail={systemDetail(fallbackText(), "after-icon")}
        />
      </Match>
      <Match when={typeName() === "payment"}>
        <SystemMessageLine
          icon={Wallet}
          label={t("message.systemPayment")}
          detail={systemDetail(fallbackText(), "after-colon")}
        />
      </Match>
      <Match when={typeName() === "newsletter"}>
        <SystemMessageLine
          icon={Megaphone}
          label={t("message.systemNewsletter")}
          detail={systemDetail(fallbackText(), "after-colon")}
        />
      </Match>
      <Match when={typeName() === "album"}>
        <SystemMessageLine
          icon={Images}
          label={t("message.systemAlbum")}
          detail={systemDetail(fallbackText(), "after-colon")}
        />
      </Match>
      <Match when={typeName() === "interactive"}>
        <SystemMessageLine
          icon={ListChecks}
          label={t("message.systemInteractive")}
          detail={systemDetail(fallbackText(), "after-icon")}
        />
      </Match>
      <Match when={true}>
        <div class="attachment-card">
          <span class="attachment-icon"><TriangleAlert size={21} /></span>
          <span class="attachment-meta">
            <strong>{fallbackText() || t("message.systemUnsupported")}</strong>
            <span>{typeName()}</span>
          </span>
        </div>
      </Match>
    </Switch>
  );
}

/** A centered grey system line — WhatsApp prints these kinds of notices as a
 * plain line in the middle of the chat, not as a bubble. */
function SystemMessageLine(props: {
  icon: Component<{ size?: number }>;
  label: string;
  detail?: string;
}) {
  return (
    <div class="system-message-line">
      <props.icon size={15} />
      <span>{props.label}</span>
      <Show when={props.detail}><small>{props.detail}</small></Show>
    </div>
  );
}

/**
 * The backend bakes an English sentence into the fallback text
 * ("📩 Group invite: Trip", "⏱ Disappearing messages turned off"). Only the
 * informative tail is worth showing next to the localized label: whatever
 * follows the first colon, or the whole sentence when the kind carries a
 * state instead of a name.
 */
function systemDetail(
  fallbackText: string,
  mode: "after-colon" | "after-icon",
): string | undefined {
  const first = (fallbackText.split("\n")[0] ?? "").trim();
  if (mode === "after-colon") {
    const separator = first.indexOf(": ");
    if (separator < 0) return undefined;
    const detail = first.slice(separator + 2).trim();
    return detail.length > 0 ? detail : undefined;
  }
  const stripped = first.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

function TextMessage(props: { content: TextContent; mentions: string[]; onOpenLink: (url: string) => Promise<void> }) {
  return (
    <>
      <Show when={props.content.linkPreview}>
        {(preview) => (
          <LinkPreviewCard preview={preview()} onOpenLink={props.onOpenLink} />
        )}
      </Show>
      <div class="message-text whatsapp-text">
        <LinkifiedText text={props.content.text} mentions={props.mentions} onOpenLink={props.onOpenLink} />
      </div>
    </>
  );
}

function LinkifiedText(props: { text: string; mentions?: string[]; onOpenLink: (url: string) => Promise<void> }) {
  const blocks = () => parseWhatsAppText(props.text, { mentions: props.mentions });
  return (
    <For each={blocks()}>
      {(block) => <WhatsAppBlock block={block} onOpenLink={props.onOpenLink} />}
    </For>
  );
}

function WhatsAppBlock(props: {
  block: WhatsAppTextBlock;
  onOpenLink: (url: string) => Promise<void>;
}) {
  const segments = () => "segments" in props.block ? props.block.segments : [];
  const content = () => (
    <For each={segments()}>
      {(segment) => <WhatsAppSegment segment={segment} onOpenLink={props.onOpenLink} />}
    </For>
  );
  return (
    <Switch>
      <Match when={props.block.kind === "paragraph"}>
        <span class="whatsapp-line">{content()}</span>
      </Match>
      <Match when={props.block.kind === "blank-line"}>
        <span class="whatsapp-blank-line" aria-hidden="true" />
      </Match>
      <Match when={props.block.kind === "quote"}>
        <span class="whatsapp-line whatsapp-quote">{content()}</span>
      </Match>
      <Match when={props.block.kind === "bullet-list-item"}>
        <span class="whatsapp-line whatsapp-list-item">
          <span class="whatsapp-list-marker" aria-hidden="true">•</span>
          <span>{content()}</span>
        </span>
      </Match>
      <Match when={props.block.kind === "numbered-list-item"}>
        <span class="whatsapp-line whatsapp-list-item">
          <span class="whatsapp-list-marker">
            {props.block.kind === "numbered-list-item" ? `${props.block.number}.` : ""}
          </span>
          <span>{content()}</span>
        </span>
      </Match>
      <Match when={props.block.kind === "code-block"}>
        <code class="whatsapp-code-block">
          {props.block.kind === "code-block" ? props.block.text : ""}
        </code>
      </Match>
    </Switch>
  );
}

function WhatsAppSegment(props: {
  segment: WhatsAppInlineSegment;
  onOpenLink: (url: string) => Promise<void>;
}) {
  const [revealed, setRevealed] = createSignal(false);
  const formatClass = () => formattingClass(props.segment.styles);
  const spoiler = () => props.segment.styles.includes("spoiler");
  const className = () => (spoiler() && revealed() ? `${formatClass()} revealed` : formatClass());
  return (
    <Switch>
      <Match when={props.segment.kind === "link"}>
        <a
          class={className()}
          href={props.segment.kind === "link" ? props.segment.href : ""}
          title={props.segment.text}
          onClick={(event) => {
            event.preventDefault();
            if (props.segment.kind === "link") void props.onOpenLink(props.segment.href);
          }}
        >
          {props.segment.text}
        </a>
      </Match>
      <Match when={props.segment.kind === "mention"}>
        <span class={`message-mention ${className()}`}>{props.segment.text}</span>
      </Match>
      <Match when={true}>
        <span class={className()}>
          <Show
            when={spoiler()}
            fallback={props.segment.text}
          >
            <button
              type="button"
              class="whatsapp-spoiler-toggle"
              onClick={() => setRevealed(true)}
            >
              {props.segment.text}
            </button>
          </Show>
        </span>
      </Match>
    </Switch>
  );
}

function formattingClass(styles: readonly WhatsAppInlineStyle[]) {
  return styles.map((style) => `whatsapp-format-${style}`).join(" ");
}

function LinkPreviewCard(props: {
  preview: LinkPreview;
  onOpenLink: (url: string) => Promise<void>;
}) {
  const target = () => safeHttpUrl(props.preview.url);
  const thumbnail = () => jpegDataUrl(props.preview.jpegThumbnail);
  return (
    <button
      type="button"
      class="link-preview"
      disabled={!target()}
      onClick={() => {
        const url = target();
        if (url) void props.onOpenLink(url);
      }}
    >
      <Show when={thumbnail()}>{(source) => <img src={source()} alt="" />}</Show>
      <span class="link-preview-meta">
        <strong>{props.preview.title || props.preview.url}</strong>
        <span>{props.preview.description}</span>
        <span class="link-preview-url" title={props.preview.url}>{props.preview.url}</span>
      </span>
    </button>
  );
}

function ImageMessage(props: { message: Message; model: AppModel; chatId: string }) {
  const image = () => {
    const content = props.message.content;
    return content && "image" in content ? content.image : undefined;
  };
  const path = () => image()?.thumbnailPath || image()?.localPath || "";
  const source = () => assetUrl(path()) || jpegDataUrl(image()?.jpegThumbnail ?? []);
  const error = () => props.model.state.imageFailures[`${props.chatId}\u0000${props.message.id}`];
  return (
    <>
      <button
        type="button"
        class={`message-image ${image()?.sticker ? "sticker" : ""}`}
        style={imageAspectStyle(image()?.width ?? 0, image()?.height ?? 0, Boolean(image()?.sticker), props.model.preferences.uiScale)}
        onClick={() => {
          const media = image();
          if (!media) return;
          if (media.localPath) {
            props.model.actions.openImage(media.localPath, media.caption, media.sticker);
            return;
          }
          if (media.downloadable) {
            void props.model.actions
              .hydrateImage(props.message, true, true, props.chatId)
              .then((downloadedPath) => {
                if (downloadedPath) {
                  props.model.actions.openImage(downloadedPath, media.caption, media.sticker);
                }
              });
            return;
          }
          if (media.thumbnailPath) {
            props.model.actions.openImage(media.thumbnailPath, media.caption, media.sticker);
          }
        }}
      >
        <Show
          when={source()}
          fallback={
            <span class="media-placeholder">
              <Show when={!error()} fallback={<><RefreshCcw size={23} /><span>{error()}</span></>}>
                <Spinner small label={image()?.sticker ? "Loading sticker" : "Loading photo"} />
              </Show>
            </span>
          }
        >
          {(url) => <img src={url()} alt={image()?.caption || (image()?.sticker ? "Sticker" : "Photo")} draggable={false} />}
        </Show>
      </button>
      <Show when={image()?.caption}>
        <div class="message-text whatsapp-text">
          <LinkifiedText text={image()?.caption ?? ""} mentions={props.message.mentionTexts} onOpenLink={props.model.actions.openExternalLink} />
        </div>
      </Show>
    </>
  );
}

function AttachmentMessage(props: {
  message: Message;
  attachment: AttachmentContent;
  model: AppModel;
  chatId: string;
}) {
  const [playbackFailed, setPlaybackFailed] = createSignal(false);
  let videoRef: HTMLVideoElement | undefined;
  const source = () => assetUrl(props.attachment.localPath);
  const isAudio = () => props.attachment.kind === "audio" || props.attachment.voiceNote;
  const isVideo = () => props.attachment.kind === "video";
  const isGif = () => isVideo() && props.attachment.animated;
  const failure = () => props.model.state.attachmentFailures[`${props.chatId}\u0000${props.message.id}`];
  const icon = () => (isAudio() ? <FileAudio size={23} /> : isVideo() ? <FileVideo size={23} /> : <FileText size={23} />);

  // Audio, voice notes, and videos play inline, so download them as soon as
  // they enter the viewport instead of waiting for a manual tap on the card.
  createEffect(() => {
    const attachment = props.attachment;
    if (
      !(isAudio() || isVideo())
      || attachment.localPath
      || !attachment.downloadable
      || props.model.state.attachmentFailures[`${props.chatId}\u0000${props.message.id}`]
    ) {
      return;
    }
    void props.model.actions.hydrateAttachment(props.message, false, props.chatId);
  });

  createEffect(() => {
    if (!videoRef || !isGif()) return;
    if (props.model.preferences.batterySaver) videoRef.pause();
    else void videoRef.play().catch(() => undefined);
  });

  return (
    <>
      <Show when={isVideo() && !playbackFailed() ? source() : undefined}>
        {(url) => (
          <video
            ref={videoRef}
            class={`message-image ${isGif() ? "gif" : ""}`}
            controls={!isGif() || props.model.preferences.batterySaver}
            autoplay={isGif() && !props.model.preferences.batterySaver}
            loop={isGif()}
            muted={isGif()}
            playsinline
            preload={isGif() && !props.model.preferences.batterySaver ? "auto" : "metadata"}
            src={url()}
            aria-label={props.attachment.fileName || (isGif() ? "Animated GIF" : "Video")}
            onError={() => setPlaybackFailed(true)}
          />
        )}
      </Show>
      <Show when={isAudio() && source()}>
        {(url) => (
          <AudioMessagePlayer
            url={url()}
            durationSeconds={props.attachment.durationSeconds}
            voiceNote={props.attachment.voiceNote}
          />
        )}
      </Show>
      <Show when={!(isVideo() && source() && !playbackFailed()) && !(isAudio() && source())}>
        <button
          type="button"
          class="attachment-card"
          onClick={() => {
            // Audio and video download straight into the inline player; the
            // external OS player stays reserved for documents.
            if (isAudio() || isVideo()) {
              void props.model.actions.hydrateAttachment(props.message, true, props.chatId);
              return;
            }
            void props.model.actions.openAttachment(props.message, props.chatId);
          }}
        >
          <span class="attachment-icon">{icon()}</span>
          <span class="attachment-meta">
            <strong>{props.attachment.fileName || attachmentLabel(props.attachment)}</strong>
            <span>
              {[formatBytes(props.attachment.fileSize), formatDuration(props.attachment.durationSeconds), props.attachment.mimeType]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <Show when={props.attachment.downloadable && !props.attachment.localPath}>
            <Download size={20} />
          </Show>
        </button>
      </Show>
      <Show when={failure()}>
        {(error) => (
          <button
            type="button"
            class="media-download-error"
            onClick={() => void props.model.actions.openAttachment(props.message, props.chatId)}
          >
            <RefreshCcw size={14} />
            <span>{error()}</span>
          </button>
        )}
      </Show>
      <Show when={props.attachment.caption}>
        <div class="message-text whatsapp-text">
          <LinkifiedText text={props.attachment.caption} mentions={props.message.mentionTexts} onOpenLink={props.model.actions.openExternalLink} />
        </div>
      </Show>
    </>
  );
}

function MessageStatusIcon(props: { status: number }) {
  return (
    <Switch>
      <Match when={props.status === MessageStatus.Pending}><ThemeIcon icon={Clock3} name="clock" size={12} /></Match>
      <Match when={props.status === MessageStatus.Sent}><ThemeIcon icon={Check} name="check" size={13} /></Match>
      <Match when={props.status === MessageStatus.Delivered}><ThemeIcon icon={CheckCheck} name="check-double" size={14} /></Match>
      <Match when={props.status === MessageStatus.Read}><ThemeIcon icon={CheckCheck} name="check-double" class="read" size={14} /></Match>
      <Match when={props.status === MessageStatus.Failed}><ThemeIcon icon={TriangleAlert} name="warning" class="failed" size={13} /></Match>
    </Switch>
  );
}

function groupReactions(reactions: readonly Reaction[]) {
  const groups = new Map<string, Reaction[]>();
  for (const reaction of reactions) {
    if (!reaction.emoji) continue;
    groups.set(reaction.emoji, [...(groups.get(reaction.emoji) ?? []), reaction]);
  }
  return [...groups].map(([emoji, grouped]) => ({ emoji, reactions: grouped }));
}

function reactionName(reaction: Reaction): string {
  return reaction.fromMe ? "You" : reaction.senderName || reaction.senderPhoneNumber || "Unknown";
}

function jpegDataUrl(bytes: number[]): string | undefined {
  if (bytes.length === 0) return undefined;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

function attachmentLabel(attachment: AttachmentContent): string {
  if (attachment.voiceNote) return "Voice message";
  if (attachment.kind === "video" && attachment.animated) return "GIF";
  if (attachment.kind === "video") return "Video";
  if (attachment.kind === "audio") return "Audio";
  return "Document";
}

function imageAspectStyle(width: number, height: number, sticker: boolean, uiScale: number) {
  if (width <= 0 || height <= 0) return {};
  const maxWidth = (sticker ? 210 : 320) * uiScale;
  const maxHeight = (sticker ? 210 : 360) * uiScale;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: `${Math.max(110 * uiScale, Math.round(width * scale))}px`,
    height: `${Math.max(90 * uiScale, Math.round(height * scale))}px`,
  };
}

/** Only images/attachments that are actually downloaded locally can be
 * "Saved to folder" — G7's `saveMediaAs`. */
function savableMediaInfo(message: Message): { path: string; name: string } | null {
  const content = message.content;
  if (!content) return null;
  if ("image" in content && content.image.localPath) {
    return { path: content.image.localPath, name: suggestedMediaName(content.image) };
  }
  if ("attachment" in content && content.attachment.localPath) {
    return {
      path: content.attachment.localPath,
      name: content.attachment.fileName || suggestedAttachmentName(content.attachment),
    };
  }
  return null;
}

function suggestedMediaName(image: ImageContent): string {
  const base = basename(image.localPath);
  if (base) return base;
  const extension = image.mimeType.split("/").pop();
  return `${image.sticker ? "sticker" : "photo"}${extension ? `.${extension}` : ""}`;
}

function suggestedAttachmentName(attachment: AttachmentContent): string {
  const base = basename(attachment.localPath);
  if (base) return base;
  const extension = attachment.mimeType.split("/").pop();
  return `${attachmentLabel(attachment).toLowerCase()}${extension ? `.${extension}` : ""}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

function AudioMessagePlayer(props: {
  url: string;
  durationSeconds?: number;
  voiceNote?: boolean;
}) {
  let audioRef: HTMLAudioElement | undefined;
  const [playing, setPlaying] = createSignal(false);
  const [currentTime, setCurrentTime] = createSignal(0);
  // The attachment may arrive without a duration, so the element's own
  // metadata fills the gap; a duration that shows up later wins over it.
  const [metadataDuration, setMetadataDuration] = createSignal(0);
  const duration = createMemo(() => props.durationSeconds || metadataDuration());
  const [playbackRate, setPlaybackRate] = createSignal(1);

  const togglePlay = () => {
    if (!audioRef) return;
    if (playing()) {
      audioRef.pause();
    } else {
      void audioRef.play().catch(() => undefined);
    }
  };

  const toggleRate = (event: MouseEvent) => {
    event.stopPropagation();
    if (!audioRef) return;
    const next = playbackRate() === 1 ? 1.5 : playbackRate() === 1.5 ? 2 : 1;
    setPlaybackRate(next);
    audioRef.playbackRate = next;
  };

  const handleSeek = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const val = Number(event.currentTarget.value);
    setCurrentTime(val);
    if (audioRef) audioRef.currentTime = val;
  };

  const formatAudioTime = (seconds: number) => {
    const s = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div class="whatsapp-audio-player" classList={{ "voice-note": props.voiceNote }}>
      <audio
        ref={audioRef}
        src={props.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        onLoadedMetadata={() => {
          if (audioRef && Number.isFinite(audioRef.duration)) {
            setMetadataDuration(audioRef.duration);
          }
        }}
        onTimeUpdate={() => {
          if (audioRef) setCurrentTime(audioRef.currentTime);
        }}
      />
      <button
        type="button"
        class="audio-play-button"
        aria-label={playing() ? "Pause" : "Play"}
        onClick={togglePlay}
      >
        {playing() ? <Pause size={18} /> : <Play size={18} class="play-icon-offset" />}
      </button>
      <div class="audio-track-container">
        <input
          type="range"
          min="0"
          max={duration() || 1}
          step="0.1"
          value={currentTime()}
          onInput={handleSeek}
          class="audio-scrubber"
          aria-label="Audio progress"
        />
        <div class="audio-time-row">
          <span class="audio-time">{formatAudioTime(currentTime() > 0 ? currentTime() : duration())}</span>
          <Show when={props.voiceNote || duration() > 5}>
            <button
              type="button"
              class="audio-rate-button"
              onClick={toggleRate}
              title="Playback speed"
            >
              {playbackRate()}×
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

