# whatsapp-tui-ts

WhatsApp TUI client with vim keybindings — TypeScript rewrite.

## Stack

- **Runtime**: Bun
- **WA Protocol**: [Baileys](https://github.com/WhiskeySockets/Baileys) 7.x
- **Storage**: bun:sqlite (WAL mode)
- **TUI**: OpenTUI + SolidJS (Phase 2)
- **Images**: [phosphor-cli](https://github.com/alkautsarf/phosphor) (Phase 4)

## Install

```bash
# Homebrew (macOS)
brew install alkautsarf/tap/whatsapp-tui

# npm (requires bun)
bun install -g whatsapp-tui-ts

# From source
bun install && bun run start
```

Run `wa` or `watui` to start. On first run, scan the QR code inside the TUI.

Data stored at `~/.local/share/whatsapp-tui/` (auth, database, media, logs).

## Current Status (v0.4.4)

- Full terminal UI with OpenTUI + SolidJS: split layout, vim keybindings, message bubbles
- Real-time messaging: send/receive with delivery receipts, unread badges, and read status
- Inline image/sticker rendering via Kitty graphics protocol (phosphor-cli)
- Media send: type `@path` to attach images, videos, audio, documents with caption
- Reply to any message type — text, image, video, sticker, document — with proper quoted preview
- Video/audio/document preview: Enter opens with system viewer (QuickTime, Preview, etc.)
- Ctrl+G editor mode: opens `$EDITOR` for composing long messages
- Chat list with j/k navigation, search (/), command palette (Ctrl+P)
- Auto-mark-read: messages arriving in the chat you're viewing are read instantly
- Socket liveness check: forces reconnect if WhatsApp stops sending frames
- Paste handling: long pastes show truncated preview, full text preserved
- NORMAL/INSERT/SEARCH vim modes with contextual key hints
- Full history sync, SQLite storage, zero data loss

## Tip: Run wa-tui in a background tmux session

If you use tmux, bind a key to switch to a persistent `wa-tui` session so it
keeps running and receiving messages without sitting in your main session:

```tmux
# ~/.tmux.conf.local
bind a run-shell '~/.tmux/scripts/wa-toggle.sh'
```

```bash
# ~/.tmux/scripts/wa-toggle.sh
#!/bin/bash
SESSION_NAME=wa-tui
if [ "$(tmux display-message -p '#{session_name}')" = "$SESSION_NAME" ]; then
  tmux switch-client -l
else
  tmux has-session -t "$SESSION_NAME" 2>/dev/null || tmux new-session -d -s "$SESSION_NAME" "wa"
  tmux switch-client -t "$SESSION_NAME"
fi
```

Note: tmux `display-popup` cannot render Kitty graphics (popups are not panes
and have no passthrough), so use `switch-client` to a real session instead.
