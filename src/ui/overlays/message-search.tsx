import { createSignal, For, createMemo, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";
import type { StoreQueries, MessageRow } from "../../store/queries.ts";

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function snippet(text: string, query: string, max = 60): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, max);
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + query.length + 40);
  let s = text.slice(start, end);
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

export function MessageSearchOverlay(props: {
  queries: StoreQueries;
  onJump: (msg: MessageRow) => void;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const [query, setQuery] = createSignal("");
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  let inputRef: any;

  createEffect(() => {
    inputRef?.focus();
  });

  const results = createMemo<MessageRow[]>(() => {
    const q = query().trim();
    const jid = store.selectedChatJid;
    if (!q || !jid) return [];
    return props.queries.searchMessages(jid, q, 50);
  });

  // Reset selection when results change
  createEffect(() => {
    results();
    setSelectedIdx(0);
  });

  function close() {
    helpers.setOverlay(null);
    helpers.setMode("normal");
  }

  function handleKeyDown(evt: any) {
    if (evt.name === "escape") {
      evt.preventDefault?.();
      close();
      return;
    }
    if (evt.name === "return") {
      evt.preventDefault?.();
      const m = results()[selectedIdx()];
      if (m) {
        props.onJump(m);
        close();
      }
      return;
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.min(i + 1, results().length - 1));
      return;
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
  }

  const overlayWidth = () => Math.min(80, Math.max(60, Math.floor(dims().width * 0.65)));
  const overlayHeight = () => Math.min(28, Math.max(18, Math.floor(dims().height * 0.7)));

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
        title=" Search messages in this chat "
        titleAlignment="center"
        padding={1}
      >
        <input
          ref={(el: any) => (inputRef = el)}
          width={overlayWidth() - 4}
          value={query()}
          placeholder="Type to search..."
          textColor={theme.text}
          focused
          cursorStyle={{ style: "block", blinking: false }}
          onInput={(v: string) => setQuery(v)}
          onKeyDown={handleKeyDown}
        />
        <box height={1} />
        <scrollbox flexGrow={1} viewportCulling>
          <For each={results()}>
            {(msg, idx) => {
              const isSel = () => idx() === selectedIdx();
              const text = msg.text ?? "";
              return (
                <box
                  paddingX={1}
                  height={1}
                  backgroundColor={isSel() ? theme.bgSelected : undefined}
                  flexDirection="row"
                >
                  <box width={8}>
                    <text fg={theme.textMuted}>{formatTime(msg.timestamp)}</text>
                  </box>
                  <text fg={isSel() ? theme.textStrong : theme.text}>
                    {snippet(text, query())}
                  </text>
                </box>
              );
            }}
          </For>
        </scrollbox>
        <box height={1}>
          <text fg={theme.textMuted}>
            {`${results().length} matches · Enter to jump · Esc to close`}
          </text>
        </box>
      </box>
    </box>
  );
}
