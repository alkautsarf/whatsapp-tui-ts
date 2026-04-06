#!/bin/bash
# Build release tarball for Homebrew
# Usage: ./scripts/release.sh

set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
NAME="whatsapp-tui"
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

# Normalize arch
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
esac

TARBALL="${NAME}-v${VERSION}-${OS}-${ARCH}.tar.gz"
DIST="dist/${NAME}"

echo "Building ${TARBALL}..."

rm -rf dist
mkdir -p "${DIST}/bin" "${DIST}/src" "${DIST}/node_modules"

# Copy source
cp -r src/ "${DIST}/src/"
cp package.json "${DIST}/"
cp README.md "${DIST}/"

# Install production deps only
cd "${DIST}"
bun install --production --frozen-lockfile 2>/dev/null || bun install --production
cd -

# Create wrapper script
cat > "${DIST}/bin/wa" << 'WRAPPER'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec bun run "${SCRIPT_DIR}/src/index.tsx" "$@"
WRAPPER
chmod +x "${DIST}/bin/wa"

# Also create watui alias
ln -sf "wa" "${DIST}/bin/watui"

# Create tarball
cd dist
tar -czf "../${TARBALL}" "${NAME}/"
cd ..

SHA=$(shasum -a 256 "${TARBALL}" | awk '{print $1}')
echo ""
echo "Built: ${TARBALL}"
echo "SHA256: ${SHA}"
echo "Size: $(du -h "${TARBALL}" | awk '{print $1}')"

rm -rf dist
