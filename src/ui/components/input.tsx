import { Show, For, createSignal, createEffect, createMemo, onMount } from "solid-js";
import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { usePaste } from "@opentui/solid";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { tryExtractClipboardImageSync } from "../../utils/clipboard-image.ts";
import type { StoreQueries } from "../../store/queries.ts";
import type { InputMethods } from "../types.ts";

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

  // Expose getText/setText for editor mode
  onMount(() => {
    props.inputMethodsRef?.({
      getText: () => longPasteText() ?? textareaRef?.plainText ?? "",
      setText: (text: string) => {
        setLongPasteText(null);
        try { textareaRef?.replaceText?.(text); } catch {}
        try { textareaRef?.setText?.(text); } catch {}
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
    // Ctrl+V → check clipboard for image. If found, fill the input with the
    // @'<path>' form so the user sees what's about to be sent and can add a
    // caption before hitting Enter. Matches drag-drop behavior — both routes
    // populate the input, neither auto-sends.
    //
    // If clipboard has no image, fall through to whatever the textarea does
    // with Ctrl+V by default (usually nothing on macOS — it's the X11 paste
    // shortcut which terminals on macOS don't intercept the way they do Cmd+V).
    if (evt.ctrl && (evt.name === "v" || evt.name === "V")) {
      const imagePath = tryExtractClipboardImageSync();
      if (imagePath) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        // Single-quote the path so the existing @path parser at layout.tsx
        // handles it via the sglQuoteMatch branch (handles spaces correctly).
        const newText = `@'${imagePath}' `;
        try { textareaRef?.replaceText?.(newText); } catch {
          try { textareaRef?.setText?.(newText); } catch {}
        }
        try { textareaRef.cursorOffset = newText.length; } catch {}
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
    // is just a valid file path that exists, replace it with the @'<path>'
    // syntax so the existing send flow handles it as media. Single-quote the
    // path so the parser handles spaces correctly (the unquoted form uses
    // \S+ which stops at the first space). The user can add a caption and
    // hit Enter (or just hit Enter to send without caption).
    const text = textareaRef?.plainText ?? "";
    const droppedPath = detectDroppedFilePath(text);
    if (droppedPath) {
      const newText = `@'${droppedPath}' `;
      // Avoid infinite loop: only replace if the current text isn't already
      // the @'path' form (which would re-trigger this on the next change event).
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
