# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.3] - 2026-04-11

### Fixed

- **Double image encoding on every chat switch**. Root cause: `onSelectChat` in `src/ui/app.tsx` called `encodeImagesForChat(chatMsgs)` directly AFTER `helpers.selectChat(jid)`, while the `createEffect` watching `store.selectedChatJid` + `store.messages[jid]` ALSO fired (from `selectChat`'s setStore) and called `encodeImagesForChat` with the same list. Because `encodingStarted.clear()` ran between the effect's claim and the direct call, both passes saw an empty claim set and both ran to completion — visible as doubled `"Encoded N images (instant)"` log lines, doubled `"Downloading N in background"` lines, and doubled per-message download-failure warnings. Every chat switch did 2x the encode work and 2x the media downloads. Fix: (1) move dedup inside `encodeImagesForChat` with a combined filter (image-type + `!encodingStarted.has`) + synchronous claim before the first `await` so concurrent callers bail at the filter, (2) move the three clear calls (`encodingStarted.clear` / `helpers.clearEncodedImages` / `clearAllImages`) to BEFORE `helpers.selectChat` so the effect sees a fresh set, (3) remove the trailing direct call in `onSelectChat`. The effect is now the single encode path. Verified end-to-end in a tmux dev instance: chris 2, testing, and a 29-image chat each log exactly once; rapid chat switching produces no duplicates.

## [0.5.2] - 2026-04-11

### Fixed

- **Phone push notifications suppressed while wa-tui is running**. Root cause: baileys was called without `markOnlineOnConnect` override, defaulting to `true`, so every reconnect Baileys broadcast `sendPresenceUpdate('available')` and WhatsApp's server stopped routing push to the phone whenever a linked device appeared online. Fix wires the existing terminal-focus tracker (`src/utils/terminal-focus.ts`, DEC 1004) to Baileys presence: `markOnlineOnConnect: false` in the socket config, a new `subscribeFocusChange(cb)` pub-sub in `terminal-focus.ts`, and a `publishPresence()` bridge in `runTui()` that fires `sendPresenceUpdate('available')` immediately on focus-in and `sendPresenceUpdate('unavailable')` after a 1500ms debounce on focus-out (so quick tmux pane-hops don't flicker contacts' "online" dot). `onConnected` re-applies the current focus state on every (re)connect. `quit()` became async and flushes `sendPresenceUpdate('unavailable')` with a 500ms `Promise.race` timeout before `sock.end` — sock.end closes the websocket synchronously without draining pending frames, so without the flush the server would hold us "online" for its ~60s idle timeout and phone pushes would stay suppressed for that window after clean quit. Net behavior now matches WhatsApp Desktop: phone silent while the pane is focused, phone takes over the instant focus leaves, both surfaces alert when backgrounded.

## [0.5.1] - 2026-04-09

### Fixed

- Drop messages with unidentifiable content type (`contentType === null`) in `convertMessage` — prevents ghost group rows from being created or bumped to the top of the chat list when baileys delivers undecryptable messages for groups the user has left

## [0.5.0] - 2026-04-08

### Added

- **Forward messages** with `f` in NORMAL mode on a selected message. Opens a target-chat picker overlay (search/Enter to pick). Three send paths in priority order: cached raw `WAMessage` from the LRU (cleanest, baileys' built-in `forward` field, no re-upload), media re-download via `media_key` + `direct_path` for older media that's been evicted from the 200-message cache (re-sent as fresh media, caption preserved), and finally a synthesized text-only `WAMessage` for older text. Toast clarifies which path was taken on failure.
- **Delete message** with `d` in NORMAL mode on a selected message. Confirmation modal offers "Delete for me" (local-only `markMessageDeleted` — sets text to `[deleted]`, clears media columns), "Delete for everyone" (only when `from_me=1` and within WhatsApp's 2-hour window — sends `sock.sendMessage(jid, { delete: key })` then marks locally), and Cancel.
- **Save media** with `s` in NORMAL mode on a selected media message. Confirmation modal asks "Save \<filename\> to ~/Downloads/wa-tui/?". Auto-downloads via `downloadAndCache` if `media_path` is null (image only had a thumbnail). `basename()` guard on the destination filename prevents path traversal from a malicious sender's `documentMessage.fileName`. Toast progresses: `Downloading media…` → `Saved to ~/Downloads/wa-tui/<name>`.
- **React to messages** with `e` in NORMAL mode on a selected message. Opens the existing emoji picker in "react" mode. On pick: `sock.sendMessage(jid, { react: { text, key } })` + `queries.setReaction(msgId, emoji)` to persist locally + chat refresh so the bubble shows the emoji immediately. WA doesn't echo our own reactions back via `messages.upsert`, so the local persist is necessary. Schema migrated to v3 with new `react_emoji TEXT` column on the `messages` table.
- **Contact / group info overlay** via `gi` chord in NORMAL mode. For DMs: display name + bare phone/id (no `@suffix`) + `sock.fetchStatus()` status text. For groups: name + bare id + `sock.groupMetadata()` description (capped to 6 wrapped lines with `… (see WhatsApp app for full description)` indicator) + member count + scrollable participant list with admin marker (★). Backfills the local `group_participants` table on each successful metadata fetch so the next open is instant.
- **Auto-fetch group participants on chat open**: `app.tsx onSelectChat` calls `sock.groupMetadata(jid)` when entering a group with empty `group_participants`. Pre-populates the table so the mention picker has data on first open without needing to open the info overlay first.
- **Mention picker for groups**: in groups, `@` opens a participant picker (DMs keep `@` as the file picker — context-aware). The picker shows `[@] Display Name  62812345678` in a dropdown above the input. Picking inserts `@<sanitized-name>` (e.g. `@chris_2` — spaces → `_`, non-word chars stripped) so the user sees a human-readable token instead of raw digits. Send-time conversion via `finalizeMentions(text)` walks the visible text, rewrites every `@<sanitized-name>` to `@<bare-id>` (WA's wire format), and returns the JID list for the `mentions: []` baileys field. Sorts tokens by length DESC so longer names match before prefixes; disambiguates same-name collisions by appending the bare id. Caption mentions in media sends also threaded through `sendAttachmentsWithCaption` → `sendMedia`.
- **`@/path` and `@~/path` in groups** falls through to the file picker. Groups can still use `@` to attach files even though `@` defaults to mentions there.
- **Mention rendering on display**: `messages.tsx` resolves `@<digits>` tokens via `queries.resolveContactName()` (tries `<digits>@s.whatsapp.net`, falls back to `<digits>@lid`) before passing to `MessageBubble` as a new `resolvedText` prop. The bubble uses `resolvedText` for both the main content and the image caption row. Chat list preview also runs the same resolver. Both layers cache resolved text per `(id, text)` / `(jid, text)` so the per-render hot path stays cheap.
- **Trailing path drag-drop detection**: `extractTrailingPath()` detects a file path drag-dropped at the END of an existing input (handles single-quoted, double-quoted, backslash-escaped, plain absolute, tilde-expanded). Replaces just the path portion with `[Image N]`, preserving any preceding text (mentions, partial caption). Critical for groups where the user has typed mentions first and then wants to drop in a file.
- **File picker accept produces `[Image N]` placeholder**: picking a file from the `@/path` completion now uses the attachment registry instead of inserting the raw `@<full-path>`. Same registry path as Ctrl+V and drag-drop. Cleaner visual + routes through the primary placeholder send pipeline, bypassing the legacy matcher entirely.
- **Restart command** in the `Ctrl+P` command palette. Releases the PID lock, spawns a detached child via `spawn(process.argv0, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref()`, then `process.exit(0)`. The detached child re-acquires the lock cleanly.
- **Auto-prune chat row on self-removal from group**: `group-participants.update` handler now detects when the removed participant matches `sock.user.id` (or its phone / LID base forms) and deletes the chat row + messages + group_participants. Stops stale ghost group rows from accumulating after leave / kick events.
- **Generic confirm modal** at `src/ui/overlays/confirm.tsx` — title, message, options[], dispatch via `intent` field on the overlay payload. Used by delete and save; reusable for future destructive actions.
- **Toast feedback** on yank ("Copied to clipboard" / "Nothing to copy"), reply set ("Replying: \<resolved preview\>"), reply cleared ("Reply cleared" — Esc from insert with reply set, before exiting insert mode).

### Fixed

- **Unread "always 2" double-count**. Root cause: baileys' `chats.update` event delivered `c.unreadCount` that already included the message about to arrive via `messages.upsert`, then `state.tsx onNewMessage` added another `+1` on top. Two paths racing, both adding 1, so every chat where both fired ended up at 2. Fixed in `handlers.ts chats.update`: force `row.unread = 0` before `bulkUpsertChats` so the SQL CASE preserves the local count. Special case kept: explicit `unreadCount === 0` from WA (= read on another device) still propagates as a `clearUnread` so cross-device read sync works. Verified empirically against elpabl0's DB histogram (`80@1, 24@2, 14@3, 9@4, ...`) which exactly matches the "two paths racing" pattern.
- **Search overlay cursor sync**: `selectChat()` in `state.tsx` now also sets `highlightedChatJid` so picking a chat from search (or any other jump path) moves the chat-list cursor to the picked row. Previously the cursor stayed wherever it was, so backing out of a chat landed on a different row than expected.
- **Group notification sender uses contact name + truncated**: `handlers.ts` notification gate now resolves `msg.key.participant` via `store.resolveContactName()` instead of using WhatsApp's `pushName` (which is the sender's profile name, not the user's address-book name). Sender name truncated to 20 chars in the notification body so the actual message text stays visible in macOS notifications.
- **Confirm modal payload null bug**: confirm.tsx and forward.tsx were calling `close()` BEFORE the user-provided `onPick` callback. `close()` nulls `store.overlay`, so the dispatcher (which reads `store.overlay.confirm` / `store.overlay.forwardSourceMsgId`) got a null payload and silently no-op'd. Fixed by capturing the picked value and calling the callback first, then closing. This unblocked delete, save, AND forward in one fix.
- **Forward false-success toast**: media path was firing the success toast synchronously after a fire-and-forget `sendMedia()`, hiding upload errors. Now `await`s.
- **`gi` chord ordering**: was firing `i` (insert mode) first because the chord check came after the generic `i` handler. Reordered.
- **Image caption mention rendering**: caption row in `message-bubble.tsx` was rendering `props.message.text` directly instead of the upstream-resolved version. Now uses `props.resolvedText ?? props.message.text` like the main content row.
- **`selectChat` losing loaded message history**: was unconditionally replacing `store.messages[jid]` with the latest 100 fetched from DB. Re-entering a chat after `gg`-loading older messages then made search say "found in history but not loaded yet" because the in-memory slice was back to 100. Now merges: if existing has more than 100, fetches the latest 100 and dedup-merges by id while preserving the older ones (sort by timestamp DESC).
- **`legacy @path` matcher tightened**: regex was `/@(\S+)/` which matched `@chris_2` (a mention token) before the actual file path in inputs like `@chris_2 @/Users/.../file.jpg`. Now requires `/` or `~/` prefix: `/@((?:\/|~\/)\S+)/`.
- **Group desc overflow**: capped to 6 wrapped lines with truncation indicator so long group rules blocks don't push past the modal border.
- **Cursor blinking inside confirm/info overlays**: hidden focus-capture input was visible. Moved into a `position="absolute" top={-100} left={-100}` box.
- **`presence.update` events**: already fixed in v0.4.12, no further change needed in v0.5.0.
- **Self-sent reactions don't show locally**: WA doesn't echo our own reactions back via `messages.upsert`. After sending, `setReaction(msgId, emoji)` persists locally and `selectChat(jid)` re-pulls so the bubble shows immediately.
- **Group info members 0**: was reading from local `group_participants` which could be empty for groups we never received `groups.upsert` for. Now fetches via `sock.groupMetadata(jid)` and uses the live participants list, falling back to local DB only when the live fetch is empty. Backfills the local table on each successful fetch.
- **Reply/save preview shows raw `@<digits>`**: now resolves via `resolveMentionDisplay` so the toast and confirm modal preview show `@chris 2` instead of `@107838240207070`.
- **`Ctrl+P` palette arrow scroll**: with the new entries the list overflowed the modal and arrow-down past the visible area didn't scroll. Now the scrollbox uses `scrollChildIntoView(\`palette-${idx}\`)` on each navigation step.
- **`Ctrl+P` palette typing / arrow nav not reaching the input**: opening the palette didn't switch mode to "search", so the global keyboard handler kept eating Down/Up (routing to messages scroll) and typed letters never reached the focused input. Now `Ctrl+P` sets `mode = "search"` like the other overlays so global keys pass through. Close path resets to "normal".
- **Restart command broke the terminal display**: `spawn-detached` doesn't give the new TUI a controlling PTY, so the child rendered to nowhere while the parent's terminal returned to the shell — leaving stale chrome on screen and no live wa-tui. Replaced with a shell-loop pattern: the in-app restart now exits with sentinel code 42, and `bin/wa` loops on that code to respawn cleanly with a real PTY. Direct `bun run src/index.tsx` invocations (no wrapper) just exit and require manual relaunch.

### Security

- **Path traversal in save-media destination filename**: `msg.file_name` comes straight from the sender's `documentMessage.fileName`. A malicious contact could send a file named `../../../Library/something.txt` and the save would write outside `~/Downloads/wa-tui/`. Wrapped destination name in `basename()` to strip path separators.

### Changed

- **Schema migration v2 → v3**: added `react_emoji TEXT` column on `messages` table (idempotent ALTER TABLE in `db.ts migrate()`).
- **`storeQueries` additions**: `deleteChat(jid)` (cascading delete in transaction), `markMessageDeleted(id)`, `setReaction(id, emoji)`. SELECT statements pull `react_emoji`.
- **`clearUnreadStmt`** now has `AND unread != 0` guard so re-applying the clear is a true no-op (no WAL churn on repeat syncs).
- **Help (`?`) overlay** updated with all new bindings (`d`, `s`, `e`, `f`, `gi`, plus context-aware `@` description).
- **`Ctrl+P` command palette** updated with new entries (Delete, Save, React, Forward, Show chat info, Restart wa-tui, Show help).
- **Pre-existing TypeScript errors fixed**: `runInChunks` undefined index access, `resolveContactName` return type, `<Show>` `img` Accessor type, and `qrcode-terminal` ambient module declaration. Project now type-checks clean (zero errors).
- **Code reuse**: `resolveMentionDisplay()` and `truncate()` extracted into `src/utils/text.ts` (deduped from `messages.tsx`, `chat-list.tsx`, `info.tsx`, `app.tsx`). Mention resolution is cached per `(id, text)` / `(jid, text)` to keep the per-render hot path cheap.

### Data cleanup (one-time, elpabl0's local DB)

- Deleted 5 ghost group rows + 10 stale messages (Buweel 🎱, BizPrivate #1, Libra Billiard & Cafe, Mi Casa Billiard & Cafe ×2). Backed up to `chats_backup_ghosts_apr8` + `messages_backup_ghosts_apr8` tables. Mi Casa Billiard Family kept (user confirmed membership).

## [0.4.13] - 2026-04-07

### Fixed

- **Notifications no longer silently suppressed for backgrounded wa-tui sessions.** Reported by elpabl0: he had wa-tui running in a detached tmux session with chris 2's chat selected as the active chat, was working in another tmux session entirely, and never received any notifications for incoming messages from chris 2. Root cause: `src/utils/terminal-focus.ts` defaulted `focused` to `true`, expecting the first `FOCUS_IN`/`FOCUS_OUT` event to correct it. But for a detached tmux session, tmux never fires focus events to a pane that isn't in an attached session — so focus stayed `true` forever and the notification gate's `userActivelyViewing` check (`viewingJid === chatJid && isTerminalFocused()`) always evaluated true, suppressing every notification for the selected chat. Fix: default `focused` to `false`. When the user attaches to the wa-tui session (or if wa-tui starts in a foreground terminal), tmux/the terminal fires `FOCUS_IN` immediately and flips to true within milliseconds. The only edge case is one spurious notification at startup if a message arrives before the first `FOCUS_IN` — acceptable trade-off vs missing every notification for backgrounded sessions.

## [0.4.12] - 2026-04-07

### Added

- **PDF rendering via phosphor in full-view mode.** Hitting Enter on a PDF document message in NORMAL mode now suspends the OpenTUI renderer and runs `phosphor <path>` inline (interactive page navigation built in — j/k/space). Same suspend/resume pattern as the editor mode. Other media types (video/audio/non-PDF documents) still open in the system viewer (QuickTime, Preview, etc.) via background `open` / `xdg-open`.
- **Help overlay (`?`) showing all keybindings** grouped by mode/zone (Global, Chat List, Messages, Input, @ Completion, Search). Scrollable with j/k or Ctrl+D/U. Distinct from `Ctrl+P` command palette: `?` is the read-only reference, `Ctrl+P` is the executable fuzzy palette. The user explicitly chose to keep both.
- **`[Image N]` placeholder UX for inline media attachments**, matching Claude Code's clipboard-image flow. Ctrl+V image paste and Finder drag-drop now insert a `[Image N]` / `[File N]` placeholder at the cursor position (not at the start of the input) and stash the real path in an attachment registry. Multiple attachments per message supported. Single attachment + text → sends as captioned media. Multiple attachments + text → sends each attachment in order, then a final text message with the joined caption.
- **Inline paste mid-message.** The placeholder gets inserted at the current cursor position so you can paste an image into the middle of a typed message: "look at this `[Image 1]` cool right?" — replaces the previous "@'<path>'-replaces-whole-input" behavior.
- **Emoji picker overlay (`Ctrl+E` from INSERT mode).** Curated 318-emoji catalog with fuzzy keyword search. Arrow keys navigate the grid, Enter inserts at cursor, Esc cancels. Picker switches to "search" mode while open so the global handler passes keys through to the picker's input. After pick, restores INSERT mode + input focus + textarea cursor focus so the user can keep typing immediately. Note: Ctrl+H/J/K/L navigation removed because terminals intercept Ctrl+H as backspace and Ctrl+J as newline before the keys reach the application.
- **Within-chat message search overlay (`/` when focus is on the messages zone).** Now context-aware: `/` from chat list focus opens the chat-list search (existing behavior), `/` from messages focus opens the new in-chat message search. Type to filter, Enter to jump to the matched message via `scrollChildIntoView`. If the matched message is older than the loaded slice, shows a toast pointing the user to scroll up first.
- **Single-instance lock at startup** via PID file at `~/.local/share/whatsapp-tui/wa.pid`. Detects existing wa-tui processes via `process.kill(pid, 0)` + `ps -p <pid> -o command=` cross-check (catches stale PID files). Refuses to start with a clear error if another instance is alive. Reported by elpabl0 after he hit a green/yellow connection-flicker from two instances fighting.
- **`searchMessages(chatJid, query, limit)`** prepared statement in `src/store/queries.ts` for the new in-chat search overlay. Case-insensitive substring on `text`, ordered by timestamp DESC, limited to 50 results.
- **`InputMethods.insertAtCursor(text)`** exposed for the emoji picker and other consumers that need to inject content at the cursor position without replacing the whole input.
- **`AppStore.helpScrollOffset`** + `setHelpScrollOffset` helper for the help overlay's manual scroll handling (j/k routed from `keys.ts` instead of using a `<scrollbox>`).
- **`detectDroppedFilePath()` helper** in `input.tsx` that recognizes terminal-typed file paths (backslash-escaped, single-quoted, double-quoted, plain absolute, tilde-expanded) and routes them through the new attachment registry.
- **`utils/clipboard-image.ts`** with synchronous osascript-based clipboard image extraction (`the clipboard as «class PNGf»`), saves to `/tmp/wa-tui-clipboard/`.
- **`utils/attachment-registry.ts`** as the source of truth mapping `[Image N]` / `[File N]` placeholder labels to real file paths + media kinds. Counters reset on send.
- **`utils/emoji-data.ts`** with the curated 318-entry emoji catalog and `filterEmojis()`.
- **`utils/instance-lock.ts`** with `acquireLock()` / `releaseLock()` / `InstanceLockError`.

### Fixed

- **Document messages with caption no longer render as text-only locally.** `msgContent` in `message-bubble.tsx` was returning the caption text alone if both text and media were present, hiding the document attachment indicator. The fix renders `[Document]\n<caption>` for documents/videos/audio with captions, keeping images on their existing inline-image-with-separate-caption-row path.
- **`presence.update` events keyed by LID now resolve to the canonical phone JID** before reaching the bridge. After v0.4.10's LID dedup work, all chats are stored under phone JIDs but baileys was still delivering presence events keyed by LID for some contacts. Without resolution, the typing/online indicator never appeared because the UI looks up presence by phone jid but the data was stored under the LID key. Same `resolveJid()` fix applied to `messages.upsert`, `chats.upsert`, and `chats.update`.
- **Help overlay scroll indicator no longer overlaps content.** The `visibleLines` math undercounted the modal chrome (border + padding + title + footer) by ~2 lines, causing the last visible binding row to render on top of the "↓ more below" indicator. Adjusted to `overlayHeight - 8` for safety.
- **Emoji picker scroll content no longer overlaps the footer row.** Same chrome-undercount bug as the help overlay. Modal height now uses `VISIBLE_ROWS + 8` so 6 emoji rows fit cleanly with a 1-row safety buffer above the footer.
- **Ctrl+V image paste no longer auto-sends without preview.** Now matches drag-drop behavior — both populate the input with `[Image N]` first so the user can verify (and add an optional caption) before hitting Enter. Also fixed the path-quoting issue where the unquoted `@/path` form broke on filenames with spaces.

### Known limitations / accepted trade-offs

- **Emoji picker shows ~10-20 placeholder circles** for emojis whose Unicode codepoints exist but Ghostty's emoji font has no glyph for. The codepoints are valid — they render correctly when sent (the recipient's WhatsApp uses its own font). Local picker just looks blank for those entries. Removable in a follow-up patch by stripping the missing glyphs.
- **Help overlay strips emojis from the underlying chat list** while open, due to an OpenTUI compositor quirk with wide chars under absolute-positioned overlays. Emojis come back on close. Tried inline replacement to dodge it; elpabl0 preferred the floating overlay style.
- **Message search jump only works for messages in the loaded slice.** If the matched message is older than the hydrated history, the user gets a toast pointing them to scroll up first to load older messages. Full-history jump would need a larger architectural change.

## [0.4.11] - 2026-04-07

### Added

- **Single-instance lock** via PID file at `~/.local/share/whatsapp-tui/wa.pid`. WhatsApp's protocol allows only one active linked-device connection per account, so running two `wa` instances simultaneously causes both to fight (the connection dot flickers between green and yellow). The new lock detects an existing wa-tui process via `process.kill(pid, 0)` + `ps -p <pid> -o command=` cross-check (catches stale PID files where the process died without releasing) and refuses to start with a clear error pointing at the existing PID and suggested resolution. Reported by elpabl0 after he hit the green/yellow flicker from two leftover instances during testing.
- **Clipboard image paste via Ctrl+V.** Pressing Ctrl+V in the input bar now extracts an image from the macOS clipboard via `osascript` (`the clipboard as «class PNGf»`), saves it to `/tmp/wa-tui-clipboard/`, and fills the input with `@'<path>' ` so the existing send flow handles it. User sees the path before sending, can add a caption, hits Enter to send. If clipboard has no image, Ctrl+V falls through to its default behavior (no-op on macOS, no key conflict).
- **Drag-and-drop image to send.** When you drag an image file from Finder (or the macOS screenshot popup) onto the Ghostty window with wa-tui in INSERT mode, the path that gets typed into the input is now auto-detected and replaced with `@'<path>' ` for the send flow. Handles backslash-escaped paths (Ghostty's default), single-quoted, double-quoted, and unquoted forms. Tilde-expansion supported. Detection only fires when the entire input is a valid file path that exists, so manual typing of paths in messages isn't accidentally rewritten.

### Notes

- Both Ctrl+V and drag-drop populate the input with `@'<path>' ` rather than auto-sending — the user sees what's about to be sent and can add an optional caption before hitting Enter. Matches the behavior of @path manual entry.
- Followup for v0.4.12 (already requested by elpabl0 during testing): replace the visible path with a `[Image N]` placeholder for cleaner UX matching Claude Code, support inline paste mid-message (not just at the start), and route PDF full-view through phosphor instead of the system viewer.

## [0.4.10] - 2026-04-07

### Fixed

- **LID chat-row duplication.** Reported by christopher (relayed via chilldawg): "messages don't appear post-history-sync." Root cause was duplicate chat list rows caused by WhatsApp's gradual LID privacy rollout — for contacts known by both phone JID and `<id>@lid`, baileys would push `chats.upsert` / `chats.update` events keyed by the LID, and wa-tui's handlers (unlike `messages.upsert`) didn't normalize the LID before insert. Result: a phantom LID-keyed chat row sitting next to the real phone-jid row in the chat list. christopher opened the LID twin → empty conversation → "messages dropped." Actually messages were arriving correctly under the canonical phone row he wasn't looking at.
- **Two-line code fix in `src/wa/handlers.ts`:** call `resolveJid()` on each chat id in `chats.upsert` and `chats.update` before insert, mirroring what `messages.upsert` already does. Stops new phantoms from being created. Existing `resolveLidToPhone` helper has both `chats.lid_jid` and `contacts.lid` fallbacks, so the routing works whether or not baileys included `lidJid`/`accountLid` in the chat metadata.
- **Smarter `listChats` dedup query in `src/store/queries.ts`:** the existing dedup filter only checked `chats.lid_jid` back-references, which meant LID twins leaked through whenever baileys hadn't populated `lidJid` on the phone row (christopher's case: 30% of his phone rows leaked their LID twin). The new filter also checks `contacts.lid` as a fallback, hiding existing leaked phantoms at query time. Read-only, self-healing — no migration needed, no data mutation, no DELETE.

### Notes

- **Diagnosis credit goes to chilldawg.** They ran the three-datapoint debug checklist on christopher's machine (tui.log onNewMessage events firing, app.db rows being inserted, WS connection ESTABLISHED) and pinpointed the LID dedup failure when my own initial theory of "baileys stuck post-sync" turned out to be wrong.
- **Validation done before shipping.** Ran SQL on my own DB to verify the original "delete empty LID phantoms" cleanup plan was wrong — most LID rows on my install (30 of 37) are legitimate LID-only contacts with real messages, not phantoms. The original plan would have wiped 337 real messages. The shipped fix has zero DELETE statements.
- **My install impact:** zero visible change. Already had 99.6% lid_jid populated, all 7 LID twins were already correctly hidden by the old filter.
- **christopher impact (post manual cleanup + this upgrade):** new LID twins stop accumulating; any future leakage caught by the smarter dedup filter even without backfill.

## [0.4.9] - 2026-04-07

### Fixed

- **Long messages no longer get visually truncated in the chat view.** Reported by chris (relayed via elpabl0): a 119-char message without explicit newlines was clipped at column ~59 ("blom tau nih, kyk nya sih display, klo outcoming message ke" cut off mid-word). Root cause was in `src/ui/components/message-bubble.tsx`: `contentLineCount` only counted explicit `\n` characters via `text.split("\n").length`, so any single-line message that wraps to multiple visual rows still got `height={1}`, clipping everything past the first wrapped line. The fix computes wrapped line count from `process.stdout.columns × 0.70 (messages area) × 0.65 (bubble maxWidth) - 4 (padding)`, with `Math.max(1, Math.ceil(line.length / wrapCols))` per `\n`-separated segment. Verified end-to-end against the actual long message in chris's chat.

## [0.4.8] - 2026-04-07

### Fixed

- **Media send no longer crashes the TUI on oversized files.** Previously, attaching a file larger than WhatsApp's media limits (e.g., a 3.4 GB screen recording) would either OOM Bun trying to allocate the buffer or escape an unhandled `fs.WriteStream` construct→destroy stack trace from baileys' upload pipeline into the renderer, corrupting the display so badly the user had to quit the app. `sendMedia` now stat-checks file size BEFORE allocating the buffer, rejects oversized files with a clean toast, and wraps the entire pipeline in try/catch so any error from `statSync`, `readFile`, or `sock.sendMessage` is caught and surfaced as a toast instead of escaping.
- **`MEDIA_SIZE_LIMITS_BYTES`** validated against WhatsApp's official limits (not assumed): images/videos/audio = 16 MB, stickers = 1 MB, documents = 2 GB on Web. Sources cited inline in `src/ui/layout.tsx`.

### Added

- **Toast UI in the status bar** for transient error/info messages. New `AppStore.toast` field, `helpers.showToast(message, level, durationMs?)`, and a status bar renderer that replaces the hints area with a colored toast (red for error, green for info) until it auto-clears. Used by the media send error handler — extensible for future error surfaces.
- **`formatBytes()` helper** for human-readable file sizes in toast messages and logs.

### Notes

- Followup for v0.4.9: auto-compress videos > 16 MB via `ffmpeg` (matching what WhatsApp Web/app do client-side). Out of scope for this release — would have delayed shipping the urgent error-handling fix.

## [0.4.7] - 2026-04-07

### Added

- **Native macOS notifications via WhatsAppTuiNotifier daemon** — opt-in Swift app installed via `notifier/install.sh`. Fires native `UNUserNotifications` with the WhatsApp icon, Glass sound, and persistent banner style on every message that passes the notification gate. Decoupled from wa-tui via `/tmp/wa-tui-notif/<ts>-<rand>.json` JSON files watched by FSEvents — bursts don't drop. See `notifier/README.md` and the [native notifications section](README.md#native-notifications-macos-only-optional) of the main README.
- **Notification gate** with 6 conditions in `messages.upsert`: not from me, message type is "notify" (real new message, not history sync), chat is not currently focused (terminal focus + selected chat both required), chat is not status@broadcast, chat is not muted on WhatsApp, per-chat 3s rate limit.
- **Terminal focus tracking** via xterm focus reporting (DEC mode 1004) in `src/utils/terminal-focus.ts`. wa-tui asks the terminal to send `ESC [ I` (focus in) and `ESC [ O` (focus out) on stdin. Tracked via a tiny atom and exposed to handlers, so notifications correctly fire when wa-tui has a chat selected but its tmux pane / terminal window is in the background. Verified working on Ghostty + tmux + `focus-events on`.
- **`getChat(jid)`** prepared statement in `src/store/queries.ts` so the notification trigger can read `muted_until` to respect WhatsApp mute settings.
- **Self-contained README rewrite** with installation, quick-start nav diagram, native notifications setup, data dir layout, Rust whatsapp-tui collision instructions, project layout, and acknowledgments.
- **`notifier/README.md`** documenting the daemon: install/uninstall flow, recommended notification settings, JSON payload schema, log paths, and architecture rationale.
- **`.gitignore`**: `*.tar.gz` and `notifier/build/` so release artifacts and Swift build output stay untracked.

### Notes

- Daemon is opt-in only — `brew install whatsapp-tui` and `npm install -g whatsapp-tui-ts` give you only the main `wa` CLI. Notifications are silent no-ops without the daemon (zero impact on Linux/Windows users or anyone who doesn't want a background daemon).
- Long-term followup tracked separately: `wa install-notifier` subcommand that wraps `notifier/install.sh` so users don't need to clone the repo.

## [0.4.6] - 2026-04-07

### Fixed

- Detect and bail cleanly when the data dir contains a database from the original Rust whatsapp-tui project. Both projects default to `~/.local/share/whatsapp-tui/` and the schemas are completely incompatible — christopher (chilldawg's collaborator) hit `SQLiteError: no such column: lid` on first run after `brew install` because his existing data dir was from the Rust version. The TS rewrite now refuses to start with a clear, actionable error message instructing the user to back up the old data and let the TS rewrite create a fresh database. Reported by christopher via chilldawg.

### Notes

- Long-term followup tracked separately: split data dirs so the TS rewrite uses `~/.local/share/whatsapp-tui-ts/` and never collides with the Rust version's path again.

## [0.4.5] - 2026-04-07

### Fixed

- Brew formula now installs cross-platform — was previously macOS-arm64-only and broke on linuxbrew with `formula requires at least a URL`. Reported by christopher via chilldawg.

### Changed

- Release tarball is now source-only (no bundled `node_modules`) — `bun install` runs at brew install time, so the correct per-arch native modules (OpenTUI Zig binaries) are pulled on each platform. Single tarball replaces the old per-arch matrix.
- `scripts/release.sh` no longer suffixes the tarball with `${OS}-${ARCH}` — it produces `whatsapp-tui-vX.Y.Z-source.tar.gz` only.

## [0.4.4] - 2026-04-07

### Fixed

- Reply-to-image (and other media replies) now sends a proper quote — handler passes the cached raw `WAMessage` protobuf to Baileys instead of fabricating a `conversation` stub that the WA server couldn't match
- Reply preview indicator now renders for media quotes — `> Photo`, `> Sticker`, `> Video`, etc., instead of nothing when the quoted message has no text
- `h` from input zone now goes back to chat list (vim "left"), instead of stopping at messages

### Changed

- Per-pane `allow-passthrough` now uses `all` instead of `on` so DCS sequences also work in invisible/zoomed panes (popups still don't work — they aren't panes — see CHANGELOG note below)

### Notes

- tmux popups (`display-popup`) cannot render Kitty graphics protocol regardless of `allow-passthrough` value, because popups are not panes in tmux's data model and have no pane id to attach passthrough to. Use `switch-client` to a real session for image rendering instead.

## [0.4.3] - 2026-04-07

### Added

- Socket liveness health check: forces reconnect after 90s of WS-frame silence to recover from zombie sockets caused by stream-replaced churn

### Fixed

- Unread badge never incrementing on incoming messages (only history sync ever set the count) — bridge now bumps store + DB on incoming, skipping own messages and the currently-viewed chat
- Unread badge ghosting back into the currently-viewed chat after WhatsApp pushes a stale `chats.update` — handlers now batch-call `sock.readMessages` for messages landing in the viewed chat, and the bridge defensively re-clears on view
- Last-message preview empty when latest message is a sticker/photo/video and stale when media arrives after a text — chat list now falls back to a media label and always overwrites text/type per message

### Changed

- Centralized WhatsApp message-type constants and label helper into `src/wa/message-types.ts` (used by chat list, message bubble, and handlers)

## [0.4.2] - 2026-04-06

### Added

- `--version` / `-v` flag for CLI version check

### Changed

- Auth, database, media, and logs now stored in `~/.local/share/whatsapp-tui/` instead of relative `./data/` and `./auth_state/`
- Session and data persist across brew upgrades and work from any directory

## [0.4.0] - 2026-04-06

### Added

- Inline `@` file picker: type `@` in insert mode to browse filesystem, Tab to select, supports quoted paths for spaces
- Ctrl+G editor mode: opens `$EDITOR` (vim) for composing long messages, content persists back to input
- Media send via `@path`: attach images, videos, audio, documents with optional caption
- Video/audio/document preview: Enter on media messages opens with system viewer (`open` on macOS, `xdg-open` on Linux)
- Long paste handling: pastes over 500 chars show truncated preview, full text sent on Enter
- Chat list renders immediately on startup from SQLite cache (no more "Connecting..." blank screen)
- `clearUnread` persists to database (unread count survives app restarts)

### Changed

- Image encoding pipeline: thumbnails render instantly, full-res downloads happen in background with 3x parallelism
- Failed media downloads cached to avoid retrying expired URLs (capped at 500)
- Connection resilience: 5s timeout on version fetch, re-fetch on 405 errors, never gives up reconnecting
- Yank (y) clipboard now wrapped in DCS passthrough for tmux compatibility
- Status bar hints updated with new keybindings (`@`, `Ctrl+G`, `a`)

### Fixed

- Paste doubling: removed manual `handlePaste` call that conflicted with OpenTUI's native paste handler
- Editor content not persisting: replaced non-existent `replaceContent()` with correct `replaceText()`/`setText()` API
- Video files no longer passed to image encoder (was causing `sips` failures on `.mp4` files)
- `fetchLatestBaileysVersion()` no longer blocks startup for 75+ seconds on slow networks

### Removed

- Separate file-picker overlay (replaced by inline `@` completion)
- "Connecting to WhatsApp..." blocking screen (Layout now renders for all connection states)

## [0.3.0] - 2026-04-06

### Added

- Inline image rendering via Kitty graphics protocol with phosphor-cli integration
- Full-resolution image download from WhatsApp servers using stored media keys
- Full-view image overlay: press Enter on image message, Esc to return
- Sticker inline rendering (WebP via phosphor/sharp)
- Media metadata persistence: media_key, direct_path, mimetype, dimensions, thumbnail stored in DB
- LID→phone JID resolution for outgoing messages (fixes messages going to wrong chat)
- `scrollChildIntoView` for reliable message cursor tracking across all message types
- Media download cache with `data/media/` directory and DB path tracking
- Hidden message type filter: protocol, reaction, poll, edit messages hidden from display

### Changed

- DB schema v2: 9 new columns on messages table for media metadata
- Message scroll uses OpenTUI's native `scrollChildIntoView` instead of estimated `scrollBy`
- Image transmit uses OpenTUI's `setFrameCallback` for zero-interleave DCS writes
- Navigation: `h` from input goes to messages (not chat list), `l` from input goes to messages
- Quit clears Kitty images and resets terminal fully

### Fixed

- Cursor indicator matching by message ID instead of array index (immune to hidden message filtering)
- `gg` then `k` no longer triggers repeated `loadMoreMessages` jumps
- Scroll-to-bottom on message send now actually scrolls the scrollbox

## [0.2.3] - 2026-04-06

### Changed

- Chat header shows contact online status (`● online`) instead of connection state
- Presence updates skip no-op store writes when value is unchanged
- Typing indicator interval only ticks when someone is actively typing

## [0.2.2] - 2026-04-06

### Added

- Read receipt colors: gray `·` pending, gray `✓` sent, lighter gray `✓✓` delivered, blue `✓✓` read
- Typing indicators: "typing..." shown in chat header when contact is composing (6s auto-expiry)
- Scroll-to-top pagination: `gg` and `k` at boundary load older messages from SQLite
- Mark-as-read: `sock.readMessages()` called on chat open to clear unread on sender's side
- Presence subscription per chat for typing notifications
- Dynamic connection status in chat header (connected/reconnecting/disconnected with color)
- Auto-highlight first chat on startup

### Changed

- Receipt timestamp and glyph rendered as separate row for per-status coloring
- Pagination guard: skips DB query for chats with no more messages to load
- Presence subscriptions cleared on reconnect to re-subscribe with new socket

## [0.2.1] - 2026-04-06

### Added

- Message cursor with `▸`/`◂` selection indicators and `isSelected` background highlight
- `gg`/`G` keybindings to jump to top/bottom in both chat list and messages
- Last message preview in chat list (replaces empty/generic "(group)" text)
- Chat list viewport scrolling with vim-like edge padding on j/k navigation
- Scroll-to-bottom on message send and reply

### Fixed

- Reply not sending as quote (quoted object was in content arg instead of options arg)
- Message bubbles collapsing with no spacing between them
- Long message bubbles overflowing background (explicit Yoga height from line count)
- Timestamp rendering outside bubble on short messages (inline for single-line, own line for multi-line)
- Chat list timestamps showing stale values (SQL now uses actual latest message timestamp)
- Cursor style: block instead of line, non-blinking across input, search, and command palette
- Reply state carrying over when switching chats
- Chat list not reordering in real-time (direct store update bypasses stale WAL reader)
- Tab cycling to input/messages zone when no chat is selected
- `G` (Shift+g) key conflict with `gg` sequence handler

### Changed

- Chat list selection indicator uses full-height background color instead of single-line text character
- Message scroll estimates line count from content to keep cursor in viewport
- Removed `viewportCulling` from messages scrollbox for correct `scrollHeight` calculation

## [0.2.0] - 2026-04-06

### Added

- Full TUI shell with OpenTUI + SolidJS replacing the REPL as default entry point
- Split layout: chat list (30%) with j/k navigation, message area with scrollable bubbles, input area
- Message bubbles with left/right alignment (others/own), sender grouping, date separators, read receipts
- Vim keybindings: NORMAL/INSERT/SEARCH modes with Tab/Esc focus cycling
- Real-time message display via reactive bridge (Baileys events → SolidJS store → UI)
- QR auth flow rendered inside the TUI (decoupled connection lifecycle)
- Search overlay (/) for fuzzy chat filtering and command palette (Ctrl+P)
- Status bar with mode pill, connection indicator, and context-sensitive key hints
- File-based debug logging (data/tui.log) when in TUI mode

### Changed

- Contact name resolution now prioritizes saved contact names over WhatsApp display names for LID JIDs
- REPL preserved as `--repl` flag fallback for debugging

### Fixed

- Group message sender names showing WhatsApp profile name instead of address book name
- Terminal state (cursor, alternate screen) properly restored on TUI exit
- Chat list selection tracking by JID instead of index (immune to list reordering)

## [0.1.0] - 2026-04-05

### Added

- Baileys 7.x WhatsApp connection with QR auth, session persistence, and auto-reconnect
- SQLite data layer (bun:sqlite) with WAL mode for concurrent read/write
- Full history sync pipeline: contacts, chats, and messages stored with zero data loss
- Contact resolution with LID→phone name fallback chain
- Group participant fetching via on-demand `groupMetadata()` with name resolution
- Message send/receive with delivery status tracking
- DB/auth state inconsistency detection on startup
- Verification REPL with commands: chats, msgs, contacts, groups, send, stats, sql
- Test harness (`test.ts`) for standalone Baileys protocol validation

[0.5.3]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.5.3
[0.5.2]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.5.2
[0.5.1]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.5.1
[0.5.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.5.0
[0.4.4]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.4.4
[0.4.3]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.4.3
[0.4.2]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.4.2
[0.4.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.4.0
[0.3.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.3.0
[0.2.3]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.2.3
[0.2.2]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.2.2
[0.2.1]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.2.1
[0.2.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.1.0
