import { createMemo } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";

export function StatusBar() {
  const { store } = useAppStore();
  const theme = useTheme();

  const modeColor = createMemo(() => {
    switch (store.mode) {
      case "normal": return theme.modeNormal;
      case "insert": return theme.modeInsert;
      case "search": return theme.modeSearch;
    }
  });

  const modeLabel = createMemo(() => {
    switch (store.mode) {
      case "normal": return " NORMAL ";
      case "insert": return " INSERT ";
      case "search": return " SEARCH ";
    }
  });

  const connectionDot = createMemo(() => {
    switch (store.connection.status) {
      case "connected": return { char: "\u25cf", color: theme.online };
      case "reconnecting": return { char: "\u25cf", color: theme.warning };
      case "connecting": return { char: "\u25cb", color: theme.textMuted };
      case "qr": return { char: "\u25cb", color: theme.warning };
      case "disconnected": return { char: "\u25cf", color: theme.error };
    }
  });

  const hints = createMemo(() => {
    if (store.mode === "insert") return "Enter send \u00b7 @ attach \u00b7 Ctrl+G editor \u00b7 Esc normal";
    if (store.mode === "search") return "Enter select \u00b7 Esc cancel";

    switch (store.focusZone) {
      case "chat-list":
        return "j/k nav \u00b7 Enter open \u00b7 / search \u00b7 i insert";
      case "messages":
        return "j/k scroll \u00b7 r reply \u00b7 y yank \u00b7 a attach \u00b7 h back";
      case "input":
        return "i insert \u00b7 a attach \u00b7 Ctrl+G editor \u00b7 Esc back";
    }
  });

  // Toast takes precedence over hints when active. Renders with error/info
  // colored background so it's visually distinct from the muted hints.
  const toastDisplay = createMemo(() => {
    const t = store.toast;
    if (!t) return null;
    return {
      message: t.message,
      bg: t.level === "error" ? theme.error : theme.online,
    };
  });

  return (
    <box flexDirection="row" height={1} justifyContent="space-between">
      <box flexDirection="row" gap={1}>
        <text bg={modeColor()} fg="#000000" attributes={1}>
          {modeLabel()}
        </text>
        <text fg={connectionDot().color}>
          {" " + connectionDot().char}
        </text>
      </box>
      {toastDisplay() ? (
        <text bg={toastDisplay()!.bg} fg="#000000" attributes={1}>
          {" " + toastDisplay()!.message + " "}
        </text>
      ) : (
        <text fg={theme.textMuted}>{hints()}</text>
      )}
    </box>
  );
}
