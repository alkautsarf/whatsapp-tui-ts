#!/bin/bash
# Uninstall WhatsAppTuiNotifier — stop the daemon, remove the .app and
# launchd plist. Does NOT remove the System Settings → Notifications entry
# (macOS keeps those around indefinitely; remove manually if desired).

set -euo pipefail

APP_NAME="WhatsAppTuiNotifier"
BUNDLE_ID="com.elpabl0.whatsapp-tui-notifier"
APP_PATH="${HOME}/Applications/${APP_NAME}.app"
PLIST_PATH="${HOME}/Library/LaunchAgents/${BUNDLE_ID}.plist"
WATCH_DIR="/tmp/wa-tui-notif"

echo "==> Stopping daemon"
launchctl unload "${PLIST_PATH}" 2>/dev/null || true
pkill -f "${APP_NAME}" 2>/dev/null || true
sleep 0.5

echo "==> Removing files"
[ -e "${APP_PATH}" ] && rm -rf "${APP_PATH}" && echo "  removed ${APP_PATH}"
[ -e "${PLIST_PATH}" ] && rm -f "${PLIST_PATH}" && echo "  removed ${PLIST_PATH}"
[ -d "${WATCH_DIR}" ] && rm -rf "${WATCH_DIR}" && echo "  removed ${WATCH_DIR}"

echo ""
echo "✓ WhatsAppTuiNotifier uninstalled."
echo ""
echo "Note: the 'WhatsApp' entry in System Settings → Notifications may"
echo "still appear. macOS keeps those around indefinitely; remove it"
echo "manually from System Settings if you want a clean state."
