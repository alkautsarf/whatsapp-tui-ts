import type { ChatRow, MessageRow } from "../store/queries.ts";

export type AppMode = "normal" | "insert" | "search";
export type FocusZone = "chat-list" | "messages" | "input";
export type ConnectionStatus =
  | "connecting"
  | "qr"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ConnectionState {
  status: ConnectionStatus;
  qrData?: string;
  reconnectAttempt?: number;
}

export type OverlayType = "search" | "command-palette";

export interface OverlayState {
  type: OverlayType;
}

export interface EncodedImageData {
  cols: number;
  rows: number;
  placeholders: string;
  fgHex: string;
  imageId: number;
}

export interface AppStore {
  chats: ChatRow[];
  messages: Record<string, MessageRow[]>;
  selectedChatJid: string | null;
  selectedMessageIndex: number;
  highlightedChatJid: string | null;
  connection: ConnectionState;
  mode: AppMode;
  focusZone: FocusZone;
  overlay: OverlayState | null;
  replyToMessageId: string | null;
  typingJids: Record<string, number>;
  presenceMap: Record<string, string>;
  encodedImages: Record<string, EncodedImageData>;
}
