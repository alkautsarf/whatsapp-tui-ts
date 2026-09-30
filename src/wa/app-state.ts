import {
  decodePatches,
  decodeSyncdSnapshot,
  extractSyncdPatches,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  newLTHashState,
  processSyncAction,
  S_WHATSAPP_NET,
  type ChatMutation,
  type Contact,
  type WAPatchName,
  type WASocket,
} from "@whiskeysockets/baileys";

/** The slice of the socket a from-scratch app-state read needs. */
export type AppStateSocket = Pick<WASocket, "query" | "authState">;

// A collection arrives as one snapshot plus a few rounds of patches. This
// only exists so a server that keeps answering "has more" cannot loop us.
const MAX_ROUNDS = 25;

/**
 * Read one app-state collection from version 0 and return the latest record
 * per index. App state is where WhatsApp keeps per-account settings that sync
 * between devices: mutes, pins, archives, saved contact names.
 *
 * This is deliberately NOT `sock.resyncAppState()`:
 *
 *  - resyncAppState only fetches patches newer than the version stored in the
 *    auth dir, whatever its second argument says. On a linked session it
 *    never re-announces existing records, so it cannot recover state that was
 *    dropped when it first arrived.
 *  - Passing `true` as its second argument makes it worse outside a first
 *    link: every chat update is then emitted with a condition that only holds
 *    during history sync, so Baileys' event buffer parks it and never
 *    delivers it.
 *
 * Instead we send the same IQ ourselves and decode the answer with Baileys'
 * own helpers. Nothing is written to the auth key store and no Baileys events
 * fire, so a failure here cannot leave the session's sync state damaged.
 *
 * Known limit, shared with Baileys' own resync: a record REMOVEd by a patch
 * newer than the snapshot is still returned, because the decoder does not
 * report the operation. Snapshots themselves never contain removed records.
 */
export async function fetchAppStateMutations(
  sock: AppStateSocket,
  name: WAPatchName,
): Promise<ChatMutation[]> {
  const keyCache = new Map<string, Awaited<ReturnType<typeof loadKey>>>();
  async function loadKey(keyId: string) {
    const { [keyId]: key } = await sock.authState.keys.get("app-state-sync-key", [keyId]);
    return key;
  }
  const getKey = async (keyId: string) => {
    if (!keyCache.has(keyId)) keyCache.set(keyId, await loadKey(keyId));
    return keyCache.get(keyId);
  };

  let state = newLTHashState();
  const latest: Record<string, ChatMutation> = {};

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const versionBefore = state.version;
    const result = await sock.query({
      tag: "iq",
      attrs: { to: S_WHATSAPP_NET, xmlns: "w:sync:app:state", type: "set" },
      content: [
        {
          tag: "sync",
          attrs: {},
          content: [
            {
              tag: "collection",
              attrs: {
                name,
                version: state.version.toString(),
                return_snapshot: (!state.version).toString(),
              },
            },
          ],
        },
      ],
    });
    // Baileys resolves a timed-out query with undefined instead of rejecting.
    if (!result) throw new Error(`WhatsApp did not answer the ${name} request`);

    // A refused collection comes back inside an ordinary iq result, as an
    // error on the collection node. Baileys' decoder does not look at it and
    // would report it as an empty, fully synced collection.
    const node = getBinaryNodeChildren(getBinaryNodeChild(result, "sync"), "collection")
      .find((c) => c.attrs.name === name);
    const errorNode = node && getBinaryNodeChild(node, "error");
    if (node?.attrs.type === "error" || errorNode) {
      const detail = errorNode?.attrs.text ?? errorNode?.attrs.code ?? "no detail";
      throw new Error(`WhatsApp refused the ${name} request (${detail})`);
    }

    const decoded = await extractSyncdPatches(result, {});
    const collection = decoded[name];
    if (!collection) throw new Error(`WhatsApp returned no ${name} collection`);
    // We asked from version 0 with a snapshot; an answer carrying neither a
    // snapshot nor patches told us nothing, which is not the same as "empty".
    if (round === 0 && !collection.snapshot && !collection.patches.length) {
      throw new Error(`WhatsApp returned no data for ${name}`);
    }

    // MAC validation is off, matching Baileys' own default for app state.
    if (collection.snapshot) {
      const snap = await decodeSyncdSnapshot(name, collection.snapshot, getKey, undefined, false);
      state = snap.state;
      Object.assign(latest, snap.mutationMap);
    }
    if (collection.patches.length) {
      const patched = await decodePatches(
        name, collection.patches, state, getKey, {}, undefined, undefined, false,
      );
      state = patched.state;
      Object.assign(latest, patched.mutationMap);
    }

    if (!collection.hasMorePatches) return Object.values(latest);
    if (state.version === versionBefore) {
      throw new Error(`${name} sync made no progress at v${state.version}`);
    }
  }
  throw new Error(`${name} sync did not finish in ${MAX_ROUNDS} rounds`);
}

const CONTACT_COLLECTIONS: WAPatchName[] = ["critical_unblock_low", "regular_low", "regular"];

let contactResync: "idle" | "running" | "done" = "idle";

/**
 * Re-read the address book from scratch and hand every saved-contact record
 * to the normal `contacts.upsert` handlers, so the mask-vs-name rule in the
 * contact upsert applies. Returns how many records were replayed.
 *
 * Succeeds at most once per process: connection "open" fires on every
 * reconnect, and a full re-read each time would be pure waste. A failed
 * attempt does not use up that once. The records go out as ONE
 * event per collection. Emitting them one by one costs a chat-list refresh
 * each and froze the UI for ~12s on a 2,000-contact address book, long enough
 * to threaten Baileys' keepalive.
 */
export async function resyncContacts(
  sock: AppStateSocket & Pick<WASocket, "ev">,
): Promise<number> {
  if (contactResync !== "idle") return 0;
  const me = sock.authState.creds.me;
  if (!me) throw new Error("not linked");
  contactResync = "running";
  try {
    const replayed = await replayContacts(sock, me);
    contactResync = "done";
    return replayed;
  } catch (e) {
    contactResync = "idle";
    throw e;
  }
}

async function replayContacts(
  sock: AppStateSocket & Pick<WASocket, "ev">,
  me: Contact,
): Promise<number> {
  let replayed = 0;
  for (const name of CONTACT_COLLECTIONS) {
    const contacts: Contact[] = [];
    // Let Baileys turn each record into its contact shape, but collect the
    // results instead of emitting them; LID-mapping side events are dropped
    // so this stays a read that writes nothing to the auth key store.
    const collector = {
      emit(event: string, data: unknown) {
        if (event === "contacts.upsert") contacts.push(...(data as Contact[]));
        return true;
      },
    } as unknown as WASocket["ev"];
    for (const mutation of await fetchAppStateMutations(sock, name)) {
      const value = mutation.syncAction.value;
      if (!value?.contactAction && !value?.lidContactAction) continue;
      processSyncAction(mutation, collector, me);
    }
    if (contacts.length) sock.ev.emit("contacts.upsert", contacts);
    replayed += contacts.length;
  }
  return replayed;
}
