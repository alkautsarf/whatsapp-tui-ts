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

// Optimistic default: assume we're focused at startup. The first FOCUS_IN
// or FOCUS_OUT will correct it within milliseconds.
let focused = true;
let installed = false;

export function isTerminalFocused(): boolean {
  return focused;
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
    if (chunk.includes(FOCUS_IN)) focused = true;
    if (chunk.includes(FOCUS_OUT)) focused = false;
  });
}

export function uninstallFocusTracking(): void {
  if (!installed) return;
  installed = false;
  try { process.stdout.write(DISABLE_FOCUS_REPORTING); } catch {}
}
