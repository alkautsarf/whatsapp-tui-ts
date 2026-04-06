import { Show, createMemo } from "solid-js";
import { useTheme } from "../theme.tsx";
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

function receiptStr(status: number): string {
  switch (status) {
    case 0: return " \u00b7";
    case 1: return " \u2713";
    case 2: return " \u2713";
    case 3: return " \u2713\u2713";
    case 4: return " \u2713\u2713";
    default: return "";
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
  const isOwn = () => props.message.from_me === 1;
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

  // Build body text (quote + content + time) as single string
  const bodyText = createMemo(() => {
    const lines: string[] = [];
    if (props.quotedText) {
      lines.push("> " + props.quotedText.slice(0, 50));
    }
    const content = msgContent();
    const timeStr = formatTime(props.message.timestamp) + (isOwn() ? receiptStr(props.message.status) : "");
    // Multi-line content: timestamp on its own line; single-line: inline
    if (content.includes("\n")) {
      lines.push(content);
      lines.push(timeStr);
    } else {
      lines.push(content + "  " + timeStr);
    }
    return lines.join("\n");
  });

  // Explicit line count for Yoga height — OpenTUI doesn't auto-size from \n count
  const bodyLineCount = createMemo(() => bodyText().split("\n").length);

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
          {/* Body: quote + content + time — explicit height for OpenTUI */}
          <box height={bodyLineCount()}>
            <text fg={theme.text}>{bodyText()}</text>
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
