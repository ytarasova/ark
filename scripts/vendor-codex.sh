#!/usr/bin/env bash
# Download a pre-built codex binary for a given platform from the
# openai/codex GitHub release. Mirrors vendor-goose.sh.
#
# Usage:
#   scripts/vendor-codex.sh <platform>
# Where platform is one of: darwin-arm64, darwin-x64, linux-arm64, linux-x64
#
# Output: dist/vendor/codex-<platform> (executable binary)

set -euo pipefail

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  echo "Usage: $0 <platform>" >&2
  echo "Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/vendor"
OUT_FILE="$OUT_DIR/codex-$PLATFORM"
mkdir -p "$OUT_DIR"

# Read the pinned version from vendor/versions.yaml if available, so the
# manifest is the single source of truth. Env override still wins.
# Codex tags follow the pattern rust-vX.Y.Z for the CLI release line.
MANIFEST="$REPO_ROOT/vendor/versions.yaml"
if [ -z "${CODEX_VERSION:-}" ] && [ -f "$MANIFEST" ] && command -v yq >/dev/null 2>&1; then
  CODEX_VERSION=$(yq '.codex.version' "$MANIFEST" 2>/dev/null || echo "")
fi
CODEX_VERSION="${CODEX_VERSION:-rust-v0.120.0}"

case "$PLATFORM" in
  darwin-arm64) ASSET="codex-aarch64-apple-darwin.tar.gz" ;;
  darwin-x64)   ASSET="codex-x86_64-apple-darwin.tar.gz" ;;
  linux-arm64)  ASSET="codex-aarch64-unknown-linux-gnu.tar.gz" ;;
  linux-x64)    ASSET="codex-x86_64-unknown-linux-gnu.tar.gz" ;;
  *)
    echo "Unknown platform: $PLATFORM" >&2
    exit 1
    ;;
esac

URL="https://github.com/openai/codex/releases/download/$CODEX_VERSION/$ASSET"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "  codex-$PLATFORM: downloading $CODEX_VERSION..."
if ! curl -fsSL "$URL" -o "$TMPDIR/codex.tar.gz"; then
  echo "  codex-$PLATFORM: download failed ($URL)" >&2
  exit 1
fi

tar -C "$TMPDIR" -xzf "$TMPDIR/codex.tar.gz"

# Locate the binary inside the extracted tree
BIN=$(find "$TMPDIR" -type f -name "codex" -perm -u+x 2>/dev/null | head -1)
if [ -z "$BIN" ]; then
  echo "  codex-$PLATFORM: binary not found in archive" >&2
  exit 1
fi

cp "$BIN" "$OUT_FILE"
chmod +x "$OUT_FILE"
SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "  codex-$PLATFORM: ok ($SIZE)"
