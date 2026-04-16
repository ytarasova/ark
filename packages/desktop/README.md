# Ark Desktop

A fully self-contained Tauri v2 desktop app for Ark. No separate installation
required -- the `ark` binary is embedded inside the app bundle via Tauri's
`externalBin` mechanism.

As of v0.17.1 the DMG is approximately 81 MB (3.2 MB Tauri shell + ~78 MB
ark-native binary). This is still smaller than the old Electron build (94.3 MB)
and requires zero external dependencies.

## Layout

```
packages/desktop/
  package.json            # @tauri-apps/cli + plugin JS bindings
  src-tauri/
    Cargo.toml            # Rust crate (tauri, plugin-shell, plugin-opener,
                          # plugin-single-instance, reqwest, tokio, tracing)
    tauri.conf.json       # window + bundle + externalBin config
    build.rs              # tauri_build + TARGET_TRIPLE env injection
    binaries/             # (gitignored) sidecar binaries placed here at build
    capabilities/
      default.json        # core + opener permissions
    icons/                # .icns / .ico / PNG set
    src/
      main.rs             # binary entry point (cfg'd to windows_subsystem)
      lib.rs              # Builder wiring (plugins, setup, RunEvent handler)
      sidecar.rs          # bundled sidecar resolution + spawn + health probe
      cli_install.rs      # first-launch CLI symlink offer (macOS auth dialog)
      window.rs           # main window navigation + critical-error fallback UI
```

The web UI is NOT duplicated here. `tauri.conf.json > build > frontendDist`
points at `../../web/dist` which the existing `bun run build:web` step in the
root already produces.

## How the sidecar works

The `externalBin` entry in `tauri.conf.json` tells Tauri to bundle
platform-specific binaries from `src-tauri/binaries/`. At build time, the
binary must be named with the Rust target triple:

- `src-tauri/binaries/ark-aarch64-apple-darwin` (macOS arm64)
- `src-tauri/binaries/ark-x86_64-apple-darwin` (macOS x64)
- `src-tauri/binaries/ark-x86_64-unknown-linux-gnu` (Linux x64)

The `make build-desktop` target and CI release pipeline automatically build
`ark-native` and copy it to the right location before running `tauri build`.

At runtime, `sidecar::find_ark_binary()` resolves the binary in this order:

1. **Bundled sidecar** -- `<resource_dir>/binaries/ark-<triple>` (production)
2. **Repo-relative** -- `../../../ark` (dev mode via `tauri dev`)
3. **Common paths** -- `/usr/local/bin/ark`, `~/.bun/bin/ark`, `~/.ark/bin/ark`
4. **$PATH** -- fallback

## CLI installation

On macOS first launch, the app checks if `/usr/local/bin/ark` exists. If not,
it shows a native dialog offering to create a symlink from the embedded
sidecar. This uses `osascript` for privilege elevation (the standard macOS
admin auth dialog -- no raw `sudo`).

The same operation is available on demand via the Tauri IPC command
`install_cli_command`, which can be wired to a menu item.

Future enhancement: switch macOS packaging from DMG to PKG (`.pkg`) so the
symlink can be created during the standard install flow without any dialog.

## Prerequisites (development only)

End users install the DMG and get everything. Developers need:

- Bun (`curl -fsSL https://bun.sh/install | bash`) for the root install.
- Rust stable (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
  -- rustc 1.77 or newer.
- System deps:
  - macOS: Xcode command-line tools (`xcode-select --install`).
  - Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
    (Debian/Ubuntu) or distro equivalent. See
    <https://v2.tauri.app/start/prerequisites/#linux>.
  - Windows: WebView2 (preinstalled on Win11; installer ships WebView2 loader).

## Quickstart (development)

```bash
# 1. Install deps.
bun install
cd packages/desktop && bun install && cd ../..

# 2. Dev mode (uses ark from PATH, no sidecar needed).
make desktop

# 3. Release build (builds ark-native first, bundles as sidecar).
make build-desktop
```

## How the shell boots

1. `lib.rs > run()` initializes tracing, installs plugins
   (`shell`, `opener`, `single-instance` on desktop), and hands control to
   `tauri::Builder`.
2. `setup()` spawns a tokio task that:
   - Finds the `ark` binary via `sidecar::find_ark_binary()` (bundled sidecar
     first, then PATH fallback).
   - Picks a free port starting at 8420.
   - Spawns `ark web --with-daemon --port <port>` with `setsid(2)` on Unix
     (`CREATE_NEW_PROCESS_GROUP` on Windows) so the whole subtree is a reapable
     process group.
   - Polls `GET http://localhost:<port>/api/health` every 250 ms until 200 OK
     or a 30 s timeout.
   - Navigates the (initially hidden) main window to the live URL and calls
     `show()` + `set_focus()`.
3. On macOS, after the UI is up, checks if CLI is installed and offers to
   symlink if not.
4. On `RunEvent::ExitRequested` / `Exit`, `Sidecar::shutdown()` `SIGTERM`s the
   process group, waits up to 2 s, then `SIGKILL`s.

## macOS first-launch workaround

The current release is **unsigned and unnotarized**. macOS Gatekeeper will
refuse to open the app. Run this once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Ark.app
```

## Known limitations

- **Unsigned macOS build**: see the Gatekeeper workaround above.
- **Unsigned Windows build**: SmartScreen warns about unverified publisher.
- **No Windows sidecar**: bun --compile does not target Windows yet. The
  Windows app falls back to PATH resolution.
- **No auto-updater**: `createUpdaterArtifacts: false` in the bundle config.
- **No deep-link registration**: the `single-instance` plugin is wired but no
  `tauri-plugin-deep-link` yet.
- **No tray icon**: closing the window quits the app on Windows/Linux; on
  macOS it stays in the dock per platform convention.

## CI

The `tauri-build` job in `.github/workflows/ci.yml` depends on the `build` job
(which produces ark-native binaries) and bundles them as sidecars before running
`tauri build`. Artifacts include `.dmg`, `.deb`, `.AppImage`, and `.exe`.

The `desktop` job in `.github/workflows/release.yml` similarly depends on
`build-ark` and produces release-quality bundles with the embedded sidecar.

Bundle size verification: the CI "Verify sidecar in bundle" step checks that
produced bundles are ~80 MB (not ~3 MB), confirming the sidecar was included.
