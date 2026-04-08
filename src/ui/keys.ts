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
  onJumpMessages: (pos: "first" | "last") => void;
  onScrollMessagesPage: (dir: number) => void;
  onYankMessage: () => void;
  onReply: () => void;
  onOpenImage?: () => void;
  onOpenEditor?: () => void;
  onTypeAt?: () => void;
  onDeleteMessage?: () => void;
  onSaveMedia?: () => void;
  onReactMessage?: () => void;
  onForwardMessage?: () => void;
  onShowChatInfo?: () => void;
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
    const zones = store.selectedChatJid ? FOCUS_ORDER : (["chat-list"] as FocusZone[]);
    const idx = zones.indexOf(store.focusZone);
    const next = forward
      ? zones[(idx + 1) % zones.length]!
      : zones[(idx - 1 + zones.length) % zones.length]!;
    helpers.setFocusZone(next);
  }

  function drillBack() {
    if (store.mode === "insert") {
      // First Esc with an active reply: clear the reply, stay in insert.
      // Lets the user cancel a reply without sending a junk message.
      // Second Esc (or Esc with no reply) leaves insert mode normally.
      if (store.replyToMessageId) {
        helpers.setReplyTo(null);
        helpers.showToast("Reply cleared", "info", 1500);
        return;
      }
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

    // Insert mode: pass through to textarea except Esc, Ctrl+G, Ctrl+E
    if (store.mode === "insert") {
      if (evt.name === "escape") {
        drillBack();
        evt.preventDefault();
      }
      if (evt.ctrl && evt.name === "g") {
        evt.preventDefault();
        actions.onOpenEditor?.();
      }
      // Ctrl+E from inside the textarea opens the emoji picker. We switch
      // to "search" mode so the global key handler passes keystrokes through
      // to the picker's own input element instead of the textarea below it.
      // The picker's onPick callback restores insert mode + input focus.
      if (evt.ctrl && evt.name === "e") {
        evt.preventDefault();
        helpers.setMode("search");
        helpers.setOverlay({ type: "emoji-picker" });
      }
      return;
    }

    // ── Normal mode ──────────────────────────────────────────────
    evt.preventDefault();

    // Command palette. Switch to "search" mode so the global key handler
    // passes keys through to the palette's focused input — without this,
    // the global Down/Up handlers eat the navigation keys (and typing
    // doesn't reach the input either).
    if (evt.ctrl && evt.name === "p") {
      helpers.setMode("search");
      helpers.setOverlay({ type: "command-palette" });
      return;
    }

    // Help overlay — `?` key toggles a full keyboard shortcut reference.
    // Esc / second `?` press closes it via the existing drillBack path.
    if (evt.name === "?" || (evt.shift && evt.name === "/")) {
      if (store.overlay?.type === "help") {
        helpers.setOverlay(null);
      } else {
        // Open at the top — reset scroll offset.
        helpers.setHelpScrollOffset?.(0);
        helpers.setOverlay({ type: "help" });
      }
      return;
    }

    // While the help overlay is open, intercept j/k/up/down to scroll its
    // content instead of the message list. Without this, scrolling in the
    // overlay would silently scroll the underlying messages view.
    if (store.overlay?.type === "help") {
      if (evt.name === "j" || evt.name === "down") {
        helpers.setHelpScrollOffset?.(store.helpScrollOffset + 1);
        return;
      }
      if (evt.name === "k" || evt.name === "up") {
        helpers.setHelpScrollOffset?.(Math.max(0, store.helpScrollOffset - 1));
        return;
      }
      if (evt.ctrl && evt.name === "d") {
        helpers.setHelpScrollOffset?.(store.helpScrollOffset + 5);
        return;
      }
      if (evt.ctrl && evt.name === "u") {
        helpers.setHelpScrollOffset?.(Math.max(0, store.helpScrollOffset - 5));
        return;
      }
      // Let Esc / ? fall through to their handlers above; swallow everything
      // else so the help overlay isn't dismissed by random keystrokes (and
      // q doesn't quit the app while reading the help — needs explicit Esc).
      if (evt.name !== "escape" && evt.name !== "?") {
        return;
      }
    }

    // Search — context-aware. When focus is on messages, search within the
    // current chat's messages. Otherwise open the chat-list search overlay.
    // Both branches set mode to "search" so the global handler passes
    // keystrokes through to the overlay's input element instead of
    // intercepting them as normal-mode commands.
    if (evt.name === "/" && !evt.ctrl && !evt.meta) {
      if (store.focusZone === "messages" && store.selectedChatJid) {
        helpers.setMode("search");
        helpers.setOverlay({ type: "message-search" });
      } else {
        helpers.setMode("search");
        helpers.setOverlay({ type: "search" });
      }
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

    // Open $EDITOR for long text (Ctrl+G)
    if (evt.ctrl && evt.name === "g") {
      actions.onOpenEditor?.();
      return;
    }

    // Attach file — enter insert mode and type @ to trigger inline completion
    if (evt.name === "a" && !evt.ctrl && !evt.meta) {
      if (store.selectedChatJid) {
        helpers.setMode("insert");
        helpers.setFocusZone("input");
        // Type @ into the textarea to trigger completion
        actions.onTypeAt?.();
      }
      return;
    }

    // Chat info — `gi` chord. MUST come before the `i` insert handler
    // below or `i` would always switch to insert mode first and the chord
    // would never fire.
    if (evt.name === "i" && !evt.ctrl && !evt.meta && keyBuffer === "g") {
      clearKeyBuffer();
      actions.onShowChatInfo?.();
      return;
    }

    // Insert mode
    if (evt.name === "i" && !evt.ctrl && !evt.meta) {
      helpers.setMode("insert");
      helpers.setFocusZone("input");
      return;
    }

    // gg sequence
    if (evt.name === "g" && !evt.ctrl && !evt.meta && !evt.shift) {
      if (keyBuffer === "g") {
        clearKeyBuffer();
        if (store.focusZone === "chat-list") actions.onJumpChatList("first");
        else if (store.focusZone === "messages") actions.onJumpMessages("first");
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
      else if (store.focusZone === "messages") actions.onJumpMessages("last");
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

    // Open chat / enter messages / open image
    if (evt.name === "return" || evt.name === "l") {
      if (store.focusZone === "chat-list") {
        actions.onSelectChat();
        helpers.setFocusZone("messages");
      } else if (store.focusZone === "input" && evt.name === "l") {
        helpers.setFocusZone("messages");
      } else if (store.focusZone === "messages" && evt.name === "return" && actions.onOpenImage) {
        actions.onOpenImage();
      }
      return;
    }

    // Back to chat list (vim-style "left")
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

    // Delete message (`d` in messages zone) — opens confirm modal
    if (evt.name === "d" && !evt.ctrl && !evt.meta) {
      if (store.focusZone === "messages") {
        actions.onDeleteMessage?.();
      }
      return;
    }

    // Save media (`s` in messages zone) — opens confirm modal
    if (evt.name === "s" && !evt.ctrl && !evt.meta && !evt.shift) {
      if (store.focusZone === "messages") {
        actions.onSaveMedia?.();
      }
      return;
    }

    // React to message (`e` in messages zone) — opens emoji picker in
    // react mode (sends the picked emoji as a reaction instead of inserting
    // into the input box).
    if (evt.name === "e" && !evt.ctrl && !evt.meta) {
      if (store.focusZone === "messages") {
        actions.onReactMessage?.();
      }
      return;
    }

    // Forward message (`f` in messages zone) — opens target picker
    if (evt.name === "f" && !evt.ctrl && !evt.meta) {
      if (store.focusZone === "messages") {
        actions.onForwardMessage?.();
      }
      return;
    }

  });
}
