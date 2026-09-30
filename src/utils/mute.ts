/**
 * Chat mute state, shared by the WhatsApp handlers, the notification gate and
 * the UI.
 *
 * Stored form (`chats.muted_until`), always one of:
 *    0   not muted
 *   -1   muted with no end ("Always" on the phone)
 *   >0   muted until this unix time, in SECONDS
 *
 * WhatsApp does not send that form. The app-state mute action carries
 * `muteEndTimestamp` in MILLISECONDS, uses -1 for "Always", and signals an
 * unmute with null. Everything that crosses the wire goes through
 * `normalizeMuteUntil` / `muteUntilToWire` so the rest of the app only ever
 * sees the stored form.
 */

export const MUTE_NONE = 0;
export const MUTE_ALWAYS = -1;

/** Above this a positive value can only be milliseconds (seconds stay below
 *  it until the year 5138). */
const MS_THRESHOLD = 100_000_000_000;

/** Beyond any real end time even in milliseconds. History sync carries the
 *  mute as an UNSIGNED 64-bit field, where an "always" of -1 would surface as
 *  1.8e19; read anything this large as "always" rather than a date. */
const ABSURD_THRESHOLD = 1e15;

/** The choices offered by the mute dialog, in display order. `seconds` is
 *  the duration from now; null means no end. The `value` doubles as the
 *  dialog option id, so adding a duration is a one-line change here. */
export const MUTE_OPTIONS = [
  { value: "mute-8h", label: "8 hours", seconds: 8 * 60 * 60 },
  { value: "mute-1w", label: "1 week", seconds: 7 * 24 * 60 * 60 },
  { value: "mute-always", label: "Always", seconds: null },
] as const;

export type MuteOptionValue = (typeof MUTE_OPTIONS)[number]["value"];

/** Stored `muted_until` for a picked dialog option, or null if `value` is
 *  not a mute option. */
export function muteUntilForOption(value: string, nowSec: number): number | null {
  const option = MUTE_OPTIONS.find((o) => o.value === value);
  if (!option) return null;
  return option.seconds === null ? MUTE_ALWAYS : nowSec + option.seconds;
}

/** Number, bigint, numeric string or protobuf Long to a JS number (NaN if it
 *  is none of those). Never read a Long as `.low >>> 0`: that turns the -1
 *  "Always" sentinel into 4294967295 and drops the high bits of a
 *  millisecond timestamp. */
export function longToNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (raw && typeof raw === "object" && typeof (raw as any).toNumber === "function") {
    return (raw as any).toNumber();
  }
  return Number(raw);
}

/** Convert whatever WhatsApp / Baileys hands us into the stored form. */
export function normalizeMuteUntil(raw: unknown): number {
  if (raw == null || raw === false) return MUTE_NONE;
  const n = longToNumber(raw);
  if (!Number.isFinite(n) || n === 0) return MUTE_NONE;
  if (n < 0 || n >= ABSURD_THRESHOLD) return MUTE_ALWAYS;
  return n > MS_THRESHOLD ? Math.floor(n / 1000) : Math.floor(n);
}

/** True when a stored `muted_until` value means "muted right now". */
export function isMuted(mutedUntil: number | null | undefined, nowSec: number): boolean {
  const until = normalizeMuteUntil(mutedUntil);
  return until === MUTE_ALWAYS || until > nowSec;
}

/** Stored form to the value Baileys' `chatModify({ mute })` expects: an
 *  absolute end time in milliseconds, -1 for always, null to unmute. */
export function muteUntilToWire(mutedUntil: number): number | null {
  const until = normalizeMuteUntil(mutedUntil);
  if (until === MUTE_NONE) return null;
  if (until === MUTE_ALWAYS) return MUTE_ALWAYS;
  return until * 1000;
}

/** Short human label for a muted chat, e.g. "muted", "muted until 02:25",
 *  "muted until Oct 7". Empty string when not muted. */
export function describeMute(mutedUntil: number | null | undefined, nowSec: number): string {
  const until = normalizeMuteUntil(mutedUntil);
  if (!isMuted(until, nowSec)) return "";
  if (until === MUTE_ALWAYS) return "muted";
  const end = new Date(until * 1000);
  // A clock time while the end is under a day away (an 8 hour mute set in
  // the evening ends "at 02:25", not "on Oct 1"), a date beyond that.
  const when = until - nowSec < 24 * 60 * 60
    ? end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : end.toLocaleDateString([], { month: "short", day: "numeric" });
  return `muted until ${when}`;
}
