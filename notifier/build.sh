#!/bin/bash
# Build WhatsAppTuiNotifier.app
#
# Compiles main.swift, assembles the .app bundle, and copies the
# WhatsApp icon from /Applications/WhatsApp.app.
#
# Output: notifier/build/WhatsAppTuiNotifier.app

set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "WhatsAppTuiNotifier is macOS-only" >&2
    exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
    echo "ERROR: swiftc not found. Install Xcode Command Line Tools:" >&2
    echo "  xcode-select --install" >&2
    exit 1
fi

APP_NAME="WhatsAppTuiNotifier"
BUILD_DIR="build"
APP_BUNDLE="${BUILD_DIR}/${APP_NAME}.app"

echo "==> Cleaning ${BUILD_DIR}/"
rm -rf "${BUILD_DIR}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources"

echo "==> Compiling Swift"
swiftc -O \
    -framework Cocoa \
    -framework UserNotifications \
    -framework CoreServices \
    -o "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}" \
    Sources/main.swift

echo "==> Copying Info.plist"
cp Resources/Info.plist "${APP_BUNDLE}/Contents/Info.plist"

# Try to find the WhatsApp icon. Falls back to a clear warning.
ICON_DST="${APP_BUNDLE}/Contents/Resources/AppIcon.icns"
ICON_FOUND=""
for candidate in \
    "Resources/AppIcon.icns" \
    "/Applications/WhatsApp.app/Contents/Resources/AppIcon.icns" \
    "/Applications/WhatsApp.app/Contents/Resources/WhatsApp.icns" \
    "/Applications/WhatsApp.app/Contents/Resources/icon.icns"; do
    if [ -f "${candidate}" ]; then
        cp "${candidate}" "${ICON_DST}"
        ICON_FOUND="${candidate}"
        break
    fi
done

if [ -z "${ICON_FOUND}" ]; then
    echo "WARNING: no WhatsApp icon found at expected paths."
    echo "         Notifications will use the system default icon."
    echo "         Drop your own AppIcon.icns into Resources/ to override."
else
    echo "==> Icon copied from ${ICON_FOUND}"
fi

# Ad-hoc code sign so the bundle has a valid signature for macOS to register
# it with NotificationCenter cleanly. Locally-built unsigned binaries usually
# work, but ad-hoc sign is the recommended belt-and-suspenders.
echo "==> Ad-hoc code signing"
codesign --sign - --force --deep "${APP_BUNDLE}" 2>&1 | grep -v "replacing existing signature" || true

echo ""
echo "✓ Built ${APP_BUNDLE}"
defaults read "$(pwd)/${APP_BUNDLE}/Contents/Info" CFBundleIdentifier 2>/dev/null && \
    echo "  Bundle identifier verified."
