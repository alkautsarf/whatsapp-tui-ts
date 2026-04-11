/**
 * Terminal focus tracking via xterm focus reporting (DEC mode 1004).
 *
 * When enabled, modern terminals (Ghostty, iTerm2, WezTerm, kitty, gnome-
 * terminal, modern xterm) emit:
 *   ESC [ I  → window/pane gained focus
 *   ESC [ O  → window/pane lost focus
 *
 * tmux with `set -g focus-events on` (default in oh-my-tmux) forwards these
 * events to the active pane in the active window of the attached client.
 *
 * Used by the system notification trigger in src/wa/handlers.ts to suppress
 * notifications when the user is actively viewing the chat AND the wa-tui
 * pane is the focused pane in the focused terminal window. If wa-tui is in
 * a background tmux session or the terminal is in another macOS Space, the
 * notification still fires even when the chat happens to be selected.
 */

const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

const FOCUS_IN = Buffer.from([0x1b, 0x5b, 0x49]);  // ESC [ I
const FOCUS_OUT = Buffer.from([0x1b, 0x5b, 0x4f]); // ESC [ O

// Pessimistic default: assume NOT focused at startup. This is the correct
// state for wa-tui running in a detached tmux session — tmux won't fire any
// focus events to a pane that isn't in an attached session, so without this
// the focus state would be stuck at "true" forever and notifications would
// be suppressed for the chat the user happens to have selected, even though
// they aren't actually looking at wa-tui.
//
// When the user attaches to the wa-tui session (or if wa-tui starts in a
// foreground terminal), tmux/the terminal fires FOCUS_IN immediately and
// flips this to true within milliseconds — so the only edge case is "user
// runs wa-tui in foreground, immediately receives a message in a selected
// chat before the first FOCUS_IN arrives", which produces one spurious
// notification at most. Acceptable trade-off vs the original bug of missing
// every notification for a backgrounded session.
let focused = false;
let installed = false;

type FocusListener = (focused: boolean) => void;
const listeners = new Set<FocusListener>();

export function isTerminalFocused(): boolean {
  return focused;
}

function setFocused(next: boolean): void {
  if (focused === next) return;
  focused = next;
  for (const cb of listeners) {
    try { cb(next); } catch {}
  }
}

// Subscribe to focus changes. The callback fires with the current state on
// subscribe (via queueMicrotask), then on every subsequent focus flip.
// Returns an unsubscribe function.
export function subscribeFocusChange(cb: FocusListener): () => void {
  listeners.add(cb);
  queueMicrotask(() => cb(focused));
  return () => { listeners.delete(cb); };
}

export function installFocusTracking(): void {
  if (installed) return;
  installed = true;

  process.stdout.write(ENABLE_FOCUS_REPORTING);

  // OpenTUI / our key handlers consume stdin in raw mode, but they pass
  // unrecognized escape sequences through. We attach a low-priority data
  // listener that scans for the focus markers and updates state. The
  // listener does NOT swallow the bytes — they continue to whatever else
  // is reading stdin (which ignores them as no-op CSI).
  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.includes(FOCUS_IN)) setFocused(true);
    if (chunk.includes(FOCUS_OUT)) setFocused(false);
  });
}

export function uninstallFocusTracking(): void {
  if (!installed) return;
  installed = false;
  try { process.stdout.write(DISABLE_FOCUS_REPORTING); } catch {}
}
