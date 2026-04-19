#!/usr/bin/env bash
# Download a pre-built codebase-memory-mcp binary for a given platform.
#
# Upstream: github.com/DeusData/codebase-memory-mcp (MIT). A static C binary
# with 66 tree-sitter grammars vendored in -- no runtime deps. Speaks MCP
# over stdio when invoked with no args. Ark agents see its 14 tools at
# dispatch via .mcp.json entry.
#
# Usage:
#   scripts/vendor-codebase-memory-mcp.sh <platform>
# Where platform is one of: darwin-arm64, darwin-x64, linux-arm64, linux-x64
# (Ark internal platform labels; upstream uses -amd64 suffix, mapped below.)
#
# Output: dist/vendor/codebase-memory-mcp-<platform> (executable binary)

set -euo pipefail

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  echo "Usage: $0 <platform>" >&2
  echo "Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/vendor"
OUT_FILE="$OUT_DIR/codebase-memory-mcp-$PLATFORM"
mkdir -p "$OUT_DIR"

# Pinned version read from vendor/versions.yaml; env override wins.
MANIFEST="$REPO_ROOT/vendor/versions.yaml"
if [ -z "${CODEBASE_MEMORY_MCP_VERSION:-}" ] && [ -f "$MANIFEST" ] && command -v yq >/dev/null 2>&1; then
  CODEBASE_MEMORY_MCP_VERSION=$(yq '.codebase-memory-mcp.version' "$MANIFEST" 2>/dev/null || echo "")
fi
CODEBASE_MEMORY_MCP_VERSION="${CODEBASE_MEMORY_MCP_VERSION:-v0.6.0}"

case "$PLATFORM" in
  darwin-arm64) ASSET="codebase-memory-mcp-darwin-arm64.tar.gz" ;;
  darwin-x64)   ASSET="codebase-memory-mcp-darwin-amd64.tar.gz" ;;
  linux-arm64)  ASSET="codebase-memory-mcp-linux-arm64.tar.gz"  ;;
  linux-x64)    ASSET="codebase-memory-mcp-linux-amd64.tar.gz"  ;;
  *)
    echo "Unknown platform: $PLATFORM" >&2
    exit 1
    ;;
esac

URL="https://github.com/DeusData/codebase-memory-mcp/releases/download/$CODEBASE_MEMORY_MCP_VERSION/$ASSET"
CHECKSUMS_URL="https://github.com/DeusData/codebase-memory-mcp/releases/download/$CODEBASE_MEMORY_MCP_VERSION/checksums.txt"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "  codebase-memory-mcp-$PLATFORM: downloading $CODEBASE_MEMORY_MCP_VERSION..."
if ! curl -fsSL "$URL" -o "$TMPDIR/cbm.tar.gz"; then
  echo "  codebase-memory-mcp-$PLATFORM: download failed ($URL)" >&2
  exit 1
fi

# Verify checksum (upstream publishes a checksums.txt per release)
if curl -fsSL "$CHECKSUMS_URL" -o "$TMPDIR/checksums.txt" 2>/dev/null; then
  EXPECTED=$(grep "$ASSET" "$TMPDIR/checksums.txt" | awk '{print $1}')
  ACTUAL=$(shasum -a 256 "$TMPDIR/cbm.tar.gz" | awk '{print $1}')
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "  codebase-memory-mcp-$PLATFORM: checksum mismatch" >&2
    echo "    expected: $EXPECTED" >&2
    echo "    actual:   $ACTUAL" >&2
    exit 1
  fi
else
  echo "  codebase-memory-mcp-$PLATFORM: WARN checksums.txt not retrieved, skipping verification" >&2
fi

tar -C "$TMPDIR" -xzf "$TMPDIR/cbm.tar.gz"

BIN=$(find "$TMPDIR" -type f -name "codebase-memory-mcp" -perm -u+x 2>/dev/null | head -1)
if [ -z "$BIN" ]; then
  echo "  codebase-memory-mcp-$PLATFORM: binary not found in archive" >&2
  exit 1
fi

cp "$BIN" "$OUT_FILE"
chmod +x "$OUT_FILE"
SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "  codebase-memory-mcp-$PLATFORM: ok ($SIZE)"
