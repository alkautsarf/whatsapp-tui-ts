import { describe, expect, it } from "bun:test";
import {
  MUTE_ALWAYS,
  MUTE_NONE,
  describeMute,
  isMuted,
  muteUntilToWire,
  normalizeMuteUntil,
} from "./mute.ts";

const NOW = 1_790_000_000; // seconds

/** Minimal stand-in for a protobuf Long. */
function long(n: number) {
  return { low: n | 0, high: n < 0 ? -1 : 0, unsigned: false, toNumber: () => n };
}

describe("normalizeMuteUntil", () => {
  it("treats absent and zero values as not muted", () => {
    for (const v of [null, undefined, 0, false, "", NaN, "junk"]) {
      expect(normalizeMuteUntil(v)).toBe(MUTE_NONE);
    }
  });

  it("maps any negative value to the always sentinel", () => {
    expect(normalizeMuteUntil(-1)).toBe(MUTE_ALWAYS);
    expect(normalizeMuteUntil(-1000)).toBe(MUTE_ALWAYS);
    expect(normalizeMuteUntil(-1n)).toBe(MUTE_ALWAYS);
  });

  it("keeps -1 when it arrives as a protobuf Long", () => {
    // `.low >>> 0` on this would yield 4294967295 (muted until 2106).
    expect(normalizeMuteUntil(long(-1))).toBe(MUTE_ALWAYS);
  });

  it("converts millisecond timestamps to seconds", () => {
    expect(normalizeMuteUntil(1_787_494_531_872)).toBe(1_787_494_531);
    expect(normalizeMuteUntil(long(1_787_494_531_872))).toBe(1_787_494_531);
    expect(normalizeMuteUntil("1787494531872")).toBe(1_787_494_531);
  });

  it("reads an unsigned all-ones value as always, not as a date", () => {
    // -1 stored in a uint64 field (history sync) surfaces as 2^64 - 1.
    expect(normalizeMuteUntil(18446744073709551615)).toBe(MUTE_ALWAYS);
    expect(normalizeMuteUntil(long(18446744073709551615))).toBe(MUTE_ALWAYS);
    expect(normalizeMuteUntil(4_294_967_295_000)).toBe(4_294_967_295);
  });

  it("leaves second timestamps alone", () => {
    expect(normalizeMuteUntil(1_787_494_531)).toBe(1_787_494_531);
  });
});

describe("isMuted", () => {
  it("is false for an unmuted chat", () => {
    expect(isMuted(0, NOW)).toBe(false);
    expect(isMuted(null, NOW)).toBe(false);
    expect(isMuted(undefined, NOW)).toBe(false);
  });

  it("is true for an always-muted chat", () => {
    expect(isMuted(MUTE_ALWAYS, NOW)).toBe(true);
  });

  it("follows the end time of a timed mute", () => {
    expect(isMuted(NOW + 60, NOW)).toBe(true);
    expect(isMuted(NOW - 60, NOW)).toBe(false);
    expect(isMuted(NOW, NOW)).toBe(false);
  });

  it("expires a legacy millisecond value instead of muting forever", () => {
    // The pre-v4 bug: 1787494531872 (ms, Aug 2026) compared against seconds
    // was always "in the future".
    expect(isMuted(1_787_494_531_872, NOW)).toBe(false);
    expect(isMuted((NOW + 60) * 1000, NOW)).toBe(true);
  });
});

describe("muteUntilToWire", () => {
  it("unmutes with null", () => {
    expect(muteUntilToWire(MUTE_NONE)).toBeNull();
  });

  it("passes the always sentinel through", () => {
    expect(muteUntilToWire(MUTE_ALWAYS)).toBe(-1);
  });

  it("sends an absolute end time in milliseconds", () => {
    expect(muteUntilToWire(NOW + 8 * 3600)).toBe((NOW + 8 * 3600) * 1000);
  });

  it("round-trips through normalizeMuteUntil", () => {
    for (const v of [MUTE_NONE, MUTE_ALWAYS, NOW + 3600]) {
      expect(normalizeMuteUntil(muteUntilToWire(v))).toBe(v);
    }
  });
});

describe("describeMute", () => {
  it("is empty when not muted or already expired", () => {
    expect(describeMute(0, NOW)).toBe("");
    expect(describeMute(NOW - 1, NOW)).toBe("");
  });

  it("labels an always mute without an end", () => {
    expect(describeMute(MUTE_ALWAYS, NOW)).toBe("muted");
  });

  it("labels a mute ending within a day with a clock time, even past midnight", () => {
    expect(describeMute(NOW + 3600, NOW)).toMatch(/^muted until \d{2}:\d{2}$/);
    expect(describeMute(NOW + 23 * 3600, NOW)).toMatch(/^muted until \d{2}:\d{2}$/);
  });

  it("labels a longer mute with a date", () => {
    expect(describeMute(NOW + 7 * 86400, NOW)).toMatch(/^muted until \D+ \d{1,2}$/);
  });
});
