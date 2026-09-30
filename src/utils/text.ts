/**
 * Tiny shared text helpers used across the UI layer.
 */

import type { StoreQueries } from "../store/queries.ts";

/** Truncate to `max` chars, appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

/** The two bullets WhatsApp masks digits with: U+2219 and U+2022. */
export const MASK_BULLETS = ["\u2219", "\u2022"] as const;

/** Every character a masked number can contain, as the inside of a character
 *  class that is valid both in a JS regex and in a SQLite GLOB (so the hyphen
 *  stays last). The SQL twin, maskedNameSql() in store/queries.ts, is built
 *  from this same string. */
export const MASK_CHARS = `0-9+${MASK_BULLETS.join("")} ()-`;

const MASK_BULLET_RE = new RegExp(`[${MASK_BULLETS.join("")}]`);
const MASK_SHAPE_RE = new RegExp(`^[${MASK_CHARS}]+$`);

/**
 * True for a privacy-masked phone number such as "+62∙∙∙∙∙∙∙∙∙59", which
 * WhatsApp sends as a contact's name when the real one is withheld. Requires
 * the mask SHAPE (only digits, bullets and phone punctuation), not just a
 * bullet, so a saved name like "Mom • Work" is not mistaken for one.
 */
export function isMaskedName(name: string | null | undefined): boolean {
  return !!name && MASK_BULLET_RE.test(name) && MASK_SHAPE_RE.test(name);
}

/**
 * Display name for a message sender: the contacts resolution, unless that
 * only produced a bare id or a privacy mask and the message carries the
 * sender's own push name, which beats both.
 */
export function resolveSenderName(
  queries: Pick<StoreQueries, "resolveContactName">,
  jid: string,
  pushName?: string | null,
): string {
  const resolved = queries.resolveContactName(jid);
  return pushName && (isMaskedName(resolved) || resolved === jid.split("@")[0])
    ? pushName
    : resolved;
}

/**
 * Replace `@<digits>` mention tokens (WA's wire format) with `@<contact name>`
 * for display. Tries the phone JID form first, then the LID form, falling
 * back to the original token when nothing matches. Used by message bubbles
 * AND the chat-list preview line — both need the same resolution to keep
 * mentions readable.
 *
 * Note: this resolves AT-DISPLAY-TIME from a flat string. The mention
 * registry (utils/mention-registry.ts) handles the inverse direction —
 * inserting display tokens at compose time and rewriting them to the wire
 * form at send time.
 */
export function resolveMentionDisplay(text: string, queries: StoreQueries): string {
  return text.replace(/@(\d+)/g, (match, digits) => {
    const phoneJid = `${digits}@s.whatsapp.net`;
    const lidJid = `${digits}@lid`;
    let resolved = queries.resolveContactName(phoneJid);
    if (!resolved || resolved === digits) {
      resolved = queries.resolveContactName(lidJid);
    }
    if (resolved && resolved !== digits) return `@${resolved}`;
    return match;
  });
}
