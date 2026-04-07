import { Show } from "solid-js";
import { existsSync, statSync } from "fs";
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

type MediaType = "image" | "video" | "audio" | "document" | "sticker";

function mediaTypeFromExt(ext: string): MediaType {
  const e = ext.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "bmp", "heic", "heif"].includes(e)) return "image";
  if (["webp"].includes(e)) return "sticker";
  if (["mp4", "mov", "avi", "mkv", "webm", "3gp"].includes(e)) return "video";
  if (["mp3", "ogg", "wav", "opus", "m4a", "aac", "flac"].includes(e)) return "audio";
  return "document";
}

// Validated against WhatsApp's official limits — see README.md and the FAQ
// at https://faq.whatsapp.com/239536730601513/?locale=en_US (videos) plus the
// 2GB document announcement at
// https://blog.whatsapp.com/reactions-2gb-file-sharing-512-groups
//
// Bytes, not MB — 1024-based.
const MEDIA_SIZE_LIMITS_BYTES: Record<MediaType, number> = {
  image:    16 * 1024 * 1024,         //  16 MB
  video:    16 * 1024 * 1024,         //  16 MB (WhatsApp Web/app auto-compresses
                                      //         client-side; baileys does NOT, so
                                      //         we have to enforce the wire limit)
  audio:    16 * 1024 * 1024,         //  16 MB
  sticker:   1 * 1024 * 1024,         //   1 MB (WebP sticker spec)
  document: 2 * 1024 * 1024 * 1024,   //   2 GB (WhatsApp Web only)
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
    const fileName = basename(filePath);

    try {
      const ext = filePath.split(".").pop() ?? "";
      const type = mediaTypeFromExt(ext);

      // Pre-validate file size BEFORE allocating a multi-GB buffer. Without
      // this guard, a 3 GB video would either OOM Bun or crash deep inside
      // baileys' upload pipeline (the fs WriteStream construct→destroy stack
      // trace that escaped the renderer in v0.4.7 and earlier).
      const stat = statSync(filePath);
      const limit = MEDIA_SIZE_LIMITS_BYTES[type];
      if (stat.size > limit) {
        const msg = `${type} too large: ${formatBytes(stat.size)} (limit ${formatBytes(limit)})`;
        log("media", `${msg} — ${fileName}`);
        helpers.showToast(msg, "error", 8000);
        return;
      }

      const buffer = await readFile(filePath);

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

      log("media", `Sending ${type}: ${fileName} (${formatBytes(stat.size)})`);
      try {
        await sock.sendMessage(jid, content);
      } catch (e) {
        const msg = (e as Error)?.message ?? "unknown error";
        log("media", `Send failed: ${msg}`);
        helpers.showToast(`Failed to send ${type}: ${msg}`, "error", 8000);
      }
    } catch (e) {
      // Catches statSync ENOENT/EACCES, readFile errors, anything else
      // synchronous or async that escapes. Renderer never sees the throw.
      const msg = (e as Error)?.message ?? "unknown error";
      log("media", `Media send pipeline failed for ${fileName}: ${msg}`);
      helpers.showToast(`Cannot send ${fileName}: ${msg}`, "error", 8000);
    }
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
