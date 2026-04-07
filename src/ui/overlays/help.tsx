import { For, createMemo } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";

interface KeyBinding {
  keys: string;
  description: string;
}

interface KeySection {
  title: string;
  bindings: KeyBinding[];
}

const SECTIONS: KeySection[] = [
  {
    title: "Global",
    bindings: [
      { keys: "Ctrl+C", description: "Quit wa-tui" },
      { keys: "Ctrl+P", description: "Command palette" },
      { keys: "?", description: "Show this help" },
      { keys: "Tab / Shift+Tab", description: "Cycle focus zones" },
      { keys: "Esc", description: "Drill back / cancel" },
    ],
  },
  {
    title: "Chat List (NORMAL)",
    bindings: [
      { keys: "j / Down", description: "Next chat" },
      { keys: "k / Up", description: "Previous chat" },
      { keys: "gg", description: "Jump to first chat" },
      { keys: "G", description: "Jump to last chat" },
      { keys: "Enter / l", description: "Open selected chat" },
      { keys: "/", description: "Search chats" },
      { keys: "i", description: "Enter INSERT mode (compose)" },
      { keys: "a", description: "Attach file (opens @ picker)" },
      { keys: "q", description: "Quit" },
    ],
  },
  {
    title: "Messages (NORMAL)",
    bindings: [
      { keys: "j / Down", description: "Scroll down one message" },
      { keys: "k / Up", description: "Scroll up one message" },
      { keys: "Ctrl+D", description: "Half page down" },
      { keys: "Ctrl+U", description: "Half page up" },
      { keys: "gg", description: "Jump to top of message history" },
      { keys: "G", description: "Jump to most recent" },
      { keys: "Enter", description: "Open image / video / PDF (full view)" },
      { keys: "r", description: "Reply to selected message" },
      { keys: "y", description: "Yank message text to clipboard" },
      { keys: "h", description: "Back to chat list" },
      { keys: "i", description: "Enter INSERT mode" },
    ],
  },
  {
    title: "Input (INSERT)",
    bindings: [
      { keys: "Enter", description: "Send message" },
      { keys: "Ctrl+Enter / Cmd+Enter", description: "Newline (multi-line message)" },
      { keys: "Esc", description: "Back to NORMAL mode" },
      { keys: "Ctrl+G", description: "Open $EDITOR for long compose" },
      { keys: "Ctrl+V", description: "Paste image from clipboard" },
      { keys: "@", description: "Inline file picker (start typing path)" },
      { keys: "Drag-drop file", description: "Auto-attach as media" },
    ],
  },
  {
    title: "@ File Completion (INSERT)",
    bindings: [
      { keys: "Tab / Enter", description: "Accept selected file" },
      { keys: "Down / Ctrl+N", description: "Next suggestion" },
      { keys: "Up / Ctrl+P", description: "Previous suggestion" },
      { keys: "Esc", description: "Cancel completion" },
    ],
  },
  {
    title: "Search Mode",
    bindings: [
      { keys: "Type", description: "Filter chats" },
      { keys: "Enter", description: "Open selected" },
      { keys: "Esc", description: "Cancel search" },
    ],
  },
];

// Flatten the sections into a single list of "lines" (header / binding /
// spacer) so we can apply a simple scroll offset by slicing the array. We
// avoid OpenTUI's <scrollbox> here because j/k key handling needs to live in
// the global keys.ts dispatcher (so the underlying message list doesn't get
// scrolled instead), and a flat list with offset slicing is the simplest way
// to drive that from outside the component.
type Line =
  | { type: "header"; text: string }
  | { type: "binding"; keys: string; desc: string }
  | { type: "spacer" };

function flattenSections(): Line[] {
  const lines: Line[] = [];
  for (const section of SECTIONS) {
    lines.push({ type: "header", text: section.title });
    for (const b of section.bindings) {
      lines.push({ type: "binding", keys: b.keys, desc: b.description });
    }
    lines.push({ type: "spacer" });
  }
  return lines;
}

export function HelpOverlay() {
  const { store } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  // Modal sized as a fraction of the terminal, with sensible bounds.
  const overlayWidth = () => Math.min(76, Math.max(60, Math.floor(dims().width * 0.7)));
  const overlayHeight = () => Math.min(30, Math.max(18, Math.floor(dims().height * 0.8)));

  // Inside the modal box: border (with title overlay) takes 1 line top + 1
  // bottom, padding=1 takes 1 each side, the close-hint row takes 1, the
  // gap row takes 1, and the bottom scroll-indicator row takes 1. So:
  //   2 (border) + 2 (padding) + 1 (close hint) + 1 (gap) + 1 (footer) = 7
  // Subtract one extra line as a safety buffer.
  const visibleLines = () => Math.max(5, overlayHeight() - 8);

  const allLines = flattenSections();
  const maxOffset = () => Math.max(0, allLines.length - visibleLines());

  const visibleSlice = createMemo(() => {
    const offset = Math.min(store.helpScrollOffset, maxOffset());
    return allLines.slice(offset, offset + visibleLines());
  });

  const scrollIndicator = createMemo(() => {
    const offset = Math.min(store.helpScrollOffset, maxOffset());
    if (allLines.length <= visibleLines()) return "";
    const top = offset === 0;
    const bot = offset >= maxOffset();
    if (top) return " ↓ more below ";
    if (bot) return " ↑ more above ";
    return " ↑↓ scrollable ";
  });

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
        width={overlayWidth()}
        height={overlayHeight()}
        border
        borderStyle="rounded"
        borderColor={theme.borderFocused}
        backgroundColor={theme.bgOverlay}
        title=" Keyboard Shortcuts "
        titleAlignment="center"
        padding={1}
      >
        <box flexDirection="row" justifyContent="flex-end" height={1}>
          <text fg={theme.textMuted}>{"Esc or ? to close · j/k to scroll"}</text>
        </box>
        <box height={1} />

        <box flexDirection="column" flexGrow={1}>
          <For each={visibleSlice()}>
            {(line) => {
              if (line.type === "header") {
                return (
                  <box height={1}>
                    <text fg={theme.borderAccent} attributes={1}>{line.text}</text>
                  </box>
                );
              }
              if (line.type === "spacer") {
                return <box height={1}></box>;
              }
              return (
                <box flexDirection="row" gap={2} height={1}>
                  <box width={26}>
                    <text fg={theme.online}>{"  " + line.keys}</text>
                  </box>
                  <text fg={theme.text}>{line.desc}</text>
                </box>
              );
            }}
          </For>
        </box>

        <box height={1}>
          <text fg={theme.textMuted}>{scrollIndicator()}</text>
        </box>
      </box>
    </box>
  );
}
