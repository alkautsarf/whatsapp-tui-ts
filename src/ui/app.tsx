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
  let chatListScrollRef: any;

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
      if (chatListScrollRef) {
        const itemH = 2;
        const cursorY = newIdx * itemH;
        const viewTop = chatListScrollRef.scrollTop;
        const viewH = dims().height - 3; // terminal height minus borders + status bar
        const pad = 6;
        if (cursorY < viewTop + pad) {
          chatListScrollRef.scrollTop = Math.max(0, cursorY - pad);
        } else if (cursorY + itemH > viewTop + viewH - pad) {
          chatListScrollRef.scrollTop = cursorY + itemH - viewH + pad;
        }
      }
    },

    onJumpChatList(pos) {
      const chats = store.chats;
      if (chats.length === 0) return;
      if (pos === "first") {
        helpers.setHighlightedChatJid(chats[0]!.jid);
        if (chatListScrollRef) chatListScrollRef.scrollTop = 0;
      } else {
        helpers.setHighlightedChatJid(chats[chats.length - 1]!.jid);
        if (chatListScrollRef) chatListScrollRef.scrollTop = chatListScrollRef.scrollHeight;
      }
    },

    onJumpMessages(pos) {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      if (pos === "first") {
        helpers.setSelectedMessageIndex(msgs.length - 1);
        if (messagesScrollRef) messagesScrollRef.scrollTop = 0;
      } else {
        helpers.setSelectedMessageIndex(0);
        if (messagesScrollRef) messagesScrollRef.scrollTop = messagesScrollRef.scrollHeight;
      }
    },

    onScrollMessages(dir) {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const maxIdx = msgs.length - 1;
      const newIdx = Math.max(0, Math.min(maxIdx, store.selectedMessageIndex - dir));
      helpers.setSelectedMessageIndex(newIdx);
      const targetMsg = msgs[newIdx];
      const newlines = targetMsg?.text ? (targetMsg.text.match(/\n/g)?.length ?? 0) : 0;
      messagesScrollRef?.scrollBy(dir * (newlines + 2));
    },

    onScrollMessagesPage(dir) {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs) return;
      const maxIdx = msgs.length - 1;
      const step = 10;
      const newIdx = Math.max(0, Math.min(maxIdx, store.selectedMessageIndex - dir * step));
      helpers.setSelectedMessageIndex(newIdx);
      messagesScrollRef?.scrollBy(dir, "viewport");
    },

    onYankMessage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (msg?.text) {
        const b64 = Buffer.from(msg.text).toString("base64");
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    },

    onReply() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
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
            chatListScrollRef={(el) => (chatListScrollRef = el)}
            onScrollToBottom={() => {
              helpers.setSelectedMessageIndex(0);
              const jid = store.selectedChatJid;
              if (jid) helpers.selectChat(jid);
            }}
          />
        </Match>
      </Switch>
    </box>
  );
}
