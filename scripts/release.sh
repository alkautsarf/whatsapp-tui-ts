#!/bin/bash
# Build cross-platform source tarball for Homebrew
# Single tarball — formula runs `bun install` at install time so the correct
# per-arch native modules (OpenTUI Zig binaries, etc.) are pulled on each platform.
# Usage: ./scripts/release.sh

set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
NAME="whatsapp-tui"

TARBALL="${NAME}-v${VERSION}-source.tar.gz"
DIST="dist/${NAME}"

echo "Building ${TARBALL}..."

rm -rf dist
mkdir -p "${DIST}/bin" "${DIST}/src"

# Copy source + config + lockfile (no node_modules — installed at brew install time)
cp -r src/ "${DIST}/src/"
cp package.json bun.lock tsconfig.json bunfig.toml ws-override.ts README.md "${DIST}/"

# Copy the repo's bin/wa (has the exit-42 restart loop)
cp bin/wa "${DIST}/bin/wa"
chmod +x "${DIST}/bin/wa"

ln -sf "wa" "${DIST}/bin/watui"

cd dist
tar -czf "../${TARBALL}" "${NAME}/"
cd ..

SHA=$(shasum -a 256 "${TARBALL}" | awk '{print $1}')
echo ""
echo "Built: ${TARBALL}"
echo "SHA256: ${SHA}"
echo "Size: $(du -h "${TARBALL}" | awk '{print $1}')"

rm -rf dist
