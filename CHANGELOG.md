# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[0.2.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.1.0
