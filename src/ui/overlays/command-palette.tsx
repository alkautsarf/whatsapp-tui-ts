import { createSignal, For, createMemo, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";

interface Action {
  name: string;
  shortcut: string;
  handler: () => void;
}

export function CommandPalette(props: { onQuit: () => void }) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const [query, setQuery] = createSignal("");
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  let inputRef: any;

  createEffect(() => {
    if (store.overlay?.type === "command-palette") {
      inputRef?.focus();
    }
  });

  const actions: Action[] = [
    { name: "Search chats", shortcut: "/", handler: () => { helpers.setOverlay({ type: "search" }); helpers.setMode("search"); } },
    { name: "Insert mode", shortcut: "i", handler: () => { helpers.setMode("insert"); helpers.setFocusZone("input"); } },
    { name: "Focus chat list", shortcut: "h", handler: () => helpers.setFocusZone("chat-list") },
    { name: "Focus messages", shortcut: "l", handler: () => helpers.setFocusZone("messages") },
    { name: "Quit", shortcut: "q", handler: props.onQuit },
  ];

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim();
    if (!q) return actions;
    return actions.filter((a) => a.name.toLowerCase().includes(q));
  });

  function handleKeyDown(evt: any) {
    if (evt.name === "escape") {
      helpers.setOverlay(null);
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      const action = filtered()[selectedIdx()];
      if (action) {
        helpers.setOverlay(null);
        action.handler();
      }
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      setSelectedIdx((i) => Math.min(i + 1, filtered().length - 1));
      evt.preventDefault();
      return;
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      setSelectedIdx((i) => Math.max(i - 1, 0));
      evt.preventDefault();
      return;
    }
  }

  const width = () => Math.min(Math.floor(dims().width * 0.5), 50);
  const height = () => Math.min(Math.floor(dims().height * 0.4), 15);

  return (
    <box
      position="absolute"
      width={dims().width}
      height={dims().height}
      justifyContent="center"
      alignItems="center"
      zIndex={3000}
    >
      <box
        flexDirection="column"
        width={width()}
        height={height()}
        border
        borderStyle="rounded"
        borderColor={theme.borderFocused}
        backgroundColor={theme.bgOverlay}
        title=" Commands "
        titleAlignment="center"
        padding={1}
      >
        <input
          ref={(el: any) => (inputRef = el)}
          width={width() - 4}
          placeholder="Type a command..."
          textColor={theme.text}
          focused
          cursorStyle={{ style: "block", blinking: false }}
          onInput={(v: string) => { setQuery(v); setSelectedIdx(0); }}
          onKeyDown={handleKeyDown}
        />
        <box height={1} />
        <scrollbox flexGrow={1} viewportCulling>
          <For each={filtered()}>
            {(action, idx) => {
              const isSel = () => idx() === selectedIdx();
              return (
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingX={1}
                  backgroundColor={isSel() ? theme.bgSelected : undefined}
                >
                  <text fg={isSel() ? theme.textStrong : theme.text}>
                    {action.name}
                  </text>
                  <text fg={theme.textMuted}>{action.shortcut}</text>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </box>
    </box>
  );
}
