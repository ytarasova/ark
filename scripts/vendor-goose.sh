#!/usr/bin/env bash
# Download a pre-built goose binary for a given platform from the
# block/goose GitHub release.
#
# Usage:
#   scripts/vendor-goose.sh <platform>
# Where platform is one of: darwin-arm64, darwin-x64, linux-arm64, linux-x64
#
# Output: dist/vendor/goose-<platform> (executable binary)

set -euo pipefail

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  echo "Usage: $0 <platform>" >&2
  echo "Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/vendor"
OUT_FILE="$OUT_DIR/goose-$PLATFORM"
mkdir -p "$OUT_DIR"

# Read the pinned version from vendor/versions.yaml if available, so the
# manifest is the single source of truth. Env override still wins.
MANIFEST="$REPO_ROOT/vendor/versions.yaml"
if [ -z "${GOOSE_VERSION:-}" ] && [ -f "$MANIFEST" ] && command -v yq >/dev/null 2>&1; then
  GOOSE_VERSION=$(yq '.goose.version' "$MANIFEST" 2>/dev/null || echo "")
fi
GOOSE_VERSION="${GOOSE_VERSION:-v1.30.0}"

case "$PLATFORM" in
  darwin-arm64) ASSET="goose-aarch64-apple-darwin.tar.gz" ;;
  darwin-x64)   ASSET="goose-x86_64-apple-darwin.tar.gz" ;;
  linux-arm64)  ASSET="goose-aarch64-unknown-linux-gnu.tar.gz" ;;
  linux-x64)    ASSET="goose-x86_64-unknown-linux-gnu.tar.gz" ;;
  *)
    echo "Unknown platform: $PLATFORM" >&2
    exit 1
    ;;
esac

URL="https://github.com/block/goose/releases/download/$GOOSE_VERSION/$ASSET"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "  goose-$PLATFORM: downloading $GOOSE_VERSION..."
if ! curl -fsSL "$URL" -o "$TMPDIR/goose.tar.gz"; then
  echo "  goose-$PLATFORM: download failed ($URL)" >&2
  exit 1
fi

tar -C "$TMPDIR" -xzf "$TMPDIR/goose.tar.gz"

# Locate the binary inside the extracted tree
BIN=$(find "$TMPDIR" -type f -name "goose" -perm -u+x 2>/dev/null | head -1)
if [ -z "$BIN" ]; then
  echo "  goose-$PLATFORM: binary not found in archive" >&2
  exit 1
fi

cp "$BIN" "$OUT_FILE"
chmod +x "$OUT_FILE"
SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "  goose-$PLATFORM: ok ($SIZE)"
