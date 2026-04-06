import qrcode from "qrcode-generator";

export interface QRCell {
  char: string;
  fg: string;
  bg: string;
}

/**
 * Convert a QR data string to half-block character lines.
 * Each pair of QR module rows maps to one terminal row using ▀ (U+2580).
 * Returns Cell[][] where each inner array is one terminal row.
 */
export function buildQRLines(input: string): QRCell[][] {
  const qr = qrcode(0, "L");
  qr.addData(input);
  qr.make();

  const size = qr.getModuleCount();
  const quiet = 1; // quiet zone padding
  const total = size + quiet * 2;

  const WHITE = "#ffffff";
  const BLACK = "#000000";

  function isDark(row: number, col: number): boolean {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= size || c >= size) return false;
    return qr.isDark(r, c);
  }

  const lines: QRCell[][] = [];

  for (let y = 0; y < total; y += 2) {
    const row: QRCell[] = [];
    for (let x = 0; x < total; x++) {
      const top = isDark(y, x);
      const bot = y + 1 < total ? isDark(y + 1, x) : false;

      if (!top && !bot) {
        row.push({ char: " ", fg: WHITE, bg: WHITE });
      } else if (top && bot) {
        row.push({ char: " ", fg: BLACK, bg: BLACK });
      } else if (top && !bot) {
        row.push({ char: "\u2580", fg: BLACK, bg: WHITE });
      } else {
        row.push({ char: "\u2580", fg: WHITE, bg: BLACK });
      }
    }
    lines.push(row);
  }

  return lines;
}
