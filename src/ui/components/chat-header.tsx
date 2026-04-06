import { Show, createMemo } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import type { StoreQueries } from "../../store/queries.ts";

export function ChatHeader(props: { queries: StoreQueries }) {
  const { store } = useAppStore();
  const theme = useTheme();

  const name = createMemo(() => {
    const jid = store.selectedChatJid;
    if (!jid) return "";
    // Try to find from chat list first
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
    // Format phone number from JID
    const phone = jid.split("@")[0];
    return phone ? `+${phone}` : "";
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
          <text fg={theme.online}>{"\u25cf connected"}</text>
        </box>
        <text fg={theme.textMuted}>{subtitle()}</text>
      </box>
    </Show>
  );
}
