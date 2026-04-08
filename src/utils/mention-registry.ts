/**
 * Pending-mention registry for the input bar.
 *
 * When the user types `@` in a group chat and picks a participant, we insert
 * `@<sanitized-name>` (spaces replaced with `_`) into the textarea so the
 * user sees a human-readable token instead of a raw phone/lid id. The
 * registry maps both the sanitized name AND the bare id to the full JID
 * so the wire-format converter can find the JID either way.
 *
 * On send, finalizeMentions(text) walks the text, replaces every recognized
 * `@<sanitized-name>` with `@<bare-id>` (the WA wire format), and returns
 * both the rewritten text AND the JIDs that should go into baileys'
 * `mentions: []` array.
 *
 * Recipients' WhatsApp clients render the `@628xxxxxxxxxxxx` wire token as
 * the contact's local display name on their side.
 *
 * Cleared after every successful send via clearMentions().
 */

interface MentionEntry {
  jid: string;
  bareId: string;
  sanitizedName: string;
}

// Index by sanitized name (what's in the input text) for fast lookup.
const pending = new Map<string, MentionEntry>();

/** Replace spaces with underscores and strip non-word characters so the
 *  display token is unambiguous when parsed back from the input string. */
function sanitize(name: string): string {
  return name.replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
}

/**
 * Register a pending mention. Returns the visible token to insert into the
 * textarea (e.g. "@chris_2"). The bare id is also tracked so legacy
 * `@<digits>` tokens (if the user types one manually) are still recognized.
 */
export function addMention(jid: string, displayName: string): string {
  const bare = jid.split("@")[0]!;
  let token = sanitize(displayName);
  if (!token) token = bare; // fallback for empty/special-only names
  // Disambiguate collisions: if the same sanitized name maps to a DIFFERENT
  // jid, append the bare id so both can coexist in one message.
  const existing = pending.get(token);
  if (existing && existing.jid !== jid) {
    token = `${token}_${bare}`;
  }
  pending.set(token, { jid, bareId: bare, sanitizedName: token });
  return `@${token}`;
}

/**
 * Walk the text, find every `@<token>` mention that matches a registered
 * entry (by sanitized name OR bare id), and rewrite the text into WA's wire
 * format `@<bare-id>` while collecting the corresponding JIDs.
 *
 * Returns the rewritten text and the list of JIDs to pass as baileys'
 * `mentions` array.
 */
export function finalizeMentions(text: string): { text: string; jids: string[] } {
  const jids: string[] = [];
  // Match @ followed by one or more word characters (letters/digits/underscore).
  // We sort registered tokens by length DESC so longer names match before
  // shorter prefixes (e.g. `@chris_2` before `@chris`).
  const tokens = Array.from(pending.keys()).sort((a, b) => b.length - a.length);
  let result = text;
  for (const token of tokens) {
    const entry = pending.get(token)!;
    // Match `@token` as a whole word — preceded by start/space, followed by
    // a non-word char or end of string.
    const re = new RegExp(`(^|\\s)@${escapeRegex(token)}(?=\\W|$)`, "g");
    let matched = false;
    result = result.replace(re, (full, prefix) => {
      matched = true;
      return `${prefix}@${entry.bareId}`;
    });
    if (matched) jids.push(entry.jid);
  }
  return { text: result, jids };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Legacy: parse for `@<digits>` already in wire format. Used during the
 * transition; new code should call finalizeMentions instead.
 */
export function parseMentions(text: string): string[] {
  const MENTION_RE = /@(\d+)/g;
  const jids: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    // Look up by bareId across all entries
    for (const entry of pending.values()) {
      if (entry.bareId === match[1]) {
        jids.push(entry.jid);
        break;
      }
    }
  }
  return jids;
}

/**
 * Clear all pending mentions. Called by handleSend after a successful send.
 */
export function clearMentions(): void {
  pending.clear();
}
