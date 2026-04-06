import { For, Show } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import type { StoreQueries } from "../../store/queries.ts";

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

export function ChatList(props: { queries: StoreQueries }) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  const isFocused = () => store.focusZone === "chat-list";

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={isFocused() ? theme.borderFocused : theme.border}
      title=" Chats "
      titleAlignment="left"
    >
      <Show
        when={store.chats.length > 0}
        fallback={
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={theme.textMuted}>Waiting for sync...</text>
          </box>
        }
      >
        <scrollbox
          flexGrow={1}
          stickyScroll={false}
          viewportCulling
        >
          <For each={store.chats}>
            {(chat, idx) => {
              const isSelected = () => chat.jid === store.highlightedChatJid;
              const name = () =>
                chat.name || props.queries.resolveContactName(chat.jid);
              const time = () => formatTime(chat.last_msg_ts);
              const unread = () => chat.unread ?? 0;
              const isPinned = () => (chat.pinned ?? 0) > 0;
              const isMuted = () => (chat.muted_until ?? 0) > 0;

              return (
                <box
                  flexDirection="column"
                  backgroundColor={isSelected() ? theme.bgSelected : undefined}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  {/* Line 1: name + timestamp */}
                  <box flexDirection="row" justifyContent="space-between">
                    <box flexDirection="row" flexShrink={1}>
                      <Show when={isSelected()}>
                        <text fg={theme.borderAccent}>{"\u258c"}</text>
                      </Show>
                      <Show when={isPinned()}>
                        <text fg={theme.pin}>{" \u25cf"}</text>
                      </Show>
                      <Show when={isMuted()}>
                        <text fg={theme.textMuted}>{" \u00d7"}</text>
                      </Show>
                      <text
                        fg={isSelected() ? theme.textStrong : theme.text}
                        attributes={unread() > 0 ? 1 : 0}
                      >
                        {" " + truncate(name(), 28)}
                      </text>
                    </box>
                    <text fg={theme.textMuted}>{time()}</text>
                  </box>

                  {/* Line 2: preview + unread badge */}
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>
                      {"  " + truncate(chat.jid.endsWith("@g.us") ? "(group)" : "", 30)}
                    </text>
                    <Show when={unread() > 0}>
                      <text fg={theme.unread} attributes={1}>
                        {" " + String(unread())}
                      </text>
                    </Show>
                  </box>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}
