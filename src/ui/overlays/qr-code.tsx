import { For } from "solid-js";
import { buildQRLines } from "../qr.ts";
import { useTheme } from "../theme.tsx";

export function QROverlay(props: { data: string }) {
  const theme = useTheme();
  const lines = () => buildQRLines(props.data);

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
    >
      <text fg={theme.textStrong} attributes={1 /* BOLD */}>
        Scan QR Code with WhatsApp
      </text>
      <box height={1} />
      <text fg={theme.textMuted}>
        Open WhatsApp → Linked Devices → Link a Device
      </text>
      <box height={1} />
      <box flexDirection="column" alignItems="center">
        <For each={lines()}>
          {(row) => (
            <box flexDirection="row">
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
      </box>
      <box height={1} />
      <text fg={theme.textMuted}>Waiting for scan...</text>
    </box>
  );
}
