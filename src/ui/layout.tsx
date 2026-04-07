import { Show } from "solid-js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename } from "path";
import { useAppStore } from "./state.tsx";
import { useTheme } from "./theme.tsx";
import { ChatList } from "./components/chat-list.tsx";
import { ChatHeader } from "./components/chat-header.tsx";
import { Messages } from "./components/messages.tsx";
import { InputArea } from "./components/input.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { SearchOverlay } from "./overlays/search.tsx";
import { CommandPalette } from "./overlays/command-palette.tsx";
import { log } from "../utils/log.ts";
import { getRawMessage } from "../wa/media.ts";
import type { StoreQueries } from "../store/queries.ts";
import type { WASocket } from "@whiskeysockets/baileys";
import type { InputMethods } from "./types.ts";

function mediaTypeFromExt(ext: string): "image" | "video" | "audio" | "document" | "sticker" {
  const e = ext.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "bmp", "heic", "heif"].includes(e)) return "image";
  if (["webp"].includes(e)) return "sticker";
  if (["mp4", "mov", "avi", "mkv", "webm", "3gp"].includes(e)) return "video";
  if (["mp3", "ogg", "wav", "opus", "m4a", "aac", "flac"].includes(e)) return "audio";
  return "document";
}

export function Layout(props: {
  queries: StoreQueries;
  getSock: () => WASocket | null;
  onQuit: () => void;
  scrollRef?: (el: any) => void;
  chatListScrollRef?: (el: any) => void;
  inputMethodsRef?: (methods: InputMethods) => void;
  onScrollToBottom?: () => void;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  function handleSend(text: string) {
    const jid = store.selectedChatJid;
    const sock = props.getSock();
    if (!jid || !sock) return;

    // Check for @"quoted path", @'quoted path', or @path in the text — send as media
    const dblQuoteMatch = text.match(/@"([^"]+)"/);
    const sglQuoteMatch = text.match(/@'([^']+)'/);
    const plainMatch = text.match(/@(\S+)/);
    const atMatch = dblQuoteMatch || sglQuoteMatch || plainMatch;
    if (atMatch) {
      const filePath = atMatch[1]!;
      // Expand ~ to home
      const expanded = filePath.startsWith("~") ? (process.env.HOME || "") + filePath.slice(1) : filePath;
      if (existsSync(expanded)) {
        // Remove the @path (quoted or plain) from text to get caption
        const atPattern = dblQuoteMatch ? /@"[^"]+"?\s?/
          : sglQuoteMatch ? /@'[^']+'?\s?/
          : /@\S+\s?/;
        const caption = text.replace(atPattern, "").trim() || undefined;
        sendMedia(sock, jid, expanded, caption);
        helpers.setReplyTo(null);
        props.onScrollToBottom?.();
        return;
      }
    }

    const quotedId = store.replyToMessageId;
    const content: any = { text };
    const msgOpts: any = {};
    if (quotedId) {
      // Prefer the cached raw WAMessage — Baileys needs the full protobuf
      // to build a valid contextInfo for media replies. Reconstructing from
      // our flat MessageRow only produces a fake `conversation` (text), which
      // the WA server can't match against image/video/sticker originals,
      // making the reply silently fail or render as a broken empty quote.
      const rawQuoted = getRawMessage(quotedId);
      if (rawQuoted) {
        msgOpts.quoted = rawQuoted;
      } else {
        // LRU evicted the raw cache (>200 messages back). Fall back to the
        // text-only stub — works for text replies, degrades for media.
        const quoted = props.queries.getMessage(quotedId);
        if (quoted) {
          msgOpts.quoted = {
            key: { remoteJid: jid, id: quotedId, fromMe: quoted.from_me === 1 },
            message: { conversation: quoted.text || "" },
          };
        }
      }
    }
    sock.sendMessage(jid, content, msgOpts).catch(() => {});
    helpers.setReplyTo(null);
    props.onScrollToBottom?.();
  }

  async function sendMedia(sock: WASocket, jid: string, filePath: string, caption?: string) {
    const ext = filePath.split(".").pop() ?? "";
    const type = mediaTypeFromExt(ext);
    const buffer = await readFile(filePath);
    const fileName = basename(filePath);

    let content: any;
    switch (type) {
      case "image":
        content = { image: buffer, caption };
        break;
      case "sticker":
        content = { sticker: buffer };
        break;
      case "video":
        content = { video: buffer, caption };
        break;
      case "audio":
        content = { audio: buffer, ptt: false };
        break;
      case "document":
        content = { document: buffer, fileName, caption };
        break;
    }

    log("media", `Sending ${type}: ${fileName}`);
    sock.sendMessage(jid, content).catch((e: Error) => {
      log("media", `Send failed: ${e.message}`);
    });
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        {/* Chat list — 30% */}
        <box width="30%" flexDirection="column" flexShrink={0}>
          <ChatList queries={props.queries} scrollRef={props.chatListScrollRef} />
        </box>

        {/* Main area — 70% */}
        <box flexGrow={1} flexDirection="column">
          <ChatHeader queries={props.queries} />
          <Messages queries={props.queries} scrollRef={props.scrollRef} />
          <InputArea
            queries={props.queries}
            onSend={handleSend}
            inputMethodsRef={props.inputMethodsRef}
          />
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
