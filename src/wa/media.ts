import { downloadMediaMessage, downloadContentFromMessage, type WAMessage, type WASocket, type MediaType } from "@whiskeysockets/baileys";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { extname } from "path";
import { log, warn } from "../utils/log.ts";
import { MEDIA_DIR } from "../utils/paths.ts";
import type { MessageRow } from "../store/queries.ts";

let mediaDirEnsured = false;
export function ensureMediaDir() {
  if (mediaDirEnsured) return;
  mkdirSync(MEDIA_DIR, { recursive: true });
  mediaDirEnsured = true;
}

function extFromMimetype(mime?: string | null): string {
  if (!mime) return "bin";
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "video/mp4": "mp4", "audio/ogg": "ogg",
    "audio/mpeg": "mp3", "application/pdf": "pdf",
  };
  // The subtype comes from the sender and ends up in a file name handed to a
  // viewer, so keep only plain characters ("vnd.ms-excel", "gpx+xml").
  const sub = mime.split(";")[0]!.split("/")[1]?.trim();
  return map[mime] ?? (sub && /^[a-z0-9.+-]{1,80}$/i.test(sub) ? sub : "bin");
}

// Mimetype Bun knows for an extension, or "" when it doesn't. Bun's lookup is
// case-sensitive ("a.PDF" comes back octet-stream), so lowercase first, and
// drop parameters like ";charset=utf-8" to match what phones send.
function typeForExt(ext: string): string {
  const type = Bun.file(`f.${ext.toLowerCase()}`).type.split(";")[0]!;
  return type === "application/octet-stream" ? "" : type;
}

// A document's file-name extension, only when it is a real one. "Contract
// v1.2" or "Invoice No.123" end in a dotted number, not an extension (Bun
// even maps ".123" to Lotus 1-2-3), so the caller falls back to the message's
// mimetype for those. Real extensions carry a letter: pdf, xlsx, mp3, 7z.
export function knownFileExt(fileName?: string | null): string | undefined {
  const ext = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return ext && /[a-z]/.test(ext) && typeForExt(ext) ? ext : undefined;
}

// Mimetype for an outgoing document or audio file. Baileys labels one sent
// without a mimetype application/pdf (audio: Opus), so recipients saw every
// .csv/.xlsx/.md as a PDF.
export function mimetypeForFile(filePath: string): string {
  return typeForExt(extname(filePath).slice(1)) || "application/octet-stream";
}

// Documents keep their own extension: the mimetype can lie (wa-tui builds
// before the send fix labeled every outgoing document application/pdf), and
// the system viewer picks an app from the cached file's extension.
export function mediaCachePath(msgId: string, mime?: string | null, fileName?: string | null): string {
  return `${MEDIA_DIR}/${msgId}.${knownFileExt(fileName) ?? extFromMimetype(mime)}`;
}

// LRU cache for raw WAMessage objects (needed for downloadMediaMessage)
const rawMessageCache = new Map<string, WAMessage>();
const MAX_CACHE = 200;

export function cacheRawMessage(msg: WAMessage) {
  const id = msg.key?.id;
  if (!id) return;
  rawMessageCache.set(id, msg);
  if (rawMessageCache.size > MAX_CACHE) {
    const first = rawMessageCache.keys().next().value;
    if (first) rawMessageCache.delete(first);
  }
}

export function getRawMessage(msgId: string): WAMessage | undefined {
  return rawMessageCache.get(msgId);
}

// Track failed downloads to avoid retrying expired URLs (capped at 500)
const failedDownloads = new Set<string>();
const MAX_FAILED = 500;

export function isDownloadable(row: MessageRow): boolean {
  // Skip if we already know this download fails
  if (failedDownloads.has(row.id)) return false;
  // Must have either a cached raw message or stored metadata
  return rawMessageCache.has(row.id) || !!(row.media_key && row.direct_path);
}

export async function downloadAndCache(
  sock: WASocket,
  row: MessageRow,
  store?: { updateMediaPath(id: string, path: string): void },
): Promise<string | null> {
  ensureMediaDir();
  const path = mediaCachePath(row.id, row.mimetype, row.file_name);

  if (existsSync(path)) return path;

  // Skip if we already know this fails
  if (failedDownloads.has(row.id)) return null;

  // Try cached raw WAMessage first (fastest)
  const raw = rawMessageCache.get(row.id);
  if (raw) {
    try {
      const buffer = await downloadMediaMessage(raw, "buffer", {});
      writeFileSync(path, buffer as Buffer);
      log("media", `Downloaded ${path} (${(buffer as Buffer).length} bytes)`);
      store?.updateMediaPath(row.id, path);
      return path;
    } catch (e) {
      warn("media", `Download via raw msg failed: ${(e as Error)?.message}`);
    }
  }

  // Fallback: reconstruct download from stored metadata (media_key + direct_path)
  if (row.media_key && row.direct_path) {
    try {
      const mediaKey = Buffer.from(row.media_key, "base64");
      const mediaTypeMap: Record<string, MediaType> = {
        imageMessage: "image", videoMessage: "video", audioMessage: "audio",
        stickerMessage: "sticker", documentMessage: "document",
      };
      const mediaType = mediaTypeMap[row.media_type ?? ""] ?? "image";
      const stream = await downloadContentFromMessage(
        { mediaKey, directPath: row.direct_path, url: row.media_url ?? undefined },
        mediaType,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);
      writeFileSync(path, buffer);
      log("media", `Downloaded via metadata ${path} (${buffer.length} bytes)`);
      store?.updateMediaPath(row.id, path);
      return path;
    } catch (e) {
      failedDownloads.add(row.id);
      if (failedDownloads.size > MAX_FAILED) {
        const first = failedDownloads.values().next().value;
        if (first) failedDownloads.delete(first);
      }
      warn("media", `Download failed (won't retry): ${row.id.slice(0,12)}`);
    }
  } else if (!raw) {
    // No raw message and no metadata — mark as permanently failed
    failedDownloads.add(row.id);
  }

  return null;
}
