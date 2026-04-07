/**
 * Pending-attachment registry for the input bar.
 *
 * When the user pastes an image (Ctrl+V) or drag-drops a file, we don't want
 * to clutter the input box with raw paths like `@'/tmp/wa-tui-clipboard/abc.png'`.
 * Instead we insert a clean placeholder like `[Image 1]` at the cursor and
 * stash the real path here, keyed by the placeholder string.
 *
 * On send, the layout's handleSend parses the text for placeholders, looks
 * up each one in this registry, sends the attachments in order, and finally
 * clears the registry. This matches the multi-attachment flow Claude Code
 * uses for image input.
 *
 * Counters reset on `clearPending()` (called after a successful send), so
 * every new message starts at [Image 1] / [Video 1] / etc.
 */

export type AttachmentKind = "image" | "video" | "audio" | "sticker" | "document";

export interface PendingAttachment {
  path: string;
  kind: AttachmentKind;
}

const pending = new Map<string, PendingAttachment>();
const counters: Record<AttachmentKind, number> = {
  image: 0,
  video: 0,
  audio: 0,
  sticker: 0,
  document: 0,
};

const KIND_LABELS: Record<AttachmentKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  sticker: "Sticker",
  document: "File",
};

/**
 * Add an attachment and return its placeholder label, e.g. `[Image 1]`.
 * Caller is responsible for inserting the label string into the input.
 */
export function addAttachment(path: string, kind: AttachmentKind): string {
  counters[kind] += 1;
  const label = `[${KIND_LABELS[kind]} ${counters[kind]}]`;
  pending.set(label, { path, kind });
  return label;
}

/**
 * Look up a pending attachment by its placeholder label. Returns null if no
 * such attachment exists (e.g., user typed a `[Image N]` literal that
 * doesn't correspond to anything actually pasted).
 */
export function getAttachment(label: string): PendingAttachment | null {
  return pending.get(label) ?? null;
}

/**
 * Parse text for placeholder occurrences in order. Returns the matched
 * attachments and the text with placeholders stripped. Used by handleSend
 * in layout.tsx to extract attachments before sending.
 */
export function parsePlaceholders(text: string): {
  attachments: PendingAttachment[];
  textWithoutPlaceholders: string;
} {
  const PLACEHOLDER_RE = /\[(Image|Video|Audio|Sticker|File) \d+\]/g;
  const attachments: PendingAttachment[] = [];

  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const att = pending.get(match[0]);
    if (att) attachments.push(att);
  }

  // Strip placeholder substrings, collapse repeated whitespace, trim.
  const textWithoutPlaceholders = text
    .replace(PLACEHOLDER_RE, "")
    .replace(/\s+/g, " ")
    .trim();

  return { attachments, textWithoutPlaceholders };
}

/**
 * Clear all pending attachments and reset the per-kind counters. Called by
 * handleSend after a successful send so the next message starts fresh.
 */
export function clearPending(): void {
  pending.clear();
  for (const k of Object.keys(counters) as AttachmentKind[]) {
    counters[k] = 0;
  }
}

/**
 * Total count of currently pending attachments. Used by the input renderer
 * if we ever want to show a "3 attachments pending" hint.
 */
export function pendingCount(): number {
  return pending.size;
}
