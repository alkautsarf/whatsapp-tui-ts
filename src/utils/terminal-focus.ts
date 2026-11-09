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
// True while `focused` is OFF only because the Mac went idle (see the idle
// safety net below), so returning to the keyboard can restore it without
// waiting for a FOCUS_IN that will never come.
let idleForced = false;

type FocusListener = (focused: boolean) => void;
const listeners = new Set<FocusListener>();

export function isTerminalFocused(): boolean {
  return focused;
}

// `idle` marks an OFF caused by the idle poller, so the flag and the state
// change together and no caller has to re-set it afterwards.
function setFocused(next: boolean, opts: { idle?: boolean } = {}): void {
  idleForced = !next && opts.idle === true;
  if (focused === next) return;
  focused = next;
  for (const cb of listeners) {
    try { cb(next); } catch {}
  }
}

// Test-only access to the focus state machine. Not used by the app.
export const __focusStateForTest = {
  set: setFocused,
  get: () => ({ focused, idleForced }),
  reset: () => { focused = false; idleForced = false; },
};

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
    // setFocused also clears `idleForced` even when the state does not flip,
    // so a real FOCUS_OUT while idle-forced OFF cancels the pending restore.
    if (chunk.includes(FOCUS_IN)) setFocused(true);
    if (chunk.includes(FOCUS_OUT)) setFocused(false);
  });

  startTmuxWatch();
  startIdleWatch();
}

export function uninstallFocusTracking(): void {
  if (!installed) return;
  installed = false;
  stopTmuxWatch();
  stopIdleWatch();
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
// Run a short command with a hard kill deadline and return its stdout, or
// null on non-zero exit, spawn failure, or timeout.
async function runBounded(argv: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    let out = "";
    try {
      out = await new Response(proc.stdout).text();
      await proc.exited;
    } finally {
      clearTimeout(killer);
    }
    return proc.exitCode === 0 ? out : null;
  } catch {
    return null;
  }
}

async function tmuxPaneAttended(pane: string): Promise<boolean | null> {
  const out = await runBounded(
    [
      "tmux", "display-message", "-p", "-t", pane, "-F",
      "#{session_attached}:#{window_active}:#{pane_active}",
    ],
    TMUX_QUERY_TIMEOUT_MS,
  );
  // tmux missing / server gone / killed: don't touch focus state
  return out === null ? null : parseTmuxAttended(out);
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

// ---- macOS idle safety net -----------------------------------------
//
// The second way `focused` gets stuck true: the wa-tui pane is the focused
// pane and the user walks away. Display sleep and screen lock deliver no
// FOCUS_OUT, so presence stays "available" and WhatsApp keeps suppressing
// phone push while nobody is at the Mac (2026-11-09 incident). A full system
// sleep drops the socket, so it was only the awake-but-away case that broke.
//
// Fix: poll the HID idle time (keyboard/mouse inactivity, which also covers
// display-off and lock). Past IDLE_THRESHOLD_MS, force focus OFF and remember
// it was idle that did it. When input resumes, restore focus ON, but only if
// idle was the sole reason (any real focus event clears `idleForced`) and,
// under tmux, the pane is still the attended one. macOS only; no-op elsewhere.

const IDLE_THRESHOLD_MS = 3 * 60_000;
const IDLE_POLL_INTERVAL_MS = 15_000;
const IDLE_QUERY_TIMEOUT_MS = 2000;
let idlePoll: ReturnType<typeof setInterval> | null = null;
let idleQueryInFlight = false;

// Parse `HIDIdleTime` (nanoseconds) out of `ioreg -c IOHIDSystem` output.
// Returns milliseconds, or null when the field is missing or unparsable.
export function parseHidIdleMs(out: string): number | null {
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return null;
  const ns = Number(m[1]);
  return Number.isFinite(ns) ? Math.floor(ns / 1_000_000) : null;
}

// The idle poller's decision as a pure function. `false` = force focus OFF
// (went idle while focused), `true` = restore focus ON (input resumed after an
// idle-forced OFF), `null` = leave state alone. It can only return `true`
// when the OFF was idle-forced, so it never overrides a real FOCUS_OUT.
export function focusOverrideFromIdle(
  idleMs: number | null,
  state: { focused: boolean; idleForced: boolean },
  thresholdMs = IDLE_THRESHOLD_MS,
): boolean | null {
  if (idleMs === null) return null;
  if (state.focused && idleMs >= thresholdMs) return false;
  if (!state.focused && state.idleForced && idleMs < thresholdMs) return true;
  return null;
}

async function hidIdleMs(): Promise<number | null> {
  // -r -k limits the dump to the IOHIDSystem entry that carries the key.
  const out = await runBounded(
    ["ioreg", "-c", "IOHIDSystem", "-r", "-k", "HIDIdleTime", "-d", "1"],
    IDLE_QUERY_TIMEOUT_MS,
  );
  return out === null ? null : parseHidIdleMs(out);
}

function startIdleWatch(): void {
  if (process.platform !== "darwin") return;
  idlePoll = setInterval(() => {
    // Only two states need a check: focused (could go idle) and idle-forced
    // OFF (could come back). A real unfocus needs nothing from us.
    if (!(focused || idleForced) || idleQueryInFlight) return;
    idleQueryInFlight = true;
    (async () => {
      const decision = focusOverrideFromIdle(await hidIdleMs(), { focused, idleForced });
      if (decision === false) {
        setFocused(false, { idle: true });
      } else if (decision === true) {
        const pane = process.env.TMUX_PANE;
        if (process.env.TMUX && pane && (await tmuxPaneAttended(pane)) !== true) {
          idleForced = false; // user came back to a different pane: stay OFF
          return;
        }
        setFocused(true);
      }
    })()
      .catch(() => {})
      .finally(() => { idleQueryInFlight = false; });
  }, IDLE_POLL_INTERVAL_MS);
  (idlePoll as { unref?: () => void }).unref?.();
}

function stopIdleWatch(): void {
  if (idlePoll) {
    clearInterval(idlePoll);
    idlePoll = null;
  }
}
