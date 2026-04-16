# CI + GitHub Release + Install Script -- Design Spec

## Overview

Add GitHub Actions CI for automated testing, GitHub Releases for versioned distribution, and a curl-installable script served via GitHub Pages.

## Decisions

- **CI:** Unit + E2E tests on macOS runner (tmux required for E2E)
- **Release:** Manual `v*` tags create versioned releases; every push to main updates a rolling `latest` release. Source-only -- no compiled binaries.
- **Install:** Source install via `curl | bash` script hosted on GitHub Pages. Downloads release tarball, runs `bun install`, symlinks `ark`.
- **Platforms:** macOS only (arm64 + x64 -- same source, Bun handles both)

## 1. CI Workflow

**File:** `.github/workflows/ci.yml`

**Triggers:** push to `main`, pull requests targeting `main`

**Runner:** `macos-latest` (tmux pre-installed, needed for E2E tests)

**Steps:**
1. Checkout
2. Install Bun (`oven-sh/setup-bun@v2`)
3. `bun install`
4. `tsc --noEmit` (type checking)
5. `bun test` (all tests -- unit + E2E)

Single job, no matrix. macOS runners have tmux and git pre-installed.

## 2. Release Workflow

**File:** `.github/workflows/release.yml`

**Trigger A -- Tagged release:** Push of `v*` tag (e.g. `v0.2.0`)
- Creates a GitHub Release named after the tag
- GitHub auto-attaches source tarball and zip
- Release body: auto-generated from commits since last tag

**Trigger B -- Rolling latest:** Push to `main`
- Creates or updates a release tagged `latest`
- Uses `gh release upload --clobber` to keep it current
- Marked as pre-release so it doesn't show as the "latest stable"

No build step -- GitHub automatically provides source archives for every release. The install script downloads these.

## 3. Install Script

**File:** `docs/install.sh`
**URL:** `https://ytarasova.github.io/ark/install.sh`

```
curl -fsSL https://ytarasova.github.io/ark/install.sh | bash
```

**What it does:**
1. Check for Bun -- if missing, install via `curl -fsSL https://bun.sh/install | bash`
2. Check for tmux -- warn if missing (required at runtime, not install time)
3. Check for git -- required for worktree features
4. Determine install dir: `$ARK_HOME` env var, or `$HOME/.ark`
5. Download source tarball from `latest` release via GitHub API
6. Unpack to `$HOME/.ark/`
7. Run `bun install` inside the unpacked directory
8. Create symlink: `$HOME/.ark/bin/ark` → `$HOME/.ark/ark`
9. Add `$HOME/.ark/bin` to PATH (append to `.zshrc`/`.bashrc` if not present)
10. Print success message with next steps

**Upgrade path:** Running the script again overwrites the install (idempotent). The `latest` release always points at HEAD of main.

**Version pinning:** `curl ... | ARK_VERSION=v0.2.0 bash` downloads a specific tag instead of `latest`.

## 4. GitHub Pages

**Setup:** Enable Pages in repo settings → Source: "Deploy from a branch" → Branch: `main`, folder: `/docs`

**Files:**
- `docs/index.html` -- minimal landing page with install command
- `docs/install.sh` -- the install script

No build step for Pages -- GitHub serves the `docs/` folder directly.

## File Structure

| File | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | Test on push/PR |
| `.github/workflows/release.yml` | Create releases on tag + rolling latest |
| `docs/install.sh` | Curl-installable install script |
| `docs/index.html` | GitHub Pages landing page |

## What Changes in the Repo

- `package.json` version bumped manually before tagging
- `Makefile` unchanged (still works for local dev)
- `ark` shell script unchanged (still runs from source via Bun)

## Success Criteria

- `bun test` passes in CI on every push
- `git tag v0.2.0 && git push --tags` creates a release with source archives
- `curl -fsSL https://ytarasova.github.io/ark/install.sh | bash` installs ark on a clean macOS machine
- `ark --help` works after install without Bun being pre-installed by the user
