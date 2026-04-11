#!/usr/bin/env bash
# Build/fetch a relocatable tmux binary for a given platform.
#
# Usage:
#   scripts/vendor-tmux.sh <platform>
# Where platform is one of: darwin-arm64, darwin-x64, linux-arm64, linux-x64
#
# Strategy:
#   darwin-*: build from source, statically link libevent, dynamically link
#             libSystem (always present on macOS). Output has zero external
#             non-system dependencies.
#   linux-*:  build inside an Alpine Docker container to get a fully static
#             musl binary. Requires Docker + buildx for cross-arch.
#
# Output: dist/vendor/tmux-<platform> (executable binary)

set -euo pipefail

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  echo "Usage: $0 <platform>" >&2
  echo "Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/vendor"
OUT_FILE="$OUT_DIR/tmux-$PLATFORM"
mkdir -p "$OUT_DIR"

TMUX_VERSION="${TMUX_VERSION:-3.5a}"
LIBEVENT_VERSION="${LIBEVENT_VERSION:-2.1.12-stable}"

HOST_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
  x86_64|amd64) HOST_ARCH="x64" ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
esac
HOST_PLATFORM="$HOST_OS-$HOST_ARCH"

info() { printf "\033[36m[vendor-tmux]\033[0m %s\n" "$*"; }
warn() { printf "\033[33m[vendor-tmux]\033[0m %s\n" "$*"; }
error() { printf "\033[31m[vendor-tmux]\033[0m %s\n" "$*" >&2; exit 1; }

case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *) error "Invalid platform: $PLATFORM" ;;
esac

# ── darwin: build from source with static libevent + ncurses ─────────────

build_darwin() {
  if [ "$HOST_OS" != "darwin" ]; then
    warn "macOS builds must be produced on macOS. Skipping $PLATFORM."
    return 1
  fi
  if [ "$HOST_ARCH" != "${PLATFORM#darwin-}" ]; then
    warn "Cross-arch macOS build ($HOST_ARCH -> ${PLATFORM#darwin-}) not supported without CI. Skipping."
    return 1
  fi

  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' RETURN

  info "Downloading libevent $LIBEVENT_VERSION..."
  curl -fsSL "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz" \
    -o "$WORK/libevent.tar.gz"
  tar -xf "$WORK/libevent.tar.gz" -C "$WORK"

  info "Building libevent statically..."
  (
    cd "$WORK/libevent-$LIBEVENT_VERSION"
    ./configure --prefix="$WORK/deps" --enable-static --disable-shared \
      --disable-openssl --disable-samples --disable-debug-mode \
      >/dev/null 2>&1 || error "libevent configure failed"
    make -j"$(sysctl -n hw.ncpu)" >/dev/null 2>&1 || error "libevent build failed"
    make install >/dev/null 2>&1
  )

  info "Downloading tmux $TMUX_VERSION..."
  curl -fsSL "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" \
    -o "$WORK/tmux.tar.gz"
  tar -xf "$WORK/tmux.tar.gz" -C "$WORK"

  info "Building tmux with static libevent + system ncurses..."
  (
    cd "$WORK/tmux-$TMUX_VERSION"
    # Use system ncurses (present on all macOS). Statically link libevent.
    ./configure \
      --prefix="$WORK/tmux-out" \
      CFLAGS="-I$WORK/deps/include" \
      LDFLAGS="-L$WORK/deps/lib" \
      LIBS="-lresolv" \
      >/dev/null 2>&1 || error "tmux configure failed"
    make -j"$(sysctl -n hw.ncpu)" >/dev/null 2>&1 || error "tmux build failed"
  )

  # Verify the binary only depends on system libs (libSystem + libutil + libncurses)
  info "Verifying binary dependencies..."
  otool -L "$WORK/tmux-$TMUX_VERSION/tmux" | grep -v "^$WORK" | tail -n +2 || true
  if otool -L "$WORK/tmux-$TMUX_VERSION/tmux" | grep -qi libevent; then
    error "tmux still depends on libevent dynamically (static link failed)"
  fi

  cp "$WORK/tmux-$TMUX_VERSION/tmux" "$OUT_FILE"
  chmod +x "$OUT_FILE"
  info "Built $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
}

# ── linux: build inside Alpine Docker for fully static musl binary ───────

build_linux() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker required for Linux builds. Skipping $PLATFORM."
    return 1
  fi

  local DOCKER_ARCH
  case "$PLATFORM" in
    linux-x64) DOCKER_ARCH="linux/amd64" ;;
    linux-arm64) DOCKER_ARCH="linux/arm64" ;;
  esac

  info "Building tmux statically in Alpine Docker ($DOCKER_ARCH)..."

  local BUILD_SCRIPT
  BUILD_SCRIPT=$(cat <<'EOF'
set -eu
apk add --no-cache build-base libevent-dev libevent-static ncurses-dev ncurses-static byacc bison curl tar
cd /tmp
curl -fsSL "https://github.com/tmux/tmux/releases/download/TMUX_VERSION/tmux-TMUX_VERSION.tar.gz" -o tmux.tar.gz
tar -xf tmux.tar.gz
cd "tmux-TMUX_VERSION"
./configure --enable-static --prefix=/tmp/out \
  CFLAGS="-static" \
  LDFLAGS="-static" \
  LIBS="-lresolv"
make -j"$(nproc)"
cp tmux /out/tmux
EOF
)
  BUILD_SCRIPT="${BUILD_SCRIPT//TMUX_VERSION/$TMUX_VERSION}"

  local WORK
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' RETURN

  docker run --rm --platform "$DOCKER_ARCH" \
    -v "$WORK:/out" \
    -e BUILD_SCRIPT="$BUILD_SCRIPT" \
    alpine:3.20 \
    sh -c 'echo "$BUILD_SCRIPT" | sh' 2>&1 \
    || error "Docker tmux build failed. Is Docker running and buildx enabled?"

  if [ ! -f "$WORK/tmux" ]; then
    error "tmux binary not produced by Docker build"
  fi

  cp "$WORK/tmux" "$OUT_FILE"
  chmod +x "$OUT_FILE"
  info "Built $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
}

# ── Entry ────────────────────────────────────────────────────────────────

# Already built? Skip.
if [ -f "$OUT_FILE" ] && [ -s "$OUT_FILE" ]; then
  info "$OUT_FILE already exists, skipping"
  exit 0
fi

case "$PLATFORM" in
  darwin-*) build_darwin || exit 0 ;;
  linux-*)  build_linux  || exit 0 ;;
esac
