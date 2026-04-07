# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
