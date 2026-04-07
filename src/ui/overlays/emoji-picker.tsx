import { createSignal, For, createMemo, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";
import { filterEmojis, type EmojiEntry } from "../../utils/emoji-data.ts";

const COLS = 8;          // emojis per row in the grid
const VISIBLE_ROWS = 6;  // rows shown at once

export function EmojiPicker(props: { onPick: (char: string) => void }) {
  const { helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const [query, setQuery] = createSignal("");
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  let inputRef: any;

  createEffect(() => {
    inputRef?.focus();
  });

  const results = createMemo(() => filterEmojis(query()));

  // Reset selection when results change so we don't index past the end
  createEffect(() => {
    results();
    setSelectedIdx(0);
  });

  function close() {
    helpers.setOverlay(null);
    // Don't change mode here — the layout's onPick callback will set
    // mode back to "insert" after inserting the emoji. For Esc-cancel,
    // restore to insert (the picker was opened from insert mode).
  }

  function handleKeyDown(evt: any) {
    if (evt.name === "escape") {
      evt.preventDefault?.();
      // User cancelled — restore insert mode so they can keep typing.
      helpers.setMode("insert");
      helpers.setFocusZone("input");
      close();
      return;
    }

    if (evt.name === "return") {
      evt.preventDefault?.();
      const entry = results()[selectedIdx()];
      if (entry) {
        props.onPick(entry.char);
        close();
      }
      return;
    }

    // Grid navigation: arrow keys only — Ctrl+H/J/K/L don't work because
    // most terminals intercept Ctrl+H as backspace and Ctrl+J as newline
    // before the keys reach this handler.
    if (evt.name === "left") {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (evt.name === "right") {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.min(results().length - 1, i + 1));
      return;
    }
    if (evt.name === "up") {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.max(0, i - COLS));
      return;
    }
    if (evt.name === "down") {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.min(results().length - 1, i + COLS));
      return;
    }
  }

  const visibleStart = createMemo(() => {
    const idx = selectedIdx();
    const rowOfSelected = Math.floor(idx / COLS);
    const firstVisibleRow = Math.max(0, rowOfSelected - VISIBLE_ROWS + 1);
    return firstVisibleRow * COLS;
  });

  const visibleSlice = createMemo(() =>
    results().slice(visibleStart(), visibleStart() + VISIBLE_ROWS * COLS)
  );

  // Group visible slice into rows of COLS
  const rows = createMemo(() => {
    const slice = visibleSlice();
    const out: EmojiEntry[][] = [];
    for (let i = 0; i < slice.length; i += COLS) {
      out.push(slice.slice(i, i + COLS));
    }
    return out;
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
        width={Math.min(50, Math.max(40, Math.floor(dims().width * 0.4)))}
        // Chrome inside the modal: 2 border + 2 padding + 1 input + 1 spacer
        // + 1 footer = 7 lines. Add VISIBLE_ROWS for the content + 1 safety
        // buffer line so the last emoji row never overflows into the footer.
        height={VISIBLE_ROWS + 8}
        border
        borderStyle="rounded"
        borderColor={theme.borderFocused}
        backgroundColor={theme.bgOverlay}
        title=" Emoji Picker "
        titleAlignment="center"
        padding={1}
      >
        <input
          ref={(el: any) => (inputRef = el)}
          width={46}
          placeholder="Type to search emoji..."
          textColor={theme.text}
          focused
          cursorStyle={{ style: "block", blinking: false }}
          onInput={(v: string) => setQuery(v)}
          onKeyDown={handleKeyDown}
        />
        <box height={1} />
        <box flexDirection="column" flexGrow={1}>
          <For each={rows()}>
            {(row, rowIdx) => (
              <box flexDirection="row" height={1}>
                <For each={row}>
                  {(entry, colIdx) => {
                    const absoluteIdx = () =>
                      visibleStart() + rowIdx() * COLS + colIdx();
                    const isSel = () => absoluteIdx() === selectedIdx();
                    return (
                      <box width={5}>
                        <text
                          fg={isSel() ? "#000000" : theme.text}
                          bg={isSel() ? theme.borderFocused : undefined}
                        >
                          {" " + entry.char + " "}
                        </text>
                      </box>
                    );
                  }}
                </For>
              </box>
            )}
          </For>
        </box>
        <box height={1}>
          <text fg={theme.textMuted}>
            {`${results().length} emoji · Enter to insert · Esc to close`}
          </text>
        </box>
      </box>
    </box>
  );
}
