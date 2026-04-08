/**
 * Tiny shared text helpers used across the UI layer.
 */

import type { StoreQueries } from "../store/queries.ts";

/** Truncate to `max` chars, appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
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
