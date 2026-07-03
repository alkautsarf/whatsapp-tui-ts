import { expect, test, describe } from "bun:test";
import { parseTmuxAttended, focusOverrideFromPoll } from "./terminal-focus.ts";

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
