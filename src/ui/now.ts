import { createSignal, onCleanup } from "solid-js";

/**
 * A reactive "current unix time in seconds" that ticks on an interval. For
 * UI that depends on the clock rather than on store changes, such as a timed
 * mute's marker, which must disappear when the mute runs out even if nothing
 * else happens.
 */
export function useNowSec(intervalMs = 30_000): () => number {
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}
