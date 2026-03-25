#!/usr/bin/env bash
set -euo pipefail

# Ark installer - downloads pre-built binary from GitHub.
# Usage:
#   curl -fsSL https://ytarasova.github.io/ark/install.sh | bash              # latest stable release
#   curl -fsSL https://ytarasova.github.io/ark/install.sh | bash -s -- --latest  # bleeding edge from main
#   ARK_VERSION=v0.1.0 curl ... | bash                                        # pin specific version

REPO="ytarasova/ark"
INSTALL_DIR="${ARK_HOME:-$HOME/.ark}"
BIN_DIR="$INSTALL_DIR/bin"

# Parse --latest flag
USE_MAIN=false
for arg in "$@"; do
  case "$arg" in
    --latest) USE_MAIN=true ;;
  esac
done

if [ -n "${ARK_VERSION:-}" ]; then
  VERSION="$ARK_VERSION"
elif [ "$USE_MAIN" = true ]; then
  VERSION="latest"
else
  # Resolve latest tagged release via GitHub API
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" \
    | grep -o '"tag_name": *"v[^"]*"' | head -1 | cut -d'"' -f4) \
    || true
  if [ -z "$VERSION" ]; then
    error "Could not determine latest release. Use ARK_VERSION=v0.1.0 to pin."
  fi
fi

info()  { printf "\033[36m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
error() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

# ── Detect platform ─────────────────────────────────────────────────────────

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *)      error "Unsupported OS: $OS. Ark supports macOS and Linux." ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             error "Unsupported architecture: $ARCH. Ark supports x64 and arm64." ;;
esac

BINARY="ark-${OS}-${ARCH}"
info "Detected platform: ${OS}/${ARCH}"

# ── Preflight checks ────────────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  warn "git not found - some features (worktrees, cloning) won't work."
fi

if ! command -v tmux &>/dev/null; then
  warn "tmux not found - required for running agent sessions."
  if [ "$OS" = "darwin" ]; then
    warn "Install it: brew install tmux"
  else
    warn "Install it: sudo apt install tmux (or your package manager)"
  fi
fi

# ── Download binary ─────────────────────────────────────────────────────────

info "Installing Ark ($VERSION) to $INSTALL_DIR..."

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading $BINARY..."
if command -v curl &>/dev/null; then
  curl -fsSL -o "$TMPDIR/ark" "$DOWNLOAD_URL" || error "Download failed. Check version '$VERSION' exists at https://github.com/$REPO/releases"
elif command -v wget &>/dev/null; then
  wget -q -O "$TMPDIR/ark" "$DOWNLOAD_URL" || error "Download failed. Check version '$VERSION' exists."
else
  error "Neither curl nor wget found."
fi

chmod +x "$TMPDIR/ark"

# ── Install ─────────────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"
mv "$TMPDIR/ark" "$BIN_DIR/ark"

# ── PATH setup ──────────────────────────────────────────────────────────────

add_to_path() {
  local shell_rc="$1"
  local line='export PATH="$HOME/.ark/bin:$PATH"'
  if [ -f "$shell_rc" ] && grep -q '.ark/bin' "$shell_rc" 2>/dev/null; then
    return 0
  fi
  echo "" >> "$shell_rc"
  echo "# Ark" >> "$shell_rc"
  echo "$line" >> "$shell_rc"
  info "Added to $shell_rc"
}

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  if [ -n "${ZSH_VERSION:-}" ] || [ -f "$HOME/.zshrc" ]; then
    add_to_path "$HOME/.zshrc"
  fi
  if [ -f "$HOME/.bashrc" ]; then
    add_to_path "$HOME/.bashrc"
  fi
  if [ -f "$HOME/.bash_profile" ] && ! [ -f "$HOME/.bashrc" ]; then
    add_to_path "$HOME/.bash_profile"
  fi
  export PATH="$BIN_DIR:$PATH"
fi

# ── Done ────────────────────────────────────────────────────────────────────

info ""
info "Ark installed successfully!"
info ""
info "  Run:     ark --help"
info "  TUI:     ark tui"
info "  Update:  curl -fsSL https://ytarasova.github.io/ark/install.sh | bash"
info "  Edge:    curl -fsSL https://ytarasova.github.io/ark/install.sh | bash -s -- --latest"
info ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  info "  Restart your shell or run: export PATH=\"\$HOME/.ark/bin:\$PATH\""
fi
