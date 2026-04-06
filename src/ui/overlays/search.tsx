import { createSignal, For, Show, createMemo, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import type { StoreQueries } from "../../store/queries.ts";
import { useTerminalDimensions } from "@opentui/solid";

export function SearchOverlay(props: { queries: StoreQueries }) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const [query, setQuery] = createSignal("");
  let inputRef: any;

  createEffect(() => {
    if (store.overlay?.type === "search") {
      inputRef?.focus();
    }
  });

  const results = createMemo(() => {
    const q = query().trim();
    if (!q) return store.chats.slice(0, 20);
    const lower = q.toLowerCase();
    return store.chats.filter((c) => {
      const name = c.name || props.queries.resolveContactName(c.jid);
      return name.toLowerCase().includes(lower) || c.jid.includes(lower);
    }).slice(0, 20);
  });

  const [selectedIdx, setSelectedIdx] = createSignal(0);

  function handleKeyDown(evt: any) {
    if (evt.name === "escape") {
      helpers.setOverlay(null);
      helpers.setMode("normal");
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      const r = results()[selectedIdx()];
      if (r) {
        helpers.selectChat(r.jid);
        helpers.setOverlay(null);
        helpers.setMode("normal");
        helpers.setFocusZone("messages");
      }
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      setSelectedIdx((i) => Math.min(i + 1, results().length - 1));
      evt.preventDefault();
      return;
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      setSelectedIdx((i) => Math.max(i - 1, 0));
      evt.preventDefault();
      return;
    }
  }

  const width = () => Math.min(Math.floor(dims().width * 0.6), 60);
  const height = () => Math.min(Math.floor(dims().height * 0.5), 25);

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
        title=" Search "
        titleAlignment="center"
        padding={1}
      >
        <input
          ref={(el: any) => (inputRef = el)}
          width={width() - 4}
          value={query()}
          placeholder="Search chats..."
          textColor={theme.text}
          focused
          onInput={(v: string) => { setQuery(v); setSelectedIdx(0); }}
          onKeyDown={handleKeyDown}
        />
        <box height={1} />
        <scrollbox flexGrow={1} viewportCulling>
          <For each={results()}>
            {(chat, idx) => {
              const name = () =>
                chat.name || props.queries.resolveContactName(chat.jid);
              const isSel = () => idx() === selectedIdx();
              return (
                <box
                  paddingX={1}
                  backgroundColor={isSel() ? theme.bgSelected : undefined}
                >
                  <text fg={isSel() ? theme.textStrong : theme.text}>
                    {name()}
                  </text>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </box>
    </box>
  );
}
