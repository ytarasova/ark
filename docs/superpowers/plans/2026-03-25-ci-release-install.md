# CI + GitHub Release + Install Script -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Actions CI (tests on push/PR), GitHub Releases (tagged + rolling latest), and a curl-installable script served via GitHub Pages.

**Architecture:** Three GitHub Actions workflows: `ci.yml` runs tests, `release.yml` creates releases on tags and rolling `latest` on main push, and Pages serves a static `docs/` folder with an install script. The install script downloads the source tarball from the `latest` release, runs `bun install`, and symlinks `ark` onto PATH.

**Tech Stack:** GitHub Actions, GitHub Releases, GitHub Pages, Bun, bash

---

## File Structure

| File | Change | Purpose |
|------|--------|---------|
| `.github/workflows/ci.yml` | **Create** | Test workflow -- runs on push to main + PRs |
| `.github/workflows/release.yml` | **Create** | Release workflow -- tagged + rolling latest |
| `docs/install.sh` | **Create** | Curl-installable install script |
| `docs/index.html` | **Create** | GitHub Pages landing page |

---

### Task 1: CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Type check
        run: bun tsc --noEmit

      - name: Unit tests
        run: bun test --timeout 30000

```

- [ ] **Step 2: Verify workflow syntax**

Run: `cat .github/workflows/ci.yml | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin.read()); print('YAML valid')"` (or `brew install yq && yq . .github/workflows/ci.yml > /dev/null && echo valid`)

If neither yaml tool is available, visual inspection is fine -- GitHub will validate on push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions test workflow"
```

---

### Task 2: Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the release workflow**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']
    branches: [main]

jobs:
  release:
    runs-on: macos-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Determine release type
        id: release-type
        run: |
          if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
            echo "tag=${GITHUB_REF#refs/tags/}" >> "$GITHUB_OUTPUT"
            echo "is_tag=true" >> "$GITHUB_OUTPUT"
          else
            echo "tag=latest" >> "$GITHUB_OUTPUT"
            echo "is_tag=false" >> "$GITHUB_OUTPUT"
          fi

      # Tagged release: create a new GitHub Release
      - name: Create tagged release
        if: steps.release-type.outputs.is_tag == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${{ steps.release-type.outputs.tag }}" \
            --title "${{ steps.release-type.outputs.tag }}" \
            --generate-notes

      # Rolling latest: create or update the "latest" pre-release
      - name: Update latest release
        if: steps.release-type.outputs.is_tag == 'false'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          # Delete existing latest tag + release if present
          gh release delete latest --yes --cleanup-tag 2>/dev/null || true
          # Create fresh latest release pointing at current HEAD
          gh release create latest \
            --title "Latest (rolling)" \
            --notes "Rolling release from \`main\` branch. Updated on every push.

          Install: \`curl -fsSL https://ytarasova.github.io/ark/install.sh | bash\`

          Commit: ${{ github.sha }}" \
            --prerelease \
            --target ${{ github.sha }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow -- tagged + rolling latest"
```

---

### Task 3: Install Script

**Files:**
- Create: `docs/install.sh`

- [ ] **Step 1: Create the install script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Ark installer -- downloads source from GitHub, installs via Bun.
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

# Check for curl or wget
if command -v curl &>/dev/null; then
  FETCH="curl -fsSL"
elif command -v wget &>/dev/null; then
  FETCH="wget -qO-"
else
  error "Neither curl nor wget found. Install one and retry."
fi

# Check for tar
command -v tar &>/dev/null || error "tar is required but not found."

# Check for git (needed for worktree features at runtime)
if ! command -v git &>/dev/null; then
  warn "git not found -- some features (worktrees, cloning) won't work."
fi

# Check for tmux (needed at runtime for agent sessions)
if ! command -v tmux &>/dev/null; then
  warn "tmux not found -- required for running agent sessions."
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

# Resolve download URL
if [ "$VERSION" = "latest" ]; then
  TARBALL_URL="https://github.com/$REPO/releases/download/latest/latest.tar.gz"
  # GitHub auto-generates source archives -- but for rolling latest we use the API
  TARBALL_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/latest" \
    | grep '"tarball_url"' | head -1 | cut -d'"' -f4)
else
  TARBALL_URL="https://api.github.com/repos/$REPO/tarball/$VERSION"
fi

[ -z "$TARBALL_URL" ] && error "Could not resolve download URL for $VERSION"

# Download and extract
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading from GitHub..."
$FETCH "$TARBALL_URL" > "$TMPDIR/ark.tar.gz"

info "Extracting..."
mkdir -p "$TMPDIR/extract"
tar -xzf "$TMPDIR/ark.tar.gz" -C "$TMPDIR/extract" --strip-components=1

# ── Install ─────────────────────────────────────────────────────────────────

# Remove previous install (preserve config)
if [ -d "$INSTALL_DIR/packages" ]; then
  info "Removing previous installation..."
  rm -rf "$INSTALL_DIR/packages" "$INSTALL_DIR/node_modules" \
         "$INSTALL_DIR/agents" "$INSTALL_DIR/flows" "$INSTALL_DIR/recipes"
fi

# Copy source files
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

# Install dependencies
info "Installing dependencies..."
cd "$INSTALL_DIR" && bun install --production 2>/dev/null || bun install

# Create bin symlink
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
info "✓ Ark installed successfully!"
info ""
info "  Run:     ark --help"
info "  TUI:     ark tui"
info "  Update:  curl -fsSL https://ytarasova.github.io/ark/install.sh | bash"
info ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  info "  Restart your shell or run: export PATH=\"\$HOME/.ark/bin:\$PATH\""
fi
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x docs/install.sh`

- [ ] **Step 3: Test locally (dry run)**

Run: `bash -n docs/install.sh` -- checks for syntax errors without executing.
Expected: No output (clean parse).

- [ ] **Step 4: Commit**

```bash
git add docs/install.sh
git commit -m "feat: add curl-installable install script"
```

---

### Task 4: GitHub Pages Landing Page

**Files:**
- Create: `docs/index.html`

- [ ] **Step 1: Create the landing page**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ark -- Autonomous Agent Ecosystem</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #0d1117; color: #c9d1d9;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 2rem;
    }
    .container { max-width: 600px; text-align: center; }
    h1 { font-size: 3rem; color: #58a6ff; margin-bottom: 0.5rem; }
    .tagline { color: #8b949e; font-size: 1.1rem; margin-bottom: 2rem; }
    .install-box {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 1.5rem; margin: 1.5rem 0; text-align: left;
    }
    .install-box code {
      color: #7ee787; font-size: 0.95rem; word-break: break-all;
    }
    .install-box .label {
      color: #8b949e; font-size: 0.8rem; margin-bottom: 0.5rem; display: block;
    }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .links { margin-top: 2rem; }
    .links a { margin: 0 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ark</h1>
    <p class="tagline">Autonomous agent ecosystem.<br>Orchestrate Claude agents through multi-stage flows.</p>

    <div class="install-box">
      <span class="label">Install (macOS)</span>
      <code>curl -fsSL https://ytarasova.github.io/ark/install.sh | bash</code>
    </div>

    <div class="install-box">
      <span class="label">Pin to a version</span>
      <code>curl -fsSL https://ytarasova.github.io/ark/install.sh | ARK_VERSION=v0.2.0 bash</code>
    </div>

    <p class="links">
      <a href="https://github.com/ytarasova/ark">GitHub</a>
      <a href="https://github.com/ytarasova/ark/releases">Releases</a>
    </p>
  </div>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add docs/index.html
git commit -m "feat: add GitHub Pages landing page"
```

---

### Task 5: Push, Enable Pages, Verify

- [ ] **Step 1: Push all commits**

```bash
git push
```

- [ ] **Step 2: Enable GitHub Pages**

Go to https://github.com/ytarasova/ark/settings/pages
- Source: "Deploy from a branch"
- Branch: `main`
- Folder: `/docs`
- Save

Wait 1-2 minutes for the first deploy.

- [ ] **Step 3: Verify CI runs**

Go to https://github.com/ytarasova/ark/actions -- the CI workflow should trigger on the push and run tests.

- [ ] **Step 4: Verify Pages**

Open https://ytarasova.github.io/ark/ -- should show the landing page.
Open https://ytarasova.github.io/ark/install.sh -- should show the install script.

- [ ] **Step 5: Test the release workflow**

Create a test tag and push:
```bash
git tag v0.1.0
git push --tags
```

Go to https://github.com/ytarasova/ark/releases -- should show both a `v0.1.0` release and a `latest` release.

- [ ] **Step 6: Test the install script**

On a clean terminal (or after `rm -rf ~/.ark`):
```bash
curl -fsSL https://ytarasova.github.io/ark/install.sh | bash
ark --help
```

Expected: Ark installs to `~/.ark`, `ark --help` prints usage.
