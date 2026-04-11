import { createContext, useContext } from "solid-js";
import { createStore, type SetStoreFunction } from "solid-js/store";
import type { StoreQueries, ChatRow, MessageRow, ContactRow } from "../store/queries.ts";
import { log } from "../utils/log.ts";
import { isTerminalFocused } from "../utils/terminal-focus.ts";
import type {
  AppStore,
  AppMode,
  FocusZone,
  ConnectionState,
  OverlayState,
} from "./types.ts";

// ── Reactive Bridge ─────────────────────────────────────────────────
// Called by wa/handlers.ts after each SQLite write to push into SolidJS store

export interface ReactiveBridge {
  onHistoryBatch(): void;
  onNewMessage(msg: MessageRow, chatJid: string): void;
  onChatUpdate(chat: ChatRow): void;
  onContactUpdate(contact: ContactRow): void;
  onStatusUpdate(msgId: string, status: number): void;
  onPresenceUpdate(chatJid: string, isTyping: boolean, presence?: string): void;
  /** Read by wa/handlers to decide whether to auto-mark incoming messages as read. */
  getViewJid(): string | null;
}

// ── Store helpers ───────────────────────────────────────────────────

export interface AppStoreHelpers {
  hydrate(): void;
  refreshChats(): void;
  selectChat(jid: string): void;
  loadMoreMessages(jid: string): void;
  setMode(mode: AppMode): void;
  setFocusZone(zone: FocusZone): void;
  setConnection(state: ConnectionState): void;
  setOverlay(overlay: OverlayState | null): void;
  setReplyTo(messageId: string | null): void;
  setSelectedMessageIndex(index: number): void;
  setHighlightedChatJid(jid: string | null): void;
  setEncodedImage(msgId: string, data: { cols: number; rows: number; placeholders: string; fgHex: string; imageId: number }): void;
  clearEncodedImages(): void;
  showToast(message: string, level?: "error" | "info", durationMs?: number): void;
  clearToast(): void;
  setHelpScrollOffset(offset: number): void;
  createBridge(): ReactiveBridge;
}

// ── Create store ────────────────────────────────────────────────────

const INITIAL_STORE: AppStore = {
  chats: [],
  messages: {},
  selectedChatJid: null,
  selectedMessageIndex: 0,
  highlightedChatJid: null,
  connection: { status: "connecting" },
  mode: "normal",
  focusZone: "chat-list",
  overlay: null,
  replyToMessageId: null,
  typingJids: {},
  presenceMap: {},
  encodedImages: {},
  toast: null,
  helpScrollOffset: 0,
};

export function createAppStore(queries: StoreQueries): [AppStore, SetStoreFunction<AppStore>, AppStoreHelpers] {
  const [store, setStore] = createStore<AppStore>({ ...INITIAL_STORE });

  function hydrate() {
    const chats = queries.listChats(500);
    setStore("chats", chats);

    if (!store.highlightedChatJid && chats.length > 0) {
      setStore("highlightedChatJid", chats[0]!.jid);
    }

    if (store.selectedChatJid) {
      const msgs = queries.getMessages(store.selectedChatJid, 50);
      setStore("messages", store.selectedChatJid, msgs);
    }
  }

  function refreshChats() {
    const chats = queries.listChats(500);
    setStore("chats", chats);
  }

  function selectChat(jid: string) {
    setStore("selectedChatJid", jid);
    // Move the chat-list cursor to the picked chat too. Without this,
    // jumping into a chat from the search overlay (or any other jump path)
    // leaves the chat-list highlight wherever it was, so backing out lands
    // in the wrong row.
    setStore("highlightedChatJid", jid);
    setStore("selectedMessageIndex", 0);
    setStore("replyToMessageId", null);

    // Fetch the latest 100 messages and MERGE with whatever's already in
    // the store for this chat. Without merging, every chat re-select would
    // wipe the older history the user loaded via gg / loadMoreMessages and
    // they'd have to re-load it before search could find anything.
    const fresh = queries.getMessages(jid, 100);
    const existing = store.messages[jid] ?? [];
    if (existing.length > fresh.length) {
      // We had more loaded than 100 (gg / loadMoreMessages happened).
      // Merge by id to pick up any new live messages without dropping the
      // older ones the user already loaded.
      const seen = new Set(existing.map((m) => m.id));
      const merged = [...fresh.filter((m) => !seen.has(m.id)), ...existing];
      // Store is sorted timestamp DESC (latest first); keep that ordering.
      merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      setStore("messages", jid, merged);
    } else {
      setStore("messages", jid, fresh);
    }

    const idx = store.chats.findIndex((c) => c.jid === jid);
    if (idx >= 0) {
      setStore("chats", idx, "unread", 0);
    }
    queries.clearUnread(jid);
  }

  const exhaustedChats = new Set<string>();

  function loadMoreMessages(jid: string) {
    if (exhaustedChats.has(jid)) return;
    const existing = store.messages[jid];
    if (!existing || existing.length === 0) return;
    const oldestTs = existing[existing.length - 1]!.timestamp;
    const older = queries.getMessages(jid, 30, oldestTs);
    if (older.length > 0) {
      setStore("messages", jid, (prev) => [...(prev || []), ...older]);
    } else {
      exhaustedChats.add(jid);
    }
  }

  const helpers: AppStoreHelpers = {
    hydrate,
    refreshChats,
    selectChat,
    loadMoreMessages,

    setMode(mode) { setStore("mode", mode); },
    setFocusZone(zone) { setStore("focusZone", zone); },
    setConnection(state) { setStore("connection", state); },
    setOverlay(overlay) { setStore("overlay", overlay); },
    setReplyTo(messageId) { setStore("replyToMessageId", messageId); },
    setSelectedMessageIndex(index) { setStore("selectedMessageIndex", index); },
    setHighlightedChatJid(jid) { setStore("highlightedChatJid", jid); },
    setEncodedImage(msgId, data) { setStore("encodedImages", msgId, data); },
    clearEncodedImages() { setStore("encodedImages", {}); },

    showToast(message, level = "info", durationMs = 5000) {
      const expiresAt = Date.now() + durationMs;
      setStore("toast", { message, level, expiresAt });
      // Schedule the auto-clear. We compare expiresAt before clearing so a
      // newer toast that lands while the old one is still showing isn't
      // wiped early by the previous timer.
      setTimeout(() => {
        if (store.toast && store.toast.expiresAt <= Date.now()) {
          setStore("toast", null);
        }
      }, durationMs + 50);
    },

    clearToast() { setStore("toast", null); },

    setHelpScrollOffset(offset) { setStore("helpScrollOffset", Math.max(0, offset)); },

    createBridge(): ReactiveBridge {
      return {
        onHistoryBatch() {
          log("bridge", "onHistoryBatch");
          hydrate();
        },

        onNewMessage(msg, chatJid) {
          log("bridge", `onNewMessage: ${chatJid} | viewing: ${store.selectedChatJid} | text: ${msg.text?.slice(0, 40)}`);
          const viewing = store.selectedChatJid;
          const isViewingThisChat = viewing === chatJid;
          // "Actually reading" requires the pane to be focused too — matches
          // the read-receipt gate in wa/handlers.ts. Without the focus
          // check, a new message arriving in a selected-but-unfocused chat
          // would silently clear the unread badge locally while the server
          // still has it unread (we no longer send a read receipt), and
          // the user would return to wa-tui and miss the new-message cue.
          const isActivelyViewing = isViewingThisChat && isTerminalFocused();
          if (isViewingThisChat) {
            const msgs = queries.getMessages(viewing, 100);
            setStore("messages", viewing, msgs);
          }
          const chatIdx = store.chats.findIndex(c => c.jid === chatJid);
          const shouldBumpUnread = !msg.from_me && !isActivelyViewing;
          if (chatIdx >= 0) {
            setStore("chats", chatIdx, "last_msg_ts", msg.timestamp);
            // Always update both fields so a sticker/media arriving after
            // a text doesn't leave a stale preview behind.
            setStore("chats", chatIdx, "last_msg_text", msg.text ?? null);
            setStore("chats", chatIdx, "last_msg_type", msg.type);
            if (shouldBumpUnread) {
              setStore("chats", chatIdx, "unread", (u) => (u ?? 0) + 1);
              queries.incrementUnread(chatJid);
            } else if (isActivelyViewing && (store.chats[chatIdx]?.unread ?? 0) > 0) {
              // Belt-and-suspenders: a stale increment shouldn't survive
              // while the user is actually looking at the chat.
              setStore("chats", chatIdx, "unread", 0);
              queries.clearUnread(chatJid);
            }
          }
          // Re-sort only if the updated chat isn't already at the top (after pinned chats)
          const pinnedCount = store.chats.filter(c => (c.pinned ?? 0) > 0).length;
          if (chatIdx < 0 || chatIdx > pinnedCount) {
            const sorted = [...store.chats].sort((a, b) => {
              if ((a.pinned ?? 0) !== (b.pinned ?? 0)) return (b.pinned ?? 0) - (a.pinned ?? 0);
              return (b.last_msg_ts ?? 0) - (a.last_msg_ts ?? 0);
            });
            setStore("chats", sorted);
          }
        },

        onChatUpdate(chat) {
          // WA may push chats.update with unreadCount>0 before the readReceipt
          // round-trips. Don't let it ghost the badge back into the chat the
          // user is staring at.
          if (chat?.jid && chat.jid === store.selectedChatJid) {
            queries.clearUnread(chat.jid);
          }
          refreshChats();
        },

        onContactUpdate() {
          refreshChats();
        },

        onStatusUpdate(msgId, status) {
          log("bridge", `onStatusUpdate: ${msgId} -> ${status}`);
          const jid = store.selectedChatJid;
          if (!jid || !store.messages[jid]) return;
          setStore(
            "messages",
            jid,
            (msg: MessageRow) => msg.id === msgId,
            "status",
            status
          );
        },

        onPresenceUpdate(chatJid, isTyping, presence) {
          if (isTyping) {
            setStore("typingJids", chatJid, Math.floor(Date.now() / 1000));
          } else if (store.typingJids[chatJid]) {
            setStore("typingJids", chatJid, 0);
          }
          if (presence && store.presenceMap[chatJid] !== presence) {
            setStore("presenceMap", chatJid, presence);
          }
        },

        getViewJid() {
          return store.selectedChatJid;
        },
      };
    },
  };

  return [store, setStore, helpers];
}

// ── Context ─────────────────────────────────────────────────────────

interface AppStoreContext {
  store: AppStore;
  setStore: SetStoreFunction<AppStore>;
  helpers: AppStoreHelpers;
}

const StoreContext = createContext<AppStoreContext>();

export function AppStoreProvider(props: {
  store: AppStore;
  setStore: SetStoreFunction<AppStore>;
  helpers: AppStoreHelpers;
  children: any;
}) {
  return (
    <StoreContext.Provider
      value={{ store: props.store, setStore: props.setStore, helpers: props.helpers }}
    >
      {props.children}
    </StoreContext.Provider>
  );
}

export function useAppStore(): AppStoreContext {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useAppStore must be used within AppStoreProvider");
  return ctx;
}
