import { Show } from "solid-js";
import { useAppStore } from "./state.tsx";
import { useTheme } from "./theme.tsx";
import { ChatList } from "./components/chat-list.tsx";
import { ChatHeader } from "./components/chat-header.tsx";
import { Messages } from "./components/messages.tsx";
import { InputArea } from "./components/input.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { SearchOverlay } from "./overlays/search.tsx";
import { CommandPalette } from "./overlays/command-palette.tsx";
import type { StoreQueries } from "../store/queries.ts";
import type { WASocket } from "@whiskeysockets/baileys";

export function Layout(props: {
  queries: StoreQueries;
  getSock: () => WASocket | null;
  onQuit: () => void;
  scrollRef?: (el: any) => void;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  function handleSend(text: string) {
    const jid = store.selectedChatJid;
    const sock = props.getSock();
    if (!jid || !sock) return;
    const quotedId = store.replyToMessageId;
    const opts: any = { text };
    if (quotedId) {
      const quoted = props.queries.getMessage(quotedId);
      if (quoted) {
        opts.quoted = {
          key: { remoteJid: jid, id: quotedId, fromMe: quoted.from_me === 1 },
          message: { conversation: quoted.text || "" },
        };
      }
    }
    sock.sendMessage(jid, opts).catch(() => {});
    helpers.setReplyTo(null);
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        {/* Chat list — 30% */}
        <box width="30%" flexDirection="column" flexShrink={0}>
          <ChatList queries={props.queries} />
        </box>

        {/* Main area — 70% */}
        <box flexGrow={1} flexDirection="column">
          <ChatHeader queries={props.queries} />
          <Messages queries={props.queries} scrollRef={props.scrollRef} />
          <InputArea queries={props.queries} onSend={handleSend} />
        </box>
      </box>

      <StatusBar />

      {/* Overlays */}
      <Show when={store.overlay?.type === "search"}>
        <SearchOverlay queries={props.queries} />
      </Show>
      <Show when={store.overlay?.type === "command-palette"}>
        <CommandPalette onQuit={props.onQuit} />
      </Show>
    </box>
  );
}
