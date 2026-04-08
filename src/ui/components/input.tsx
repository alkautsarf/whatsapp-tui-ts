import { Show, For, createSignal, createEffect, createMemo, onMount } from "solid-js";
import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { usePaste } from "@opentui/solid";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { tryExtractClipboardImageSync } from "../../utils/clipboard-image.ts";
import { addAttachment, type AttachmentKind } from "../../utils/attachment-registry.ts";
import { addMention } from "../../utils/mention-registry.ts";
import type { StoreQueries } from "../../store/queries.ts";
import type { InputMethods } from "../types.ts";

interface MentionEntry {
  kind: "mention";
  jid: string;
  displayName: string;
}

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

/**
 * Detect a file path drag-dropped at the END of an input that already
 * contains other text (e.g. mentions or a partial message). Used in
 * groups where the @ key is reserved for the mention picker, so the only
 * way to attach a file mid-message is to drop it from Finder.
 *
 * Returns the resolved path AND the start index in the original text so
 * the caller can splice in the placeholder. Tries (in order):
 *   - Trailing single-quoted: ... '/path/to/file.jpg'
 *   - Trailing double-quoted: ... "/path/to/file.jpg"
 *   - Trailing backslash-escaped or unquoted: ... /path/to/My\ File.jpg
 */
function extractTrailingPath(text: string): { path: string; start: number } | null {
  // Helper to validate a candidate
  const validate = (candidate: string): string | null => {
    const expanded = candidate.startsWith("~")
      ? (process.env.HOME || "") + candidate.slice(1)
      : candidate;
    try {
      if (!existsSync(expanded)) return null;
      if (!statSync(expanded).isFile()) return null;
    } catch {
      return null;
    }
    return expanded;
  };

  // Single-quoted trailing path
  const sgl = text.match(/'([^']+)'\s*$/);
  if (sgl) {
    const expanded = validate(sgl[1]!);
    if (expanded) {
      const start = text.lastIndexOf(sgl[0]);
      return { path: expanded, start };
    }
  }

  // Double-quoted trailing path
  const dbl = text.match(/"([^"]+)"\s*$/);
  if (dbl) {
    const expanded = validate(dbl[1]!);
    if (expanded) {
      const start = text.lastIndexOf(dbl[0]);
      return { path: expanded, start };
    }
  }

  // Unquoted trailing path: look for the LAST `/` or `~` and try the
  // longest substring from there to the end. Handles backslash-escaped
  // spaces — match runs of (escaped char | non-whitespace).
  const plain = text.match(/(?:^|\s)((?:\/|~)(?:\\.|[^\s'"])+)\s*$/);
  if (plain) {
    const raw = plain[1]!;
    const unescaped = raw.replace(/\\(.)/g, "$1");
    const expanded = validate(unescaped);
    if (expanded) {
      const start = text.lastIndexOf(raw);
      return { path: expanded, start };
    }
  }

  return null;
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

  // Whether the current chat is a group — drives whether @ opens a mention
  // picker (group participants) or a file picker (DMs).
  const isCurrentChatGroup = () =>
    !!store.selectedChatJid && store.selectedChatJid.endsWith("@g.us");

  // Tells the @ completion router whether the user is typing a file path.
  // In groups `@` defaults to mentions, but `@/` or `@~/` is the user
  // explicitly asking for the file picker (no other way to attach in groups
  // with the @ shortcut).
  const isFilePathQuery = (q: string) =>
    q.startsWith("/") || q.startsWith("~");

  const mentionItems = createMemo<MentionEntry[]>(() => {
    if (!completionActive()) return [];
    if (!isCurrentChatGroup()) return [];
    // `@/` and `@~/` in a group is the user asking for the file picker —
    // mention list should be empty so the file dropdown gets shown instead.
    if (isFilePathQuery(completionQuery())) return [];
    const jid = store.selectedChatJid;
    if (!jid) return [];
    const participants = props.queries.getGroupParticipants(jid);
    const q = completionQuery().toLowerCase();
    return participants
      .map((p) => ({
        kind: "mention" as const,
        jid: p.user_jid,
        displayName: props.queries.resolveContactName(p.user_jid),
      }))
      .filter((m) => {
        if (!q) return true;
        return (
          m.displayName.toLowerCase().includes(q) ||
          m.jid.toLowerCase().includes(q)
        );
      })
      .slice(0, MAX_SUGGESTIONS);
  });

  const completionItems = createMemo(() => {
    if (!completionActive()) return [];
    // In group chats, @ opens the mention picker. Exception: if the query
    // looks like a file path (starts with / or ~), fall through to the
    // file picker so groups can still use @ to attach files.
    if (isCurrentChatGroup() && !isFilePathQuery(completionQuery())) {
      return [];
    }
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

  function acceptCompletion(entry?: FileEntry | MentionEntry) {
    // Group chat path — pick a mention IF the query isn't a file path.
    // (`@/...` and `@~/...` in groups falls through to the file picker.)
    const groupMode = isCurrentChatGroup() && !isFilePathQuery(completionQuery());
    if (groupMode) {
      const mentions = mentionItems();
      const m = (entry as MentionEntry | undefined) ??
        mentions[completionIdx()];
      if (!m || !textareaRef) return;
      const text: string = textareaRef.plainText ?? "";
      const cursor: number = textareaRef.cursorOffset ?? text.length;
      const atPos = completionAtPos();
      const after = text.slice(cursor);
      // addMention returns the visible "@<sanitized-name>" token (e.g.
      // "@chris_2") and registers the full JID. The wire-format conversion
      // happens at send time via finalizeMentions in layout.tsx.
      const token = addMention(m.jid, m.displayName);
      const replacement = token + " ";
      const newText = text.slice(0, atPos) + replacement + after;
      const newCursorPos = atPos + replacement.length;
      try { textareaRef.replaceText(newText); } catch {
        try { textareaRef.setText(newText); } catch {}
      }
      try { textareaRef.cursorOffset = newCursorPos; } catch {}
      setCompletionActive(false);
      return;
    }

    // DM (or group + path query) file picker path
    const item = (entry as FileEntry | undefined) ?? completionItems()[completionIdx()];
    if (!item || !textareaRef) return;

    const text: string = textareaRef.plainText ?? "";
    const cursor: number = textareaRef.cursorOffset ?? text.length;
    const atPos = completionAtPos();
    const after = text.slice(cursor);

    if (item.isDir) {
      // Directory: keep `@` and continue browsing — same as before.
      const hasSpaces = item.path.includes(" ") || item.name.includes(" ");
      const replacement = hasSpaces ? `"${item.path}/` : item.path + "/";
      const newText = text.slice(0, atPos) + "@" + replacement + after;
      const newCursorPos = atPos + 1 + replacement.length;
      try { textareaRef.replaceText(newText); } catch {
        try { textareaRef.setText(newText); } catch {}
      }
      try { textareaRef.cursorOffset = newCursorPos; } catch {}
      setTimeout(() => checkForCompletion(), 10);
      return;
    }

    // File: register in the attachment registry and replace the `@<query>`
    // chunk with a `[Image N]` / `[File N]` placeholder. Matches the
    // drag-drop and Ctrl+V flows so the input stays clean and the send
    // pipeline goes through path 1 (placeholder parsing) instead of the
    // legacy @path branch.
    const ext = item.path.split(".").pop() ?? "";
    const kind = kindFromExt(ext);
    const label = addAttachment(item.path, kind);
    // Replace from `@` (atPos) up to the cursor with the placeholder + space.
    const replacement = `${label} `;
    const newText = text.slice(0, atPos) + replacement + after;
    const newCursorPos = atPos + replacement.length;
    try { textareaRef.replaceText(newText); } catch {
      try { textareaRef.setText(newText); } catch {}
    }
    try { textareaRef.cursorOffset = newCursorPos; } catch {}
    setCompletionActive(false);
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

    // @ completion navigation. In groups, source is mentions UNLESS the
    // query is a file path (then it's files); in DMs it's always files.
    const inGroupMention = isCurrentChatGroup() && !isFilePathQuery(completionQuery());
    const activeCount = inGroupMention
      ? mentionItems().length
      : completionItems().length;
    if (completionActive() && activeCount > 0) {
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
        const newIdx = Math.min(completionIdx() + 1, activeCount - 1);
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

    // Drag-drop file detection. Two passes — whole-input drop (clean
    // empty-input drop) and trailing-path drop (input already has text,
    // typically mentions in front). Both register the file and substitute
    // a `[Image N]` / `[File N]` placeholder; the trailing case replaces
    // only the path portion so the preceding text survives.
    const text = textareaRef?.plainText ?? "";

    const droppedPath = detectDroppedFilePath(text);
    if (droppedPath) {
      const ext = droppedPath.split(".").pop() ?? "";
      const kind = kindFromExt(ext);
      const label = addAttachment(droppedPath, kind);
      const newText = `${label} `;
      if (text.trim() !== newText.trim()) {
        try { textareaRef?.replaceText?.(newText); } catch {
          try { textareaRef?.setText?.(newText); } catch {}
        }
        try { textareaRef.cursorOffset = newText.length; } catch {}
      }
      return;
    }

    const trailing = extractTrailingPath(text);
    if (trailing) {
      const ext = trailing.path.split(".").pop() ?? "";
      const kind = kindFromExt(ext);
      const label = addAttachment(trailing.path, kind);
      // Splice in the placeholder where the path started, dropping the
      // path itself. Trim any trailing space the prefix might have so we
      // don't end up with double spaces.
      const before = text.slice(0, trailing.start).replace(/\s*$/, "");
      const newText = (before ? before + " " : "") + label + " ";
      if (text !== newText) {
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
      {/* @ completion dropdown — rendered ABOVE the input box. Group chats
          show participant mentions, DMs show file picker entries. */}
      <Show when={completionActive() && isCurrentChatGroup() && !isFilePathQuery(completionQuery()) && mentionItems().length > 0}>
        <box
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={theme.borderFocused}
          backgroundColor={theme.bgOverlay}
          height={Math.min(mentionItems().length + 2, VISIBLE_SUGGESTIONS + 2)}
          paddingX={1}
        >
          <scrollbox
            ref={(el: any) => (completionScrollRef = el)}
            flexGrow={1}
          >
          <For each={mentionItems()}>
            {(m, idx) => {
              const isSel = () => idx() === completionIdx();
              const bare = () => m.jid.split("@")[0] ?? m.jid;
              return (
                <box
                  id={`completion-${idx()}`}
                  flexDirection="row"
                  paddingX={1}
                  backgroundColor={isSel() ? theme.bgSelected : undefined}
                >
                  <text fg={theme.info}>{"[@] "}</text>
                  <text fg={isSel() ? theme.textStrong : theme.text}>
                    {m.displayName}
                  </text>
                  <text fg={theme.textMuted}>{"  " + bare()}</text>
                </box>
              );
            }}
          </For>
          </scrollbox>
        </box>
      </Show>
      <Show when={completionActive() && (!isCurrentChatGroup() || isFilePathQuery(completionQuery())) && completionItems().length > 0}>
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
