import { createSignal, For, createMemo, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";
import type { StoreQueries } from "../../store/queries.ts";

/**
 * Target chat picker for forwarding a message. Mirrors SearchOverlay layout
 * but on Enter calls onForward with the picked chat jid instead of opening
 * the chat. layout.tsx wires the actual sock.sendMessage forward call.
 */
export function ForwardOverlay(props: {
  queries: StoreQueries;
  onForward: (jid: string) => void;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const [query, setQuery] = createSignal("");
  let inputRef: any;

  createEffect(() => {
    if (store.overlay?.type === "forward") {
      inputRef?.focus();
    }
  });

  const results = createMemo(() => {
    const q = query().trim();
    if (!q) return store.chats.slice(0, 20);
    const lower = q.toLowerCase();
    return store.chats
      .filter((c) => {
        const name = c.name || props.queries.resolveContactName(c.jid);
        return name.toLowerCase().includes(lower) || c.jid.includes(lower);
      })
      .slice(0, 20);
  });

  const [selectedIdx, setSelectedIdx] = createSignal(0);

  function close() {
    helpers.setOverlay(null);
    helpers.setMode("normal");
    helpers.setFocusZone("messages");
  }

  function handleKeyDown(evt: any) {
    if (evt.name === "escape") {
      evt.preventDefault?.();
      close();
      return;
    }
    if (evt.name === "return") {
      evt.preventDefault?.();
      const r = results()[selectedIdx()];
      if (r) {
        // Call onForward BEFORE closing — close() nulls store.overlay
        // and the handler reads store.overlay.forwardSourceMsgId which
        // would otherwise be gone.
        props.onForward(r.jid);
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
        title=" Forward to... "
        titleAlignment="center"
        padding={1}
      >
        <input
          ref={(el: any) => (inputRef = el)}
          width={width() - 4}
          value={query()}
          placeholder="Search target chat..."
          textColor={theme.text}
          focused
          cursorStyle={{ style: "block", blinking: false }}
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
