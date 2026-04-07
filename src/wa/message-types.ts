// Single source of truth for WhatsApp message-type strings used across the app.
// Baileys returns the contentType field as one of these literal strings.

export const MEDIA_TYPE_LABELS = {
  imageMessage: "Photo",
  videoMessage: "Video",
  audioMessage: "Audio",
  stickerMessage: "Sticker",
  documentMessage: "Document",
} as const;

export type MediaMessageType = keyof typeof MEDIA_TYPE_LABELS;

export const MEDIA_TYPES: ReadonlySet<string> = new Set(Object.keys(MEDIA_TYPE_LABELS));

// Types we deliberately drop on the floor — protocol housekeeping, reactions,
// polls, edits, and other non-displayable updates.
export const SKIP_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "associatedChildMessage",
  "reactionMessage",
  "pollUpdateMessage",
  "editedMessage",
  "keepInChatMessage",
]);

/** Returns a short human label for media-type messages, or "" for non-media. */
export function mediaLabel(type: string | null | undefined): string {
  if (type && type in MEDIA_TYPE_LABELS) {
    return MEDIA_TYPE_LABELS[type as MediaMessageType];
  }
  return "";
}
