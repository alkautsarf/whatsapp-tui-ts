import type { WASocket } from "@whiskeysockets/baileys";
import type { StoreQueries } from "../store/queries.ts";
import { log, warn } from "../utils/log.ts";
import {
  MUTE_ALWAYS,
  MUTE_NONE,
  isMuted,
  longToNumber,
  muteUntilToWire,
  normalizeMuteUntil,
} from "../utils/mute.ts";
import { fetchAppStateMutations, type AppStateSocket } from "./app-state.ts";

// Baileys swallows a query timeout: after 60s with no reply chatModify
// RESOLVES as if the server had acknowledged. Give up well before that so an
// unconfirmed mute is reported as such rather than recorded as done.
export const MUTE_CONFIRM_TIMEOUT_MS = 20_000;

/** WhatsApp has not confirmed the change within the timeout. It is not a
 *  rejection: the request is still in flight and may yet be applied, in which
 *  case the usual `chats.update` event records it. */
export class MuteUnconfirmedError extends Error {
  constructor() {
    super("WhatsApp has not confirmed yet");
    this.name = "MuteUnconfirmedError";
  }
}

type MuteStore = Pick<StoreQueries, "setChatMute" | "getChat" | "resolveLidToPhoneJid">;

/**
 * Mute or unmute a chat on WhatsApp (it syncs to the phone and other linked
 * devices), then record it locally. `mutedUntil` is the stored form from
 * utils/mute.ts: 0 unmute, -1 always, otherwise a unix time in seconds.
 *
 * The local row is written only after WhatsApp confirms, and written here
 * directly rather than left to the `chats.update` echo Baileys emits for our
 * own change.
 */
export async function setChatMute(
  sock: Pick<WASocket, "chatModify">,
  store: Pick<StoreQueries, "setChatMute">,
  jid: string,
  mutedUntil: number,
  timeoutMs = MUTE_CONFIRM_TIMEOUT_MS,
): Promise<void> {
  const until = normalizeMuteUntil(mutedUntil);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // `mute` is an ABSOLUTE end time in milliseconds (-1 always, null to
      // unmute). Baileys' README shows a duration here; that sends an end
      // time in January 1970.
      sock.chatModify({ mute: muteUntilToWire(until) }, jid),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MuteUnconfirmedError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  store.setChatMute(jid, until);
}

export interface MuteSyncResult {
  /** Chats we have that are muted right now. */
  muted: number;
  /** Chats whose mute state was written (muted or not). */
  applied: number;
  /** Mute records for chats we have no row for. */
  skipped: number;
}

/**
 * Pull every chat's mute state from WhatsApp and apply it to chats we already
 * have.
 *
 * Needed because mute only reaches us as a change event: a chat that was
 * muted on the phone while this client dropped the event stays wrong forever
 * otherwise. Only existing rows are updated, so mute records for groups the
 * user has left do not create empty chats.
 */
export async function syncMuteState(sock: AppStateSocket, store: MuteStore): Promise<MuteSyncResult> {
  const mutations = await fetchAppStateMutations(sock, "regular_high");
  const nowSec = Math.floor(Date.now() / 1000);

  // One chat can be indexed twice (by phone JID and by LID). Apply oldest
  // first so the most recent action is the one left standing.
  const records = mutations
    .filter((m) => m.index[0] === "mute" && m.index[1] && m.syncAction.value?.muteAction)
    .sort((a, b) => actionTime(a.syncAction.value?.timestamp) - actionTime(b.syncAction.value?.timestamp));

  const state = new Map<string, number>();
  let skipped = 0;
  for (const { index, syncAction } of records) {
    const action = syncAction.value!.muteAction!;
    const until = action.muted
      // `muted` with no usable end time can only mean "until further notice".
      ? normalizeMuteUntil(action.muteEndTimestamp) || MUTE_ALWAYS
      : MUTE_NONE;
    const jid = store.resolveLidToPhoneJid(index[1]!);
    if (!store.getChat(jid)) { skipped++; continue; }
    store.setChatMute(jid, until);
    state.set(jid, until);
  }

  let muted = 0;
  for (const until of state.values()) if (isMuted(until, nowSec)) muted++;
  return { muted, applied: state.size, skipped };
}

function actionTime(ts: unknown): number {
  const n = ts == null ? 0 : longToNumber(ts);
  return Number.isFinite(n) ? n : 0;
}

const BACKFILL_KEY = "mute_backfill_v1";
const BACKFILL_MAX_ATTEMPTS = 5;
const BACKFILL_DELAY_MS = 5_000;

let backfillTimer: ReturnType<typeof setTimeout> | null = null;
let backfillRunning = false;
let backfillSock: AppStateSocket | null = null;

/**
 * One-time recovery for installs that predate working mute sync, and for a
 * fresh link (where Baileys can drop mute updates that arrive during history
 * sync): run `syncMuteState` once per linked device, shortly after
 * connecting, and remember that it succeeded.
 *
 * Call it on every connect. It always uses the most recent socket, and a
 * pass that fails after a newer socket has connected is put down to the lost
 * connection: it is not counted and the pass is re-armed on the new socket.
 * (Baileys reports a connection that drops mid-request as a plain timeout,
 * so the error text cannot be trusted to say so.) A pass counts as done only
 * if it told us something: it applied at least one record, or the account
 * has no mute records at all. Real failures and empty passes are capped so
 * this cannot become a request per reconnect; "Resync mute settings from
 * phone" in the command palette remains as the manual route.
 */
export function backfillMuteStateOnce(
  sock: AppStateSocket,
  store: MuteStore & Pick<StoreQueries, "getMeta" | "setMeta">,
  onDone?: () => void,
  delayMs = BACKFILL_DELAY_MS,
): void {
  backfillSock = sock;
  if (backfillTimer || backfillRunning) return;

  // Keyed to the linked device: a re-link gets a new device id and with it a
  // fresh pass, even though app.db (and this flag) is kept across re-links.
  const device = sock.authState.creds.me?.id ?? "unknown";
  const doneKey = `${BACKFILL_KEY}:${device}`;
  const attemptsKey = `${doneKey}:attempts`;
  if (store.getMeta(doneKey)) return;
  if (Number(store.getMeta(attemptsKey) ?? 0) >= BACKFILL_MAX_ATTEMPTS) return;

  // Let the connection settle first; this is housekeeping, not urgent.
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    const current = backfillSock;
    if (!current) return;
    backfillRunning = true;
    const countAttempt = () =>
      store.setMeta(attemptsKey, String(Number(store.getMeta(attemptsKey) ?? 0) + 1));
    let failed = false;

    syncMuteState(current, store)
      .then(({ muted, applied, skipped }) => {
        if (applied === 0 && skipped > 0) {
          // Mute records exist but none of their chats do yet (a fresh link
          // whose history has not landed). Try again on a later connect.
          countAttempt();
          log("wa", `Mute backfill deferred: ${skipped} records, no matching chats yet`);
          return;
        }
        store.setMeta(doneKey, String(Date.now()));
        log("wa", `Mute backfill complete: ${muted} chats muted`);
        onDone?.();
      })
      .catch((e) => {
        failed = true;
        const message = (e as Error)?.message ?? String(e);
        const superseded = backfillSock !== current;
        if (!superseded && !/connection closed/i.test(message)) countAttempt();
        warn("wa", `Mute backfill failed: ${message}`);
      })
      .finally(() => {
        backfillRunning = false;
        // A reconnect that arrived while we were busy was turned away at the
        // top of this function; give its socket the pass it did not get.
        const latest = backfillSock;
        if (failed && latest && latest !== current) {
          backfillMuteStateOnce(latest, store, onDone, delayMs);
        }
      });
  }, delayMs);
}
