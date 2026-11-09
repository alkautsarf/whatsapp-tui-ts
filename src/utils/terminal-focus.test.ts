import { expect, test, describe } from "bun:test";
import {
  parseTmuxAttended,
  focusOverrideFromPoll,
  parseHidIdleMs,
  focusOverrideFromIdle,
  __focusStateForTest as fsm,
} from "./terminal-focus.ts";

describe("parseTmuxAttended", () => {
  test("attended: attached client, active window, active pane", () => {
    expect(parseTmuxAttended("2:1:1")).toBe(true);
    expect(parseTmuxAttended("1:1:1")).toBe(true);
  });

  test("detached session (the switch-client bug) → not attended", () => {
    // The exact reading observed on the live wa-tui pane during the
    // 2026-07-03 no-phone-push incident: session_attached=0.
    expect(parseTmuxAttended("0:1:1")).toBe(false);
  });

  test("inactive window or inactive pane → not attended", () => {
    expect(parseTmuxAttended("1:0:1")).toBe(false);
    expect(parseTmuxAttended("1:1:0")).toBe(false);
    expect(parseTmuxAttended("2:0:0")).toBe(false);
  });

  test("tolerates trailing whitespace/newline from tmux", () => {
    expect(parseTmuxAttended("0:1:1\n")).toBe(false);
    expect(parseTmuxAttended("  2:1:1  ")).toBe(true);
  });

  test("unusable output → null (leave focus state untouched)", () => {
    expect(parseTmuxAttended("")).toBeNull();
    expect(parseTmuxAttended("   ")).toBeNull();
    expect(parseTmuxAttended("garbage")).toBeNull();
    expect(parseTmuxAttended("1:1")).toBeNull(); // too few fields
  });
});

describe("focusOverrideFromPoll (OFF-only invariant)", () => {
  test("not attended → force focus OFF", () => {
    expect(focusOverrideFromPoll(false)).toBe(false);
  });

  test("attended → do nothing (NEVER forces focus ON)", () => {
    // The safety-critical guarantee: a tmux poll can never re-pin presence to
    // "available", so it must not return true here. Only a real FOCUS_IN turns
    // focus back on. If this ever returns true, the 2026-07-03 stuck-available
    // (no phone push) regression is back.
    expect(focusOverrideFromPoll(true)).toBeNull();
  });

  test("unknown/unusable reading → do nothing", () => {
    expect(focusOverrideFromPoll(null)).toBeNull();
  });

  test("only possible outputs are false or null (never true)", () => {
    for (const input of [true, false, null] as const) {
      const out = focusOverrideFromPoll(input);
      expect(out === false || out === null).toBe(true);
      expect(out).not.toBe(true);
    }
  });
});

describe("parseHidIdleMs", () => {
  test("reads HIDIdleTime nanoseconds as milliseconds", () => {
    expect(parseHidIdleMs('    | |     "HIDIdleTime" = 60483583\n')).toBe(60);
    expect(parseHidIdleMs('"HIDIdleTime" = 240000000000')).toBe(240_000);
  });

  test("missing field -> null", () => {
    expect(parseHidIdleMs("")).toBeNull();
    expect(parseHidIdleMs('"HIDIdleTimeX" = garbage')).toBeNull();
  });
});

describe("focusOverrideFromIdle", () => {
  const T = 180_000;

  test("focused and idle past threshold -> force OFF (the 2026-11-09 bug)", () => {
    expect(focusOverrideFromIdle(T, { focused: true, idleForced: false }, T)).toBe(false);
  });

  test("focused and active -> leave alone", () => {
    expect(focusOverrideFromIdle(5_000, { focused: true, idleForced: false }, T)).toBeNull();
  });

  test("idle-forced OFF and input resumed -> restore ON", () => {
    expect(focusOverrideFromIdle(1_000, { focused: false, idleForced: true }, T)).toBe(true);
  });

  test("idle-forced OFF and still idle -> leave alone", () => {
    expect(focusOverrideFromIdle(T * 2, { focused: false, idleForced: true }, T)).toBeNull();
  });

  test("a REAL unfocus is never overridden back ON", () => {
    expect(focusOverrideFromIdle(0, { focused: false, idleForced: false }, T)).toBeNull();
  });

  test("unreadable idle time -> leave alone", () => {
    expect(focusOverrideFromIdle(null, { focused: true, idleForced: false }, T)).toBeNull();
    expect(focusOverrideFromIdle(null, { focused: false, idleForced: true }, T)).toBeNull();
  });
});

describe("focus state machine (idle-forced flag)", () => {
  const T = 180_000;

  test("idle OFF then a real FOCUS_OUT cancels the restore (review finding #1)", () => {
    fsm.reset();
    fsm.set(true);
    fsm.set(false, { idle: true });
    expect(fsm.get()).toEqual({ focused: false, idleForced: true });
    fsm.set(false); // ESC [ O arrives while already OFF
    expect(fsm.get()).toEqual({ focused: false, idleForced: false });
    // The next idle poll after input resumes must NOT turn focus back on.
    expect(focusOverrideFromIdle(1_000, fsm.get(), T)).toBeNull();
  });

  test("idle OFF then FOCUS_IN restores and clears the flag", () => {
    fsm.reset();
    fsm.set(true);
    fsm.set(false, { idle: true });
    fsm.set(true);
    expect(fsm.get()).toEqual({ focused: true, idleForced: false });
  });

  test("idle OFF then input resumes -> poller restores ON", () => {
    fsm.reset();
    fsm.set(true);
    fsm.set(false, { idle: true });
    expect(focusOverrideFromIdle(1_000, fsm.get(), T)).toBe(true);
  });

  test("a non-idle OFF never sets the flag", () => {
    fsm.reset();
    fsm.set(true);
    fsm.set(false);
    expect(fsm.get().idleForced).toBe(false);
  });
});
