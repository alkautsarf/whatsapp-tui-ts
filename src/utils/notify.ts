/**
 * System notifications via WhatsAppTuiNotifier daemon (macOS only).
 *
 * Writes a JSON file to /tmp/wa-tui-notif/, which the daemon (installed
 * via notifier/install.sh) picks up via FSEvents and fires as a native
 * UNNotification with the WhatsApp icon.
 *
 * Falls back to a silent no-op if:
 *   - the platform is not macOS, or
 *   - the watch directory doesn't exist (daemon not installed)
 *
 * Per-chat rate limiting at 3s avoids spam during message bursts.
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";

const WATCH_DIR = "/tmp/wa-tui-notif";
const RATE_LIMIT_MS = 3_000;
const DEFAULT_SOUND = "Glass";

export type NotifyPayload = {
  title: string;
  body: string;
  subtitle?: string;
  sound?: string;
  chatJid?: string;
  messageId?: string;
};

const lastFiredAt = new Map<string, number>();
let directoryReady: boolean | null = null;

function ensureDirectory(): boolean {
  if (directoryReady !== null) return directoryReady;
  try {
    if (!existsSync(WATCH_DIR)) {
      mkdirSync(WATCH_DIR, { recursive: true });
    }
    directoryReady = true;
  } catch {
    directoryReady = false;
  }
  return directoryReady;
}

export function notify(payload: NotifyPayload): void {
  if (process.platform !== "darwin") return;
  if (!ensureDirectory()) return;

  // Per-chat rate limiting — second message from same chat within 3s is dropped.
  const key = payload.chatJid ?? payload.title;
  const now = Date.now();
  const last = lastFiredAt.get(key);
  if (last !== undefined && now - last < RATE_LIMIT_MS) return;
  lastFiredAt.set(key, now);

  // Drop stale rate-limit entries periodically so the map doesn't grow.
  if (lastFiredAt.size > 200) {
    const cutoff = now - RATE_LIMIT_MS * 10;
    for (const [k, v] of lastFiredAt) {
      if (v < cutoff) lastFiredAt.delete(k);
    }
  }

  const finalPayload: NotifyPayload = {
    title: payload.title,
    body: payload.body,
    sound: payload.sound ?? DEFAULT_SOUND,
    ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
    ...(payload.chatJid ? { chatJid: payload.chatJid } : {}),
    ...(payload.messageId ? { messageId: payload.messageId } : {}),
  };

  // Unique filename: timestamp prefix gives chronological sort, random
  // suffix prevents collision when two payloads land in the same ms.
  const filename = `${now}-${randomBytes(4).toString("hex")}.json`;
  try {
    writeFileSync(`${WATCH_DIR}/${filename}`, JSON.stringify(finalPayload), "utf-8");
  } catch {
    // Best-effort: silent fail. Notifications shouldn't break wa-tui.
  }
}
