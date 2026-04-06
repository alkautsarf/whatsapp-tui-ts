# whatsapp-tui-ts

WhatsApp TUI client with vim keybindings — TypeScript rewrite.

## Stack

- **Runtime**: Bun
- **WA Protocol**: [Baileys](https://github.com/WhiskeySockets/Baileys) 7.x
- **Storage**: bun:sqlite (WAL mode)
- **TUI**: OpenTUI + SolidJS (Phase 2)
- **Images**: [phosphor-cli](https://github.com/alkautsarf/phosphor) (Phase 4)

## Setup

```bash
bun install
bun run start
```

On first run, scan the QR code inside the TUI. Session persists across restarts.

For the debug REPL (Phase 1): `bun run start:repl`

## Current Status (v0.4.0)

- Full terminal UI with OpenTUI + SolidJS: split layout, vim keybindings, message bubbles
- Real-time messaging: send/receive with delivery receipts and read status
- Inline image/sticker rendering via Kitty graphics protocol (phosphor-cli)
- Media send: type `@path` to attach images, videos, audio, documents with caption
- Video/audio/document preview: Enter opens with system viewer (QuickTime, Preview, etc.)
- Ctrl+G editor mode: opens `$EDITOR` for composing long messages
- Chat list with j/k navigation, search (/), command palette (Ctrl+P)
- Paste handling: long pastes show truncated preview, full text preserved
- NORMAL/INSERT/SEARCH vim modes with contextual key hints
- Full history sync, SQLite storage, zero data loss
