import { createSignal, For, Show } from "solid-js";
import { Plus, X } from "lucide-solid";
import type { AppModel } from "../state/app";
import { formatTime } from "../lib/format";
import { MessageContent } from "./MessageBubble";
import { IconButton } from "./Primitives";
import { t } from "../lib/i18n";

export function NewsletterPanel(props: { model: AppModel }) {
  const { state, actions } = props.model;
  const [subscribeOpen, setSubscribeOpen] = createSignal(false);
  const [inviteKey, setInviteKey] = createSignal("");
  const [createOpen, setCreateOpen] = createSignal(false);
  const [channelName, setChannelName] = createSignal("");
  const [channelDesc, setChannelDesc] = createSignal("");

  const newsletter = () => state.selectedNewsletter;

  return (
    <div class="newsletter-panel">
      <header class="conversation-header">
        <div class="conversation-contact" style={{ cursor: "default" }}>
          <span class="avatar" style={{ "--avatar-hue": "160", width: "41px", height: "41px", "min-width": "41px" }}>{avatarLabel(newsletter()?.name)}</span>
          <span class="conversation-heading">
            <strong>
              {newsletter()?.name || "Channel"}
              <Show when={newsletter()?.local}><span class="role-badge">local</span></Show>
              <Show when={newsletter()?.muted}><span class="role-badge">muted</span></Show>
            </strong>
            <span>{newsletter()?.description || t("channel.postsLabel")}</span>
          </span>
        </div>
        <Show when={newsletter()}>
          <button
            type="button"
            class="secondary-button"
            onClick={() => actions.toggleNewsletterMute(newsletter()!.jid)}
          >
            {newsletter()!.muted ? "Unmute" : "Mute"}
          </button>
        </Show>
        <IconButton
          label={t("channel.unfollow")}
          onClick={() => {
            if (newsletter()) void actions.unsubscribeNewsletter(newsletter()!.jid);
          }}
        >
          <X size={18} />
        </IconButton>
      </header>

      <div class="newsletter-posts">
        <Show
          when={!state.newsletterLoading}
          fallback={<div class="newsletter-empty"><span class="spinner" aria-label="Loading channel posts" /></div>}
        >
          <Show when={state.newsletterPosts.length > 0} fallback={<div class="newsletter-empty">{t("channel.postsEmpty")}</div>}>
            <For each={state.newsletterPosts}>
              {(message) => (
                <div class="newsletter-post">
                  <div class="newsletter-post-meta">
                    <strong>{newsletter()?.name}</strong>
                    <span>{formatTime(message.timestampMs)}</span>
                  </div>
                  <MessageContent message={message} model={props.model} chatId={newsletter()?.jid ?? message.chatId} />
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      <Show when={subscribeOpen()}>
        <div class="newsletter-subscribe" role="dialog" aria-modal="true" aria-label={t("channel.subscribeTitle")}>
          <h3>{t("channel.subscribeTitle")}</h3>
          <p>{t("channel.subscribeHint")}</p>
          <input
            type="text"
            value={inviteKey()}
            placeholder={t("channel.invitePlaceholder")}
            aria-label="Channel invite link"
            onInput={(event) => setInviteKey(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const key = inviteKey();
                if (key.trim()) void actions.subscribeNewsletter(key);
              }
            }}
          />
          <div class="newsletter-subscribe-actions">
            <button type="button" class="secondary-button" onClick={() => setSubscribeOpen(false)}>{t("channel.cancel")}</button>
            <button
              type="button"
              class="primary-button"
              disabled={!inviteKey().trim()}
              onClick={() => {
                const key = inviteKey();
                if (key.trim()) void actions.subscribeNewsletter(key);
              }}
            >
              {t("channel.follow")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={!subscribeOpen() && !createOpen()}>
        <div class="newsletter-footer">
          <button type="button" class="primary-button" onClick={() => setSubscribeOpen(true)}>
            <Plus size={16} />
            {t("channel.follow")}
          </button>
          <button type="button" class="secondary-button" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            New local channel
          </button>
        </div>
      </Show>

      <Show when={createOpen()}>
        <div class="newsletter-subscribe" role="dialog" aria-modal="true" aria-label="Create local channel">
          <h3>New local channel</h3>
          <p>Stored in memory only; linked-device scope has no channel RPC.</p>
          <input
            type="text"
            value={channelName()}
            placeholder="Channel name"
            aria-label="Channel name"
            onInput={(event) => setChannelName(event.currentTarget.value)}
          />
          <input
            type="text"
            value={channelDesc()}
            placeholder="Description (optional)"
            aria-label="Channel description"
            onInput={(event) => setChannelDesc(event.currentTarget.value)}
          />
          <div class="newsletter-subscribe-actions">
            <button type="button" class="secondary-button" onClick={() => setCreateOpen(false)}>{t("channel.cancel")}</button>
            <button
              type="button"
              class="primary-button"
              disabled={!channelName().trim()}
              onClick={() => {
                actions.createLocalChannel(channelName(), channelDesc());
                setChannelName("");
                setChannelDesc("");
                setCreateOpen(false);
              }}
            >
              Create
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function avatarLabel(value: string | undefined): string {
  return value?.trim().slice(0, 1).toUpperCase() || "C";
}
