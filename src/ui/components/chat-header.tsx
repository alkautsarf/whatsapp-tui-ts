import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import type { StoreQueries } from "../../store/queries.ts";

export function ChatHeader(props: { queries: StoreQueries }) {
  const { store } = useAppStore();
  const theme = useTheme();

  const name = createMemo(() => {
    const jid = store.selectedChatJid;
    if (!jid) return "";
    const chat = store.chats.find((c) => c.jid === jid);
    if (chat?.name) return chat.name;
    return props.queries.resolveContactName(jid);
  });

  const isGroup = createMemo(() => {
    return store.selectedChatJid?.endsWith("@g.us") ?? false;
  });

  const subtitle = createMemo(() => {
    const jid = store.selectedChatJid;
    if (!jid) return "";
    if (isGroup()) return "group";
    const phone = jid.split("@")[0];
    return phone ? `+${phone}` : "";
  });

  // Typing indicator — tick every 2s to expire stale entries
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 2000);
  onCleanup(() => clearInterval(tick));

  const isTyping = createMemo(() => {
    const jid = store.selectedChatJid;
    if (!jid) return false;
    const ts = store.typingJids[jid];
    if (!ts || ts === 0) return false;
    return (now() - ts) < 6;
  });

  return (
    <Show when={store.selectedChatJid}>
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={theme.border}
        paddingLeft={1}
        paddingRight={1}
        height={4}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textStrong} attributes={1}>
            {name()}
          </text>
          <text fg={store.connection.status === "connected" ? theme.online
            : store.connection.status === "reconnecting" ? theme.warning
            : theme.error}>
            {"\u25cf " + store.connection.status}
          </text>
        </box>
        <Show when={isTyping()} fallback={<text fg={theme.textMuted}>{subtitle()}</text>}>
          <text fg={theme.success}>{"typing..."}</text>
        </Show>
      </box>
    </Show>
  );
}
