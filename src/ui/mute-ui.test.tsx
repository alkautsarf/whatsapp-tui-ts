import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { closeDb } from "../store/db.ts";
import { tempStores } from "../test-store.ts";
import { App } from "./app.tsx";
import { AppStoreProvider, createAppStore } from "./state.tsx";
import { ThemeProvider } from "./theme.tsx";

const { freshStore } = tempStores("wa-mute-ui");

const LOUD = "120363000000000001@g.us";
const QUIET = "120363000000000002@g.us";
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function mountApp(name: string) {
  const { db, store: queries } = freshStore(name);
  const now = Math.floor(Date.now() / 1000);
  queries.upsertChat({ jid: LOUD, name: "Loud Group", is_group: 1, last_msg_ts: now, unread: 3 });
  queries.upsertChat({ jid: QUIET, name: "Quiet Group", is_group: 1, last_msg_ts: now - 60, unread: 5, muted_until: -1 });

  const [store, setStore, helpers] = createAppStore(queries);
  helpers.hydrate();
  helpers.setConnection({ status: "connected" });

  const calls: Array<[unknown, string]> = [];
  const behaviour = { chatModify: async () => {} };
  let quits = 0;
  const sock = {
    chatModify: async (mod: unknown, jid: string) => { calls.push([mod, jid]); await behaviour.chatModify(); },
    readMessages: async () => {},
    presenceSubscribe: async () => {},
    groupMetadata: async () => ({}),
  } as any;

  const ui = await testRender(
    () => (
      <AppStoreProvider store={store} setStore={setStore} helpers={helpers}>
        <ThemeProvider>
          <App queries={queries} getSock={() => sock} getRenderer={() => null} onQuit={() => { quits++; }} />
        </ThemeProvider>
      </AppStoreProvider>
    ),
    { width: 120, height: 30 },
  );
  const frame = async () => {
    await tick();
    await ui.renderOnce();
    return ui.captureCharFrame();
  };
  // A chat-list row is two lines: name + time, then preview + marker/unread.
  const rowOf = (text: string, needle: string) => {
    const lines = text.split("\n").map((line) => line.slice(0, 36));
    const i = lines.findIndex((line) => line.includes(needle));
    return i < 0 ? "" : lines[i] + "\n" + (lines[i + 1] ?? "");
  };
  const type = async (text: string) => {
    for (const ch of text) { ui.mockInput.pressKey(ch); await tick(5); }
  };
  return { ...ui, db, queries, store, helpers, calls, behaviour, frame, rowOf, type, quits: () => quits };
}

describe("mute in the TUI", () => {
  it("marks muted chats in the chat list and leaves others alone", async () => {
    const app = await mountApp("list.db");
    const text = await app.frame();
    expect(app.rowOf(text, "Quiet Group")).toContain("⊘");
    expect(app.rowOf(text, "Loud Group")).not.toContain("⊘");
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("mutes the highlighted chat with m, then unmutes it", async () => {
    const app = await mountApp("flow.db");
    await app.frame();
    expect(app.store.highlightedChatJid).toBe(LOUD);

    // m opens the duration picker for the chat under the cursor.
    app.mockInput.pressKey("m");
    let text = await app.frame();
    expect(text).toContain("Mute notifications");
    for (const label of ["Loud Group", "8 hours", "1 week", "Always", "Cancel"]) {
      expect(text).toContain(label);
    }

    // Down twice to "Always", Enter.
    app.mockInput.pressKey("j");
    await tick();
    app.mockInput.pressKey("j");
    await tick();
    app.mockInput.pressKey("RETURN");
    text = await app.frame();

    expect(app.calls).toEqual([[{ mute: -1 }, LOUD]]);
    expect(app.queries.getChat(LOUD)?.muted_until).toBe(-1);
    expect(app.store.overlay).toBeNull();
    expect(app.store.mode).toBe("normal");
    expect(app.rowOf(text, "Loud Group")).toContain("⊘");

    // m again on a muted chat offers Unmute.
    app.mockInput.pressKey("m");
    text = await app.frame();
    expect(text).toContain("Unmute chat");
    expect(text).toContain("Loud Group is muted");
    app.mockInput.pressKey("RETURN");
    text = await app.frame();

    expect(app.calls[1]).toEqual([{ mute: null }, LOUD]);
    expect(app.queries.getChat(LOUD)?.muted_until).toBe(0);
    expect(app.rowOf(text, "Loud Group")).not.toContain("⊘");
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("stores an absolute end time for a timed mute", async () => {
    const app = await mountApp("timed.db");
    await app.frame();
    const before = Math.floor(Date.now() / 1000);
    app.mockInput.pressKey("m");
    await app.frame();
    app.mockInput.pressKey("RETURN"); // first option: 8 hours
    await app.frame();

    const until = app.queries.getChat(LOUD)?.muted_until ?? 0;
    expect(until).toBeGreaterThanOrEqual(before + 8 * 3600);
    expect(until).toBeLessThanOrEqual(before + 8 * 3600 + 5);
    expect(app.calls).toEqual([[{ mute: until * 1000 }, LOUD]]);
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("cancels without touching WhatsApp", async () => {
    const app = await mountApp("cancel.db");
    await app.frame();
    app.mockInput.pressKey("m");
    await app.frame();
    app.mockInput.pressKey("ESCAPE");
    await app.frame();
    expect(app.calls).toEqual([]);
    expect(app.store.overlay).toBeNull();
    expect(app.queries.getChat(LOUD)?.muted_until).toBe(0);
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("refuses to mute while disconnected", async () => {
    const app = await mountApp("offline.db");
    await app.frame();
    app.mockInput.pressKey("m");
    await app.frame();
    // Connection drops while the dialog is open; getSock() still returns the
    // old socket in that state, so the status is what has to gate it.
    app.helpers.setConnection({ status: "reconnecting", reconnectAttempt: 1 });
    app.mockInput.pressKey("RETURN");
    const text = await app.frame();
    expect(app.calls).toEqual([]);
    expect(app.queries.getChat(LOUD)?.muted_until).toBe(0);
    expect(text).toContain("Not connected");
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("mutes the open chat from the messages zone, not the highlighted one", async () => {
    const app = await mountApp("zone.db");
    await app.frame();
    app.mockInput.pressKey("RETURN");          // open Loud Group, focus moves to messages
    await app.frame();
    app.helpers.setHighlightedChatJid(QUIET);  // cursor elsewhere in the list
    app.mockInput.pressKey("m");
    let text = await app.frame();
    expect(text).toContain("Mute notifications");
    app.mockInput.pressKey("j");
    await tick();
    app.mockInput.pressKey("j");
    await tick();
    app.mockInput.pressKey("RETURN");
    text = await app.frame();
    expect(app.calls).toEqual([[{ mute: -1 }, LOUD]]);
    expect(text).toContain("group \u00b7 muted");
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("opens the mute dialog from the command palette and survives the palette closing", async () => {
    const app = await mountApp("palette.db");
    await app.frame();
    app.mockInput.pressKey("p", { ctrl: true });
    await app.frame();
    await app.type("mute /");
    await app.frame();
    app.mockInput.pressKey("RETURN");
    const text = await app.frame();
    expect(app.store.overlay?.type).toBe("confirm");
    expect(text).toContain("Mute notifications");
    expect(text).not.toContain("Type a command");
    app.mockInput.pressKey("RETURN"); // 8 hours
    await app.frame();
    expect(app.calls.length).toBe(1);
    expect(app.calls[0]![1]).toBe(LOUD);
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("keeps insert mode when the palette's Insert mode action is picked", async () => {
    const app = await mountApp("palette-insert.db");
    await app.frame();
    app.mockInput.pressKey("p", { ctrl: true });
    await app.frame();
    await app.type("insert mode");
    await app.frame();
    app.mockInput.pressKey("RETURN");
    await app.frame();
    expect(app.store.overlay).toBeNull();
    expect(app.store.mode).toBe("insert");
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("reports a rejected mute and changes nothing", async () => {
    const app = await mountApp("reject.db");
    app.behaviour.chatModify = async () => { throw new Error("App state key not present!"); };
    await app.frame();
    app.mockInput.pressKey("m");
    await app.frame();
    app.mockInput.pressKey("RETURN");
    const text = await app.frame();
    expect(text).toContain("Mute failed: App state key not present!");
    expect(app.queries.getChat(LOUD)?.muted_until).toBe(0);
    expect(app.rowOf(text, "Loud Group")).not.toContain("\u2298");
    app.renderer.destroy();
    closeDb(app.db);
  });

  it("ignores m on the pairing screen and leaves q working", async () => {
    const app = await mountApp("qr.db");
    app.helpers.setConnection({ status: "qr", qrData: "2@" + "A".repeat(40) });
    await app.frame();
    app.mockInput.pressKey("m");
    await app.frame();
    expect(app.store.overlay).toBeNull();
    expect(app.store.mode).toBe("normal");
    app.mockInput.pressKey("q");
    await app.frame();
    expect(app.quits()).toBe(1);
    app.renderer.destroy();
    closeDb(app.db);
  });
});
