import { useKeyboard } from "@opentui/solid";
import { useAppStore } from "./state.tsx";
import type { AppMode, FocusZone } from "./types.ts";

const FOCUS_ORDER: FocusZone[] = ["chat-list", "messages", "input"];

/**
 * Global keyboard dispatcher. Handles vim modes and focus cycling.
 * Must be called inside a component within AppStoreProvider.
 */
export function useAppKeyboard(actions: {
  onQuit: () => void;
  onSelectChat: () => void;
  onScrollMessages: (dir: number) => void;
  onNavigateChatList: (dir: number) => void;
  onJumpChatList: (pos: "first" | "last") => void;
  onScrollMessagesPage: (dir: number) => void;
  onYankMessage: () => void;
  onReply: () => void;
}) {
  const { store, helpers } = useAppStore();

  let keyBuffer = "";
  let keyBufferTimer: ReturnType<typeof setTimeout> | null = null;

  function clearKeyBuffer() {
    keyBuffer = "";
    if (keyBufferTimer) {
      clearTimeout(keyBufferTimer);
      keyBufferTimer = null;
    }
  }

  function cycleFocus(forward: boolean) {
    const idx = FOCUS_ORDER.indexOf(store.focusZone);
    const next = forward
      ? FOCUS_ORDER[(idx + 1) % FOCUS_ORDER.length]!
      : FOCUS_ORDER[(idx - 1 + FOCUS_ORDER.length) % FOCUS_ORDER.length]!;
    helpers.setFocusZone(next);
  }

  function drillBack() {
    if (store.mode === "insert") {
      helpers.setMode("normal");
      return;
    }
    if (store.overlay) {
      helpers.setOverlay(null);
      helpers.setMode("normal");
      return;
    }
    switch (store.focusZone) {
      case "input":
        helpers.setFocusZone("messages");
        break;
      case "messages":
        helpers.setFocusZone("chat-list");
        break;
    }
  }

  useKeyboard((evt) => {
    // Always handle Ctrl+C for exit
    if (evt.ctrl && evt.name === "c") {
      evt.preventDefault();
      actions.onQuit();
      return;
    }

    // Search mode: pass through to overlay except Esc
    if (store.mode === "search") {
      if (evt.name === "escape") {
        drillBack();
        evt.preventDefault();
      }
      return;
    }

    // Insert mode: pass through to textarea except Esc
    if (store.mode === "insert") {
      if (evt.name === "escape") {
        drillBack();
        evt.preventDefault();
      }
      return;
    }

    // ── Normal mode ──────────────────────────────────────────────
    evt.preventDefault();

    // Command palette
    if (evt.ctrl && evt.name === "p") {
      helpers.setOverlay({ type: "command-palette" });
      return;
    }

    // Search
    if (evt.name === "/" && !evt.ctrl && !evt.meta) {
      helpers.setMode("search");
      helpers.setOverlay({ type: "search" });
      return;
    }

    // Quit
    if (evt.name === "q" && !evt.ctrl && !evt.meta) {
      actions.onQuit();
      return;
    }

    // Tab — cycle focus
    if (evt.name === "tab") {
      cycleFocus(!evt.shift);
      return;
    }

    // Escape — drill back
    if (evt.name === "escape") {
      drillBack();
      return;
    }

    // Insert mode
    if (evt.name === "i" && !evt.ctrl && !evt.meta) {
      helpers.setMode("insert");
      helpers.setFocusZone("input");
      return;
    }

    // gg sequence
    if (evt.name === "g" && !evt.ctrl && !evt.meta) {
      if (keyBuffer === "g") {
        clearKeyBuffer();
        if (store.focusZone === "chat-list") actions.onJumpChatList("first");
        return;
      }
      keyBuffer = "g";
      keyBufferTimer = setTimeout(clearKeyBuffer, 500);
      return;
    }

    // G — jump to last
    if (evt.name === "G" || (evt.shift && evt.name === "g")) {
      clearKeyBuffer();
      if (store.focusZone === "chat-list") actions.onJumpChatList("last");
      return;
    }

    // Clear key buffer for non-g keys
    if (keyBuffer) clearKeyBuffer();

    // Navigation
    if (evt.name === "j" || evt.name === "down") {
      if (store.focusZone === "chat-list") actions.onNavigateChatList(1);
      else if (store.focusZone === "messages") actions.onScrollMessages(1);
      return;
    }

    if (evt.name === "k" || evt.name === "up") {
      if (store.focusZone === "chat-list") actions.onNavigateChatList(-1);
      else if (store.focusZone === "messages") actions.onScrollMessages(-1);
      return;
    }

    // Half page scroll
    if (evt.ctrl && evt.name === "d") {
      actions.onScrollMessagesPage(1);
      return;
    }
    if (evt.ctrl && evt.name === "u") {
      actions.onScrollMessagesPage(-1);
      return;
    }

    // Open chat / enter messages
    if (evt.name === "return" || evt.name === "l") {
      if (store.focusZone === "chat-list") {
        actions.onSelectChat();
        helpers.setFocusZone("messages");
      }
      return;
    }

    // Back to chat list
    if (evt.name === "h") {
      if (store.focusZone === "messages" || store.focusZone === "input") {
        helpers.setFocusZone("chat-list");
      }
      return;
    }

    // Reply
    if (evt.name === "r" && !evt.ctrl && !evt.meta) {
      if (store.focusZone === "messages") {
        actions.onReply();
      }
      return;
    }

    // Yank
    if (evt.name === "y" && !evt.ctrl && !evt.meta) {
      if (store.focusZone === "messages") {
        actions.onYankMessage();
      }
      return;
    }
  });
}
