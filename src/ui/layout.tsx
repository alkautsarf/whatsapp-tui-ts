import { Show } from "solid-js";
import { existsSync, statSync, mkdirSync, copyFileSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join, extname } from "path";
import { useAppStore } from "./state.tsx";
import { useTheme } from "./theme.tsx";
import { ChatList } from "./components/chat-list.tsx";
import { ChatHeader } from "./components/chat-header.tsx";
import { Messages } from "./components/messages.tsx";
import { InputArea } from "./components/input.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { SearchOverlay } from "./overlays/search.tsx";
import { CommandPalette } from "./overlays/command-palette.tsx";
import { HelpOverlay } from "./overlays/help.tsx";
import { EmojiPicker } from "./overlays/emoji-picker.tsx";
import { MessageSearchOverlay } from "./overlays/message-search.tsx";
import { ConfirmModal } from "./overlays/confirm.tsx";
import { ForwardOverlay } from "./overlays/forward.tsx";
import { InfoOverlay } from "./overlays/info.tsx";
import { log } from "../utils/log.ts";
import { getRawMessage, downloadAndCache } from "../wa/media.ts";
import { parsePlaceholders, clearPending, type PendingAttachment } from "../utils/attachment-registry.ts";
import { finalizeMentions, clearMentions } from "../utils/mention-registry.ts";
import type { StoreQueries } from "../store/queries.ts";
import type { WASocket, WAMessageKey } from "@whiskeysockets/baileys";
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

  // Capture inputMethods locally so the emoji picker (rendered as an
  // overlay below) can insert at the cursor position via this layout
  // without needing to plumb the input ref through every overlay's props.
  let localInputMethods: InputMethods | null = null;
  // Same trick for the messages scrollbox ref so the message-search
  // overlay can scrollChildIntoView() when the user picks a result.
  let localMessagesScrollRef: any = null;

  function handleSend(text: string) {
    const jid = store.selectedChatJid;
    const sock = props.getSock();
    if (!jid || !sock) return;

    // Path 1: parse [Image N] / [Video N] / [File N] placeholders from the
    // attachment registry. This is the primary path for Ctrl+V image paste
    // and drag-drop, both of which insert placeholder labels at the cursor.
    // The registry maps each label to its real file path so we can send the
    // actual files without exposing temp paths in the input box.
    const { attachments, textWithoutPlaceholders } = parsePlaceholders(text);
    if (attachments.length > 0) {
      // Group mentions in the caption: rewrite to wire format and pull JIDs
      // BEFORE clearMentions wipes the registry.
      let captionText = textWithoutPlaceholders;
      let captionMentionJids: string[] = [];
      if (jid.endsWith("@g.us") && captionText) {
        const finalized = finalizeMentions(captionText);
        captionText = finalized.text;
        captionMentionJids = finalized.jids;
      }
      sendAttachmentsWithCaption(sock, jid, attachments, captionText, captionMentionJids);
      clearPending();
      clearMentions();
      helpers.setReplyTo(null);
      props.onScrollToBottom?.();
      return;
    }

    // Path 2: legacy @path manual entry (still supported for power users
    // who type paths directly with the @ syntax). The pattern MUST start
    // with `/` or `~/` so we don't accidentally match `@chris_2` (a group
    // mention token) as a file path. Falls through to text send if no
    // @path pattern matches a real file.
    const dblQuoteMatch = text.match(/@"([^"]+)"/);
    const sglQuoteMatch = text.match(/@'([^']+)'/);
    // Path-only plain match: @ followed by `/` or `~/` then non-whitespace.
    const plainMatch = text.match(/@((?:\/|~\/)\S+)/);
    const atMatch = dblQuoteMatch || sglQuoteMatch || plainMatch;
    if (atMatch) {
      const filePath = atMatch[1]!;
      // Expand ~ to home
      const expanded = filePath.startsWith("~") ? (process.env.HOME || "") + filePath.slice(1) : filePath;
      if (existsSync(expanded)) {
        // Remove the @path (quoted or plain) from text to get caption
        const atPattern = dblQuoteMatch ? /@"[^"]+"?\s?/
          : sglQuoteMatch ? /@'[^']+'?\s?/
          : /@(?:\/|~\/)\S+\s?/;
        let caption = text.replace(atPattern, "").trim() || undefined;
        // If the remaining caption text has group mentions, finalize them
        // before sending so the recipient renders them correctly.
        let captionMentions: string[] = [];
        if (jid.endsWith("@g.us") && caption) {
          const finalized = finalizeMentions(caption);
          caption = finalized.text;
          captionMentions = finalized.jids;
        }
        sendMedia(sock, jid, expanded, caption, captionMentions);
        clearMentions();
        helpers.setReplyTo(null);
        props.onScrollToBottom?.();
        return;
      }
    }

    const quotedId = store.replyToMessageId;

    // Group mentions: rewrite `@<sanitized-name>` tokens in the visible
    // text to WA's wire format `@<bare-id>` and collect the resolved JIDs
    // for the `mentions` array. Recipients' WhatsApp clients render the
    // wire token as the contact's local display name.
    let outgoingText = text;
    let mentionJids: string[] = [];
    if (jid.endsWith("@g.us")) {
      const finalized = finalizeMentions(text);
      outgoingText = finalized.text;
      mentionJids = finalized.jids;
    }

    const content: any = { text: outgoingText };
    if (mentionJids.length > 0) {
      content.mentions = mentionJids;
    }
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
    clearMentions();
    helpers.setReplyTo(null);
    props.onScrollToBottom?.();
  }

  /**
   * Send a series of pending attachments plus an optional caption.
   *   - Single attachment + text → send the attachment with text as caption
   *     (matches the existing one-image-with-caption behavior).
   *   - Multiple attachments → send each in order WITHOUT caption, then send
   *     the caption text as a final standalone text message (if any).
   *
   * Each attachment goes through `sendMedia` which handles size validation,
   * try/catch error handling, and the toast on failure.
   */
  async function sendAttachmentsWithCaption(
    sock: WASocket,
    jid: string,
    attachments: PendingAttachment[],
    text: string,
    mentionJids: string[] = [],
  ) {
    if (attachments.length === 1) {
      const att = attachments[0]!;
      sendMedia(sock, jid, att.path, text || undefined, mentionJids);
      return;
    }

    // Multi-attachment: send each as a standalone media message in order,
    // then send any remaining caption text as a final text-only message.
    for (const att of attachments) {
      sendMedia(sock, jid, att.path);
    }
    if (text) {
      try {
        const trailing: any = { text };
        if (mentionJids.length > 0) trailing.mentions = mentionJids;
        await sock.sendMessage(jid, trailing);
      } catch (e) {
        log("media", `Trailing text send failed: ${(e as Error)?.message}`);
        helpers.showToast(`Trailing text failed: ${(e as Error)?.message ?? "unknown"}`, "error");
      }
    }
  }

  async function sendMedia(sock: WASocket, jid: string, filePath: string, caption?: string, mentionJids: string[] = []) {
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
      // Carry through any mention JIDs from a caption that referenced
      // group participants. Stickers and audio (no caption) don't get them.
      if (mentionJids.length > 0 && type !== "sticker" && type !== "audio") {
        content.mentions = mentionJids;
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

  // ── Confirm modal dispatcher ──────────────────────────────────────
  // Maps the picked option value back to a real action based on the
  // confirm payload's intent. Centralized here so the ConfirmModal stays
  // a dumb UI component.
  async function dispatchConfirm(value: string) {
    const payload = store.overlay?.confirm;
    if (!payload || value === "cancel") return;

    if (payload.intent === "delete-message") {
      const msgId = payload.data?.msgId as string | undefined;
      const jid = payload.data?.jid as string | undefined;
      if (!msgId || !jid) return;
      const msg = props.queries.getMessage(msgId);
      if (!msg) {
        helpers.showToast("Message not found", "error", 3000);
        return;
      }

      // delete-me must stay local — WA's tombstone propagates to the
      // other party, which is the wrong semantic for "for me".
      if (value === "delete-me") {
        try {
          props.queries.markMessageDeleted(msgId);
          if (store.selectedChatJid === jid) helpers.selectChat(jid);
          helpers.showToast("Deleted locally", "info", 2000);
        } catch (e) {
          helpers.showToast(`Local delete failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000);
        }
        return;
      }

      if (value === "delete-everyone") {
        const sock = props.getSock();
        if (!sock) {
          helpers.showToast("Not connected", "error", 3000);
          return;
        }
        const key: WAMessageKey = {
          remoteJid: jid,
          id: msgId,
          fromMe: msg.from_me === 1,
          participant: jid.endsWith("@g.us") ? (msg.sender_jid ?? undefined) : undefined,
        };
        try {
          await sock.sendMessage(jid, { delete: key });
          props.queries.markMessageDeleted(msgId);
          if (store.selectedChatJid === jid) helpers.selectChat(jid);
          helpers.showToast("Message deleted for everyone", "info", 2500);
        } catch (e) {
          helpers.showToast(`Delete failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000);
        }
        return;
      }
      return;
    }

    if (payload.intent === "save-media") {
      const msgId = payload.data?.msgId as string | undefined;
      if (!msgId) return;
      const msg = props.queries.getMessage(msgId);
      if (!msg) {
        helpers.showToast("Message not found", "error", 3000);
        return;
      }

      // Resolve the source path. Try msg.media_path first; if absent or the
      // file doesn't exist, attempt an on-the-fly download via
      // downloadAndCache (which uses the cached raw WAMessage or stored
      // media_key + direct_path metadata).
      let srcPath = msg.media_path;
      if (!srcPath || !existsSync(srcPath)) {
        const sock = props.getSock();
        if (!sock) {
          helpers.showToast("Not connected — can't fetch media", "error", 3000);
          return;
        }
        helpers.showToast("Downloading media…", "info", 1500);
        try {
          srcPath = await downloadAndCache(sock, msg, props.queries);
        } catch (e) {
          helpers.showToast(`Download failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000);
          return;
        }
        if (!srcPath || !existsSync(srcPath)) {
          helpers.showToast("Media unavailable — too old or expired", "error", 4000);
          return;
        }
      }

      try {
        const downloadsDir = join(process.env.HOME || "", "Downloads", "wa-tui");
        mkdirSync(downloadsDir, { recursive: true });
        // Use the original file name if WhatsApp gave us one, otherwise the
        // cache filename (msgId.ext). basename() guards against path
        // traversal — the sender controls `file_name` and could include
        // `../` segments to write outside ~/Downloads/wa-tui/.
        const rawName = msg.file_name && msg.file_name.length > 0
          ? msg.file_name
          : basename(srcPath);
        const destName = basename(rawName);
        const destPath = join(downloadsDir, destName);
        copyFileSync(srcPath, destPath);
        const displayPath = destPath.startsWith(process.env.HOME || "")
          ? "~" + destPath.slice((process.env.HOME || "").length)
          : destPath;
        helpers.showToast(`Saved to ${displayPath}`, "info", 4000);
      } catch (e) {
        helpers.showToast(`Save failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000);
      }
      return;
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
          <Messages
            queries={props.queries}
            scrollRef={(el: any) => {
              localMessagesScrollRef = el;
              props.scrollRef?.(el);
            }}
          />
          <InputArea
            queries={props.queries}
            onSend={handleSend}
            inputMethodsRef={(methods) => {
              localInputMethods = methods;
              props.inputMethodsRef?.(methods);
            }}
          />
        </box>
      </box>

      <StatusBar />

      {/* Overlays. Note: HelpOverlay strips emojis from underlying chat list
          while it's open due to an OpenTUI compositor quirk with wide chars
          under absolute-positioned layers. Acknowledged trade-off — the help
          modal is brief enough to look at and dismiss, emojis come back on
          close. Tried inline replacement to avoid the strip, elpabl0
          preferred the floating overlay style. */}
      <Show when={store.overlay?.type === "search"}>
        <SearchOverlay queries={props.queries} />
      </Show>
      <Show when={store.overlay?.type === "command-palette"}>
        <CommandPalette onQuit={props.onQuit} />
      </Show>
      <Show when={store.overlay?.type === "help"}>
        <HelpOverlay />
      </Show>
      <Show when={store.overlay?.type === "emoji-picker"}>
        <EmojiPicker
          onPick={(char) => {
            const intent = store.overlay?.emojiPickIntent ?? "insert";
            const targetMsgId = store.overlay?.emojiTargetMsgId;
            if (intent === "react" && targetMsgId) {
              // React mode — fire a reaction to the target message instead
              // of inserting into the input. After picking, return to NORMAL
              // mode + messages focus.
              const sock = props.getSock();
              const jid = store.selectedChatJid;
              const msg = props.queries.getMessage(targetMsgId);
              if (sock && jid && msg) {
                const key: WAMessageKey = {
                  remoteJid: jid,
                  id: targetMsgId,
                  fromMe: msg.from_me === 1,
                  participant: jid.endsWith("@g.us") ? (msg.sender_jid ?? undefined) : undefined,
                };
                sock.sendMessage(jid, { react: { text: char, key } })
                  .then(() => {
                    // Persist the reaction locally so the message bubble
                    // shows it right away. WA doesn't echo our own reactions
                    // back via messages.upsert, so without this the user
                    // would see the reaction on their phone but nothing in
                    // the TUI.
                    try { props.queries.setReaction(targetMsgId, char); } catch {}
                    if (store.selectedChatJid === jid) helpers.selectChat(jid);
                    helpers.showToast(`Reacted ${char}`, "info", 1500);
                  })
                  .catch((e) => helpers.showToast(`React failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000));
              }
              helpers.setMode("normal");
              helpers.setFocusZone("messages");
              return;
            }
            // Insert mode (default) — back to INSERT + input focus, then
            // inject at cursor.
            helpers.setMode("insert");
            helpers.setFocusZone("input");
            localInputMethods?.insertAtCursor(char);
          }}
        />
      </Show>
      <Show when={store.overlay?.type === "message-search"}>
        <MessageSearchOverlay
          queries={props.queries}
          onJump={(msg) => {
            const jid = store.selectedChatJid;
            if (!jid) return;
            const msgs = store.messages[jid] ?? [];
            const idx = msgs.findIndex((m) => m.id === msg.id);
            if (idx >= 0) {
              // Found in the loaded slice — set selected index, focus the
              // messages zone, and scroll the message into view via the
              // captured scrollbox ref. Same scroll mechanism as the j/k
              // navigation in app.tsx.
              helpers.setSelectedMessageIndex(idx);
              helpers.setFocusZone("messages");
              try {
                localMessagesScrollRef?.scrollChildIntoView?.(`msg-${msg.id}`);
              } catch {}
            } else {
              // Message exists in the DB but not in the currently-loaded
              // slice — it's older than what's been hydrated. v1 limitation:
              // tell the user instead of silently failing.
              helpers.showToast(
                "Message found in history but not loaded yet — scroll up first",
                "info",
                6000,
              );
            }
          }}
        />
      </Show>
      <Show when={store.overlay?.type === "confirm" && store.overlay?.confirm}>
        <ConfirmModal
          payload={store.overlay!.confirm!}
          onPick={(value) => dispatchConfirm(value)}
        />
      </Show>
      <Show when={store.overlay?.type === "forward"}>
        <ForwardOverlay
          queries={props.queries}
          onForward={(targetJid) => {
            const sourceMsgId = store.overlay?.forwardSourceMsgId;
            const sock = props.getSock();
            if (!sourceMsgId || !sock) return;

            const targetChat = store.chats.find((c) => c.jid === targetJid);
            const targetName = targetChat?.name ?? props.queries.resolveContactName(targetJid);

            // Try the LRU raw message cache first — gives us the full
            // protobuf which baileys' `forward` handler uses to preserve
            // media context (the cleanest path: same message bytes,
            // no re-upload).
            const rawMsg = getRawMessage(sourceMsgId);
            if (rawMsg) {
              sock
                .sendMessage(targetJid, { forward: rawMsg as any })
                .then(() => helpers.showToast(`Forwarded to ${targetName}`, "info", 2500))
                .catch((e) =>
                  helpers.showToast(`Forward failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000),
                );
              return;
            }

            // LRU evicted. Look up our DB row and decide:
            //   - Media message → download via media_key/direct_path,
            //     re-send as fresh media with caption (real forward
            //     semantics for media that's older than 200 messages)
            //   - Text only → synthesize a minimal WAMessage and forward
            //     as text via baileys
            const dbMsg = props.queries.getMessage(sourceMsgId);
            if (!dbMsg) {
              helpers.showToast("Source message not found", "error", 4000);
              return;
            }

            if (dbMsg.media_type) {
              helpers.showToast("Fetching media…", "info", 1500);
              (async () => {
                let path = dbMsg.media_path;
                if (!path || !existsSync(path)) {
                  try {
                    path = await downloadAndCache(sock, dbMsg, props.queries);
                  } catch (e) {
                    helpers.showToast(`Forward failed: ${(e as Error)?.message ?? "download error"}`, "error", 4000);
                    return;
                  }
                }
                if (!path || !existsSync(path)) {
                  helpers.showToast("Forward failed: media unavailable (too old or expired)", "error", 5000);
                  return;
                }
                // Await sendMedia so a download/upload error doesn't race
                // a misleading success toast onto the screen. sendMedia
                // owns its own per-failure toast.
                const caption = dbMsg.text ?? undefined;
                await sendMedia(sock, targetJid, path, caption);
                helpers.showToast(`Forwarded to ${targetName}`, "info", 2500);
              })();
              return;
            }

            // Text-only fallback: synthesize a minimal WAMessage and use
            // baileys' forward handler.
            const sourceJid = dbMsg.chat_jid;
            const synth: any = {
              key: {
                remoteJid: sourceJid,
                id: sourceMsgId,
                fromMe: dbMsg.from_me === 1,
                participant: sourceJid.endsWith("@g.us")
                  ? (dbMsg.sender_jid ?? undefined)
                  : undefined,
              },
              message: { conversation: dbMsg.text ?? "" },
              messageTimestamp: dbMsg.timestamp,
            };
            sock
              .sendMessage(targetJid, { forward: synth })
              .then(() => helpers.showToast(`Forwarded to ${targetName}`, "info", 2500))
              .catch((e) =>
                helpers.showToast(`Forward failed: ${(e as Error)?.message ?? "unknown"}`, "error", 4000),
              );
          }}
        />
      </Show>
      <Show when={store.overlay?.type === "info" && store.overlay?.infoChatJid}>
        <InfoOverlay
          queries={props.queries}
          getSock={props.getSock}
          chatJid={store.overlay!.infoChatJid!}
        />
      </Show>
    </box>
  );
}
