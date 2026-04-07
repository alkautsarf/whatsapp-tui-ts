# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
