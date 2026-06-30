// Pure reconnect-delay policy for the WhatsApp socket. Dependency-free on
// purpose, so it is cheap to unit-test and reason about in isolation from the
// Baileys stack.
//
// Background: on 2026-06-30 a transient WhatsApp server wobble (503) flipped to
// a persistent 428 (connectionClosed), and an unbounded reconnect loop hammered
// the server ~3,600 times over 7h, holding the account in a connection-rate
// anti-abuse penalty box. This policy bounds reconnect frequency (exponential
// backoff + jitter + ceiling) and trips a circuit breaker on a sustained
// server-throttle run, escalating to long cooldowns so the box can clear.

export const RECONNECT_BASE_MS = 2_000;
// Ordinary-backoff cap. Kept short (1 min) so a normal network blip recovers
// fast; the breaker (not this ceiling) is what absorbs a sustained outage.
export const RECONNECT_CEILING_MS = 60_000;
export const RECONNECT_MAX_EXP = 8;
// +/-25% jitter so independent attempts never sync into a steady drumbeat (the
// exact cadence WhatsApp's anti-abuse detector keys on).
export const RECONNECT_JITTER = 0.25;
// Never retry sub-second, even if the constants above are later changed.
export const RECONNECT_FLOOR_MS = 1_000;

// Throttle-family closes before the breaker trips.
export const CB_THRESHOLD = 6;
export const CB_COOLDOWN_BASE_MS = 15 * 60_000; // first penalty-box cooldown: 15 min
export const CB_COOLDOWN_CEILING_MS = 60 * 60_000; // cap escalating cooldown at 1 hr

// A connection must stay open at least this long to count as "healthy". A
// shorter open (a throttle flap that accepts the handshake then drops the
// stream) must NOT reset the breaker accounting, otherwise repeated flaps each
// reset to a ~2s first-attempt backoff and re-create the storm.
export const STABLE_OPEN_MS = 30_000;

// WhatsApp server-throttle family: 428 connectionClosed (server closes the
// stream right after the handshake) and 503 unavailableService. The breaker
// counts these; transient 408/timeouts and local liveness closes neither
// increment nor reset the throttle run.
export function isThrottleClose(statusCode: number | undefined): boolean {
  return statusCode === 428 || statusCode === 503;
}

export interface ReconnectState {
  failures: number; // consecutive closes since the last healthy (stable) open
  throttleRun: number; // consecutive throttle-family closes since the last stable open
  cooldownCycle: number; // penalty-box cooldowns served since the last stable open
}

export interface ReconnectDecision {
  delay: number; // ms to wait before the next connect()
  inPenaltyBox: boolean; // true => long escalating cooldown, false => normal backoff
  next: ReconnectState; // counters to carry into the next close
}

export const RECONNECT_INITIAL: ReconnectState = { failures: 0, throttleRun: 0, cooldownCycle: 0 };

function applyJitter(ms: number, rng: () => number): number {
  return Math.round(ms + ms * RECONNECT_JITTER * (rng() * 2 - 1));
}

// Decide how long to wait before the next reconnect, given the prior state, the
// close's status code, and whether the connection that just closed had been
// open long enough to count as healthy. `rng` is injectable so tests are
// deterministic.
export function computeReconnect(
  prev: ReconnectState,
  statusCode: number | undefined,
  wasStableBeforeClose: boolean,
  rng: () => number = Math.random,
): ReconnectDecision {
  // A close that ended a genuinely healthy session starts the accounting fresh:
  // the prior session's stability means this close is a brand-new first failure.
  // A flap (open but not stable) does NOT reset, so repeated flaps still trip.
  const base = wasStableBeforeClose ? RECONNECT_INITIAL : prev;

  const failures = base.failures + 1;
  const throttleRun = base.throttleRun + (isThrottleClose(statusCode) ? 1 : 0);
  let cooldownCycle = base.cooldownCycle;

  // The breaker is sticky: once tripped it stays engaged (every subsequent close
  // serves an escalating cooldown, regardless of code) until a stable open
  // resets the accounting. That stops us from drifting back into a tight loop
  // when transient non-throttle closes interleave with the throttle run.
  const inPenaltyBox = throttleRun >= CB_THRESHOLD || cooldownCycle > 0;

  let delay: number;
  if (inPenaltyBox) {
    cooldownCycle++;
    const cooldown = Math.min(CB_COOLDOWN_BASE_MS * cooldownCycle, CB_COOLDOWN_CEILING_MS);
    delay = applyJitter(cooldown, rng);
  } else {
    const exp = Math.min(failures - 1, RECONNECT_MAX_EXP);
    const baseDelay = Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_CEILING_MS);
    // Clamp AFTER jitter so the documented ceiling is a genuine hard cap.
    delay = Math.min(applyJitter(baseDelay, rng), RECONNECT_CEILING_MS);
  }
  delay = Math.max(RECONNECT_FLOOR_MS, delay);

  return { delay, inPenaltyBox, next: { failures, throttleRun, cooldownCycle } };
}
