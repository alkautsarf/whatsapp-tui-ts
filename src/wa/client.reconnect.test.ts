import { describe, expect, it } from "bun:test";
import {
  computeReconnect,
  RECONNECT_INITIAL,
  RECONNECT_CEILING_MS,
  RECONNECT_FLOOR_MS,
  CB_COOLDOWN_BASE_MS,
  type ReconnectDecision,
  type ReconnectState,
} from "./reconnect.ts";

// rng=0.5 => (0.5*2-1)=0 => zero jitter => delay is exactly the base, deterministic.
const NO_JITTER = () => 0.5;

const CONNECTION_CLOSED = 428; // throttle family
const UNAVAILABLE = 503; // throttle family
const CONNECTION_LOST = 408; // transient/network, NOT throttle family

type Step = number | undefined | { code: number | undefined; stable?: boolean };
type RunRow = ReconnectState & { delay: number; inPenaltyBox: boolean };

// Drive a sequence of closes through the policy. Each step is a status code
// (treated as an unstable close) or {code, stable} to mark a healthy session.
function run(steps: Step[], rng = NO_JITTER): RunRow[] {
  let state: ReconnectState = { ...RECONNECT_INITIAL };
  return steps.map((step) => {
    const isObj = typeof step === "object" && step !== null;
    const code = isObj ? step.code : (step as number | undefined);
    const stable = isObj ? !!step.stable : false;
    const d: ReconnectDecision = computeReconnect(state, code, stable, rng);
    state = d.next;
    return { ...d.next, delay: d.delay, inPenaltyBox: d.inPenaltyBox };
  });
}

const delaysOf = (rows: RunRow[]) => rows.map((r) => r.delay);

describe("computeReconnect backoff", () => {
  it("recovers a single transient close fast (~2s)", () => {
    const [r] = run([CONNECTION_CLOSED]);
    expect(r!.delay).toBe(2000);
    expect(r!.inPenaltyBox).toBe(false);
    expect(r!.failures).toBe(1);
  });

  it("backs off exponentially, capped at the 60s ceiling (fast blip recovery)", () => {
    // pure non-throttle storm => backoff only, never trips the breaker
    const rows = run(Array(8).fill(CONNECTION_LOST));
    expect(delaysOf(rows)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(rows.every((r) => !r.inPenaltyBox)).toBe(true);
  });
});

describe("computeReconnect 428 circuit breaker", () => {
  it("trips after 6 throttle-family closes and escalates the cooldown", () => {
    const rows = run(Array(10).fill(CONNECTION_CLOSED));
    expect(delaysOf(rows).slice(0, 5)).toEqual([2000, 4000, 8000, 16000, 32000]);
    expect(delaysOf(rows).slice(5)).toEqual([
      15 * 60_000,
      30 * 60_000,
      45 * 60_000,
      60 * 60_000,
      60 * 60_000,
    ]);
    expect(rows[4]!.inPenaltyBox).toBe(false);
    expect(rows[5]!.inPenaltyBox).toBe(true);
  });

  it("[regression] a brief flap-open does NOT reset the run, so flaps still trip", () => {
    // 6 closes that each followed a too-short open (stable:false): must accumulate.
    const rows = run(Array(6).fill({ code: CONNECTION_CLOSED, stable: false }));
    expect(rows[5]!.inPenaltyBox).toBe(true);
    expect(rows[5]!.throttleRun).toBe(6);
  });

  it("[regression] interleaved non-428 closes do NOT reset the throttle run", () => {
    // mixed 428/408 storm (the real 2026-06-30 pattern) must still trip the breaker
    const rows = run([
      CONNECTION_CLOSED,
      CONNECTION_CLOSED,
      CONNECTION_CLOSED,
      CONNECTION_LOST,
      CONNECTION_CLOSED,
      CONNECTION_CLOSED,
      CONNECTION_CLOSED,
    ]);
    expect(rows[3]!.throttleRun).toBe(3); // the 408 neither incremented nor reset it
    expect(rows[6]!.inPenaltyBox).toBe(true); // the 6th 428 trips it
  });

  it("503 counts toward the throttle run alongside 428", () => {
    const rows = run([CONNECTION_CLOSED, UNAVAILABLE, CONNECTION_CLOSED, UNAVAILABLE, CONNECTION_CLOSED, UNAVAILABLE]);
    expect(rows[5]!.inPenaltyBox).toBe(true);
    expect(rows[5]!.throttleRun).toBe(6);
  });

  it("a pure non-throttle (network) storm never trips the breaker", () => {
    const rows = run(Array(20).fill(CONNECTION_LOST));
    expect(rows.every((r) => !r.inPenaltyBox)).toBe(true);
    expect(rows[19]!.throttleRun).toBe(0);
  });
});

describe("computeReconnect stability reset", () => {
  it("[regression] a healthy (stable) session resets the accounting to a 2s first-attempt", () => {
    const rows = run([...Array(6).fill(CONNECTION_CLOSED), { code: CONNECTION_CLOSED, stable: true }]);
    expect(rows[5]!.inPenaltyBox).toBe(true); // tripped
    const healed = rows[6]!;
    expect(healed.inPenaltyBox).toBe(false);
    expect(healed.throttleRun).toBe(1);
    expect(healed.cooldownCycle).toBe(0);
    expect(healed.delay).toBe(2000);
  });

  it("repeated stable reconnects never accumulate toward the breaker", () => {
    const rows = run(Array(10).fill({ code: CONNECTION_CLOSED, stable: true }));
    expect(rows.every((r) => r.throttleRun === 1 && !r.inPenaltyBox)).toBe(true);
  });
});

describe("computeReconnect jitter", () => {
  it("applies +/-25% jitter within bounds on backoff", () => {
    const low = computeReconnect({ ...RECONNECT_INITIAL }, CONNECTION_LOST, false, () => 0).delay;
    const high = computeReconnect({ ...RECONNECT_INITIAL }, CONNECTION_LOST, false, () => 1).delay;
    expect(low).toBe(1500); // 2000 * 0.75
    expect(high).toBe(2500); // 2000 * 1.25
  });

  it("[regression] jitter never pushes a backoff delay past the ceiling", () => {
    // drive to the ceiling then apply max positive jitter: must clamp to ceiling.
    let state: ReconnectState = { ...RECONNECT_INITIAL };
    for (let i = 0; i < 8; i++) state = computeReconnect(state, CONNECTION_LOST, false, NO_JITTER).next;
    const d = computeReconnect(state, CONNECTION_LOST, false, () => 1).delay;
    expect(d).toBe(RECONNECT_CEILING_MS);
  });

  it("[regression] cooldowns are jittered too (no synchronized drumbeat)", () => {
    // first cooldown: throttleRun reaches threshold (6) on this close.
    const tripped: ReconnectState = { failures: 6, throttleRun: 6, cooldownCycle: 0 };
    const low = computeReconnect(tripped, CONNECTION_CLOSED, false, () => 0);
    const high = computeReconnect(tripped, CONNECTION_CLOSED, false, () => 1);
    expect(low.inPenaltyBox && high.inPenaltyBox).toBe(true);
    expect(low.delay).toBe(Math.round(CB_COOLDOWN_BASE_MS * 0.75));
    expect(high.delay).toBe(Math.round(CB_COOLDOWN_BASE_MS * 1.25));
    expect(low.delay).not.toBe(high.delay);
  });

  it("never returns a delay below the floor across a long mixed sequence", () => {
    const cycle: Step[] = [CONNECTION_CLOSED, CONNECTION_LOST, UNAVAILABLE, undefined];
    const seq: Step[] = Array.from({ length: 50 }, (_, i) => cycle[i % 4]);
    const rows = run(seq, () => 0); // max negative jitter throughout
    expect(Math.min(...delaysOf(rows))).toBeGreaterThanOrEqual(RECONNECT_FLOOR_MS);
  });
});
