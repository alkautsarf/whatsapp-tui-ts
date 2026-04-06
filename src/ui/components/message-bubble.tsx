import { Show, createMemo } from "solid-js";
import { useTheme, type Theme } from "../theme.tsx";
import { useAppStore } from "../state.tsx";
import { IMAGE_MEDIA_TYPES } from "../image.ts";
import type { MessageRow } from "../../store/queries.ts";

function senderColorFromName(name: string, colors: string[]): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length]!;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function receiptStyle(status: number, t: Theme): { glyph: string; color: string } {
  switch (status) {
    case 0: return { glyph: " \u00b7", color: t.textMuted };
    case 1: case 2: return { glyph: " \u2713", color: t.sent };
    case 3: return { glyph: " \u2713\u2713", color: t.delivered };
    case 4: return { glyph: " \u2713\u2713", color: t.read };
    default: return { glyph: "", color: t.textMuted };
  }
}

function mediaLabel(type: string): string {
  switch (type) {
    case "imageMessage": return "[Image]";
    case "videoMessage": return "[Video]";
    case "audioMessage": return "[Audio]";
    case "stickerMessage": return "[Sticker]";
    case "documentMessage": return "[Document]";
    default: return `[${type}]`;
  }
}

function formatDateSeparator(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  ) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear()
  ) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export interface BubbleProps {
  message: MessageRow;
  showSender: boolean;
  showDate: boolean;
  senderName: string;
  quotedText?: string | null;
  isSelected?: boolean;
}

export function MessageBubble(props: BubbleProps) {
  const theme = useTheme();
  const { store } = useAppStore();
  const isOwn = () => props.message.from_me === 1;

  const imageData = () => {
    const mt = props.message.media_type ?? props.message.type;
    if (!IMAGE_MEDIA_TYPES.has(mt)) return null;
    return store.encodedImages[props.message.id] ?? null;
  };
  const bubbleBg = () => {
    if (props.isSelected) return theme.bgMessageSelected;
    return isOwn() ? theme.bgBubbleOwn : theme.bgBubbleOther;
  };

  const msgContent = () => {
    if (props.message.text) return props.message.text;
    if (props.message.media_type) return mediaLabel(props.message.media_type);
    if (props.message.type !== "conversation" && props.message.type !== "unknown") {
      return mediaLabel(props.message.type);
    }
    return "";
  };

  const contentText = createMemo(() => {
    const lines: string[] = [];
    if (props.quotedText) {
      lines.push("> " + props.quotedText.slice(0, 50));
    }
    const content = msgContent();
    if (content) lines.push(content);
    return lines.join("\n");
  });

  const contentLineCount = createMemo(() => {
    const t = contentText();
    return t ? t.split("\n").length : 0;
  });

  const nameColor = () => senderColorFromName(props.senderName, theme.senderColors);

  return (
    <box flexDirection="column" marginBottom={1}>
      {/* Date separator */}
      <Show when={props.showDate}>
        <box justifyContent="center" alignItems="center" width="100%" paddingY={1}>
          <text fg={theme.textMuted}>
            {"\u2500\u2500\u2500 " + formatDateSeparator(props.message.timestamp) + " \u2500\u2500\u2500"}
          </text>
        </box>
      </Show>

      {/* Message bubble */}
      <box flexDirection="row" alignItems="flex-start" justifyContent={isOwn() ? "flex-end" : "flex-start"}>
        <Show when={props.isSelected && isOwn()}>
          <box width={2}>
            <text fg={theme.borderAccent}>{"\u25b8"}</text>
          </box>
        </Show>
        <box
          flexDirection="column"
          backgroundColor={bubbleBg()}
          paddingX={1}
          maxWidth="65%"
        >
          {/* Sender name — own box to isolate from body text */}
          <Show when={props.showSender && !isOwn()}>
            <box height={1}>
              <text fg={nameColor()}>{props.senderName}</text>
            </box>
          </Show>
          {/* Inline image (Kitty virtual placement) */}
          <Show when={imageData()}>
            {(img) => (
              <box height={img().rows} width={img().cols}>
                <text fg={img().fgHex}>{img().placeholders}</text>
              </box>
            )}
          </Show>
          {/* Text content (or media label if no image data yet) */}
          <Show when={contentLineCount() > 0 && !imageData()}>
            <box height={contentLineCount()}>
              <text fg={theme.text}>{contentText()}</text>
            </box>
          </Show>
          {/* Caption below image */}
          <Show when={imageData() && props.message.text}>
            <box height={1}>
              <text fg={theme.text}>{props.message.text!}</text>
            </box>
          </Show>
          <box height={1} flexDirection="row" justifyContent="flex-end" gap={1}>
            <text fg={theme.textMuted}>{formatTime(props.message.timestamp)}</text>
            <Show when={isOwn()}>
              {(() => { const r = receiptStyle(props.message.status, theme); return <text fg={r.color}>{r.glyph}</text>; })()}
            </Show>
          </box>
        </box>
        <Show when={props.isSelected && !isOwn()}>
          <box width={2}>
            <text fg={theme.borderAccent}>{"\u25c2"}</text>
          </box>
        </Show>
      </box>
    </box>
  );
}
