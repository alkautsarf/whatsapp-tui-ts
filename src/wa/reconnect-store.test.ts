import { afterAll, describe, expect, it } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import {
  loadReconnectPersist,
  saveReconnectPersist,
  clearReconnectPersist,
  pruneConnectTimes,
  type ReconnectPersist,
} from "./reconnect-store.ts";
import { CONNECT_BUDGET_WINDOW_MS } from "./reconnect.ts";

const dir = mkdtempSync(join(tmpdir(), "wa-reconnect-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_000_000_000_000;

function base(overrides: Partial<ReconnectPersist> = {}): ReconnectPersist {
  return {
    savedAt: NOW,
    cooldownUntil: NOW + 60_000,
    reason: "penalty-box",
    state: { failures: 3, throttleRun: 2, cooldownCycle: 1 },
    connectTimes: [NOW - 1_000, NOW - 500],
    ...overrides,
  };
}

describe("reconnect-store", () => {
  it("round-trips state through save/load", () => {
    const path = join(dir, "rt.json");
    saveReconnectPersist(base(), path);
    expect(loadReconnectPersist(NOW, path)).toEqual(base());
  });

  it("returns null for a missing file", () => {
    expect(loadReconnectPersist(NOW, join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt or wrong-shape json", () => {
    const p1 = join(dir, "corrupt.json");
    writeFileSync(p1, "{not json", "utf-8");
    expect(loadReconnectPersist(NOW, p1)).toBeNull();

    const p2 = join(dir, "shape.json");
    writeFileSync(p2, JSON.stringify({ cooldownUntil: "soon", state: {}, connectTimes: [] }), "utf-8");
    expect(loadReconnectPersist(NOW, p2)).toBeNull();
  });

  it("rejects negative or non-integer breaker counters", () => {
    const path = join(dir, "neg.json");
    saveReconnectPersist(base({ state: { failures: 3, throttleRun: 2, cooldownCycle: -2 } }), path);
    expect(loadReconnectPersist(NOW, path)).toBeNull();

    saveReconnectPersist(base({ state: { failures: 1.5, throttleRun: 0, cooldownCycle: 0 } }), path);
    expect(loadReconnectPersist(NOW, path)).toBeNull();
  });

  it("discards records older than the rolling window (stale-episode expiry)", () => {
    const path = join(dir, "stale.json");
    saveReconnectPersist(base({ savedAt: NOW - CONNECT_BUDGET_WINDOW_MS - 1 }), path);
    expect(loadReconnectPersist(NOW, path)).toBeNull();
  });

  it("coerces an unknown reason to backoff", () => {
    const path = join(dir, "reason.json");
    writeFileSync(path, JSON.stringify({ ...base(), reason: "mystery" }), "utf-8");
    expect(loadReconnectPersist(NOW, path)!.reason).toBe("backoff");
  });

  it("prunes connect times outside the rolling window on load", () => {
    const path = join(dir, "prune.json");
    saveReconnectPersist(
      base({ connectTimes: [NOW - CONNECT_BUDGET_WINDOW_MS - 1, NOW - 10] }),
      path,
    );
    expect(loadReconnectPersist(NOW, path)!.connectTimes).toEqual([NOW - 10]);
  });

  it("clearReconnectPersist removes the file and tolerates a missing one", () => {
    const path = join(dir, "clear.json");
    saveReconnectPersist(base(), path);
    clearReconnectPersist(path);
    expect(loadReconnectPersist(NOW, path)).toBeNull();
    clearReconnectPersist(path); // second call: no throw
  });

  it("pruneConnectTimes drops future and non-numeric entries", () => {
    const now = 1_000_000;
    expect(pruneConnectTimes([now - 1, now + 999, Number.NaN, now], now)).toEqual([now - 1, now]);
  });
});
