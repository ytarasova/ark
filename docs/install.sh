#!/usr/bin/env bash
set -euo pipefail

# Ark installer — downloads source from GitHub, installs via Bun.
# Usage: curl -fsSL https://ytarasova.github.io/ark/install.sh | bash
# Pin version: curl ... | ARK_VERSION=v0.2.0 bash

REPO="ytarasova/ark"
VERSION="${ARK_VERSION:-latest}"
INSTALL_DIR="${ARK_HOME:-$HOME/.ark}"
BIN_DIR="$INSTALL_DIR/bin"

info()  { printf "\033[36m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
error() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

# ── Preflight checks ────────────────────────────────────────────────────────

if command -v curl &>/dev/null; then
  FETCH="curl -fsSL"
elif command -v wget &>/dev/null; then
  FETCH="wget -qO-"
else
  error "Neither curl nor wget found. Install one and retry."
fi

command -v tar &>/dev/null || error "tar is required but not found."

if ! command -v git &>/dev/null; then
  warn "git not found — some features (worktrees, cloning) won't work."
fi

if ! command -v tmux &>/dev/null; then
  warn "tmux not found — required for running agent sessions."
  warn "Install it: brew install tmux"
fi

# ── Install Bun if missing ──────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
  info "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun &>/dev/null || error "Bun installation failed."
  info "Bun installed: $(bun --version)"
fi

# ── Download source ─────────────────────────────────────────────────────────

info "Installing Ark ($VERSION) to $INSTALL_DIR..."

if [ "$VERSION" = "latest" ]; then
  TARBALL_URL=$($FETCH "https://api.github.com/repos/$REPO/releases/tags/latest" \
    | grep '"tarball_url"' | head -1 | cut -d'"' -f4)
else
  TARBALL_URL="https://api.github.com/repos/$REPO/tarball/$VERSION"
fi

[ -z "${TARBALL_URL:-}" ] && error "Could not resolve download URL for $VERSION"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading from GitHub..."
$FETCH "$TARBALL_URL" > "$TMPDIR/ark.tar.gz"

info "Extracting..."
mkdir -p "$TMPDIR/extract"
tar -xzf "$TMPDIR/ark.tar.gz" -C "$TMPDIR/extract" --strip-components=1

# ── Install ─────────────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/packages" ]; then
  info "Removing previous installation..."
  rm -rf "$INSTALL_DIR/packages" "$INSTALL_DIR/node_modules" \
         "$INSTALL_DIR/agents" "$INSTALL_DIR/flows" "$INSTALL_DIR/recipes"
fi

mkdir -p "$INSTALL_DIR"
cp -r "$TMPDIR/extract/packages" "$INSTALL_DIR/"
cp -r "$TMPDIR/extract/agents" "$INSTALL_DIR/" 2>/dev/null || true
cp -r "$TMPDIR/extract/flows" "$INSTALL_DIR/" 2>/dev/null || true
cp -r "$TMPDIR/extract/recipes" "$INSTALL_DIR/" 2>/dev/null || true
cp "$TMPDIR/extract/package.json" "$INSTALL_DIR/"
cp "$TMPDIR/extract/tsconfig.json" "$INSTALL_DIR/"
cp "$TMPDIR/extract/bunfig.toml" "$INSTALL_DIR/" 2>/dev/null || true
cp "$TMPDIR/extract/ark" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/ark"

info "Installing dependencies..."
cd "$INSTALL_DIR" && bun install --production 2>/dev/null || bun install

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/ark" "$BIN_DIR/ark"

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
info ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  info "  Restart your shell or run: export PATH=\"\$HOME/.ark/bin:\$PATH\""
fi
