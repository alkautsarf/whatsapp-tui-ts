import { Switch, Match, createEffect } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useAppStore } from "./state.tsx";
import { useTheme } from "./theme.tsx";
import { useAppKeyboard } from "./keys.ts";
import { Layout } from "./layout.tsx";
import { QROverlay } from "./overlays/qr-code.tsx";
import { encodeForInline, transmitImages, clearAllImages, showFullView, IMAGE_MEDIA_TYPES, type EncodedImage } from "./image.ts";
import { downloadAndCache } from "../wa/media.ts";
import { log } from "../utils/log.ts";
import type { StoreQueries } from "../store/queries.ts";
import type { WASocket } from "@whiskeysockets/baileys";

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

  // Download + encode images in background, then transmit briefly
  async function encodeImagesForChat(msgs: import("../store/queries.ts").MessageRow[]) {
    log("image", `Processing ${msgs.length} image messages...`);

    const sock = props.getSock();

    // Phase 1: Download + encode WITHOUT freezing (TUI stays responsive)
    const encoded: EncodedImage[] = [];
    for (const m of msgs) {
      try {
        let imagePath = m.media_path;
        if (!imagePath && sock) {
          imagePath = await downloadAndCache(sock, m, props.queries);
        }
        if (!imagePath) {
          if (!m.thumbnail) continue;
          imagePath = `/tmp/wa-thumb-${m.id}.jpg`;
          const fs = await import("fs");
          fs.writeFileSync(imagePath, Buffer.from(m.thumbnail, "base64"));
        }

        const maxCols = m.type === "stickerMessage" ? 15 : 30;
        const img = await encodeForInline(imagePath, maxCols, 12);
        helpers.setEncodedImage(m.id, {
          cols: img.cols, rows: img.rows,
          placeholders: img.placeholders, fgHex: img.fgHex, imageId: img.imageId,
        });
        encoded.push(img);
        log("image", `Encoded ${m.id.slice(0, 12)} (${img.cols}x${img.rows})`);
      } catch (e) {
        log("image", `Encode failed for ${m.id}: ${(e as Error)?.message}`);
      }
    }

    // Phase 2: Brief freeze ONLY for transmit (< 200ms)
    if (encoded.length > 0) {
      const renderer = props.getRenderer();
      if (renderer) transmitImages(renderer, encoded);
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
