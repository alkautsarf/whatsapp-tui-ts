import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { randomBytes } from "crypto";
import {
  chatModificationToAppPatch,
  encodeSyncdPatch,
  newLTHashState,
  proto,
} from "@whiskeysockets/baileys";
import { closeDb } from "../store/db.ts";
import { tempStores } from "../test-store.ts";
import { muteFromChat, registerHandlers } from "./handlers.ts";
import { MuteUnconfirmedError, backfillMuteStateOnce, setChatMute, syncMuteState } from "./mute.ts";

const { freshStore } = tempStores("wa-mute");

const GROUP = "120363000000000001@g.us";
const OTHER = "120363000000000002@g.us";
const GONE = "120363000000000003@g.us";
const NOW_SEC = Math.floor(Date.now() / 1000);

describe("muteFromChat", () => {
  it("returns undefined when the chat object carries no mute key", () => {
    expect(muteFromChat({ id: GROUP, unreadCount: 3 })).toBeUndefined();
    expect(muteFromChat({ id: GROUP })).toBeUndefined();
  });

  it("reads an app-state unmute (own null) as unmuted", () => {
    expect(muteFromChat({ id: GROUP, muteEndTime: null })).toBe(0);
  });

  it("reads always and timed mutes from app state", () => {
    expect(muteFromChat({ id: GROUP, muteEndTime: -1 })).toBe(-1);
    expect(muteFromChat({ id: GROUP, muteEndTime: 1_900_000_000_000 })).toBe(1_900_000_000);
  });

  it("reads a numeric zero from app state as muted with no end time", () => {
    // Baileys sends null for an unmute, so 0 is `muted: true` without a timestamp.
    expect(muteFromChat({ id: GROUP, muteEndTime: 0 })).toBe(-1);
  });

  it("honours app-state updates that the event buffer merged into a history chat", () => {
    const merged = (muteEndTime: number | null) => {
      const chat: any = proto.Conversation.decode(proto.Conversation.encode({ id: GROUP }).finish());
      return Object.assign(chat, { muteEndTime }); // what concatChats does
    };
    expect(muteFromChat(merged(null))).toBe(0);
    expect(muteFromChat(merged(0))).toBe(-1);
    expect(muteFromChat(merged(-1))).toBe(-1);
  });

  it("ignores the prototype default on a history chat with no mute field", () => {
    // Exactly what Baileys hands to messaging-history.set: a decoded proto
    // object whose absent muteEndTime still reads as null.
    const chat = proto.Conversation.decode(proto.Conversation.encode({ id: GROUP }).finish());
    expect(chat.muteEndTime).toBeNull();
    expect(muteFromChat(chat)).toBeUndefined();
  });

  it("takes a mute from a history chat but never an unmute", () => {
    const decode = (muteEndTime: number) =>
      proto.Conversation.decode(proto.Conversation.encode({ id: GROUP, muteEndTime }).finish());
    expect(muteFromChat(decode(1_900_000_000_000))).toBe(1_900_000_000);
    expect(muteFromChat(decode(1_900_000_000))).toBe(1_900_000_000);
    expect(muteFromChat(decode(0))).toBeUndefined();
  });
});

describe("chat event handlers", () => {
  it("apply phone mute changes to an existing chat and survive unrelated updates", () => {
    const { db, store } = freshStore("handlers.db");
    const ev = new EventEmitter();
    registerHandlers({ ev, user: { id: "1:1@s.whatsapp.net" } } as any, store);
    // The row exists first, as it does for any chat that has had a message.
    store.upsertChat({ jid: GROUP, is_group: 1, last_msg_ts: 100 });

    ev.emit("chats.update", [{ id: GROUP, muteEndTime: -1 }]);
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);

    ev.emit("chats.update", [{ id: GROUP, unreadCount: 4, conversationTimestamp: 200 }]);
    ev.emit("chats.upsert", [{ id: GROUP, name: "renamed" }]);
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);

    ev.emit("chats.update", [{ id: GROUP, muteEndTime: (NOW_SEC + 3600) * 1000 }]);
    expect(store.getChat(GROUP)?.muted_until).toBe(NOW_SEC + 3600);

    ev.emit("chats.update", [{ id: GROUP, muteEndTime: null }]);
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    closeDb(db);
  });

  it("applies an unarchive and an unpin from the phone", () => {
    const { db, store } = freshStore("flags-handlers.db");
    const ev = new EventEmitter();
    registerHandlers({ ev, user: { id: "1:1@s.whatsapp.net" } } as any, store);
    store.upsertChat({ jid: GROUP, is_group: 1, pinned: 1, archived: 1 });
    ev.emit("chats.update", [{ id: GROUP, unreadCount: 2 }]);
    expect(store.getChat(GROUP)?.archived).toBe(1);
    ev.emit("chats.update", [{ id: GROUP, archived: false }]);
    ev.emit("chats.update", [{ id: GROUP, pinned: null }]);
    expect(store.getChat(GROUP)?.archived).toBe(0);
    expect(store.getChat(GROUP)?.pinned).toBe(0);
    closeDb(db);
  });

  it("does not let a history batch without mute info clear a mute", () => {
    const { db, store } = freshStore("history.db");
    const ev = new EventEmitter();
    registerHandlers({ ev, user: { id: "1:1@s.whatsapp.net" } } as any, store);
    store.upsertChat({ jid: GROUP, is_group: 1, muted_until: -1 });
    const chat = proto.Conversation.decode(
      proto.Conversation.encode({ id: GROUP, name: "from history" }).finish(),
    );
    ev.emit("messaging-history.set", { chats: [chat], contacts: [], messages: [] });
    const row = store.getChat(GROUP);
    expect(row?.name).toBe("from history");
    expect(row?.muted_until).toBe(-1);
    closeDb(db);
  });
});

describe("setChatMute", () => {
  function fakeSock(impl: () => Promise<void> = async () => {}) {
    const calls: Array<[unknown, string]> = [];
    return {
      calls,
      sock: {
        chatModify: async (mod: unknown, jid: string) => {
          calls.push([mod, jid]);
          await impl();
        },
      } as any,
    };
  }

  it("sends an absolute millisecond end time and stores seconds", async () => {
    const { db, store } = freshStore("set-timed.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const { sock, calls } = fakeSock();
    await setChatMute(sock, store, GROUP, NOW_SEC + 8 * 3600);
    expect(calls).toEqual([[{ mute: (NOW_SEC + 8 * 3600) * 1000 }, GROUP]]);
    expect(store.getChat(GROUP)?.muted_until).toBe(NOW_SEC + 8 * 3600);
    closeDb(db);
  });

  it("sends -1 for always and null to unmute", async () => {
    const { db, store } = freshStore("set-always.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const { sock, calls } = fakeSock();
    await setChatMute(sock, store, GROUP, -1);
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    await setChatMute(sock, store, GROUP, 0);
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    expect(calls.map(([mod]) => mod)).toEqual([{ mute: -1 }, { mute: null }]);
    closeDb(db);
  });

  it("leaves the local row untouched when WhatsApp rejects", async () => {
    const { db, store } = freshStore("set-reject.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const { sock } = fakeSock(async () => { throw new Error("Connection Closed"); });
    await expect(setChatMute(sock, store, GROUP, -1)).rejects.toThrow("Connection Closed");
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    closeDb(db);
  });

  it("fails instead of recording a mute WhatsApp never confirmed", async () => {
    const { db, store } = freshStore("set-timeout.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const { sock } = fakeSock(() => new Promise(() => {}));
    await expect(setChatMute(sock, store, GROUP, -1, 20)).rejects.toBeInstanceOf(MuteUnconfirmedError);
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    closeDb(db);
  });
});

/**
 * A fake socket that answers the app-state IQ with real, encrypted patches
 * built by Baileys' own encoder, so the whole decode path runs offline.
 */
async function appStateSock(
  mutes: Array<[string, number | null]>,
  perResponse = 100,
  deviceId = "6281:1@s.whatsapp.net",
) {
  const keyId = Buffer.from("AAAAAAAB", "base64").toString("base64");
  const key = { keyData: randomBytes(32) };
  const getKey = async () => key;

  let state = newLTHashState();
  const patches: Buffer[] = [];
  for (const [jid, mute] of mutes) {
    const enc = await encodeSyncdPatch(
      chatModificationToAppPatch({ mute }, jid), keyId, state, getKey as any,
    );
    state = enc.state;
    // Distinct sync timestamps, so "most recent action wins" is testable.
    await new Promise((r) => setTimeout(r, 2));
    patches.push(Buffer.from(
      proto.SyncdPatch.encode({ ...enc.patch, version: { version: state.version } }).finish(),
    ));
  }

  const requests: Array<Record<string, string>> = [];
  const sock = {
    authState: {
      creds: { me: { id: deviceId } },
      keys: { get: async (_type: string, ids: string[]) => ({ [ids[0]!]: key }) },
    },
    query: async (node: any) => {
      const attrs = node.content[0].content[0].attrs;
      requests.push(attrs);
      const from = Number(attrs.version);
      const batch = patches.slice(from, from + perResponse);
      return {
        tag: "iq",
        attrs: {},
        content: [{
          tag: "sync",
          attrs: {},
          content: [{
            tag: "collection",
            attrs: {
              name: attrs.name,
              version: String(from),
              has_more_patches: String(from + batch.length < patches.length),
            },
            content: [{
              tag: "patches",
              attrs: {},
              content: batch.map((content) => ({ tag: "patch", attrs: {}, content })),
            }],
          }],
        }],
      };
    },
  } as any;
  return { sock, requests };
}

describe("syncMuteState", () => {

  it("applies the latest mute state per chat to existing chats only", async () => {
    const { db, store } = freshStore("sync.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });                     // the KERAMAS case
    store.upsertChat({ jid: OTHER, is_group: 1, muted_until: -1 });    // stale local mute
    const { sock, requests } = await appStateSock([
      [GROUP, (NOW_SEC + 60) * 1000],
      [OTHER, -1],
      [GONE, -1],      // muted group we have no row for
      [GROUP, -1],     // later change wins
      [OTHER, null],   // unmuted on the phone since
    ]);

    expect(await syncMuteState(sock, store)).toEqual({ muted: 1, applied: 2, skipped: 1 });
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    expect(store.getChat(OTHER)?.muted_until).toBe(0);
    expect(store.getChat(GONE)).toBeNull();
    // Asked from version 0, for the mute collection, with a snapshot.
    expect(requests[0]).toMatchObject({ name: "regular_high", version: "0", return_snapshot: "true" });
    closeDb(db);
  });

  it("lets the most recent action win when one chat is indexed by LID and by phone", async () => {
    const { db, store } = freshStore("sync-dup.db");
    const PN = "6281200000059@s.whatsapp.net";
    const LID = "99887766554433@lid";
    store.upsertChat({ jid: PN, lid_jid: LID });
    // Map order would apply the stale phone-indexed mute last.
    const { sock } = await appStateSock([[LID, -1], [PN, -1], [LID, null]]);
    expect(await syncMuteState(sock, store)).toEqual({ muted: 0, applied: 1, skipped: 0 });
    expect(store.getChat(PN)?.muted_until).toBe(0);
    closeDb(db);
  });

  it("keeps fetching while WhatsApp reports more patches", async () => {
    const { db, store } = freshStore("sync-paged.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    store.upsertChat({ jid: OTHER, is_group: 1 });
    const { sock, requests } = await appStateSock([[GROUP, -1], [OTHER, -1], [GROUP, null]], 1);

    expect((await syncMuteState(sock, store)).muted).toBe(1);
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    expect(store.getChat(OTHER)?.muted_until).toBe(-1);
    expect(requests.map((r) => r.version)).toEqual(["0", "1", "2"]);
    expect(requests.map((r) => r.return_snapshot)).toEqual(["true", "false", "false"]);
    closeDb(db);
  });

  it("rejects when WhatsApp does not answer, changing nothing", async () => {
    const { db, store } = freshStore("sync-timeout.db");
    store.upsertChat({ jid: GROUP, is_group: 1, muted_until: -1 });
    const sock = { authState: { creds: {}, keys: { get: async () => ({}) } }, query: async () => undefined } as any;
    await expect(syncMuteState(sock, store)).rejects.toThrow("did not answer");
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    closeDb(db);
  });
});

describe("fetching app state", () => {
  const baseSock = (collection: any) => ({
    authState: { creds: {}, keys: { get: async () => ({}) } },
    query: async () => ({ tag: "iq", attrs: {}, content: [{ tag: "sync", attrs: {}, content: [collection] }] }),
  }) as any;

  it("rejects a collection WhatsApp refused instead of reading it as empty", async () => {
    const { db, store } = freshStore("refused.db");
    store.upsertChat({ jid: GROUP, is_group: 1, muted_until: -1 });
    const sock = baseSock({
      tag: "collection",
      attrs: { name: "regular_high", type: "error" },
      content: [{ tag: "error", attrs: { code: "409", text: "conflict" } }],
    });
    await expect(syncMuteState(sock, store)).rejects.toThrow("refused the regular_high request (conflict)");
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    closeDb(db);
  });

  it("rejects a from-scratch answer that carries no data", async () => {
    const { db, store } = freshStore("nodata.db");
    const sock = baseSock({ tag: "collection", attrs: { name: "regular_high", version: "0" } });
    await expect(syncMuteState(sock, store)).rejects.toThrow("no data for regular_high");
    closeDb(db);
  });
});

describe("backfillMuteStateOnce", () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const counted = (sock: any) => {
    let queries = 0;
    const query = sock.query;
    sock.query = async (node: any) => { queries++; return query(node); };
    return () => queries;
  };

  it("runs once per linked device and then stays quiet", async () => {
    const { db, store } = freshStore("bf-once.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const { sock } = await appStateSock([[GROUP, -1]]);
    const queries = counted(sock);
    let done = 0;

    backfillMuteStateOnce(sock, store, () => done++, 5);
    await settle();
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    expect(done).toBe(1);
    expect(queries()).toBe(1);

    backfillMuteStateOnce(sock, store, () => done++, 5);
    await settle();
    expect(queries()).toBe(1);
    expect(done).toBe(1);
    closeDb(db);
  });

  it("runs again after a re-link, which changes the device id", async () => {
    const { db, store } = freshStore("bf-relink.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const first = await appStateSock([[GROUP, -1]], 100, "6281:33@s.whatsapp.net");
    backfillMuteStateOnce(first.sock, store, undefined, 5);
    await settle();

    const second = await appStateSock([[GROUP, null]], 100, "6281:38@s.whatsapp.net");
    const queries = counted(second.sock);
    backfillMuteStateOnce(second.sock, store, undefined, 5);
    await settle();
    expect(queries()).toBe(1);
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    closeDb(db);
  });

  it("uses the newest socket and does not charge an attempt for a dead one", async () => {
    const { db, store } = freshStore("bf-flap.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    const dead = {
      authState: { creds: { me: { id: "6281:1@s.whatsapp.net" } }, keys: { get: async () => ({}) } },
      query: async () => { throw new Error("Connection Closed"); },
    } as any;

    // A connection that dies before the delay elapses, with nothing after it.
    backfillMuteStateOnce(dead, store, undefined, 5);
    await settle();
    expect(store.getMeta("mute_backfill_v1:6281:1@s.whatsapp.net:attempts")).toBeNull();

    // A dead socket followed by a healthy one before the timer fires.
    const healthy = await appStateSock([[GROUP, -1]]);
    backfillMuteStateOnce(dead, store, undefined, 20);
    backfillMuteStateOnce(healthy.sock, store, undefined, 20);
    await settle();
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    expect(store.getMeta("mute_backfill_v1:6281:1@s.whatsapp.net")).not.toBeNull();
    closeDb(db);
  });

  it("re-arms on the newer socket when a connection drops mid-request", async () => {
    const { db, store } = freshStore("bf-inflight.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    // Baileys reports an in-flight drop as a timeout (query resolves
    // undefined), never as "Connection Closed".
    let release!: () => void;
    const dropping = {
      authState: { creds: { me: { id: "6281:1@s.whatsapp.net" } }, keys: { get: async () => ({}) } },
      query: () => new Promise((r) => { release = () => r(undefined); }),
    } as any;
    const healthy = await appStateSock([[GROUP, -1]]);

    backfillMuteStateOnce(dropping, store, undefined, 5);
    await new Promise((r) => setTimeout(r, 20));          // request now in flight
    backfillMuteStateOnce(healthy.sock, store, undefined, 5); // reconnect arrives meanwhile
    release();
    await settle();

    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    expect(store.getMeta("mute_backfill_v1:6281:1@s.whatsapp.net:attempts")).toBeNull();
    closeDb(db);
  });

  it("does not record success when no chat existed to apply the records to", async () => {
    const { db, store } = freshStore("bf-empty.db");
    const { sock } = await appStateSock([[GROUP, -1]]);
    let done = 0;
    backfillMuteStateOnce(sock, store, () => done++, 5);
    await settle();
    expect(done).toBe(0);
    expect(store.getMeta("mute_backfill_v1:6281:1@s.whatsapp.net")).toBeNull();

    // History lands, the next connect retries and succeeds.
    store.upsertChat({ jid: GROUP, is_group: 1 });
    backfillMuteStateOnce(sock, store, () => done++, 5);
    await settle();
    expect(done).toBe(1);
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    closeDb(db);
  });

  it("stops after repeated real failures", async () => {
    const { db, store } = freshStore("bf-cap.db");
    let queries = 0;
    const failing = {
      authState: { creds: { me: { id: "6281:1@s.whatsapp.net" } }, keys: { get: async () => ({}) } },
      query: async () => { queries++; return undefined; },
    } as any;
    for (let i = 0; i < 7; i++) {
      backfillMuteStateOnce(failing, store, undefined, 1);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(queries).toBe(5);
    closeDb(db);
  });
});
