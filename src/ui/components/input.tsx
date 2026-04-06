import { Show, createEffect } from "solid-js";
import { usePaste } from "@opentui/solid";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import type { StoreQueries } from "../../store/queries.ts";

export function InputArea(props: {
  queries: StoreQueries;
  onSend: (text: string) => void;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  let textareaRef: any;

  const isFocused = () => store.focusZone === "input";
  const isInsert = () => store.mode === "insert";

  // Focus management
  createEffect(() => {
    if (isFocused() && isInsert()) {
      textareaRef?.focus();
    } else {
      textareaRef?.blur();
    }
  });

  // Paste support
  usePaste((event: any) => {
    textareaRef?.handlePaste?.(event);
  });

  const replyPreview = () => {
    if (!store.replyToMessageId) return null;
    const content = props.queries.getMessageContent(store.replyToMessageId);
    return content?.text?.slice(0, 50) ?? "[media]";
  };

  const modeLabel = () => {
    if (isInsert()) return " INSERT ";
    return " Input ";
  };

  function handleKeyDown(evt: any) {
    if (evt.name === "return" && !evt.meta && !evt.ctrl && !evt.shift) {
      const text = textareaRef?.plainText ?? "";
      if (text.trim()) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        props.onSend(text.trim());
        helpers.setReplyTo(null);
        try { textareaRef?.replaceContent?.(""); } catch {}
        try { textareaRef?.clear?.(); } catch {}
      }
    }
  }

  return (
    <Show when={store.selectedChatJid}>
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={isFocused() ? theme.borderFocused : theme.border}
        title={modeLabel()}
        titleAlignment="left"
        height={store.replyToMessageId ? 5 : 4}
      >
        {/* Reply context */}
        <Show when={replyPreview()}>
          <box paddingLeft={1} borderColor={theme.borderAccent} border={["left"] as any}>
            <text fg={theme.textMuted}>
              {"reply: " + replyPreview()}
            </text>
          </box>
        </Show>

        <textarea
          ref={(el: any) => (textareaRef = el)}
          width="100%"
          minHeight={1}
          maxHeight={3}
          placeholder="Type a message..."
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          wrapMode="word"
          cursorStyle={{ style: "line", blinking: false }}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", meta: true, action: "newline" },
            { name: "return", ctrl: true, action: "newline" },
          ]}
          onKeyDown={handleKeyDown}
        />
      </box>
    </Show>
  );
}
