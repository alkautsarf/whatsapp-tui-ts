import { execSync } from "child_process";
import { log, warn } from "../utils/log.ts";

// Shared constant — used by app.tsx and message-bubble.tsx
export const IMAGE_MEDIA_TYPES = new Set(["imageMessage", "stickerMessage"]);

// Shared constant — protocol message types to hide from display
export const HIDDEN_MESSAGE_TYPES = new Set([
  "protocolMessage", "senderKeyDistributionMessage",
  "associatedChildMessage", "reactionMessage", "pollUpdateMessage",
  "editedMessage", "keepInChatMessage",
]);

// Phosphor internals — direct node_modules path (Bun resolves these fine)
import { encodeVirtual } from "../../node_modules/phosphor-cli/src/lib/protocols/kitty.ts";
import { decode } from "../../node_modules/phosphor-cli/src/lib/decode.ts";
import { getCellSize as phGetCellSize } from "../../node_modules/phosphor-cli/src/lib/cellsize.ts";
import { detect } from "../../node_modules/phosphor-cli/src/lib/detect.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface EncodedImage {
  cols: number;
  rows: number;
  placeholders: string;      // ANSI-stripped placeholder chars
  fgHex: string;             // hex color encoding image ID
  imageId: number;
  transmitChunks: string[];  // raw Kitty escape sequences (not DCS-wrapped)
}

// ── Terminal detection (cached) ────────────────────────────────────

let cachedTmux: boolean | null = null;
export function isInTmux(): boolean {
  if (cachedTmux === null) {
    cachedTmux = !!process.env.TMUX;
    if (cachedTmux) {
      try { execSync("tmux set -p allow-passthrough on", { stdio: "ignore" }); } catch {}
    }
  }
  return cachedTmux;
}

let cellSizeCached: { width: number; height: number } | null = null;
export function getCellSize(): { width: number; height: number } {
  if (cellSizeCached) return cellSizeCached;
  const info = detect();
  cellSizeCached = phGetCellSize(info.tmux);
  return cellSizeCached;
}

// ── DCS wrapping ───────────────────────────────────────────────────

function wrapDCS(seq: string): string {
  return `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export function kittyWrite(data: string) {
  if (isInTmux()) process.stdout.write(wrapDCS(data));
  else process.stdout.write(data);
}

// ── Encode image for inline display ────────────────────────────────

export async function encodeForInline(
  input: Buffer | string,
  maxCols = 30,
  maxRows = 12,
): Promise<EncodedImage> {
  const cell = getCellSize();
  const decoded = await decode(input, maxCols * cell.width, maxRows * cell.height);
  const cols = Math.ceil(decoded.width / cell.width);
  const rows = Math.ceil(decoded.height / cell.height);

  const { transmit, placeholders } = encodeVirtual(decoded.png, cols, rows);

  // Extract image ID from transmit
  const match = transmit[0]?.match(/i=(\d+)/);
  const imageId = match ? parseInt(match[1]!) : 0;

  // Compute hex fg color from image ID
  const idR = (imageId >> 16) & 0xff;
  const idG = (imageId >> 8) & 0xff;
  const idB = imageId & 0xff;
  const fgHex = `#${idR.toString(16).padStart(2, "0")}${idG.toString(16).padStart(2, "0")}${idB.toString(16).padStart(2, "0")}`;

  // Strip ANSI from placeholders — OpenTUI's fg prop handles the color
  const rawPlaceholders = placeholders.replace(/\x1b\[[^m]*m/g, "");

  return {
    cols,
    rows,
    placeholders: rawPlaceholders,
    fgHex,
    imageId,
    transmitChunks: transmit,
  };
}

// ── Transmit images (freeze pattern) ───────────────────────────────

// Debounced transmit — collects images, fires once after activity settles
let pendingTransmit: EncodedImage[] = [];
let transmitTimer: ReturnType<typeof setTimeout> | null = null;
let rendererRef: any = null;

export function transmitImages(renderer: any, images: EncodedImage[]) {
  if (images.length === 0) return;
  rendererRef = renderer;
  pendingTransmit.push(...images);

  // Debounce: wait 800ms after last encode before transmitting
  // This ensures transmit only fires after user stops scrolling
  if (transmitTimer) clearTimeout(transmitTimer);
  transmitTimer = setTimeout(doTransmit, 800);
}

function doTransmit() {
  transmitTimer = null;
  if (pendingTransmit.length === 0 || !rendererRef) return;

  const batch = pendingTransmit.splice(0);

  // Pre-build the entire transmit string
  let data = "";
  for (const img of batch) {
    if (isInTmux()) {
      data += img.transmitChunks.map(wrapDCS).join("");
    } else {
      data += img.transmitChunks.join("");
    }
  }

  // Write DCS data inside OpenTUI's frame loop via setFrameCallback
  // This runs in the same frame tick as Zig's writeOut — guaranteed no interleaving
  const writeCallback = async () => {
    rendererRef.removeFrameCallback(writeCallback);
    process.stdout.write(data);
  };
  rendererRef.setFrameCallback(writeCallback);
  rendererRef.requestRender();
}

// ── Clear all Kitty images ─────────────────────────────────────────

export function clearAllImages() {
  kittyWrite(`\x1b_Ga=d,d=A,q=2;\x1b\\`);
}

// ── Full-view overlay ──────────────────────────────────────────────

export async function showFullView(
  renderer: any,
  imagePath: string,
): Promise<void> {
  renderer.suspend();

  const termCols = process.stdout.columns || 160;
  const termRows = process.stdout.rows || 40;
  const maxH = termRows - 8;
  const maxW = termCols - 4;
  const padTop = Math.max(2, Math.floor((termRows - maxH - 3) / 2));

  process.stdout.write("\x1b[2J\x1b[?25l");
  process.stdout.write(`\x1b[${padTop};1H`);

  try {
    execSync(`ph "${imagePath}" -w ${maxW} --height ${maxH}`, {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      stdio: ["pipe", process.stdout, process.stderr],
    });
  } catch (e) {
    warn("image", `Full-view failed: ${(e as Error)?.message}`);
  }

  // Info bar
  const name = imagePath.split("/").pop() ?? "image";
  process.stdout.write(`\x1b[${termRows - 1};3H\x1b[38;2;150;150;150m${name}\x1b[0m`);
  process.stdout.write(`\x1b[${termRows};3H\x1b[38;2;100;100;100mEsc to close\x1b[0m`);

  // Wait for Esc via raw stdin
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    const onData = (buf: Buffer) => {
      if ((buf[0] === 0x1b && buf.length === 1) || buf[0] === 0x71) {
        process.stdin.removeListener("data", onData);
        resolve();
      }
    };
    process.stdin.on("data", onData);
  });

  clearAllImages();
  renderer.resume();
}
