# Ark Desktop

A Tauri v2 wrapper around the Ark web UI. Replaced the Electron build as of
v0.17.0 -- 29x smaller installer (3.2 MB vs 94.3 MB macOS DMG), faster launch,
lower memory footprint.

## Layout

```
packages/desktop/
  package.json            # @tauri-apps/cli + plugin JS bindings
  src-tauri/
    Cargo.toml            # Rust crate (tauri, plugin-shell, plugin-opener,
                          # plugin-single-instance, reqwest, tokio, tracing)
    tauri.conf.json       # window + bundle config (points at ../../web/dist)
    build.rs              # thin wrapper around tauri_build::build()
    capabilities/
      default.json        # core + opener + https-only openUrl allow-list
    icons/                # .icns / .ico / PNG set
    src/
      main.rs             # binary entry point (cfg'd to windows_subsystem)
      lib.rs              # Builder wiring (plugins, setup, RunEvent handler)
      sidecar.rs          # spawn `ark web --with-daemon` + health probe
      window.rs           # main window navigation + critical-error fallback UI
```

The web UI is NOT duplicated here. `tauri.conf.json > build > frontendDist`
points at `../../web/dist` which the existing `bun run build:web` step in the
root already produces.

## Prerequisites

- Bun (`curl -fsSL https://bun.sh/install | bash`) for the root install.
- Rust stable (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
  -- rustc 1.77 or newer.
- System deps:
  - macOS: Xcode command-line tools (`xcode-select --install`).
  - Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
    (Debian/Ubuntu) or distro equivalent. See
    <https://v2.tauri.app/start/prerequisites/#linux>.
  - Windows: WebView2 (preinstalled on Win11; installer ships WebView2 loader).

## Quickstart

```bash
# 1. Install deps (root + this package).
bun install
cd packages/desktop && bun install && cd ../..

# 2. Build the web UI dist that Tauri will serve.
bun run build:web

# 3. Install the ark CLI so the shell can spawn `ark web`.
make install   # symlinks ./ark into /usr/local/bin/ark

# 4. Run in dev mode.
make desktop
#   or: cd packages/desktop && bun run dev

# 5. Release build (produces .dmg/.app on macOS, .deb/.AppImage on Linux,
#    .msi/.exe on Windows).
make build-desktop
#   or: cd packages/desktop && bun run build
```

The first release build takes 5-10 minutes because Cargo has to compile every
transitive dependency from scratch. Subsequent builds are incremental.

## How the shell boots

1. `lib.rs > run()` initializes tracing, installs plugins
   (`shell`, `opener`, `single-instance` on desktop), and hands control to
   `tauri::Builder`.
2. `setup()` spawns a tokio task that:
   - Finds the `ark` binary via `sidecar::find_ark_binary()` (dev-tree path ->
     `resource_dir`/externalBin -> `/usr/local/bin/ark` -> `~/.bun/bin/ark` ->
     `~/.ark/bin/ark` -> `$PATH`).
   - Picks a free port starting at 8420.
   - Spawns `ark web --with-daemon --port <port>` with `setsid(2)` on Unix
     (`CREATE_NEW_PROCESS_GROUP` on Windows) so the whole subtree is a reapable
     process group.
   - Polls `GET http://localhost:<port>/api/health` every 250 ms until 200 OK
     or a 30 s timeout.
   - Navigates the (initially hidden) main window to the live URL and calls
     `show()` + `set_focus()` -- avoids the white-flash that bare `loadURL`
     produces.
3. On `RunEvent::ExitRequested` / `Exit`, `Sidecar::shutdown()` `SIGTERM`s the
   process group, waits up to 2 s, then `SIGKILL`s.

If anything fails before health passes, the tiny HTML error window in
`window::show_error` is rendered via a `data:` URL (no dialog plugin dep).

## Configuration notes

- `titleBarStyle: "Overlay"` + `trafficLightPosition: { x: 18, y: 18 }` in
  `tauri.conf.json` matches the macOS traffic-light position so the "ark" brand
  in the sidebar does not collide with the window controls.
- `visible: false` at startup + `show()` after probe -> no white flash.
- `backgroundColor: "#1a1b26"` matches the existing web UI Tokyo-Night palette.
- Capabilities list only the core plugins + `opener:allow-open-url` restricted
  to `http*` and `mailto:` -- no arbitrary shell exec from JS.
- Logs: `RUST_LOG=ark_desktop_lib=debug bun run dev` for verbose output.

## macOS first-launch workaround

The current release is **unsigned and unnotarized**. macOS Gatekeeper will
refuse to open the app. Run this once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Ark.app
```

## Known limitations

- **Bundled CLI runtime**: the desktop app resolves `ark` from the user's
  environment. A future release will bundle the platform-specific binary via
  Tauri's `externalBin`.
- **Unsigned macOS build**: see the Gatekeeper workaround above.
- **Unsigned Windows build**: SmartScreen warns about unverified publisher.
- **No auto-updater**: `createUpdaterArtifacts: false` in the bundle config.
  Add `tauri-plugin-updater` + an update server later.
- **No deep-link registration**: the `single-instance` plugin is wired but no
  `tauri-plugin-deep-link` yet.
- **No tray icon**: closing the window quits the app on Windows/Linux; on
  macOS it stays in the dock per platform convention.
- **Desktop E2E tests**: need porting from Electron Playwright to Tauri
  WebDriver. Tracked as follow-up.

## CI

The `tauri-build` job in `.github/workflows/ci.yml` runs on push/PR across a
macOS arm64 / Ubuntu x64 / Windows x64 matrix. It builds and uploads the
`.dmg` / `.deb` / `.AppImage` / `.msi` / `.exe` artifacts for inspection.

The `desktop` job in `.github/workflows/release.yml` builds Tauri bundles for
tagged releases and rolling `latest`.
