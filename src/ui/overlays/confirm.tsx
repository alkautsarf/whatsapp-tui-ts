import { createSignal, For, createEffect } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";
import type { ConfirmPayload } from "../types.ts";

/**
 * Generic confirmation modal. Shows a title, a message body, and a list of
 * options the user picks via j/k or arrow keys + Enter. Esc cancels.
 *
 * The overlay state holds a `confirm` payload with the title/options and an
 * `intent` string. The actual dispatch (what happens when an option is
 * chosen) lives in layout.tsx — this component just emits the picked option
 * value via the onPick callback prop.
 */
export function ConfirmModal(props: {
  payload: ConfirmPayload;
  onPick: (value: string) => void;
}) {
  const { helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const [selectedIdx, setSelectedIdx] = createSignal(0);

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
      const opt = props.payload.options[selectedIdx()];
      if (opt) {
        // Capture the value BEFORE closing — close() nulls the overlay
        // state, and the dispatcher reads payload.intent / data from
        // store.overlay.confirm. If we close first, the dispatcher gets
        // a null payload and silently no-ops.
        const value = opt.value;
        const onPick = props.onPick;
        onPick(value);
        close();
      }
      return;
    }
    if (evt.name === "down" || evt.name === "j" || (evt.ctrl && evt.name === "n")) {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.min(i + 1, props.payload.options.length - 1));
      return;
    }
    if (evt.name === "up" || evt.name === "k" || (evt.ctrl && evt.name === "p")) {
      evt.preventDefault?.();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
  }

  // Capture key events. We use an invisible focused input element to grab
  // keystrokes — same trick as the search/emoji overlays since the global
  // useKeyboard handler doesn't fire while in modal contexts the way we'd
  // want here.
  let inputRef: any;
  createEffect(() => {
    inputRef?.focus();
  });

  const width = () => Math.min(Math.max(40, props.payload.message.length + 8), Math.floor(dims().width * 0.6));
  const height = () => 6 + props.payload.options.length;

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
        title={` ${props.payload.title} `}
        titleAlignment="center"
        padding={1}
      >
        <text fg={theme.text}>{props.payload.message}</text>
        <box height={1} />
        <box flexDirection="column">
          <For each={props.payload.options}>
            {(opt, idx) => {
              const isSel = () => idx() === selectedIdx();
              const fg = () => {
                if (isSel()) return theme.textStrong;
                if (opt.danger) return theme.error ?? "#ff6b6b";
                return theme.text;
              };
              return (
                <box
                  paddingX={1}
                  backgroundColor={isSel() ? theme.bgSelected : undefined}
                >
                  <text fg={fg()}>
                    {(isSel() ? "› " : "  ") + opt.label}
                  </text>
                </box>
              );
            }}
          </For>
        </box>
        {/* Hidden focused input to capture keystrokes. Positioned offscreen
            (negative top) so its blinking cursor doesn't show up inside the
            modal — OpenTUI doesn't expose a "no cursor" option. */}
        <box position="absolute" top={-100} left={-100} width={1} height={1}>
          <input
            ref={(el: any) => (inputRef = el)}
            width={1}
            focused
            cursorStyle={{ style: "block", blinking: false }}
            onKeyDown={handleKeyDown}
          />
        </box>
      </box>
    </box>
  );
}
