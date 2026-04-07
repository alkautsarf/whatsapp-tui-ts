# whatsapp-tui

A WhatsApp client that lives in your terminal. Vim keybindings, native image rendering, real-time messaging, full chat history, and optional native macOS notifications via a tiny background daemon.

Built with Bun + Baileys + OpenTUI + SolidJS. Stores everything locally in SQLite — your messages never leave your machine except to talk to WhatsApp's servers.

```
brew install alkautsarf/tap/whatsapp-tui
wa
```

Scan the QR code on first launch and you're in.

---

## Why

Because the official WhatsApp app is heavy, the web client breaks every few weeks, and neither one fits a keyboard-driven workflow. wa-tui treats WhatsApp the way `mutt` treats email: a small, fast, vim-friendly TUI that pulls real protocol traffic over baileys, persists everything to local SQLite, and gets out of your way.

This is a TypeScript rewrite of the original [Rust whatsapp-tui](https://github.com/TopengDev/whatsapp-tui) by [chilldawg/christopher (TopengDev)](https://github.com/TopengDev). Same project name, same data dir convention, same vim spirit — different implementation language and stack.

## Features

**Messaging**
- Send + receive text, images, videos, audio, stickers, documents
- Reply to any message (text or media) with proper quoted previews
- Auto-mark-read for the chat you're viewing
- Delivery receipts and read status
- Unread badges that don't ghost back

**Media**
- Inline image and sticker rendering via [phosphor-cli](https://github.com/alkautsarf/phosphor) (Kitty graphics protocol — works in Ghostty, kitty, WezTerm, and any tmux pane with `allow-passthrough on`)
- `Enter` opens videos, audio, documents in your system viewer (QuickTime, Preview, etc.)
- `@path` inline file completion for sending — type `@~/Downloads/`, get a fuzzy picker

**Composing**
- `Ctrl+G` opens `$EDITOR` for composing long messages, multi-line text, or anything you'd rather not type into a tiny input box
- Long pastes show a truncated preview but preserve full text on send
- Reply/quote any message, including media

**Navigation**
- `j/k` chat list navigation, `J/K` message list scroll
- `/` search chats, `Ctrl+P` command palette
- `i/Esc` for INSERT/NORMAL modes
- `gg/G` jump to top/bottom

**Reliability**
- Full history sync from baileys, persisted to local SQLite (WAL mode)
- Socket liveness check forces reconnect if WhatsApp stops sending frames (zombie socket recovery)
- Background daemon can fire native notifications even when wa-tui is in another tmux session

**Native macOS notifications (optional)**
- Banner popups with the WhatsApp icon, Glass sound, and proper Notification Center grouping
- Per-chat rate limiting (3s)
- Respects WhatsApp mute settings
- Suppresses when you're actually viewing the chat (uses xterm focus reporting to know whether the wa-tui terminal is in front)
- See [Native notifications setup](#native-notifications-macos-only-optional) below

## Install

### Homebrew (macOS — recommended)

```bash
brew install alkautsarf/tap/whatsapp-tui
wa
```

### npm (cross-platform — requires bun)

```bash
bun install -g whatsapp-tui-ts
wa
```

### From source

```bash
git clone https://github.com/alkautsarf/whatsapp-tui-ts
cd whatsapp-tui-ts
bun install
bun run start
```

### First run

On first launch wa-tui shows a QR code in the terminal. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → scan it. Auth state is saved to `~/.local/share/whatsapp-tui/auth_state/` and reused on subsequent runs.

After scanning, history sync begins automatically. Depending on how much chat history you have, this can take anywhere from a few seconds to a few minutes. Press `q` (NORMAL mode) anytime to quit.

## Quick start

```
launch wa-tui
   │
   ▼
chat list (NORMAL mode)
   │
   ├─ j/k        navigate chats
   ├─ /          search chats
   ├─ Enter      open selected chat
   ├─ Ctrl+P     command palette
   └─ q          quit
                │
                ▼
chat view (NORMAL mode)
   │
   ├─ J/K        scroll messages
   ├─ i          enter INSERT mode (compose)
   ├─ r          reply to selected message
   ├─ Ctrl+G     open $EDITOR for long compose
   ├─ Esc        back to chat list
   └─ Enter      open media (image/video/audio)
                │
                ▼
INSERT mode (compose box)
   │
   ├─ type message
   ├─ @path      inline file picker
   ├─ Enter      send
   ├─ Esc        back to NORMAL
   └─ Ctrl+G     open external editor
```

## Native notifications (macOS only, optional)

By default wa-tui has no native notifications — the brew install only ships the main `wa` binary. To get OS-level banners with the WhatsApp icon, install the optional notifier daemon **once**:

```bash
git clone https://github.com/alkautsarf/whatsapp-tui-ts
cd whatsapp-tui-ts/notifier
./install.sh
```

The installer:

1. Builds a tiny Swift app (`WhatsAppTuiNotifier.app`, ~100 lines)
2. Extracts the WhatsApp icon from `/Applications/WhatsApp.app`
3. Installs to `~/Applications/`
4. Sets up a launchd plist so it starts at login
5. Triggers the macOS permission prompt — click **Allow**
6. Fires a test notification ("Notifier installed successfully")

That's it. From then on, every message wa-tui receives that passes the notification gate (not from you, not in the chat you're actively viewing, not muted, not status@broadcast, rate-limited at 3s/chat) fires a native notification with the WhatsApp icon and Glass sound.

The daemon survives wa-tui upgrades (independent app at `~/Applications/`). To uninstall:

```bash
cd notifier
./uninstall.sh
```

### Recommended macOS notification settings

After install, open **System Settings → Notifications → WhatsApp** and set:

| Setting | Value |
|---|---|
| Allow Notifications | ON |
| Banner Style | **Persistent** (not Temporary — Temporary auto-dismisses) |
| Notification Grouping | **Off** (so consecutive messages don't coalesce) |
| Sounds | ON |

### Why an opt-in daemon?

Three reasons:
1. **Brew best practices**: brew formulas should not write to `~/Library/LaunchAgents/` or `~/Applications/`. Auto-installing a background daemon without consent is invasive.
2. **Cross-platform**: Linux/Windows users get wa-tui via brew/npm with no notifications, no errors, no broken installs.
3. **Code signing**: bundling unsigned `.app` files via brew can trigger Gatekeeper warnings on stricter Macs. Manual install via local `swiftc` builds without quarantine and skips that whole headache.

A `wa install-notifier` subcommand that wraps this is on the followup list.

## Tip: run wa-tui in a background tmux session

If you use tmux, bind a key to switch to a persistent `wa-tui` session so it keeps running and receiving messages without sitting in your main session:

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
  tmux has-session -t "$SESSION_NAME" 2>/dev/null \
    || tmux new-session -d -s "$SESSION_NAME" "wa"
  tmux switch-client -t "$SESSION_NAME"
fi
```

`prefix a` now toggles between your current session and a persistent `wa-tui` session that survives across tmux sessions.

> **Note**: tmux `display-popup` cannot render Kitty graphics — popups are not panes and have no `allow-passthrough` scope. Use `switch-client` to a real session instead, like the script above does.

## Data dir

Everything wa-tui stores lives at `~/.local/share/whatsapp-tui/`:

```
~/.local/share/whatsapp-tui/
├── auth_state/           # baileys credentials (do not delete unless re-pairing)
├── app.db                # SQLite — chats, contacts, messages, groups
├── app.db-wal            # SQLite WAL
├── app.db-shm            # SQLite shared memory
├── media/                # downloaded images/videos/audio/documents
└── tui.log               # wa-tui's log file
```

### Existing Rust whatsapp-tui users

If you previously ran the [original Rust whatsapp-tui](https://github.com/TopengDev/whatsapp-tui), it uses the same data dir. The schemas are completely incompatible — when you `brew install` this TS rewrite, it'll detect the foreign schema and refuse to start with instructions:

```bash
mv ~/.local/share/whatsapp-tui ~/.local/share/whatsapp-tui.rust-backup
wa
```

Your Rust data is preserved in the `.rust-backup` directory and you can keep using the Rust version with `--data-dir` if you want both.

## Development

```bash
git clone https://github.com/alkautsarf/whatsapp-tui-ts
cd whatsapp-tui-ts
bun install
bun run start              # run from source
bun run start:repl         # baileys REPL for debugging WhatsApp protocol directly
```

### Project layout

```
src/
├── index.tsx              # entry point — boots renderer, baileys, store, focus tracking
├── wa/
│   ├── client.ts          # baileys connection, auth state, liveness check
│   ├── handlers.ts        # event handlers (messages, chats, contacts, presence, groups)
│   ├── media.ts           # media download + raw message cache
│   └── message-types.ts   # MEDIA_TYPES, SKIP_MESSAGE_TYPES, mediaLabel()
├── store/
│   ├── db.ts              # SQLite init, schema, foreign-DB detection
│   └── queries.ts         # all prepared statements + StoreQueries interface
├── ui/
│   ├── app.tsx            # root TUI component
│   ├── state.tsx          # SolidJS store + ReactiveBridge
│   ├── keys.ts            # vim key dispatch
│   ├── image.ts           # phosphor-cli inline image rendering
│   ├── layout.tsx         # split layout
│   └── components/        # chat-list, messages, input, header, etc.
└── utils/
    ├── notify.ts          # writes /tmp/wa-tui-notif/<ts>-<rand>.json
    ├── terminal-focus.ts  # xterm focus reporting (CSI 1004)
    ├── log.ts, paths.ts
    └── ...

notifier/
├── Sources/main.swift     # WhatsAppTuiNotifier.app (~100 LOC Swift)
├── Resources/Info.plist
├── build.sh               # swiftc compile + assemble bundle
├── install.sh             # build + install + launchd + permission prompt
└── uninstall.sh
```

### Tests + checks

```bash
bunx tsc --noEmit          # type check
bun run test.ts            # baileys validation harness
```

### Releasing

The project uses a single source-only tarball — no per-arch matrix. `bun install` runs at brew install time so the correct OpenTUI native modules get pulled per platform automatically.

```bash
./scripts/release.sh       # builds whatsapp-tui-vX.Y.Z-source.tar.gz
```

## Acknowledgments

- **chilldawg / christopher (TopengDev)** — the original Rust [whatsapp-tui](https://github.com/TopengDev/whatsapp-tui) and the spirit behind the project. This TS rewrite started as an experiment and grew into a parallel implementation
- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — pure-TypeScript WhatsApp Web protocol library, the reason this works at all
- **[OpenTUI](https://github.com/sst/opentui) + [SolidJS](https://www.solidjs.com/)** — the rendering stack
- **[phosphor-cli](https://github.com/alkautsarf/phosphor)** — terminal image rendering for Kitty graphics protocol

## License

MIT
