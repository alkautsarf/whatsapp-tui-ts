# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[0.1.0]: https://github.com/alkautsarf/whatsapp-tui-ts/releases/tag/v0.1.0
