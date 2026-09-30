import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { closeDb, initDb } from "./db.ts";
import { initQueries } from "./queries.ts";
import { tempStores } from "../test-store.ts";

const { dir, freshStore } = tempStores("wa-mute-store");

const GROUP = "120363000000000001@g.us";

describe("chat mute persistence", () => {
  it("stores a mute on first insert and defaults to unmuted", () => {
    const { db, store } = freshStore("insert.db");
    store.upsertChat({ jid: GROUP, is_group: 1, muted_until: -1 });
    store.upsertChat({ jid: "a@g.us", is_group: 1 });
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    expect(store.getChat("a@g.us")?.muted_until).toBe(0);
    closeDb(db);
  });

  it("applies an always-mute to a chat that already exists", () => {
    // The KERAMAS bug: the row existed (created by an incoming message), then
    // the phone muted it "Always" (-1). The old upsert only accepted > 0.
    const { db, store } = freshStore("always.db");
    store.upsertChat({ jid: GROUP, is_group: 1, last_msg_ts: 100 });
    store.upsertChat({ jid: GROUP, muted_until: -1 });
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    closeDb(db);
  });

  it("clears a mute when the phone unmutes", () => {
    const { db, store } = freshStore("unmute.db");
    store.upsertChat({ jid: GROUP, is_group: 1, muted_until: -1 });
    store.upsertChat({ jid: GROUP, muted_until: 0 });
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    closeDb(db);
  });

  it("keeps the stored mute when an update carries no mute information", () => {
    // Every incoming message upserts { jid, last_msg_ts, is_group }.
    const { db, store } = freshStore("preserve.db");
    store.upsertChat({ jid: GROUP, is_group: 1, muted_until: 1_900_000_000 });
    store.upsertChat({ jid: GROUP, is_group: 1, last_msg_ts: 200 });
    store.bulkUpsertChats([{ jid: GROUP, name: "renamed" }]);
    const row = store.getChat(GROUP);
    expect(row?.muted_until).toBe(1_900_000_000);
    expect(row?.name).toBe("renamed");
    expect(row?.last_msg_ts).toBe(200);
    closeDb(db);
  });

  it("setChatMute overwrites directly", () => {
    const { db, store } = freshStore("set.db");
    store.upsertChat({ jid: GROUP, is_group: 1 });
    store.setChatMute(GROUP, -1);
    expect(store.getChat(GROUP)?.muted_until).toBe(-1);
    store.setChatMute(GROUP, 0);
    expect(store.getChat(GROUP)?.muted_until).toBe(0);
    closeDb(db);
  });

  it("exposes mute state through listChats", () => {
    const { db, store } = freshStore("list.db");
    store.upsertChat({ jid: GROUP, is_group: 1, last_msg_ts: 100, muted_until: -1 });
    expect(store.listChats(10).find((c) => c.jid === GROUP)?.muted_until).toBe(-1);
    closeDb(db);
  });
});

describe("chat pin and archive persistence", () => {
  it("clears a pin or an archive when WhatsApp says so", () => {
    // Same defect as mute had: only values above 0 were ever written, so an
    // unarchive never applied and the chat stayed hidden from the list.
    const { db, store } = freshStore("flags.db");
    store.upsertChat({ jid: GROUP, is_group: 1, last_msg_ts: 100, pinned: 1, archived: 1 });
    expect(store.listChats(10).some((c) => c.jid === GROUP)).toBe(false);
    store.upsertChat({ jid: GROUP, archived: 0 });
    store.upsertChat({ jid: GROUP, pinned: 0 });
    const row = store.getChat(GROUP);
    expect(row?.archived).toBe(0);
    expect(row?.pinned).toBe(0);
    expect(store.listChats(10).some((c) => c.jid === GROUP)).toBe(true);
    closeDb(db);
  });

  it("keeps them when an update carries no such information", () => {
    const { db, store } = freshStore("flags-keep.db");
    store.upsertChat({ jid: GROUP, is_group: 1, pinned: 1, archived: 1 });
    store.upsertChat({ jid: GROUP, is_group: 1, last_msg_ts: 200 });
    const row = store.getChat(GROUP);
    expect(row?.archived).toBe(1);
    expect(row?.pinned).toBe(1);
    closeDb(db);
  });
});

describe("app_meta", () => {
  it("round-trips and overwrites values", () => {
    const { db, store } = freshStore("meta.db");
    expect(store.getMeta("missing")).toBeNull();
    store.setMeta("k", "1");
    expect(store.getMeta("k")).toBe("1");
    store.setMeta("k", "2");
    expect(store.getMeta("k")).toBe("2");
    closeDb(db);
  });
});

describe("schema v4 migration", () => {
  it("rescales millisecond mute values and leaves the rest alone", () => {
    const path = join(dir, "migrate.db");
    // Build a v3 database the way 0.6.1 left it.
    const first = initDb(path);
    first.writer.run("UPDATE schema_version SET version = 3");
    first.writer.run("DROP TABLE app_meta");
    const insert = "INSERT INTO chats (jid, muted_until) VALUES (?, ?)";
    first.writer.run(insert, ["ms@g.us", 1_787_494_531_872]);
    first.writer.run(insert, ["always@g.us", -1]);
    first.writer.run(insert, ["none@g.us", 0]);
    first.writer.run(insert, ["sec@g.us", 1_900_000_000]);
    closeDb(first);

    const db = initDb(path);
    const store = initQueries(db);
    expect(store.getChat("ms@g.us")?.muted_until).toBe(1_787_494_531);
    expect(store.getChat("always@g.us")?.muted_until).toBe(-1);
    expect(store.getChat("none@g.us")?.muted_until).toBe(0);
    expect(store.getChat("sec@g.us")?.muted_until).toBe(1_900_000_000);
    store.setMeta("k", "v"); // app_meta was recreated
    expect(store.getMeta("k")).toBe("v");
    closeDb(db);

    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT version FROM schema_version").get()).toEqual({ version: 4 });
    check.close();
  });
});
