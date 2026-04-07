#!/bin/bash
# Install WhatsAppTuiNotifier.app and set it up to start at login.
#
# Steps:
#   1. ./build.sh                                  → compile + assemble bundle
#   2. unload existing launchd job (if any)        → idempotent reinstall
#   3. install .app to ~/Applications/
#   4. write launchd plist to ~/Library/LaunchAgents/
#   5. launchctl load
#   6. open the app once → triggers macOS notification permission prompt
#   7. fire a test notification

set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "WhatsAppTuiNotifier is macOS-only" >&2
    exit 1
fi

APP_NAME="WhatsAppTuiNotifier"
BUNDLE_ID="com.elpabl0.whatsapp-tui-notifier"
INSTALL_DIR="${HOME}/Applications"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
PLIST_PATH="${HOME}/Library/LaunchAgents/${BUNDLE_ID}.plist"
WATCH_DIR="/tmp/wa-tui-notif"

echo "==> Building"
./build.sh

if launchctl list 2>/dev/null | grep -q "${BUNDLE_ID}"; then
    echo "==> Stopping existing daemon"
    launchctl unload "${PLIST_PATH}" 2>/dev/null || true
fi
pkill -f "${APP_NAME}" 2>/dev/null || true
sleep 0.5

echo "==> Installing to ${APP_PATH}"
mkdir -p "${INSTALL_DIR}"
rm -rf "${APP_PATH}"
cp -R "build/${APP_NAME}.app" "${APP_PATH}"

echo "==> Creating watch directory ${WATCH_DIR}"
mkdir -p "${WATCH_DIR}"

echo "==> Writing launchd plist"
mkdir -p "${HOME}/Library/LaunchAgents"
cat > "${PLIST_PATH}" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${BUNDLE_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>open</string>
        <string>-a</string>
        <string>${APP_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardErrorPath</key>
    <string>/tmp/whatsapp-tui-notifier.err.log</string>
    <key>StandardOutPath</key>
    <string>/tmp/whatsapp-tui-notifier.out.log</string>
</dict>
</plist>
PLIST

echo "==> Loading launchd job"
launchctl load "${PLIST_PATH}"

echo "==> Launching daemon (this triggers the macOS permission prompt on first install)"
open -a "${APP_PATH}"
sleep 2

echo "==> Firing test notification"
TEST_FILE="${WATCH_DIR}/$(date +%s)000-install-test.json"
cat > "${TEST_FILE}" << 'JSON'
{"title":"WhatsApp","body":"Notifier installed successfully","sound":"Glass"}
JSON

echo ""
echo "✓ WhatsAppTuiNotifier installed."
echo ""
echo "  App:        ${APP_PATH}"
echo "  Launchd:    ${PLIST_PATH}"
echo "  Watch dir:  ${WATCH_DIR}"
echo "  Logs:       /tmp/whatsapp-tui-notifier.{out,err}.log"
echo ""
echo "If you don't see a permission prompt or notifications:"
echo "  1. Open System Settings → Notifications"
echo "  2. Find 'WhatsApp' in the list (the bundle id is com.elpabl0.whatsapp-tui-notifier)"
echo "  3. Toggle 'Allow Notifications' on, set style to Banners or Alerts"
echo ""
echo "To uninstall: ./uninstall.sh"
