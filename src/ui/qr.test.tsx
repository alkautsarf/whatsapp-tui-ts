import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { buildQRLines } from "./qr.ts";
import { QROverlay } from "./overlays/qr-code.tsx";
import { ThemeProvider } from "./theme.tsx";

// The shape Baileys emits: a wa.me URL carrying the ref and three keys.
const PAIRING = "https://wa.me/settings/linked_devices#" + "A".repeat(120) + ","
  + "B".repeat(44) + "," + "C".repeat(44) + "," + "D".repeat(44) + ",7";

async function render(width: number, height: number) {
  const ui = await testRender(
    () => (
      <ThemeProvider>
        <box width={width} height={height} flexDirection="column">
          <QROverlay data={PAIRING} />
        </box>
      </ThemeProvider>
    ),
    { width, height },
  );
  await ui.renderOnce();
  const frame = ui.captureCharFrame();
  ui.renderer.destroy();
  return frame.split("\n");
}

/** How many screen rows hold QR cells (half blocks or the painted quiet zone
 *  are both invisible in a char frame, so count rows with any half block). */
const codeRows = (lines: string[]) => lines.filter((l) => l.includes("▀")).length;

describe("buildQRLines", () => {
  it("pads the code with a 4-module quiet zone and packs two modules per row", () => {
    const lines = buildQRLines(PAIRING);
    const modules = lines[0]!.length - 8;
    expect(lines.length).toBe(Math.ceil((modules + 8) / 2));
    expect(lines.every((row) => row.length === modules + 8)).toBe(true);
    // Quiet zone: the first two rows and the last are entirely white.
    for (const row of [lines[0]!, lines[1]!, lines[lines.length - 1]!]) {
      expect(row.every((cell) => cell.bg === "#ffffff" && cell.char === " ")).toBe(true);
    }
  });
});

describe("QROverlay", () => {
  const qr = buildQRLines(PAIRING);
  const dataRows = qr.filter((row) => row.some((c) => c.char === "▀")).length;

  it("draws every row of the code, plus the hint when a row is spare", async () => {
    const lines = await render(192, qr.length + 1);
    expect(codeRows(lines)).toBe(dataRows);
    expect(lines.join("\n")).toContain("Linked Devices");
  });

  it("draws the full code and drops the hint when the pane is exactly as tall", async () => {
    const lines = await render(192, qr.length);
    expect(codeRows(lines)).toBe(dataRows);
    expect(lines.join("\n")).not.toContain("Linked Devices");
  });

  it("says the pane is too small instead of drawing a code with rows missing", async () => {
    const lines = await render(192, qr.length - 1);
    const text = lines.join("\n");
    expect(codeRows(lines)).toBe(0);
    expect(text).toContain("Pane too small");
    expect(text).toContain(`Needs ${qr[0]!.length}x${qr.length}`);
  });

  it("says so when the pane is too narrow as well", async () => {
    const lines = await render(qr[0]!.length - 1, qr.length + 4);
    expect(codeRows(lines)).toBe(0);
    expect(lines.join("\n")).toContain("Pane too small");
  });
});
