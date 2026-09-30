import { describe, expect, it } from "bun:test";
import { closeDb } from "./db.ts";
import { tempStores } from "../test-store.ts";
import { isMaskedName, resolveSenderName } from "../utils/text.ts";

const { freshStore } = tempStores("wa-contact-names");

const PN = "6281200000059@s.whatsapp.net";
const LID = "99887766554433@lid";
const MASKS = ["+62∙∙∙∙∙∙∙∙∙59", "+62•••••••••59"];

describe("isMaskedName", () => {
  it("recognises masked numbers with either bullet", () => {
    for (const mask of MASKS) expect(isMaskedName(mask)).toBe(true);
    expect(isMaskedName("+62 812 ∙∙∙∙ 59")).toBe(true);
  });

  it("does not mistake real names or plain numbers for masks", () => {
    for (const name of ["Mom • Work", "• Rina •", "A∙B", "+6281200000059", "Budi", "", null, undefined]) {
      expect(isMaskedName(name)).toBe(false);
    }
  });
});

describe("contact name upsert", () => {
  for (const mask of MASKS) {
    it(`never lets ${mask} replace a saved name`, () => {
      const { db, store } = freshStore(`keep-${mask.charCodeAt(3)}.db`);
      store.upsertContact({ jid: PN, name: "Budi" });
      store.upsertContact({ jid: PN, name: mask });
      expect(store.getContact(PN)?.name).toBe("Budi");
      closeDb(db);
    });
  }

  it("lets a real name replace a mask, and a mask fill an empty slot", () => {
    const { db, store } = freshStore("replace.db");
    store.upsertContact({ jid: PN, name: MASKS[0] });
    expect(store.getContact(PN)?.name).toBe(MASKS[0]!);
    store.upsertContact({ jid: PN, name: "Budi" });
    expect(store.getContact(PN)?.name).toBe("Budi");
    closeDb(db);
  });

  it("accepts a rename to a real name that contains a bullet", () => {
    const { db, store } = freshStore("bullet.db");
    store.upsertContact({ jid: PN, name: "Budi" });
    store.upsertContact({ jid: PN, name: "Mom • Work" });
    expect(store.getContact(PN)?.name).toBe("Mom • Work");
    closeDb(db);
  });

  it("keeps the saved name when an update carries none or an empty one", () => {
    const { db, store } = freshStore("empty.db");
    store.upsertContact({ jid: PN, name: "Budi" });
    store.upsertContact({ jid: PN, notify: "budi_push" });
    store.upsertContact({ jid: PN, name: "" });
    expect(store.getContact(PN)?.name).toBe("Budi");
    closeDb(db);
  });
});

describe("resolveContactName", () => {
  it("prefers the saved name, then the push name, over a mask", () => {
    const { db, store } = freshStore("order.db");
    store.upsertContact({ jid: PN, name: MASKS[0], notify: "Rina" });
    expect(store.resolveContactName(PN)).toBe("Rina");
    store.upsertContact({ jid: PN, name: "Rina Saved" });
    expect(store.resolveContactName(PN)).toBe("Rina Saved");
    closeDb(db);
  });

  it("keeps a saved name that merely contains a bullet ahead of the push name", () => {
    const { db, store } = freshStore("bullet-resolve.db");
    store.upsertContact({ jid: PN, name: "Mom • Work", notify: "Siti" });
    expect(store.resolveContactName(PN)).toBe("Mom • Work");
    closeDb(db);
  });

  it("borrows the push name filed on the @lid sibling row before settling for a mask", () => {
    const { db, store } = freshStore("sibling.db");
    // The phone row knows the LID and has only a mask; Baileys files the push
    // name of a LID-addressed group message on a separate row keyed by the LID.
    store.upsertContact({ jid: PN, lid: LID, name: MASKS[0] });
    store.upsertContact({ jid: LID, notify: "Rina" });
    expect(store.resolveContactName(PN)).toBe("Rina");
    expect(store.resolveContactName(LID)).toBe("Rina");
    closeDb(db);
  });

  it("borrows the sibling's push name when the row has no name at all", () => {
    const { db, store } = freshStore("sibling-bare.db");
    store.upsertContact({ jid: PN, lid: LID });
    store.upsertContact({ jid: LID, notify: "Rina" });
    expect(store.resolveContactName(PN)).toBe("Rina");
    closeDb(db);
  });

  it("falls back to the mask, then the bare id, when nothing better exists", () => {
    const { db, store } = freshStore("fallback.db");
    store.upsertContact({ jid: PN, name: MASKS[0] });
    expect(store.resolveContactName(PN)).toBe(MASKS[0]!);
    expect(store.resolveContactName("6289900000000@s.whatsapp.net")).toBe("6289900000000");
    closeDb(db);
  });
});

describe("resolveSenderName", () => {
  it("prefers the message's push name over a mask or a bare id, never over a real name", () => {
    const { db, store } = freshStore("sender.db");
    store.upsertContact({ jid: PN, name: MASKS[0] });
    expect(resolveSenderName(store, PN, "Rina")).toBe("Rina");
    expect(resolveSenderName(store, PN, null)).toBe(MASKS[0]!);
    expect(resolveSenderName(store, "6289900000000@s.whatsapp.net", "Dewi")).toBe("Dewi");
    store.upsertContact({ jid: PN, name: "Rina Saved" });
    expect(resolveSenderName(store, PN, "Rina")).toBe("Rina Saved");
    closeDb(db);
  });
});
