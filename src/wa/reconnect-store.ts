// Persistence for reconnect/breaker state across process restarts.
//
// The in-memory breaker resets on every process start, so restarting the app
// mid-cooldown (brew upgrade, in-app Ctrl+P restart, crash) used to fire an
// immediate fresh login burst; that is the exact behavior that feeds
// WhatsApp's 428 penalty box (see the 2026-06-30 storm postmortem). This
// module persists the pending cooldown, the breaker counters, and the rolling
// connect-attempt window under APP_DIR so a restart resumes where the policy
// left off instead of starting from zero.

import { join } from "path";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { APP_DIR } from "../utils/paths.ts";
import { CONNECT_BUDGET_WINDOW_MS, type ReconnectState } from "./reconnect.ts";

export const RECONNECT_STATE_PATH = join(APP_DIR, "reconnect-state.json");

// What kind of wait a persisted cooldownUntil represents. Only the
// throttle-family reasons warrant a system notification on resume; an
// ordinary backoff remainder is routine.
export type CooldownReason = "backoff" | "penalty-box" | "budget";
const REASONS: readonly CooldownReason[] = ["backoff", "penalty-box", "budget"];

export interface ReconnectPersist {
  savedAt: number; // epoch ms of the write; records older than the budget window are discarded
  cooldownUntil: number; // epoch ms the pending reconnect delay ends; 0 = none
  reason: CooldownReason;
  state: ReconnectState;
  connectTimes: number[]; // epoch ms of recent connect attempts (rolling window)
}

function isEpoch(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// Breaker counters must be non-negative integers: a corrupt-but-parseable
// file with a negative cooldownCycle would compute a negative cooldown and
// degrade the penalty box into a 1s retry loop.
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// Keep only timestamps inside the rolling budget window. Future timestamps
// (clock skew, corrupt file) are dropped too so they can't inflate the count.
export function pruneConnectTimes(times: number[], now: number): number[] {
  const cutoff = now - CONNECT_BUDGET_WINDOW_MS;
  return times.filter(
    (t) => typeof t === "number" && Number.isFinite(t) && t > cutoff && t <= now,
  );
}

export function loadReconnectPersist(
  now: number,
  path: string = RECONNECT_STATE_PATH,
): ReconnectPersist | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const s = raw?.state;
    if (
      !isEpoch(raw?.savedAt) ||
      !isEpoch(raw?.cooldownUntil) ||
      !isCount(s?.failures) ||
      !isCount(s?.throttleRun) ||
      !isCount(s?.cooldownCycle) ||
      !Array.isArray(raw?.connectTimes)
    ) {
      return null;
    }
    // A record older than the budget window describes a bygone episode.
    // Stale penalized counters must not haunt a session that has been
    // healthy (or simply not running) for days.
    if (now - raw.savedAt > CONNECT_BUDGET_WINDOW_MS) return null;
    return {
      savedAt: raw.savedAt,
      cooldownUntil: raw.cooldownUntil,
      reason: REASONS.includes(raw.reason) ? raw.reason : "backoff",
      state: {
        failures: s.failures,
        throttleRun: s.throttleRun,
        cooldownCycle: s.cooldownCycle,
      },
      connectTimes: pruneConnectTimes(raw.connectTimes, now),
    };
  } catch {
    return null; // missing or corrupt file: start fresh
  }
}

export function saveReconnectPersist(
  p: ReconnectPersist,
  path: string = RECONNECT_STATE_PATH,
): void {
  // Write-then-rename so a crash mid-write can't leave a truncated file that
  // parses as garbage on the next start.
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(p), "utf-8");
    renameSync(tmp, path);
  } catch {
    // Best-effort: persistence must never break the reconnect path.
  }
}

// A fresh link (or a logout) must start with a clean slate.
export function clearReconnectPersist(path: string = RECONNECT_STATE_PATH): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing file is the normal case.
  }
}
