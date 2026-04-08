import { Switch, Match, createEffect } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useAppStore } from "./state.tsx";
import { useTheme } from "./theme.tsx";
import { useAppKeyboard } from "./keys.ts";
import { Layout } from "./layout.tsx";
import { QROverlay } from "./overlays/qr-code.tsx";
import { encodeForInline, transmitImages, clearAllImages, showFullView, IMAGE_MEDIA_TYPES, isInTmux, kittyWrite, type EncodedImage } from "./image.ts";
import { downloadAndCache, isDownloadable } from "../wa/media.ts";
import { log } from "../utils/log.ts";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolveMentionDisplay, truncate } from "../utils/text.ts";
import type { StoreQueries } from "../store/queries.ts";
import type { WASocket } from "@whiskeysockets/baileys";
import type { InputMethods, ConfirmOption } from "./types.ts";

export function App(props: {
  queries: StoreQueries;
  getSock: () => WASocket | null;
  onQuit: () => void;
  getRenderer: () => any;
}) {
  const dims = useTerminalDimensions();
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  let messagesScrollRef: any;
  let chatListScrollRef: any;
  const subscribedPresence = new Set<string>();
  createEffect(() => {
    if (store.connection.status === "connected") subscribedPresence.clear();
  });

  // Track which messages we've already started encoding (prevents reactive loops)
  const encodingStarted = new Set<string>();

  let inputMethods: InputMethods | null = null;

  // Watch for new image messages in the currently viewed chat
  createEffect(() => {
    const jid = store.selectedChatJid;
    if (!jid) return;
    const msgs = store.messages[jid];
    if (!msgs) return;
    const imageMsgs = msgs.filter(m => IMAGE_MEDIA_TYPES.has(m.media_type ?? m.type));
    // Filter using the local Set, NOT the reactive store (breaks the loop)
    const unencoded = imageMsgs.filter(m => !encodingStarted.has(m.id));
    if (unencoded.length > 0) {
      for (const m of unencoded) encodingStarted.add(m.id);
      log("image", `Chat ${jid.slice(0,12)}...: ${unencoded.length} new images to encode`);
      encodeImagesForChat(unencoded);
    }
  });

  // Encode images for a chat — thumbnails first (instant), downloads in background
  async function encodeImagesForChat(msgs: import("../store/queries.ts").MessageRow[]) {
    msgs = msgs.filter(m => IMAGE_MEDIA_TYPES.has(m.media_type ?? m.type));
    if (msgs.length === 0) return;
    const fs = await import("fs");
    const sock = props.getSock();

    // Phase 1: Encode from local cache or thumbnails (instant, no network)
    const encoded: EncodedImage[] = [];
    const needsDownload: import("../store/queries.ts").MessageRow[] = [];

    for (const m of msgs) {
      try {
        let imagePath = m.media_path;

        // Already cached on disk — use it directly
        if (imagePath && fs.existsSync(imagePath)) {
          const maxCols = m.type === "stickerMessage" ? 15 : 30;
          const img = await encodeForInline(imagePath, maxCols, 12);
          helpers.setEncodedImage(m.id, {
            cols: img.cols, rows: img.rows,
            placeholders: img.placeholders, fgHex: img.fgHex, imageId: img.imageId,
          });
          encoded.push(img);
          continue;
        }

        // Has thumbnail — use it immediately (no download needed for preview)
        if (m.thumbnail) {
          const thumbPath = `/tmp/wa-thumb-${m.id}.jpg`;
          fs.writeFileSync(thumbPath, Buffer.from(m.thumbnail, "base64"));
          const maxCols = m.type === "stickerMessage" ? 15 : 30;
          const img = await encodeForInline(thumbPath, maxCols, 12);
          helpers.setEncodedImage(m.id, {
            cols: img.cols, rows: img.rows,
            placeholders: img.placeholders, fgHex: img.fgHex, imageId: img.imageId,
          });
          encoded.push(img);
        }

        // Queue for background download only if downloadable
        if (!imagePath && sock && isDownloadable(m)) {
          needsDownload.push(m);
        }
      } catch (e) {
        log("image", `Encode failed for ${m.id}: ${(e as Error)?.message}`);
      }
    }

    // Transmit whatever we encoded so far (thumbnails + cached)
    if (encoded.length > 0) {
      log("image", `Encoded ${encoded.length} images (instant)`);
      const renderer = props.getRenderer();
      if (renderer) transmitImages(renderer, encoded);
    }

    // Phase 2: Background download of full-res images (non-blocking, parallel)
    if (needsDownload.length > 0 && sock) {
      log("image", `Downloading ${needsDownload.length} images in background...`);
      const CONCURRENCY = 3;
      for (let i = 0; i < needsDownload.length; i += CONCURRENCY) {
        const batch = needsDownload.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(m => downloadAndCache(sock, m, props.queries))
        );
        // Encode any successful downloads and transmit
        const newEncoded: EncodedImage[] = [];
        for (let j = 0; j < results.length; j++) {
          const result = results[j]!;
          if (result.status === "fulfilled" && result.value) {
            const m = batch[j]!;
            try {
              const maxCols = m.type === "stickerMessage" ? 15 : 30;
              const img = await encodeForInline(result.value, maxCols, 12);
              helpers.setEncodedImage(m.id, {
                cols: img.cols, rows: img.rows,
                placeholders: img.placeholders, fgHex: img.fgHex, imageId: img.imageId,
              });
              newEncoded.push(img);
            } catch {}
          }
        }
        if (newEncoded.length > 0) {
          const renderer = props.getRenderer();
          if (renderer) transmitImages(renderer, newEncoded);
        }
      }
    }
  }

  // Open full-view image overlay
  async function openImageFullView(msgId: string) {
    const jid = store.selectedChatJid;
    if (!jid) return;
    const msgs = store.messages[jid];
    const msg = msgs?.find(m => m.id === msgId);
    if (!msg) return;

    // Try to get local path first, then download
    let path = msg.media_path;
    if (!path) {
      const sock = props.getSock();
      if (sock) path = await downloadAndCache(sock, msg, props.queries);
    }

    if (!path) return;

    const renderer = props.getRenderer();
    if (!renderer) return;

    await showFullView(renderer, path);

    // Re-transmit inline images after resume
    encodingStarted.clear();
    helpers.clearEncodedImages();
    const chatMsgs = store.messages[jid];
    if (chatMsgs) encodeImagesForChat(chatMsgs);
  }

  // Open $EDITOR for composing long text
  function openEditor() {
    const renderer = props.getRenderer();
    if (!renderer) return;

    const currentText = inputMethods?.getText() ?? "";
    const tmpFile = `/tmp/wa-edit-${Date.now()}.txt`;
    writeFileSync(tmpFile, currentText);

    renderer.suspend();
    // Restore terminal state for editor: show cursor, disable raw mode
    process.stdout.write("\x1b[?25h");
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);
    process.stdin.resume();
    try {
      const editor = process.env.EDITOR || process.env.VISUAL || "vim";
      execSync(`${editor} "${tmpFile}"`, {
        stdio: "inherit",
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      });
    } catch (e) {
      log("editor", `Editor failed: ${(e as Error)?.message}`);
    }

    // Resume TUI — OpenTUI will re-set raw mode on its own
    renderer.resume();

    try {
      const newText = readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
      unlinkSync(tmpFile);
      if (newText && newText !== currentText) {
        inputMethods?.setText(newText);
        helpers.setMode("insert");
        helpers.setFocusZone("input");
      }
    } catch {}

    // Re-transmit inline images after resume (alt screen was cleared)
    const jid = store.selectedChatJid;
    if (jid) {
      encodingStarted.clear();
      helpers.clearEncodedImages();
      clearAllImages();
      const chatMsgs = store.messages[jid];
      if (chatMsgs) encodeImagesForChat(chatMsgs);
    }
  }

  // Open video/audio/document with the appropriate viewer.
  // PDFs render inline via phosphor (which supports interactive PDF page nav
  // — same code path as image rendering). All other media types fall through
  // to the system viewer (QuickTime for video, etc.) spawned in the background
  // so the TUI stays active.
  async function openMediaExternal(msg: import("../store/queries.ts").MessageRow) {
    let path = msg.media_path;
    if (!path) {
      const sock = props.getSock();
      if (sock) path = await downloadAndCache(sock, msg, props.queries);
    }
    if (!path) {
      log("media", `No path for ${msg.id}`);
      return;
    }

    // Detect PDF by mimetype or extension. mimetype comes from baileys'
    // documentMessage payload. Extension is a fallback for older messages
    // that may have null mimetype.
    const isPdf =
      msg.mimetype === "application/pdf" ||
      path.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      // Render with phosphor — interactive page navigation built in.
      // Same suspend/resume pattern as openEditor() above.
      const renderer = props.getRenderer();
      if (!renderer) return;

      renderer.suspend();
      process.stdout.write("\x1b[?25h");
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.resume();

      try {
        execSync(`phosphor "${path.replace(/"/g, '\\"')}"`, {
          stdio: "inherit",
          env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
        });
      } catch (e) {
        log("media", `phosphor PDF view failed: ${(e as Error)?.message}`);
      }

      renderer.resume();

      // Re-transmit inline images after resume (alt screen was cleared by
      // phosphor's takeover). Same cleanup as openEditor.
      const jid = store.selectedChatJid;
      if (jid) {
        encodingStarted.clear();
        helpers.clearEncodedImages();
        clearAllImages();
        const chatMsgs = store.messages[jid];
        if (chatMsgs) encodeImagesForChat(chatMsgs);
      }
      return;
    }

    // Non-PDF: spawn system viewer in background
    const isMac = process.platform === "darwin";
    try {
      const { spawn } = await import("child_process");
      if (isMac) {
        spawn("open", [path], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [path], { detached: true, stdio: "ignore" }).unref();
      }
      log("media", `Opened ${path} with ${isMac ? "open" : "xdg-open"}`);
    } catch (e) {
      log("media", `Failed to open: ${(e as Error)?.message}`);
    }
  }

  useAppKeyboard({
    onQuit() {
      clearAllImages();
      props.onQuit();
    },

    onSelectChat() {
      const jid = store.highlightedChatJid;
      if (!jid) return;
      helpers.selectChat(jid);
      const sock = props.getSock();
      if (!sock) return;
      // Mark messages as read on WhatsApp's server
      const msgs = store.messages[jid];
      if (msgs && msgs.length > 0) {
        const keys = msgs
          .filter((m) => m.from_me === 0 && m.status < 4)
          .slice(0, 20)
          .map((m) => ({
            remoteJid: jid,
            id: m.id,
            participant: jid.endsWith("@g.us") ? (m.sender_jid ?? undefined) : undefined,
          }));
        if (keys.length > 0) sock.readMessages(keys).catch(() => {});
      }
      // Subscribe to typing notifications
      if (!subscribedPresence.has(jid)) {
        subscribedPresence.add(jid);
        sock.presenceSubscribe(jid).catch(() => {});
      }

      // For groups: backfill the local participants table from baileys'
      // groupMetadata if our DB is empty for this group. Without this the
      // mention picker (`@` in groups) shows nothing because it reads from
      // the DB, and the info overlay also reports 0 members.
      if (jid.endsWith("@g.us")) {
        const existing = props.queries.getGroupParticipants(jid);
        if (existing.length === 0) {
          sock.groupMetadata(jid).then((meta: any) => {
            if (meta?.participants?.length) {
              const rows = meta.participants
                .map((p: any) => ({
                  group_jid: jid,
                  user_jid: typeof p === "string" ? p : (p?.id ?? ""),
                  role: typeof p === "object" ? (p?.admin ?? null) : null,
                }))
                .filter((r: any) => r.user_jid);
              try { props.queries.upsertGroupParticipants(jid, rows); } catch {}
            }
          }).catch(() => {});
        }
      }

      // Encode inline images for this chat
      encodingStarted.clear();
      helpers.clearEncodedImages();
      clearAllImages();
      const chatMsgs = store.messages[jid];
      if (chatMsgs) {
        encodeImagesForChat(chatMsgs);
      }
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
      if (pos === "first") {
        helpers.loadMoreMessages(jid);
        const msgs = store.messages[jid];
        if (!msgs || msgs.length === 0) return;
        helpers.setSelectedMessageIndex(msgs.length - 1);
        if (messagesScrollRef) messagesScrollRef.scrollTop = 0;
      } else {
        const msgs = store.messages[jid];
        if (!msgs || msgs.length === 0) return;
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
      // Scroll the selected message into view
      const targetMsg = msgs[newIdx];
      if (targetMsg && messagesScrollRef) {
        try { messagesScrollRef.scrollChildIntoView(`msg-${targetMsg.id}`); } catch {}
      }
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
      if (newIdx >= maxIdx - 5 && dir < 0) helpers.loadMoreMessages(jid);
      const targetMsg = msgs[newIdx];
      if (targetMsg && messagesScrollRef) {
        try { messagesScrollRef.scrollChildIntoView(`msg-${targetMsg.id}`); } catch {}
      }
    },

    onYankMessage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (msg?.text) {
        const b64 = Buffer.from(msg.text).toString("base64");
        const osc = `\x1b]52;c;${b64}\x07`;
        kittyWrite(osc);
        helpers.showToast("Copied to clipboard", "info", 2000);
      } else {
        helpers.showToast("Nothing to copy", "info", 2000);
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
        const preview = msg.text
          ? truncate(resolveMentionDisplay(msg.text, props.queries), 30)
          : "[media]";
        helpers.showToast(`Replying: ${preview}`, "info", 2000);
      }
    },

    onOpenImage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (!msg) return;
      const mt = msg.media_type ?? msg.type;
      if (mt === "imageMessage" || mt === "stickerMessage") {
        openImageFullView(msg.id);
      } else if (mt === "videoMessage" || mt === "audioMessage" || mt === "documentMessage") {
        openMediaExternal(msg);
      }
    },

    onOpenEditor() {
      openEditor();
    },

    onTypeAt() {
      // Insert @ character into the textarea to trigger inline file completion
      setTimeout(() => {
        try { inputMethods?.setText((inputMethods?.getText() ?? "") + "@"); } catch {}
      }, 50);
    },

    onDeleteMessage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (!msg) return;
      // Build options: always offer "for me", offer "for everyone" only when
      // the message is ours and within WhatsApp's 2-hour delete window.
      const nowSec = Math.floor(Date.now() / 1000);
      const withinWindow = nowSec - msg.timestamp < 2 * 60 * 60;
      const options: ConfirmOption[] = [
        { label: "Delete for me", value: "delete-me", danger: true },
        ...(msg.from_me === 1 && withinWindow
          ? [{ label: "Delete for everyone", value: "delete-everyone", danger: true } as ConfirmOption]
          : []),
        { label: "Cancel", value: "cancel" },
      ];
      const preview = msg.text
        ? truncate(resolveMentionDisplay(msg.text, props.queries), 40)
        : "[media]";
      helpers.setOverlay({
        type: "confirm",
        confirm: {
          title: "Delete message",
          message: preview,
          options,
          intent: "delete-message",
          data: { msgId: msg.id, jid },
        },
      });
      helpers.setMode("search"); // borrows search mode so the modal's input gets keys
    },

    onSaveMedia() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (!msg) return;
      const mt = msg.media_type ?? msg.type;
      const isMedia = mt === "imageMessage" || mt === "videoMessage" ||
                      mt === "audioMessage" || mt === "documentMessage" ||
                      mt === "stickerMessage";
      if (!isMedia) {
        helpers.showToast("Not a media message", "info", 2000);
        return;
      }
      const filename = msg.file_name ?? `${msg.id}`;
      helpers.setOverlay({
        type: "confirm",
        confirm: {
          title: "Save media",
          message: `Save ${filename} to ~/Downloads/wa-tui/?`,
          options: [
            { label: "Save", value: "save" },
            { label: "Cancel", value: "cancel" },
          ],
          intent: "save-media",
          data: { msgId: msg.id },
        },
      });
      helpers.setMode("search");
    },

    onReactMessage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (!msg) return;
      helpers.setOverlay({
        type: "emoji-picker",
        emojiPickIntent: "react",
        emojiTargetMsgId: msg.id,
      });
      helpers.setMode("search");
    },

    onForwardMessage() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      const msgs = store.messages[jid];
      if (!msgs || msgs.length === 0) return;
      const msg = msgs[store.selectedMessageIndex];
      if (!msg) return;
      helpers.setOverlay({
        type: "forward",
        forwardSourceMsgId: msg.id,
      });
      helpers.setMode("search");
    },

    onShowChatInfo() {
      const jid = store.selectedChatJid;
      if (!jid) return;
      helpers.setOverlay({
        type: "info",
        infoChatJid: jid,
      });
      helpers.setMode("search");
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
        <Match when={store.connection.status === "qr"}>
          <QROverlay data={store.connection.qrData!} />
        </Match>

        <Match when={store.connection.status === "disconnected"}>
          <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column" gap={1}>
            <text fg={theme.error}>Disconnected from WhatsApp</text>
            <text fg={theme.textMuted}>Press q to quit</text>
          </box>
        </Match>

        <Match when={store.connection.status === "connecting" || store.connection.status === "connected" || store.connection.status === "reconnecting"}>
          <Layout
            queries={props.queries}
            getSock={props.getSock}
            onQuit={props.onQuit}
            scrollRef={(el) => (messagesScrollRef = el)}
            chatListScrollRef={(el) => (chatListScrollRef = el)}
            inputMethodsRef={(methods) => { inputMethods = methods; }}
            onScrollToBottom={() => {
              helpers.setSelectedMessageIndex(0);
              const jid = store.selectedChatJid;
              if (jid) helpers.selectChat(jid);
              // Scroll the scrollbox to the bottom
              if (messagesScrollRef) {
                try {
                  messagesScrollRef.scrollTop = messagesScrollRef.scrollHeight;
                } catch {}
              }
            }}
          />
        </Match>
      </Switch>
    </box>
  );
}
