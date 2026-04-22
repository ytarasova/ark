# SP1: TUI Removal + Tauri Desktop + Session Sharing

> Date: 2026-04-14
> Status: Approved
> Sub-project: SP1 (Tier 1 -- Ship)
> Effort: 2-3 days
> Owners: Yana (architecture), Zineng (web UI)

## Summary

Three deliverables in one spec:
1. **Complete TUI removal** -- delete 15.8K lines of React+Ink terminal UI code, 7 npm dependencies, all tests, all docs references
2. **Tauri v2 desktop app** -- replace Electron with Tauri, ship .dmg/.app (macOS) + AppImage/.deb (Linux)
3. **Session sharing** -- read-only shareable links for completed sessions with secret redaction

This clears the maintenance burden of TUI, establishes Tauri as the desktop distribution path, and adds a collaboration feature (session sharing) that both Open Agents and the team have identified as needed.

## Context

- TUI retired by team consensus on 2026-04-14 ("ark init" meeting)
- Web UI is now the primary interface
- Electron prototype exists but packaging is broken
- Tauri v2 produces ~10x smaller binaries, uses system webview, has Rust backend
- Web UI is 100% Tauri-compatible (pure React, no Node.js APIs, no Electron APIs)
- Session sharing identified in both Open Agents competitive analysis and background agent landscape gap analysis

## Part 1: TUI Complete Removal

### Files to delete

| Path | Files | Lines | Description |
|------|-------|-------|-------------|
| `packages/tui/` | 122 | 15,814 | React+Ink terminal dashboard (10 tabs, 21 hooks, 25+ components) |
| `packages/tui-e2e/` | ~20 core | N/A | Playwright browser harness (node-pty, xterm.js, 16 test files) |
| `docs/tui-reference.md` | 1 | ~200 | TUI-only documentation |
| `docs/tui.html` | 1 | ~300 | TUI HTML docs page |
| `docs/superpowers/plans/2026-03-24-tui-design-system.md` | 1 | ~100 | Obsolete TUI design plan |
| `docs/superpowers/plans/2026-03-22-ink-tui-rewrite.md` | 1 | ~100 | Obsolete TUI rewrite plan |
| `packages/desktop/` | ~5 | ~300 | Electron app (replaced by Tauri) |

### Dependencies to remove from root package.json

```
ink
ink-select-input
ink-spinner
ink-scroll-list
ink-scroll-view
ink-text-input
ink-testing-library
```

Dependencies that STAY (used by web UI): `react`, `react-dom`, all `@radix-ui/*`, `tailwindcss`, `vite`, `recharts`, `lucide-react`, `clsx`, `class-variance-authority`, `tailwind-merge`.

### Migration: formatEvent utility

`packages/tui/helpers/formatEvent.ts` is imported by `packages/cli/commands/session.ts` for the `ark session events` command. Must be moved before TUI deletion.

**From:** `packages/tui/helpers/formatEvent.ts`
**To:** `packages/core/helpers/formatEvent.ts`

Update import in `packages/cli/commands/session.ts`:
```typescript
// Before
const { formatEvent } = await import("../../tui/helpers/formatEvent.js");
// After
const { formatEvent } = await import("../../core/helpers/formatEvent.js");
```

### CLI changes

**Remove** from `packages/cli/commands/misc.ts`:
- The `program.command("tui")` registration block (~20 lines)
- The dynamic `import("../../tui/index.js")` call

### Makefile changes

**Remove targets:**
- `dev-tui`
- `tui-standalone`
- `test-tui-e2e`

**Update targets:**
- `dev` -- remove TUI comment/reference
- `test` -- remove `packages/tui` from test glob
- `test-e2e` -- remove `test-tui-e2e` dependency, keep `test-web-e2e`

### CLAUDE.md changes

**Remove sections:**
- TUI Keyboard Shortcuts (entire table)
- TUI Design System (status bar, spinners, overlays, focus system, sub-components, helper modules)
- TUI Async Rules (CRITICAL) (entire section including useAsync, useSessionActions, useComputeActions, useStatusMessage)
- SessionsTab sub-components description

**Update sections:**
- Commands: remove `make tui`, `make dev-tui`, `make tui-standalone`
- Project Structure: remove `tui/` entry, update description
- Environment Variables: remove `ARK_TUI_EMBEDDED`
- Data Locations: remove `.claude/settings.local.json` TUI reference if TUI-specific
- Architecture Boundaries: remove `packages/tui/hooks/useFocus.ts` entry
- Code Style: remove "React + Ink for TUI components"

### Docs changes

- Delete `docs/tui-reference.md` and `docs/tui.html`
- `docs/SURFACE_PARITY.md` -- rewrite for CLI + Web only
- `docs/architecture.md` -- remove TUI references, update overview text
- `docs/architecture.html` -- remove TUI box from SVG entirely (currently grayed out)
- `docs/guide.md` -- remove TUI usage instructions
- `docs/configuration.md` -- remove TUI-specific config
- `docs/cli-reference.md` -- remove `ark tui` command
- `docs/nav.js` -- remove "TUI Dashboard" link from sidebar navigation

### CI changes

- `.github/workflows/ci.yml` -- remove TUI smoke test (`./ark-${matrix.name} tui`)

## Part 2: Tauri v2 Desktop App

### Architecture

The Tauri app is a thin native wrapper around the existing web UI. The Rust backend (~100 lines) spawns the `ark` binary as a sidecar, waits for the server to be healthy, then shows a webview pointing at `http://localhost:19400`.

```
Tauri App
  |
  +-- Rust Backend (src-tauri/src/main.rs)
  |     1. Spawn `ark server daemon start --port 19400` as sidecar
  |     2. Poll http://localhost:19400/health every 200ms (30s timeout)
  |     3. Create webview window -> http://localhost:19400
  |     4. On quit: SIGTERM to daemon (graceful shutdown via PID)
  |
  +-- System Webview
        Loads the existing web UI unchanged
        No Chromium bundled (uses OS webview)
```

### File structure

```
packages/desktop-tauri/
+-- src-tauri/
|   +-- Cargo.toml              # tauri, tauri-plugin-shell, reqwest
|   +-- tauri.conf.json         # window, sidecar, bundle config
|   +-- build.rs                # Tauri build script (auto-generated)
|   +-- capabilities/
|   |   +-- default.json        # shell:allow-spawn-sidecar, shell:allow-kill
|   +-- src/
|   |   +-- main.rs             # Entry point (~100 lines)
|   |   +-- lib.rs              # Sidecar management (spawn, health, kill)
|   +-- icons/                  # Generated from docs/favicon.svg
|       +-- icon.icns           # macOS
|       +-- icon.png            # Linux
+-- package.json                # @tauri-apps/cli@2, scripts
+-- README.md
```

### tauri.conf.json (key fields)

```json
{
  "productName": "Ark",
  "identifier": "com.ark.desktop",
  "build": {
    "devUrl": "http://localhost:19400",
    "frontendDist": "../web/dist"
  },
  "app": {
    "windows": [{
      "title": "Ark",
      "width": 1400,
      "height": 900,
      "minWidth": 900,
      "minHeight": 600,
      "decorations": true,
      "titleBarStyle": "Overlay"
    }]
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "app", "appimage", "deb"],
    "icon": ["icons/icon.icns", "icons/icon.png"],
    "externalBin": ["ark"]
  }
}
```

### main.rs (pseudocode)

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1. Find ark binary (sidecar or PATH)
            // 2. Spawn: ark server daemon start --port 19400
            // 3. Poll health endpoint with timeout
            // 4. Window is already created by tauri.conf.json
            //    pointing at devUrl / frontendDist
            Ok(())
        })
        .on_event(|app, event| {
            // On ExitRequested: kill daemon via PID file
        })
        .run(tauri::generate_context!())
        .expect("error running Ark");
}
```

### Sidecar binary

The `ark` CLI binary is bundled as an external binary via Tauri's `externalBin` config. During build:
1. CI compiles `ark` for the target platform via `bun run build:cli` (produces `dist/cli/index.js`)
2. Binary wrapped via `bun build --compile` into a standalone executable
3. Executable placed at `src-tauri/binaries/ark-{target-triple}` (Tauri naming convention)
4. Tauri bundles it into the .dmg/.AppImage

**Dev mode:** Tauri dev mode (`bunx @tauri-apps/cli dev`) expects `ark` on PATH. Use the symlinked `./ark` from `make install` or `bun run --bun ./packages/cli/index.ts` directly.

### Build targets

| Platform | Format | Architecture | CI Runner |
|----------|--------|-------------|-----------|
| macOS | `.dmg` + `.app` | Intel (x86_64) | `macos-13` |
| macOS | `.dmg` + `.app` | ARM (aarch64) | `macos-14` |
| Linux | `AppImage` + `.deb` | Intel (x86_64) | `ubuntu-latest` |
| Linux | `AppImage` + `.deb` | ARM (aarch64) | `ubuntu-24.04-arm` |

No Windows. No code signing (internal distribution -- can add later).

### CI workflow

New file: `.github/workflows/desktop.yml`

```yaml
name: Desktop Build
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-14
            target: aarch64-apple-darwin
          - os: macos-13
            target: x86_64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - os: ubuntu-24.04-arm
            target: aarch64-unknown-linux-gnu
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run build:web  # Build web UI dist
      - run: bun run build:cli  # Build ark binary
      - uses: tauri-apps/tauri-action@v0
        with:
          projectPath: packages/desktop-tauri
      - uses: actions/upload-artifact@v4
        with:
          name: ark-desktop-${{ matrix.target }}
          path: packages/desktop-tauri/src-tauri/target/release/bundle/**
```

### Makefile additions

```makefile
desktop:          ## Launch Tauri desktop app (dev mode)
	cd packages/desktop-tauri && bunx @tauri-apps/cli dev

desktop-build:    ## Build desktop app for current platform
	cd packages/desktop-tauri && bunx @tauri-apps/cli build
```

## Part 3: Session Sharing

### Schema

```sql
CREATE TABLE IF NOT EXISTS session_shares (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_by TEXT,
  expires_at INTEGER,          -- unix epoch, NULL = never expires
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

Added to `packages/core/repositories/schema.ts` alongside existing tables.

### Repository

New file: `packages/core/repositories/share.ts`

```typescript
export class ShareRepository {
  constructor(private db: DatabaseAdapter) {}

  create(sessionId: string, tenantId: string, createdBy?: string, expiresAt?: number): SessionShare
  get(shareId: string): SessionShare | null
  getBySession(sessionId: string): SessionShare[]
  delete(shareId: string): void
  deleteExpired(): number  // cleanup job
}
```

Registered on AppContext as `app.shares`.

### RPC handlers

New file: `packages/server/handlers/share.ts`

| Method | Params | Returns |
|--------|--------|---------|
| `session/share/create` | `{ sessionId, expiresInHours? }` | `{ shareId, url }` |
| `session/share/get` | `{ shareId }` | Session data (read-only, redacted) |
| `session/share/delete` | `{ shareId }` | `{ ok: true }` |
| `session/share/list` | `{ sessionId }` | `SessionShare[]` |

### Secret redaction

Before returning shared session data, redact values matching these patterns from all text content (messages, events, transcripts, environment variables):

```typescript
const REDACT_PATTERNS = [
  /\b[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*[=:]\s*\S+/gi,
  /\bark_[a-z0-9]+_[a-z0-9]+\b/gi,     // Ark API keys
  /\bghp_[a-zA-Z0-9]+\b/g,              // GitHub tokens
  /\bsk-[a-zA-Z0-9]+\b/g,               // OpenAI keys
  /\bsk-ant-[a-zA-Z0-9-]+\b/g,          // Anthropic keys
];
```

Replace matches with `[REDACTED]`.

### Web UI components

**New page:** `packages/web/src/pages/SharedPage.tsx`
- Route: `#/shared/<shareId>`
- No auth required (public read-only)
- No sidebar navigation
- Minimal header: "Ark -- Shared Session" + session title

**New component:** `packages/web/src/components/SharedSessionView.tsx`
- Subset of SessionDetail (read-only)
- Shows: summary, flow pipeline, conversation transcript, files changed, commits, diff preview, cost breakdown
- Does NOT show: action buttons (stop/dispatch/etc.), todos (editing), send message
- Redacted content shown with `[REDACTED]` styling (gray background, monospace)

**Session detail update:** Add "Share" button to SessionDetail header for completed/archived sessions. Clicking creates a share link and copies to clipboard.

### API hook

New hook: `packages/web/src/hooks/useShareQueries.ts`
- `useCreateShare(sessionId)` -- mutation, returns share URL
- `useSharedSession(shareId)` -- query for the shared view page

## Out of Scope

- Web UI overhaul (Open Agents patterns: tool renderers, git panel, etc.) -- separate SP
- Verification artifact capture (asciinema, SARIF, screenshots) -- SP10
- GitHub App webhooks -- SP3
- Security vault -- SP2
- Terminal recording attachment to shared sessions -- SP10 (when recordings exist, they'll automatically appear in shared views)

## Success Criteria

1. `packages/tui/` and `packages/tui-e2e/` fully deleted, no dangling imports
2. `make test` passes without TUI tests
3. `ark tui` command removed, CLI still works
4. CLAUDE.md, docs, CI cleaned of all TUI references
5. `make desktop-build` produces a working .dmg on macOS and AppImage on Linux
6. Desktop app launches, shows web UI, agents can be dispatched
7. `session/share/create` RPC returns a working share URL
8. Shared session view renders read-only with secrets redacted
9. No regression in existing web UI or CLI functionality
