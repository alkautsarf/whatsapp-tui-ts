import { For, Show, createMemo } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { buildQRLines } from "../qr.ts";
import { useTheme } from "../theme.tsx";

const HINT = "WhatsApp → Linked Devices → Link a Device, then scan. q quits.";

/**
 * Pairing QR.
 *
 * The code comes first and everything else yields to it. A 61-module WhatsApp
 * pairing code needs 35 terminal rows (61 modules + the mandatory 4-module
 * quiet zone on each side = 69, packed 2 modules per row by the ▀ half-block
 * glyph), and the size is not fixed: a longer server ref yields a 65-module
 * code and 37 rows. So nothing here assumes a size; it is measured each time.
 *
 *  - 2026-08-14: a title, a hint and three spacers (6 rows) pushed the bottom
 *    of the code off elpabl0's 192x36 pane. It looked fine and never scanned.
 *  - 2026-09-30: with the chrome gone, a pane even one row too short still
 *    broke the code, and worse: the row boxes flex-shrank to height 0, which
 *    deletes rows from the MIDDLE while both quiet zones and all three finder
 *    patterns stay intact. Hence flexShrink={0} on every row.
 *
 * The hint line is drawn only when there is a spare row for it, and a pane
 * that cannot hold the code says so instead of showing one that cannot scan.
 */
export function QROverlay(props: { data: string }) {
  const theme = useTheme();
  const dims = useTerminalDimensions();
  const lines = createMemo(() => buildQRLines(props.data));
  const qrRows = () => lines().length;
  const qrCols = () => lines()[0]?.length ?? 0;
  const fits = () => dims().height >= qrRows() && dims().width >= qrCols();

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent={fits() ? "flex-start" : "center"}
      flexGrow={1}
    >
      <Show
        when={fits()}
        fallback={
          <>
            <text fg={theme.warning}>Pane too small for the WhatsApp pairing code</text>
            <text fg={theme.textMuted}>
              {`Needs ${qrCols()}x${qrRows()}, this pane is ${dims().width}x${dims().height}. Enlarge it, or press q to quit.`}
            </text>
          </>
        }
      >
        <For each={lines()}>
          {(row) => (
            <box flexDirection="row" flexShrink={0}>
              <For each={row}>
                {(cell) => (
                  <text fg={cell.fg} bg={cell.bg}>
                    {cell.char}
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
        <Show when={dims().height > qrRows()}>
          <box flexShrink={0}>
            <text fg={theme.textMuted}>{HINT}</text>
          </box>
        </Show>
      </Show>
    </box>
  );
}
