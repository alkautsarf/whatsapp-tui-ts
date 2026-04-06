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

## Current Status (Phase 2 — TUI Shell)

- Full terminal UI with OpenTUI + SolidJS: split layout, vim keybindings, message bubbles
- Real-time messaging: send/receive with delivery receipts
- Chat list with j/k navigation, search (/) and command palette (Ctrl+P)
- NORMAL/INSERT/SEARCH vim modes with contextual key hints
- Phase 1 data layer: full history sync, SQLite storage, zero data loss
