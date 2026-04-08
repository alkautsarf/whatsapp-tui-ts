import { Show, createMemo, type Accessor } from "solid-js";
import { useTheme, type Theme } from "../theme.tsx";
import { useAppStore } from "../state.tsx";
import { IMAGE_MEDIA_TYPES } from "../image.ts";
import type { MessageRow } from "../../store/queries.ts";
import { mediaLabel as mediaTypeLabel } from "../../wa/message-types.ts";
import type { EncodedImageData } from "../types.ts";

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
  return `[${mediaTypeLabel(type) || type}]`;
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
  /** Pre-resolved message text (mentions replaced with contact names). If
   *  null, fall back to message.text. Resolved upstream in messages.tsx so
   *  we don't have to plumb queries through to every bubble. */
  resolvedText?: string | null;
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
    // Prefer the upstream-resolved text (mentions replaced with names),
    // falling back to the raw message text if resolution didn't happen.
    const text = props.resolvedText ?? props.message.text;
    const mediaType = props.message.media_type;

    // For images and stickers, the inline image renders separately (via the
    // imageData() path below) and any caption text gets its own row beneath
    // the image. Don't repeat the [Image] label here.
    if (mediaType === "imageMessage" || mediaType === "stickerMessage") {
      return text ?? "";
    }

    // For other media types (document, video, audio): show the bracketed
    // label + the caption on separate lines, so the user can see BOTH that
    // there's an attachment AND the text. Without this, a document with
    // caption rendered as text-only and looked like the document hadn't sent.
    if (mediaType) {
      const label = mediaLabel(mediaType);
      return text ? `${label}\n${text}` : label;
    }

    // No media at all — text-only message or one of the type-derived labels.
    if (text) return text;
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

  // Estimate the number of visual lines the rendered text will occupy after
  // word wrapping in the bubble. The bubble has `maxWidth="65%"` inside the
  // messages area which is `flexGrow=1` of the parent (chat list takes 30%),
  // so the bubble's interior text width is approximately:
  //   termCols * 0.70 (messages area) * 0.65 (bubble maxWidth) - 2 (paddingX)
  // We use ceil(line.length / wrapCols) per explicit \n-separated line to
  // count how many visual rows each will wrap to, then sum. This is a
  // character-count approximation — emoji and CJK take 2 cells each, so
  // wide-char-heavy messages may slightly under-count. The 4-char safety
  // margin compensates for that and for word-boundary wrap which can leave
  // a partial line.
  const contentLineCount = createMemo(() => {
    const t = contentText();
    if (!t) return 0;
    const termCols = process.stdout.columns || 80;
    const wrapCols = Math.max(20, Math.floor(termCols * 0.70 * 0.65) - 4);
    return t.split("\n").reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(line.length / wrapCols));
    }, 0);
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
            {(img: Accessor<EncodedImageData>) => (
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
          {/* Caption below image — use the upstream-resolved text so any
              `@<digits>` mentions get rendered as `@<contact name>`. */}
          <Show when={imageData() && (props.resolvedText ?? props.message.text)}>
            <box height={1}>
              <text fg={theme.text}>{(props.resolvedText ?? props.message.text)!}</text>
            </box>
          </Show>
          <box height={1} flexDirection="row" justifyContent="flex-end" gap={1}>
            <Show when={props.message.react_emoji}>
              <text fg={theme.borderAccent}>{props.message.react_emoji!}</text>
            </Show>
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
