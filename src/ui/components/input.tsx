import { Show, For, createSignal, createEffect, createMemo, onMount } from "solid-js";
import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { usePaste } from "@opentui/solid";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { tryExtractClipboardImageSync } from "../../utils/clipboard-image.ts";
import { addAttachment, type AttachmentKind } from "../../utils/attachment-registry.ts";
import type { StoreQueries } from "../../store/queries.ts";
import type { InputMethods } from "../types.ts";

function kindFromExt(ext: string): AttachmentKind {
  const e = ext.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "bmp", "heic", "heif"].includes(e)) return "image";
  if (["webp"].includes(e)) return "sticker";
  if (["mp4", "mov", "avi", "mkv", "webm", "3gp"].includes(e)) return "video";
  if (["mp3", "ogg", "wav", "opus", "m4a", "aac", "flac"].includes(e)) return "audio";
  return "document";
}

const PASTE_THRESHOLD = 500;
const MAX_SUGGESTIONS = 20;
const VISIBLE_SUGGESTIONS = 8;
const HOME = process.env.HOME || "/";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/**
 * Detect when the input text is JUST a file path that was likely typed by a
 * Ghostty/iTerm drag-drop event (not by the user typing manually). Handles:
 *   - Plain absolute path: /Users/foo/bar.png
 *   - Tilde-expanded:      ~/Downloads/bar.png
 *   - Backslash-escaped:   /Users/foo/My\ File.png  ← Ghostty's default for spaces
 *   - Single-quoted:       '/Users/foo/My File.png'
 *   - Double-quoted:       "/Users/foo/My File.png"
 *
 * Returns the unescaped, expanded absolute path if the input is a file that
 * exists, or null otherwise. Caller should auto-prefix the result with `@`
 * so the existing media-send flow handles it.
 */
function detectDroppedFilePath(text: string): string | null {
  let raw = text.trim();
  if (!raw) return null;

  // Strip surrounding quotes if both ends match
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }

  // Unescape backslash sequences (\ + space, \(, etc.)
  const unescaped = raw.replace(/\\(.)/g, "$1");

  // Must look like an absolute path (or ~)
  if (!unescaped.startsWith("/") && !unescaped.startsWith("~")) return null;

  // Reject paths containing whitespace that DIDN'T have escapes — those are
  // probably user prose, not a drop. (Drag-drop on macOS always escapes.)
  if (raw === unescaped && /\s/.test(unescaped)) return null;

  // Expand ~
  const expanded = unescaped.startsWith("~")
    ? (process.env.HOME || "") + unescaped.slice(1)
    : unescaped;

  try {
    if (!existsSync(expanded)) return null;
    if (!statSync(expanded).isFile()) return null;
  } catch {
    return null;
  }

  return expanded;
}

function listFilesForQuery(query: string): FileEntry[] {
  let dir: string;
  let filter: string;

  if (!query) {
    dir = HOME;
    filter = "";
  } else {
    // Expand ~ to home
    const expanded = query.startsWith("~") ? HOME + query.slice(1) : query;

    if (expanded.endsWith("/")) {
      dir = expanded;
      filter = "";
    } else if (expanded.includes("/")) {
      // Has path separator — split into dir + filter
      dir = dirname(expanded);
      filter = basename(expanded).toLowerCase();
    } else {
      // Bare query without path — search HOME
      dir = HOME;
      filter = expanded.toLowerCase();
    }
  }

  if (!existsSync(dir)) return [];

  try {
    const entries = readdirSync(dir);
    const result: FileEntry[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (filter && !name.toLowerCase().startsWith(filter)) continue;
      try {
        const full = join(dir, name);
        const stat = statSync(full);
        result.push({ name, path: full, isDir: stat.isDirectory() });
      } catch {}
    }
    result.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result.slice(0, MAX_SUGGESTIONS);
  } catch {
    return [];
  }
}

function fileTypeTag(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"].includes(ext)) return "img";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "vid";
  if (["mp3", "ogg", "wav", "opus", "m4a", "aac"].includes(ext)) return "aud";
  if (["pdf"].includes(ext)) return "pdf";
  return "   ";
}

export function InputArea(props: {
  queries: StoreQueries;
  onSend: (text: string) => void;
  inputMethodsRef?: (methods: InputMethods) => void;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();

  let textareaRef: any;

  // Long paste storage
  const [longPasteText, setLongPasteText] = createSignal<string | null>(null);

  // @ file completion state
  const [completionActive, setCompletionActive] = createSignal(false);
  const [completionQuery, setCompletionQuery] = createSignal("");
  const [completionIdx, setCompletionIdx] = createSignal(0);
  const [completionAtPos, setCompletionAtPos] = createSignal(0);

  const completionItems = createMemo(() => {
    if (!completionActive()) return [];
    return listFilesForQuery(completionQuery());
  });

  let completionScrollRef: any;

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

  // Expose getText/setText/insertAtCursor for editor mode + emoji picker
  onMount(() => {
    props.inputMethodsRef?.({
      getText: () => longPasteText() ?? textareaRef?.plainText ?? "",
      setText: (text: string) => {
        setLongPasteText(null);
        try { textareaRef?.replaceText?.(text); } catch {}
        try { textareaRef?.setText?.(text); } catch {}
      },
      insertAtCursor: (text: string) => {
        insertAtCursor(text);
      },
    });
  });

  // Paste — let framework handle short pastes, intercept only long ones
  usePaste((event: any) => {
    const bytes: Uint8Array | undefined = event.bytes;
    if (bytes && bytes.length > PASTE_THRESHOLD) {
      event.preventDefault();
      const fullText = new TextDecoder().decode(bytes);
      setLongPasteText(fullText);
      const preview = fullText.slice(0, 80).replace(/\n/g, " ") + `... (${fullText.length} chars)`;
      try { textareaRef?.setText?.(preview); } catch {}
      return;
    }
    // Short paste: do nothing — framework's renderable handler calls handlePaste automatically
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

  // --- @ completion helpers ---

  function checkForCompletion() {
    if (!textareaRef) return;
    const text: string = textareaRef.plainText ?? "";
    const cursor: number = textareaRef.cursorOffset ?? text.length;
    const before = text.slice(0, cursor);
    // Fast path: no @ in text at all
    if (!before.includes("@")) {
      setCompletionActive(false);
      return;
    }
    const dblQuoteMatch = before.match(/(^|\s)@"([^"]*)$/);
    const sglQuoteMatch = before.match(/(^|\s)@'([^']*)$/);
    const plainMatch = before.match(/(^|\s)@([^\s]*)$/);
    const match = dblQuoteMatch || sglQuoteMatch || plainMatch;
    if (match) {
      const query = match[2]!;
      if (query !== completionQuery()) setCompletionIdx(0);
      setCompletionQuery(query);
      setCompletionAtPos(before.lastIndexOf("@"));
      setCompletionActive(true);
    } else {
      setCompletionActive(false);
    }
  }

  /**
   * Insert text at the current cursor position. Used by Ctrl+V image paste,
   * drag-drop file detection, and the emoji picker to inject content inline,
   * preserving any text the user has already typed before/after the cursor.
   *
   * Also explicitly re-focuses the textarea — this matters for the emoji
   * picker case, where the picker's own input stole terminal focus while it
   * was open. After picking, the store still thinks the input is focused,
   * so the focus createEffect doesn't re-fire — we have to manually restore.
   */
  function insertAtCursor(insert: string) {
    if (!textareaRef) return;
    const text: string = textareaRef.plainText ?? "";
    const cursor: number = textareaRef.cursorOffset ?? text.length;
    const newText = text.slice(0, cursor) + insert + text.slice(cursor);
    const newCursorPos = cursor + insert.length;
    try { textareaRef.replaceText(newText); } catch {
      try { textareaRef.setText(newText); } catch {}
    }
    try { textareaRef.cursorOffset = newCursorPos; } catch {}
    try { textareaRef.focus(); } catch {}
  }

  function acceptCompletion(entry?: FileEntry) {
    const item = entry ?? completionItems()[completionIdx()];
    if (!item || !textareaRef) return;

    const text: string = textareaRef.plainText ?? "";
    const cursor: number = textareaRef.cursorOffset ?? text.length;
    const atPos = completionAtPos();
    const after = text.slice(cursor);

    // Build replacement: keep @ then add path (quote if spaces)
    const hasSpaces = item.path.includes(" ") || item.name.includes(" ");
    let replacement: string;
    if (item.isDir) {
      replacement = hasSpaces ? `"${item.path}/` : item.path + "/";
    } else {
      replacement = hasSpaces ? `"${item.path}" ` : item.path + " ";
    }
    const newText = text.slice(0, atPos) + "@" + replacement + after;
    const newCursorPos = atPos + 1 + replacement.length;
    try { textareaRef.replaceText(newText); } catch {
      try { textareaRef.setText(newText); } catch {}
    }
    // Move cursor to end of inserted path
    try { textareaRef.cursorOffset = newCursorPos; } catch {}

    if (item.isDir) {
      // Keep completion open for continued navigation
      setTimeout(() => checkForCompletion(), 10);
    } else {
      setCompletionActive(false);
    }
  }

  // --- Key handling ---

  function handleKeyDown(evt: any) {
    // Ctrl+V → check clipboard for image. If found, register the path in the
    // attachment registry and insert a `[Image N] ` placeholder at the cursor
    // (Claude Code style — clean visual, supports inline paste mid-message,
    // supports multiple images per message). The real path is hidden in the
    // registry; on send, layout.tsx parses placeholders and dispatches each
    // attachment plus optional text caption.
    //
    // If clipboard has no image, fall through to default Ctrl+V behavior
    // (typically a no-op on macOS — Cmd+V is the standard paste shortcut).
    if (evt.ctrl && (evt.name === "v" || evt.name === "V")) {
      const imagePath = tryExtractClipboardImageSync();
      if (imagePath) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        const label = addAttachment(imagePath, "image");
        insertAtCursor(`${label} `);
        return;
      }
      // No image in clipboard — let the event fall through.
    }

    // @ completion navigation
    if (completionActive() && completionItems().length > 0) {
      if (evt.name === "tab" || (evt.name === "return" && !evt.meta && !evt.ctrl)) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        acceptCompletion();
        return;
      }
      if (evt.name === "escape") {
        evt.preventDefault?.();
        setCompletionActive(false);
        return;
      }
      if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
        evt.preventDefault?.();
        const newIdx = Math.min(completionIdx() + 1, completionItems().length - 1);
        setCompletionIdx(newIdx);
        try { completionScrollRef?.scrollChildIntoView?.(`completion-${newIdx}`); } catch {}
        return;
      }
      if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
        evt.preventDefault?.();
        const newIdx = Math.max(completionIdx() - 1, 0);
        setCompletionIdx(newIdx);
        try { completionScrollRef?.scrollChildIntoView?.(`completion-${newIdx}`); } catch {}
        return;
      }
    }

    // Send message
    if (evt.name === "return" && !evt.meta && !evt.ctrl && !evt.shift) {
      const stored = longPasteText();
      const text = stored ?? textareaRef?.plainText ?? "";
      if (text.trim()) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        props.onSend(text.trim());
        helpers.setReplyTo(null);
        setLongPasteText(null);
        setCompletionActive(false);
        try { textareaRef?.clear?.(); } catch {
          try { textareaRef?.setText?.(""); } catch {}
        }
      }
    }

    // Clear long paste if user starts typing normally
    if (longPasteText() && evt.name !== "return" && evt.name !== "escape" && !evt.ctrl && !evt.meta) {
      setLongPasteText(null);
    }
  }

  function handleContentChange() {
    checkForCompletion();

    // Drag-drop file detection. When the user drops a file from Finder onto
    // the Ghostty window, the terminal "types" the path into the active
    // textarea — usually with backslash-escaped spaces. If the entire input
    // is just a valid file path that exists, register it in the attachment
    // registry and replace the input with a `[Image N]` / `[File N]` etc.
    // placeholder, matching the Ctrl+V paste flow. User can keep typing
    // before/after the placeholder to add a caption.
    const text = textareaRef?.plainText ?? "";
    const droppedPath = detectDroppedFilePath(text);
    if (droppedPath) {
      const ext = droppedPath.split(".").pop() ?? "";
      const kind = kindFromExt(ext);
      const label = addAttachment(droppedPath, kind);
      const newText = `${label} `;
      // Avoid infinite loop: only replace if the current text isn't already
      // the placeholder form.
      if (text.trim() !== newText.trim()) {
        try { textareaRef?.replaceText?.(newText); } catch {
          try { textareaRef?.setText?.(newText); } catch {}
        }
        try { textareaRef.cursorOffset = newText.length; } catch {}
      }
    }
  }

  // Height: base 3 + 1 for reply + completion rows
  const boxHeight = () => {
    let h = 4;
    if (store.replyToMessageId) h++;
    return h;
  };

  // Shorten path for display
  const shortenPath = (p: string) => {
    if (p.startsWith(HOME)) return "~" + p.slice(HOME.length);
    return p;
  };

  return (
    <Show when={store.selectedChatJid}>
      {/* @ completion dropdown — rendered ABOVE the input box */}
      <Show when={completionActive() && completionItems().length > 0}>
        <box
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={theme.borderFocused}
          backgroundColor={theme.bgOverlay}
          height={Math.min(completionItems().length + 2, VISIBLE_SUGGESTIONS + 2)}
          paddingX={1}
        >
          <scrollbox
            ref={(el: any) => (completionScrollRef = el)}
            flexGrow={1}
          >
          <For each={completionItems()}>
            {(entry, idx) => {
              const isSel = () => idx() === completionIdx();
              const tag = () => entry.isDir ? "dir" : fileTypeTag(entry.name);
              return (
                <box
                  id={`completion-${idx()}`}
                  flexDirection="row"
                  paddingX={1}
                  backgroundColor={isSel() ? theme.bgSelected : undefined}
                >
                  <text fg={entry.isDir ? theme.info : theme.textMuted}>
                    {`[${tag()}] `}
                  </text>
                  <text fg={isSel() ? theme.textStrong : (entry.isDir ? theme.info : theme.text)}>
                    {entry.name + (entry.isDir ? "/" : "")}
                  </text>
                </box>
              );
            }}
          </For>
          </scrollbox>
        </box>
      </Show>

      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={isFocused() ? theme.borderFocused : theme.border}
        title={modeLabel()}
        titleAlignment="left"
        height={boxHeight()}
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
          placeholder="Type a message... (@ to attach file)"
          placeholderColor={theme.textMuted}
          textColor={longPasteText() ? theme.textMuted : theme.text}
          wrapMode="word"
          cursorStyle={{ style: "block", blinking: false }}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", meta: true, action: "newline" },
            { name: "return", ctrl: true, action: "newline" },
          ]}
          onKeyDown={handleKeyDown}
          onContentChange={handleContentChange}
        />
      </box>
    </Show>
  );
}
