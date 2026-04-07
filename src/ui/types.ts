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

export type OverlayType = "search" | "command-palette" | "help" | "emoji-picker" | "message-search";

export interface OverlayState {
  type: OverlayType;
}

export interface InputMethods {
  getText: () => string;
  setText: (text: string) => void;
  insertAtCursor: (text: string) => void;
}

export interface EncodedImageData {
  cols: number;
  rows: number;
  placeholders: string;
  fgHex: string;
  imageId: number;
}

export type ToastLevel = "error" | "info";

export interface ToastState {
  message: string;
  level: ToastLevel;
  /** epoch ms — toast auto-clears at or after this time */
  expiresAt: number;
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
  toast: ToastState | null;
  /** Scroll offset (in lines) for the help overlay. Reset to 0 on open. */
  helpScrollOffset: number;
}
