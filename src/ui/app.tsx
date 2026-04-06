import { Switch, Match } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useAppStore } from "./state.tsx";
import { useTheme } from "./theme.tsx";
import { useAppKeyboard } from "./keys.ts";
import { Layout } from "./layout.tsx";
import { QROverlay } from "./overlays/qr-code.tsx";
import type { StoreQueries } from "../store/queries.ts";
import type { WASocket } from "@whiskeysockets/baileys";

export function App(props: {
  queries: StoreQueries;
  getSock: () => WASocket | null;
  onQuit: () => void;
}) {
  const dims = useTerminalDimensions();
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  let messagesScrollRef: any;

  // Wire up keyboard
  useAppKeyboard({
    onQuit: props.onQuit,

    onSelectChat() {
      const jid = store.highlightedChatJid;
      if (jid) helpers.selectChat(jid);
    },

    onNavigateChatList(dir) {
      const chats = store.chats;
      if (chats.length === 0) return;
      const currentIdx = Math.max(0, chats.findIndex((c) => c.jid === store.highlightedChatJid));
      const newIdx = Math.max(0, Math.min(chats.length - 1, currentIdx + dir));
      helpers.setHighlightedChatJid(chats[newIdx]!.jid);
    },

    onJumpChatList(pos) {
      const chats = store.chats;
      if (chats.length === 0) return;
      if (pos === "first") helpers.setHighlightedChatJid(chats[0]!.jid);
      else helpers.setHighlightedChatJid(chats[chats.length - 1]!.jid);
    },

    onScrollMessages(dir) {
      messagesScrollRef?.scrollBy(dir);
    },

    onScrollMessagesPage(dir) {
      messagesScrollRef?.scrollBy(dir, "viewport");
    },

    onYankMessage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      // Yank the most recent message text
      const reversed = [...msgs].reverse();
      const idx = store.selectedMessageIndex;
      const msg = reversed[idx];
      if (msg?.text) {
        // Write to clipboard via OSC 52
        const b64 = Buffer.from(msg.text).toString("base64");
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    },

    onReply() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const reversed = [...msgs].reverse();
      const idx = store.selectedMessageIndex;
      const msg = reversed[idx];
      if (msg) {
        helpers.setReplyTo(msg.id);
        helpers.setMode("insert");
        helpers.setFocusZone("input");
      }
    },

  });

  return (
    <box
      width={dims().width}
      height={dims().height}
      flexDirection="column"
      backgroundColor={theme.bg}
    >
      <Switch>
        <Match when={store.connection.status === "connecting"}>
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={theme.textMuted}>Connecting to WhatsApp...</text>
          </box>
        </Match>

        <Match when={store.connection.status === "qr"}>
          <QROverlay data={store.connection.qrData!} />
        </Match>

        <Match when={store.connection.status === "disconnected"}>
          <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column" gap={1}>
            <text fg={theme.error}>Disconnected from WhatsApp</text>
            <text fg={theme.textMuted}>Press q to quit</text>
          </box>
        </Match>

        <Match when={store.connection.status === "connected" || store.connection.status === "reconnecting"}>
          <Layout
            queries={props.queries}
            getSock={props.getSock}
            onQuit={props.onQuit}
            scrollRef={(el) => (messagesScrollRef = el)}
          />
        </Match>
      </Switch>
    </box>
  );
}
