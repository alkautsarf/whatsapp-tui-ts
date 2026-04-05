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

On first run, scan the QR code with WhatsApp (Linked Devices). Session persists across restarts.

## Current Status (Phase 1 — Data Layer)

- Full history sync: contacts, chats, messages stored in SQLite
- Zero data loss during sync
- REPL for verification: `chats`, `msgs <jid>`, `contacts`, `groups`, `send`, `stats`
