import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  Archive,
  ArchiveRestore,
  CheckCheck,
  CircleAlert,
  Pin,
  Plus,
  Search,
  ShieldAlert,
  Star,
  Volume2,
  VolumeX,
  X,
} from "lucide-solid";
import type { AppModel, ChatFilter } from "../state/app";
import { t } from "../lib/i18n";
import type {
  Chat,
  ContactSearchResult,
  MessageSearchResult,
} from "../lib/types";
import { ChatKind, SyncPhase } from "../lib/types";
import { syncStatusLabel } from "../state/sync";
import { chatSubtitle, formatChatTime } from "../lib/format";
import { Avatar } from "./Avatar";
import { EmptyState, IconButton, Spinner } from "./Primitives";
import { ThemeIcon } from "./ThemeIcon";

interface SidebarProps {
  model: AppModel;
  searchInputRef?: (element: HTMLInputElement) => void;
}

export function Sidebar(props: SidebarProps) {
  const { state, actions, preferences } = props.model;
  let listRef: HTMLDivElement | undefined;
  let searchResultsRef: HTMLDivElement | undefined;
  const chats = createMemo(() => actions.filteredChats());
  const syncLabel = createMemo(() => syncStatusLabel(state.syncStatus));
  const syncNeedsAttention = createMemo(() =>
    state.syncStatus.phase === SyncPhase.Partial ||
    state.syncStatus.phase === SyncPhase.Failed ||
    state.syncStatus.phase === SyncPhase.Offline,
  );
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return chats().length;
    },
    getScrollElement: () => listRef ?? null,
    estimateSize: () => (preferences.density === "compact" ? 58 : 72) * preferences.uiScale,
    get overscan() {
      return preferences.batterySaver ? 3 : 8;
    },
    getItemKey: (index) => chats()[index]?.id ?? index,
    onChange: (instance) => {
      const items = instance.getVirtualItems();
      const last = items.at(-1);
      if (last && last.index >= chats().length - 8) void actions.loadChats(false);
    },
  });

  const searchActive = () => state.searchQuery.trim().length >= 2;

  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; chat: Chat } | null>(null);

  createEffect(() => {
    if (!contextMenu()) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    onCleanup(() => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    });
  });

  createEffect(() => {
    if (state.chatFilter === "channels") void actions.loadNewsletters();
  });

  createEffect(() => {
    if (searchActive()) return;
    requestAnimationFrame(() => virtualizer.measure());
  });

  return (
    <aside class="sidebar" aria-label="Chats">
      <div class="sidebar-header">
        <h1 class="sidebar-title">Chats</h1>
        <IconButton
          label="Nuevo grupo"
          onClick={() => {
            const name = window.prompt("Nombre del grupo", "Nuevo grupo");
            if (name !== null) void actions.createGroup(name);
          }}
        >
          <Plus size={20} />
        </IconButton>
      </div>
      <div class="sidebar-search-wrap">
        <label class="search-field">
          <ThemeIcon icon={Search} name="search" size={17} />
          <input
            ref={props.searchInputRef}
            type="search"
            value={state.searchQuery}
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.searchLabel")}
            onInput={(event) => actions.updateSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                actions.clearSearch();
                event.currentTarget.blur();
              } else if (
                (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                searchActive()
              ) {
                searchResultsRef?.focus();
                event.preventDefault();
              }
            }}
          />
          <Show when={state.searchQuery}>
            <IconButton label={t("sidebar.clearSearch")} class="clear-search" onClick={actions.clearSearch}>
              <ThemeIcon icon={X} name="close" size={16} />
            </IconButton>
          </Show>
        </label>
      </div>

      <Show when={!searchActive()}>
        <div class="chat-filters" role="tablist" aria-label="Chat filters">
          <FilterButton filter="all" label={t("sidebar.filter.all")} model={props.model} />
          <FilterButton filter="unread" label={t("sidebar.filter.unread")} model={props.model} />
          <FilterButton filter="favorites" label="Favorites" model={props.model} />
          <FilterButton filter="groups" label={t("sidebar.filter.groups")} model={props.model} />
          <FilterButton filter="channels" label={t("sidebar.filter.channels")} model={props.model} />
          <FilterButton filter="archived" label={t("sidebar.filter.archived")} model={props.model} />
        </div>
      </Show>

      <Show when={!searchActive() && state.chatFilter === "channels"}>
        <div class="newsletter-list" role="list" aria-label="Channels">
          <For each={state.newsletters}>
            {(newsletter) => (
              <button
                type="button"
                class={`chat-row newsletter-row ${state.selectedNewsletter?.jid === newsletter.jid ? "active" : ""}`}
                role="listitem"
                aria-label={newsletter.name}
                onClick={() => void actions.selectNewsletter(newsletter.jid)}
              >
                <span class="avatar" style={{ "--avatar-hue": "160" }}>{newsletter.name.slice(0, 1).toUpperCase()}</span>
                <span class="chat-row-copy">
                  <strong>
                    {newsletter.name}
                    <Show when={newsletter.local}><span class="role-badge">local</span></Show>
                  </strong>
                  <span>Channel{newsletter.muted ? " · muted" : ""}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div ref={listRef} class="chat-list" aria-label="Conversation list" hidden={searchActive() || state.chatFilter === "channels"}>
        <Show
          when={chats().length > 0}
          fallback={
            <Show when={!state.loadingChats} fallback={<EmptyState><Spinner label="Loading chats…" /></EmptyState>}>
              <EmptyState title={emptyLabel(state.chatFilter)}>
                {state.chatFilter === "archived"
                  ? <ThemeIcon icon={Archive} name="archive" size={22} />
                  : <ThemeIcon icon={CheckCheck} name="check-double" size={22} />}
              </EmptyState>
            </Show>
          }
        >
          <div class="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const chat = () => chats()[virtualRow.index];
                return (
                  <div
                    class="virtual-row"
                    data-index={virtualRow.index}
                    style={{ transform: `translateY(${virtualRow.start}px)`, height: `${virtualRow.size}px` }}
                  >
                    <Show when={chat()}>
                      {(value) => (
                        <ChatRow
                          chat={value()}
                          model={props.model}
                          onContextMenu={(e, c) => setContextMenu({ x: e.clientX, y: e.clientY, chat: c })}
                        />
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <Show when={state.loadingChats && chats().length > 0}>
            <div class="sync-strip"><Spinner small label="Loading more chats" /></div>
          </Show>
        </Show>
      </div>

      <Show when={searchActive()}>
        <SearchResults model={props.model} ref={(element) => (searchResultsRef = element)} />
      </Show>

      <div
        class="sync-strip"
        classList={{ "sync-strip-warning": syncNeedsAttention() }}
        role="status"
        aria-live="polite"
      >
        <Show when={syncNeedsAttention()}><CircleAlert size={14} /></Show>
        <span>{syncLabel()}</span>
        <Show when={state.historyOverview}>
          {(overview) => <small>· {overview().localMessageCount.toLocaleString()} local messages</small>}
        </Show>
        <Show when={state.syncActive}><span class="progress-track" /></Show>
      </div>
      <div class="history-sync-controls">
        <Show
          when={state.historySyncJob.running}
          fallback={<button type="button" class="secondary-button" onClick={() => void actions.syncAllChatHistory()}>Sync older history for all chats</button>}
        >
          <span>
            {state.historySyncJob.totalChats > 0
              ? `${state.historySyncJob.completedChats}/${state.historySyncJob.totalChats} chats · `
              : ""}
            {state.historySyncJob.messagesAdded.toLocaleString()} added
          </span>
          <button type="button" class="secondary-button" onClick={actions.stopHistorySync}>Cancel</button>
        </Show>
      </div>

      <Show when={contextMenu()}>
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
              onMouseDown={() => setContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu(null);
              }}
            />
            <div
              class="chat-context-menu"
              style={{
                position: "fixed",
                top: `${Math.min(menu().y, window.innerHeight - 280)}px`,
                left: `${Math.min(menu().x, window.innerWidth - 240)}px`,
                "z-index": "999999",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                class="context-menu-item"
                onClick={() => {
                  const c = menu().chat;
                  setContextMenu(null);
                  void actions.setChatPinned(c.id, !c.pinned);
                }}
              >
                <Pin size={15} />
                <span>{menu().chat.pinned ? "Desfijar chat" : "Fijar chat"}</span>
              </button>
              <button
                type="button"
                class="context-menu-item"
                onClick={() => {
                  const c = menu().chat;
                  setContextMenu(null);
                  void actions.setChatMuted(c.id, !c.muted);
                }}
              >
                {menu().chat.muted ? <Volume2 size={15} /> : <VolumeX size={15} />}
                <span>{menu().chat.muted ? "Desilenciar notificaciones" : "Silenciar notificaciones"}</span>
              </button>
              <button
                type="button"
                class="context-menu-item"
                onClick={() => {
                  const c = menu().chat;
                  setContextMenu(null);
                  void actions.setChatArchived(c.id, !c.archived);
                }}
              >
                {menu().chat.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                <span>{menu().chat.archived ? "Desarchivar chat" : "Archivar chat"}</span>
              </button>
              <button
                type="button"
                class="context-menu-item"
                onClick={() => {
                  const c = menu().chat;
                  setContextMenu(null);
                  void actions.toggleFavorite(c.id);
                }}
              >
                <Star size={15} />
                <span>{menu().chat.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}</span>
              </button>
              <Show
                when={menu().chat.unreadCount > 0}
                fallback={
                  <button
                    type="button"
                    class="context-menu-item"
                    onClick={() => {
                      const c = menu().chat;
                      setContextMenu(null);
                      actions.markChatUnread(c.id);
                    }}
                  >
                    <CheckCheck size={15} />
                    <span>Marcar como no leído</span>
                  </button>
                }
              >
                <button
                  type="button"
                  class="context-menu-item"
                  onClick={() => {
                    const c = menu().chat;
                    setContextMenu(null);
                    void actions.markChatRead(c.id);
                  }}
                >
                  <CheckCheck size={15} />
                  <span>Marcar como leído</span>
                </button>
              </Show>
              <Show when={menu().chat.kind !== ChatKind.Group}>
                <div class="chat-context-divider" />
                <button
                  type="button"
                  class="context-menu-item danger"
                  onClick={() => {
                    const c = menu().chat;
                    setContextMenu(null);
                    void actions.setChatBlocked(c.id, !c.blocked);
                  }}
                >
                  <ShieldAlert size={15} />
                  <span>{menu().chat.blocked ? "Desbloquear contacto" : "Bloquear contacto"}</span>
                </button>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </aside>
  );
}

function FilterButton(props: { filter: ChatFilter; label: string; model: AppModel }) {
  return (
    <button
      type="button"
      class={`filter-chip ${props.model.state.chatFilter === props.filter ? "active" : ""}`}
      role="tab"
      aria-selected={props.model.state.chatFilter === props.filter}
      onClick={() => props.model.actions.setFilter(props.filter)}
    >
      {props.label}
    </button>
  );
}

function ChatRow(props: {
  chat: Chat;
  model: AppModel;
  onContextMenu?: (event: MouseEvent, chat: Chat) => void;
}) {
  const { state, actions, preferences, prefActions } = props.model;
  const typing = () => actions.typingLabel(props.chat.id);
  // A chat counts as open when any pane holds it, not only the focused one.
  const open = () => state.panes.some((pane) => pane.activeChatId === props.chat.id);
  queueMicrotask(() => void actions.loadAvatar(props.chat.id));

  return (
    <button
      type="button"
      class={`chat-row ${open() ? "selected" : ""} ${props.chat.unreadCount > 0 ? "unread" : ""}`}
      aria-current={state.selectedChatId === props.chat.id ? "page" : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onContextMenu?.(event, props.chat);
      }}
      onClick={(event) => {
        // Ctrl/Cmd-click matches the browser convention the tab strip sets up.
        if (event.ctrlKey || event.metaKey) actions.openInNewTab(props.chat.id);
        else void actions.selectChat(props.chat.id);
        if (window.matchMedia("(max-width: 760px)").matches) {
          prefActions.update("sidebarCollapsed", true);
        }
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        actions.openInNewTab(props.chat.id);
      }}
    >
      <Avatar
        name={props.chat.title || props.chat.phoneNumber}
        path={props.chat.avatarPath}
        size={(preferences.density === "compact" ? 38 : 49) * preferences.uiScale}
        group={props.chat.kind === ChatKind.Group}
      />
      <span class="chat-row-body">
        <span class="chat-row-line">
          <span class="chat-title">{props.chat.title || props.chat.phoneNumber || "Unknown contact"}</span>
          <span class="chat-time">{formatChatTime(props.chat.lastMessageTimestampMs)}</span>
        </span>
        <span class="chat-row-line">
          <span class={`chat-preview ${typing() ? "typing" : ""}`}>
            {typing() || chatSubtitle(props.chat, t("chat.youPrefix"))}
          </span>
          <span class="chat-flags">
            <Show when={props.chat.muted}><VolumeX size={14} /></Show>
            <Show when={props.chat.favorite}><Star size={13} /></Show>
            <Show when={props.chat.pinned}><Pin size={14} class="pin-active-badge" /></Show>
            <Show when={props.chat.unreadCount > 0}>
              <span class="chat-badge">{props.chat.unreadCount > 99 ? "99+" : props.chat.unreadCount}</span>
            </Show>
          </span>
        </span>
      </span>
    </button>
  );
}

type SearchRow =
  | { type: "heading"; label: string }
  | { type: "contact"; result: ContactSearchResult }
  | { type: "group"; result: Chat }
  | { type: "message"; result: MessageSearchResult };

function SearchResults(props: { model: AppModel; ref?: (element: HTMLDivElement) => void }) {
  const { state, actions } = props.model;
  const [selected, setSelected] = createSignal(0);
  const rows = createMemo<SearchRow[]>(() => {
    const results = state.searchResults;
    if (!results) return [];
    const next: SearchRow[] = [];
    if (results.contacts.length > 0) {
      next.push({ type: "heading", label: "Contacts" });
      next.push(...results.contacts.map((result) => ({ type: "contact" as const, result })));
    }
    if (results.groups.length > 0) {
      next.push({ type: "heading", label: "Groups" });
      next.push(...results.groups.map((result) => ({ type: "group" as const, result })));
    }
    if (results.messages.length > 0) {
      next.push({ type: "heading", label: "Messages" });
      next.push(...results.messages.map((result) => ({ type: "message" as const, result })));
    }
    return next;
  });
  const selectable = createMemo(() => rows().filter((row) => row.type !== "heading"));

  return (
    <div
      ref={props.ref}
      class="search-results"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSelected((value) => (value + direction + selectable().length) % Math.max(1, selectable().length));
          event.preventDefault();
        } else if (event.key === "Enter") {
          const row = selectable()[selected()];
          if (row) void activate(row);
        }
      }}
    >
      <Switch>
        <Match when={state.searchLoading}>
          <EmptyState><Spinner label="Searching…" /></EmptyState>
        </Match>
        <Match when={state.searchError}>
          <EmptyState title={state.searchError}><ThemeIcon icon={X} name="close" size={22} /></EmptyState>
        </Match>
        <Match when={state.searchResults && rows().length === 0}>
          <EmptyState title="No contacts, groups, or messages found"><ThemeIcon icon={Search} name="search" size={22} /></EmptyState>
        </Match>
      </Switch>
      <Show when={!state.searchLoading && rows().length > 0}>
        <For each={rows()}>
          {(row) => row.type === "heading"
            ? <div class="search-section-label">{row.label}</div>
            : <SearchResultRow row={row} active={selectable()[selected()] === row} model={props.model} onActivate={() => void activate(row)} />}
        </For>
      </Show>
    </div>
  );

  async function activate(row: Exclude<SearchRow, { type: "heading" }>) {
    if (row.type === "contact") await actions.openContact(row.result);
    else if (row.type === "group") await actions.selectChat(row.result.id);
    else await actions.openMessageResult(row.result);
  }
}

function SearchResultRow(props: {
  row: Exclude<SearchRow, { type: "heading" }>;
  active: boolean;
  model: AppModel;
  onActivate: () => void;
}) {
  const { state, actions } = props.model;

  createEffect(() => {
    const row = props.row;
    if (row.type === "contact") {
      const contact = row.result;
      const contactJid = contact.contactJid;
      if (contactJid && !state.participantAvatars[contactJid]) {
        const cancel = actions.loadParticipantAvatar(contactJid, "search");
        onCleanup(cancel);
      }
      if (contact.chatId) {
        actions.loadAvatar(contact.chatId);
      }
    } else if (row.type === "group") {
      actions.loadAvatar(row.result.id);
    }
  });

  const title = () => {
    const row = props.row;
    if (row.type === "contact") return row.result.displayName;
    if (row.type === "group") return row.result.title;
    return row.result.chatTitle;
  };
  const subtitle = () => {
    const row = props.row;
    if (row.type === "contact") {
      return row.result.phoneNumber || row.result.secondaryName;
    }
    if (row.type === "group") {
      return row.result.lastMessagePreview;
    }
    return `${row.result.senderName ? `${row.result.senderName}: ` : ""}${row.result.snippet}`;
  };
  const avatarPath = () => {
    const row = props.row;
    if (row.type === "contact") {
      const contact = row.result;
      if (contact.chatId) {
        const chat = state.chats.find((c) => c.id === contact.chatId);
        if (chat?.avatarPath) return chat.avatarPath;
      }
      return (contact.contactJid && state.participantAvatars[contact.contactJid]) || "";
    }
    if (row.type === "group") {
      const groupChat = state.chats.find((c) => c.id === row.result.id);
      return groupChat?.avatarPath || row.result.avatarPath || "";
    }
    return "";
  };

  return (
    <button
      type="button"
      class={`search-result-row ${props.active ? "selected" : ""}`}
      onClick={props.onActivate}
    >
      <Avatar
        name={title()}
        path={avatarPath()}
        size={42 * props.model.preferences.uiScale}
        group={props.row.type === "group"}
      />
      <span class="search-result-copy">
        <strong>{title()}</strong>
        <span>{subtitle()}</span>
      </span>
      <Show when={props.row.type === "message"}>
        <span class="chat-time">{formatChatTime((props.row as { type: "message"; result: MessageSearchResult }).result.timestampMs)}</span>
      </Show>
    </button>
  );
}

function emptyLabel(filter: ChatFilter): string {
  switch (filter) {
    case "unread":
      return t("sidebar.noUnread");
    case "favorites":
      return "No favorite chats yet";
    case "groups":
      return t("sidebar.noGroups");
    case "channels":
      return t("sidebar.noChannels");
    case "archived":
      return t("sidebar.noArchived");
    default:
      return t("sidebar.noChats");
  }
}
