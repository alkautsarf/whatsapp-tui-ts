# WhatsAppTuiNotifier

A tiny background macOS daemon that fires native `UNUserNotifications` on behalf of [whatsapp-tui](../README.md). Lives in `~/Applications/`, runs as `LSUIElement` (no dock icon), starts at login via launchd.

## What it does

```
wa-tui (in any tmux session, foreground or background)
  │
  │ on incoming message that passes the notification gate
  ▼
src/utils/notify.ts writes JSON to /tmp/wa-tui-notif/<ts>-<rand>.json
  │
  ▼
WhatsAppTuiNotifier (this app — installed once via install.sh)
  │
  │ FSEvents fires → reads JSON → fires UNNotification
  ▼
macOS Notification Center
  │
  ▼
Banner with WhatsApp icon, Glass sound, Persistent style
```

The daemon and wa-tui are completely decoupled. They communicate via a directory of unique JSON files (`/tmp/wa-tui-notif/`). FSEvents handles change detection. Bursts of messages don't drop because each notification is its own file with a unique name (`${timestamp}-${random}.json`).

## Install

Requires macOS 14+ and Xcode Command Line Tools (`xcode-select --install` if you don't have them).

```bash
cd notifier
./install.sh
```

What `install.sh` does:

1. **Builds** the Swift app via `swiftc` (zero dependencies, single file, ~100 lines)
2. **Extracts** the WhatsApp icon from `/Applications/WhatsApp.app/Contents/Resources/AppIcon.icns`
3. **Assembles** `WhatsAppTuiNotifier.app` bundle with the bundle id `com.elpabl0.whatsapp-tui-notifier` and display name "WhatsApp"
4. **Ad-hoc code-signs** the bundle (`codesign --sign -`)
5. **Copies** to `~/Applications/`
6. **Writes** a launchd plist to `~/Library/LaunchAgents/com.elpabl0.whatsapp-tui-notifier.plist`
7. **Loads** the launchd job (autostart at login)
8. **Opens** the app once → triggers macOS notification permission prompt → click **Allow**
9. **Fires** a test notification ("Notifier installed successfully")

If the macOS prompt doesn't appear or notifications don't fire, open System Settings → Notifications → "WhatsApp" and enable manually.

### Recommended notification settings

In System Settings → Notifications → WhatsApp:

| Setting | Value |
|---|---|
| Allow Notifications | ON |
| Banner Style | **Persistent** (not Temporary) |
| Notification Grouping | **Off** |
| Sounds | ON |

Persistent + Grouping=Off means each message banners individually instead of macOS coalescing them silently into Notification Center.

## Uninstall

```bash
cd notifier
./uninstall.sh
```

This stops the daemon, removes `~/Applications/WhatsAppTuiNotifier.app`, removes the launchd plist, and removes `/tmp/wa-tui-notif/`. The "WhatsApp" entry in System Settings → Notifications stays around — macOS keeps those indefinitely. Remove it manually if you want a clean state.

## Testing manually

You can fire a notification without going through wa-tui by writing a JSON file directly:

```bash
echo '{"title":"Test","body":"hello world","sound":"Glass"}' \
  > /tmp/wa-tui-notif/$(date +%s)000-test.json
```

The daemon picks it up via FSEvents within ~100ms and fires the notification. Files are deleted after processing.

JSON schema:

```typescript
{
  title:    string,    // banner title (chat name)
  body:     string,    // banner body (message text, or "sender: text" for groups)
  subtitle?: string,   // optional banner subtitle
  sound?:   string,    // "Glass" | "Ping" | "default" | "none" | any /System/Library/Sounds/*.aiff name
  chatJid?: string,    // used as UNNotificationRequest identifier (so subsequent notifications from the same chat replace each other)
  messageId?: string   // for future use
}
```

## Logs

- stderr → `/tmp/whatsapp-tui-notifier.err.log`
- stdout → `/tmp/whatsapp-tui-notifier.out.log`

The daemon also logs to the macOS unified log under the process name `WhatsAppTuiNotifier`. Useful query:

```bash
log show --last 5m --predicate 'process == "WhatsAppTuiNotifier"' | tail -30
```

You'll see lines like:

```
WhatsAppTuiNotifier: [com.elpabl0.whatsapp-tui-notifier]
  Adding notification request F2BF-87F9 to destinations: Default
  Added notification request: [ hasError: 0 hasCompletionHandler: 1 ]
```

## File layout

```
notifier/
├── README.md             # this file
├── Sources/
│   └── main.swift        # ~100 LOC: NSApplicationDelegate + FSEvents + UNUserNotificationCenter
├── Resources/
│   └── Info.plist        # bundle id, LSUIElement, icon name
├── build.sh              # swiftc compile + assemble .app bundle
├── install.sh            # build + install to ~/Applications + launchd + permission prompt
└── uninstall.sh          # stop + remove all installed files
```

After running `build.sh`:

```
notifier/build/WhatsAppTuiNotifier.app/
├── Contents/
│   ├── Info.plist
│   ├── MacOS/
│   │   └── WhatsAppTuiNotifier   # compiled Swift binary
│   ├── Resources/
│   │   └── AppIcon.icns           # extracted from /Applications/WhatsApp.app
│   └── _CodeSignature/
```

## Architecture choices

**Why a separate `.app` instead of OSC 9 / terminal-notifier?**
- `osascript display notification` can't change the icon — you always get Script Editor's icon. Unfixable.
- `terminal-notifier -sender com.mitchellh.ghostty` needs Ghostty registered with NotificationCenter, which on this Mac it wasn't (silent failure).
- Ghostty's OSC 9 (`ESC ] 9 ; <title> ESC \\`) is suppressed by macOS during screen recording / certain Focus modes.
- A self-contained `.app` bundle owns its own bundle id, registers with `UNUserNotificationCenter` cleanly, and works regardless of which terminal wa-tui is running in.

**Why a directory of JSON files instead of a single file?**
- FSEvents coalesces rapid changes to the same file. Single-file approaches drop notifications during message bursts.
- Each notification gets a unique filename (`${timestamp}-${random}.json`) → daemon processes them in chronological order → zero loss even under burst.

**Why `interruptionLevel = .timeSensitive`?**
- Default banner style is `.active`, which can be silenced by Focus modes that allow time-sensitive notifications. `.timeSensitive` is the highest interruption level that doesn't require special entitlements on macOS — it breaks through most Focus modes (Personal, Work) and signals to macOS that the banner should show even if other notifications from the same app would be coalesced.

**Why ad-hoc code signing (`codesign --sign -`)?**
- Locally-built unsigned binaries usually work, but Apple Silicon's `requestAuthorization()` flow is more reliable when the bundle has *some* signature. Ad-hoc sign costs nothing and doesn't require a Developer ID.

**Why isolated bundle id (`com.elpabl0.whatsapp-tui-notifier`)?**
- Reusing an existing app's identity (e.g., Ghostty) would mix WhatsApp notifications into Ghostty's notification category, which is wrong. A dedicated bundle id gives the daemon its own entry in System Settings → Notifications and its own grouping behavior.

## License

MIT — see [../LICENSE](../LICENSE)
