import { createSignal, For, createMemo, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";
import { releaseLock } from "../../utils/instance-lock.ts";

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
  let scrollRef: any;

  createEffect(() => {
    if (store.overlay?.type === "command-palette") {
      inputRef?.focus();
    }
  });

  function restartApp() {
    // Exit with sentinel code 42. The bin/wa wrapper script loops on
    // this code and respawns the app, giving the new process a real
    // controlling terminal (which spawn-detached cannot — TUIs need a
    // PTY they can render into). If the user launched wa-tui directly
    // via `bun run src/index.tsx` without the wrapper, the exit 42 just
    // returns to the shell and they have to relaunch manually.
    releaseLock();
    process.exit(42);
  }

  const actions: Action[] = [
    { name: "Search chats", shortcut: "/", handler: () => { helpers.setOverlay({ type: "search" }); helpers.setMode("search"); } },
    { name: "Show help (keybindings)", shortcut: "?", handler: () => { helpers.setOverlay({ type: "help" }); helpers.setHelpScrollOffset?.(0); } },
    { name: "Insert mode", shortcut: "i", handler: () => { helpers.setMode("insert"); helpers.setFocusZone("input"); } },
    { name: "Focus chat list", shortcut: "h", handler: () => helpers.setFocusZone("chat-list") },
    { name: "Focus messages", shortcut: "l", handler: () => helpers.setFocusZone("messages") },
    { name: "Reply to selected message", shortcut: "r", handler: () => helpers.setFocusZone("messages") },
    { name: "React to selected message", shortcut: "e", handler: () => helpers.setFocusZone("messages") },
    { name: "Forward selected message", shortcut: "f", handler: () => helpers.setFocusZone("messages") },
    { name: "Delete selected message", shortcut: "d", handler: () => helpers.setFocusZone("messages") },
    { name: "Save selected media", shortcut: "s", handler: () => helpers.setFocusZone("messages") },
    { name: "Yank selected text", shortcut: "y", handler: () => helpers.setFocusZone("messages") },
    { name: "Show chat / group info", shortcut: "gi", handler: () => helpers.setFocusZone("messages") },
    { name: "Restart wa-tui", shortcut: "", handler: restartApp },
    { name: "Quit", shortcut: "q", handler: props.onQuit },
  ];

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim();
    if (!q) return actions;
    return actions.filter((a) => a.name.toLowerCase().includes(q));
  });

  function close() {
    helpers.setOverlay(null);
    helpers.setMode("normal");
  }

  function handleKeyDown(evt: any) {
    if (evt.name === "escape") {
      close();
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      const action = filtered()[selectedIdx()];
      if (action) {
        // Run the action BEFORE closing — some handlers (like restartApp)
        // need to run while overlay state is still set, and modes that the
        // handler sets (e.g. setMode("search") for nested overlays) must
        // not be clobbered by close()'s setMode("normal").
        action.handler();
        close();
      }
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      const newIdx = Math.min(selectedIdx() + 1, filtered().length - 1);
      setSelectedIdx(newIdx);
      try { scrollRef?.scrollChildIntoView?.(`palette-${newIdx}`); } catch {}
      evt.preventDefault();
      return;
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      const newIdx = Math.max(selectedIdx() - 1, 0);
      setSelectedIdx(newIdx);
      try { scrollRef?.scrollChildIntoView?.(`palette-${newIdx}`); } catch {}
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
        <scrollbox ref={(el: any) => (scrollRef = el)} flexGrow={1} viewportCulling>
          <For each={filtered()}>
            {(action, idx) => {
              const isSel = () => idx() === selectedIdx();
              return (
                <box
                  id={`palette-${idx()}`}
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
