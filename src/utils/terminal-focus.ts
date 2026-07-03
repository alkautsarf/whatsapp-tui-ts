/**
 * Terminal focus tracking via xterm focus reporting (DEC mode 1004).
 *
 * When enabled, modern terminals (Ghostty, iTerm2, WezTerm, kitty, gnome-
 * terminal, modern xterm) emit:
 *   ESC [ I  -> window/pane gained focus
 *   ESC [ O  -> window/pane lost focus
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
// state for wa-tui running in a detached tmux session (tmux won't fire any
// focus events to a pane that isn't in an attached session), so without this
// the focus state would be stuck at "true" forever and notifications would
// be suppressed for the chat the user happens to have selected, even though
// they aren't actually looking at wa-tui.
//
// When the user attaches to the wa-tui session (or if wa-tui starts in a
// foreground terminal), tmux/the terminal fires FOCUS_IN immediately and
// flips this to true within milliseconds, so the only edge case is "user
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
  // listener does NOT swallow the bytes: they continue to whatever else
  // is reading stdin (which ignores them as no-op CSI).
  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.includes(FOCUS_IN)) setFocused(true);
    if (chunk.includes(FOCUS_OUT)) setFocused(false);
  });

  startTmuxWatch();
}

export function uninstallFocusTracking(): void {
  if (!installed) return;
  installed = false;
  stopTmuxWatch();
  try { process.stdout.write(DISABLE_FOCUS_REPORTING); } catch {}
}

// ---- tmux attach-state safety net ----------------------------------
//
// mode-1004 focus events are the primary signal, but they are not
// sufficient under tmux: when the user switches AWAY from wa-tui's own
// session (`prefix a` / switch-client, or a detach), tmux does not
// reliably emit a FOCUS_OUT to the pane whose session it left. That
// leaves `focused` stuck true, so index.tsx keeps broadcasting presence
// "available" and WhatsApp suppresses phone push indefinitely: the
// 2026-07-03 "no notifications on my phone" bug, reproduced with wa-tui
// running in its own detached `wa-tui` session (session_attached=0).
//
// Fix: while we believe we're focused, poll tmux for this pane's attended
// state and force `focused` OFF the moment the pane is no longer the active
// pane of the active window in an attached session. This ONLY ever forces
// focus off. Turning it back on stays the job of a real FOCUS_IN (which tmux
// DOES deliver on switch-IN; it is the switch-OUT FOCUS_OUT that goes
// missing, confirmed by the 2026-07-03 incident where focus was stuck true
// after a switch-away). So a missed/late event always biases toward "route
// push to the phone" (at worst a redundant buzz while genuinely viewing)
// rather than the failure we are fixing (push suppressed for hours).
//
// The poll is gated on `isTerminalFocused()`: once it has forced focus off
// there is nothing left to force, so it stops spawning tmux until the next
// FOCUS_IN flips us back on. Steady-state (backgrounded) cost is therefore
// zero subprocesses, not one every tick. No-op when not under tmux, where
// the terminal's own 1004 focus-out is reliable.

const TMUX_POLL_INTERVAL_MS = 2500;
const TMUX_QUERY_TIMEOUT_MS = 1000; // hard cap so a wedged tmux can't stall us
let tmuxPoll: ReturnType<typeof setInterval> | null = null;
let tmuxQueryInFlight = false;

// Parse `#{session_attached}:#{window_active}:#{pane_active}` from tmux.
// Returns true only when the pane is genuinely being viewed (its session
// has >=1 attached client AND our window is active AND our pane is active),
// false when it is not, and null when the output is unusable (so callers
// leave the focus state untouched).
export function parseTmuxAttended(out: string): boolean | null {
  const line = out.trim();
  if (!line) return null;
  const parts = line.split(":");
  if (parts.length < 3) return null;
  const [attached, windowActive, paneActive] = parts;
  return attached !== "0" && attached !== "" && windowActive === "1" && paneActive === "1";
}

// The poller's decision, isolated as a pure function so its safety-critical
// invariant is testable and type-enforced: it can force focus OFF (false) or
// do nothing (null), but it can NEVER return true. That guarantees a tmux
// poll cannot re-pin presence to "available" and re-suppress phone push;
// only a real FOCUS_IN may turn focus back on.
export function focusOverrideFromPoll(attended: boolean | null): false | null {
  return attended === false ? false : null;
}

// Async, timeout-bounded tmux query. Never blocks the render/stdin thread
// (spawnSync would), and a stuck tmux server is killed after
// TMUX_QUERY_TIMEOUT_MS instead of freezing the TUI indefinitely.
async function tmuxPaneAttended(pane: string): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(
      [
        "tmux", "display-message", "-p", "-t", pane, "-F",
        "#{session_attached}:#{window_active}:#{pane_active}",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, TMUX_QUERY_TIMEOUT_MS);
    let out = "";
    try {
      out = await new Response(proc.stdout).text();
      await proc.exited;
    } finally {
      clearTimeout(killer);
    }
    if (proc.exitCode !== 0) return null;
    return parseTmuxAttended(out);
  } catch {
    return null; // tmux missing / server gone / killed: don't touch focus state
  }
}

function startTmuxWatch(): void {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return; // not under tmux
  tmuxPoll = setInterval(() => {
    // Nothing to force off once we already believe we're unfocused; wait for
    // the next FOCUS_IN. Also skip if a prior query is still running.
    if (!isTerminalFocused() || tmuxQueryInFlight) return;
    tmuxQueryInFlight = true;
    tmuxPaneAttended(pane)
      .then((attended) => {
        if (focusOverrideFromPoll(attended) === false) setFocused(false);
      })
      .catch(() => {})
      .finally(() => { tmuxQueryInFlight = false; });
  }, TMUX_POLL_INTERVAL_MS);
  // Don't let this housekeeping timer keep the process alive on its own.
  (tmuxPoll as { unref?: () => void }).unref?.();
}

function stopTmuxWatch(): void {
  if (tmuxPoll) {
    clearInterval(tmuxPoll);
    tmuxPoll = null;
  }
}
