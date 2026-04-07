/**
 * Extract an image from the macOS clipboard via osascript and save it to a
 * temporary file. Returns the file path on success, or null if the clipboard
 * doesn't contain image data.
 *
 * Used by the input handler to support Cmd+V / Ctrl+V image paste, mirroring
 * how Claude Code and other native CLIs handle clipboard image attachments.
 *
 * Implementation: AppleScript's `the clipboard as «class PNGf»` returns the
 * clipboard data interpreted as a PNG-format image (or throws if there's no
 * image). We write it to /tmp/wa-tui-clipboard-<ts>-<rand>.png and return
 * the path. Caller is responsible for cleaning up the temp file after send.
 */

import { execFileSync } from "child_process";
import { existsSync, statSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";

const TEMP_DIR = "/tmp/wa-tui-clipboard";

function ensureTempDir(): boolean {
  try {
    if (!existsSync(TEMP_DIR)) {
      mkdirSync(TEMP_DIR, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronously check the clipboard for image content. Blocking call (~50-200ms
 * for osascript spawn). Returns the path to a temp PNG file if successful,
 * null if the clipboard has no image or osascript failed.
 *
 * Synchronous because the calling key handler needs to decide whether to
 * preventDefault BEFORE the textarea processes the paste event. Async would
 * race with text paste fallthrough.
 */
export function tryExtractClipboardImageSync(): string | null {
  if (process.platform !== "darwin") return null;
  if (!ensureTempDir()) return null;

  const tmpPath = `${TEMP_DIR}/${Date.now()}-${randomBytes(4).toString("hex")}.png`;

  // AppleScript: try to read clipboard as PNG, write to file, return "ok" or
  // "no image" on failure. Wrapped in `try ... on error ... end try` so the
  // script never raises — we use stdout to discriminate.
  const script = `try
  set theImage to the clipboard as «class PNGf»
  set theFile to (open for access POSIX file "${tmpPath}" with write permission)
  write theImage to theFile
  close access theFile
  return "ok"
on error
  return "no image"
end try`;

  try {
    const result = execFileSync("osascript", ["-e", script], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();

    if (result !== "ok") return null;
    if (!existsSync(tmpPath)) return null;
    if (statSync(tmpPath).size === 0) return null;

    return tmpPath;
  } catch {
    return null;
  }
}
