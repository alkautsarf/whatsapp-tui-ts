import { createContext, useContext } from "solid-js";
import { createStore, type SetStoreFunction } from "solid-js/store";
import type { StoreQueries, ChatRow, MessageRow, ContactRow } from "../store/queries.ts";
import { log } from "../utils/log.ts";
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
};

export function createAppStore(queries: StoreQueries): [AppStore, SetStoreFunction<AppStore>, AppStoreHelpers] {
  const [store, setStore] = createStore<AppStore>({ ...INITIAL_STORE });

  function hydrate() {
    const chats = queries.listChats(500);
    setStore("chats", chats);

    // If a chat is selected, refresh its messages too
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
    setStore("selectedMessageIndex", 0);
    setStore("replyToMessageId", null);
    // Load messages for this chat
    const msgs = queries.getMessages(jid, 100);
    setStore("messages", jid, msgs);
    // Reset unread in store (visual only)
    setStore("chats", (c) => c.jid === jid, "unread", 0);
  }

  function loadMoreMessages(jid: string) {
    const existing = store.messages[jid];
    if (!existing || existing.length === 0) return;
    // Messages are stored newest-first, so the oldest has the smallest timestamp
    const oldestTs = existing[existing.length - 1]!.timestamp;
    const older = queries.getMessages(jid, 30, oldestTs);
    if (older.length > 0) {
      setStore("messages", jid, (prev) => [...(prev || []), ...older]);
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

    createBridge(): ReactiveBridge {
      return {
        onHistoryBatch() {
          log("bridge", "onHistoryBatch");
          hydrate();
        },

        onNewMessage(msg, chatJid) {
          log("bridge", `onNewMessage: ${chatJid} | viewing: ${store.selectedChatJid} | text: ${msg.text?.slice(0, 40)}`);
          const viewing = store.selectedChatJid;
          if (viewing === chatJid) {
            const msgs = queries.getMessages(viewing, 100);
            setStore("messages", viewing, msgs);
          }
          const chatIdx = store.chats.findIndex(c => c.jid === chatJid);
          if (chatIdx >= 0) {
            setStore("chats", chatIdx, "last_msg_ts", msg.timestamp);
            if (msg.text) setStore("chats", chatIdx, "last_msg_text", msg.text);
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

        onChatUpdate() {
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
