# Ark Desktop (Tauri preview)

A Tauri v2 wrapper around the Ark web UI. Runs side-by-side with the Electron
build under `packages/desktop/` until we flip the default at the next minor
bump; see `docs/ROADMAP.md` SP1.

Why Tauri in parallel:

- Installer size target ~10 MB (vs ~95 MB for the Electron DMG).
- Rust backend, system webview, smaller memory footprint.
- Single-instance lock, external-link handling, and clean sidecar process-group
  teardown built into the shell (fixes the orphan `bun` grandchild leak from
  the Electron build known via PR #102).

## Layout

```
packages/desktop-tauri/
  package.json            # @tauri-apps/cli + plugin JS bindings
  src-tauri/
    Cargo.toml            # Rust crate (tauri, plugin-shell, plugin-opener,
                          # plugin-single-instance, reqwest, tokio, tracing)
    tauri.conf.json       # window + bundle config (points at ../../web/dist)
    build.rs              # thin wrapper around tauri_build::build()
    capabilities/
      default.json        # core + opener + https-only openUrl allow-list
    icons/                # .icns / .ico / PNG set (derived from the Electron build)
    src/
      main.rs             # binary entry point (cfg'd to windows_subsystem)
      lib.rs              # Builder wiring (plugins, setup, RunEvent handler)
      sidecar.rs          # spawn `ark web --with-daemon` + health probe
      window.rs           # main window navigation + critical-error fallback UI
```

The web UI is NOT duplicated here. `tauri.conf.json > build > frontendDist`
points at `../../web/dist` which the existing `bun run build:web` step in the
root already produces. That way the Tauri shell and the Electron shell ship
bit-for-bit identical web assets.

## Quickstart

You need:

- Bun (`curl -fsSL https://bun.sh/install | bash`) for the root install.
- Rust stable (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
  -- rustc 1.77 or newer.
- System deps:
  - macOS: Xcode command-line tools (`xcode-select --install`).
  - Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
    (Debian/Ubuntu) or distro equivalent. See
    <https://v2.tauri.app/start/prerequisites/#linux>.
  - Windows: WebView2 (preinstalled on Win11; installer ships WebView2 loader).

Then from the repo root:

```bash
# 1. Install deps (root + this package).
bun install
cd packages/desktop-tauri && bun install && cd ../..

# 2. Build the web UI dist that Tauri will serve.
bun run build:web

# 3. Install the ark CLI so the shell can spawn `ark web`.
make install   # symlinks ./ark into /usr/local/bin/ark

# 4. Run in dev mode.
make tauri-dev
#   or: cd packages/desktop-tauri && bun run dev

# 5. Release build (produces .dmg/.app on macOS, .deb/.AppImage on Linux,
#    .msi/.exe on Windows).
make tauri-build
#   or: cd packages/desktop-tauri && bun run build
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
  `tauri.conf.json` matches the Electron app's `hiddenInset` chrome on macOS so
  the "ark" brand in the sidebar does not collide with the traffic lights.
- `visible: false` at startup + `show()` after probe -> no white flash.
- `backgroundColor: "#1a1b26"` matches the existing web UI Tokyo-Night palette.
- Capabilities list only the core plugins + `opener:allow-open-url` restricted
  to `http*` and `mailto:` -- no arbitrary shell exec from JS.
- Logs: `RUST_LOG=ark_desktop_lib=debug bun run dev` for verbose output.

## What this scaffold does NOT do yet

- **Bundle the `ark` binary as a sidecar.** The preview resolves `ark` from
  the user's environment (same as Electron today). Bundling needs CI to
  compile `ark-<triple>` via `bun build --compile --target bun-<triple>` and
  place it at `src-tauri/binaries/ark-<triple>`, then add `"externalBin":
  ["binaries/ark"]` to `tauri.conf.json`. Follow-up PR.
- **Code signing / notarization.** Neither macOS nor Windows builds are
  signed. Gatekeeper + SmartScreen workarounds are documented in
  `packages/desktop/INSTALL.md`.
- **Auto-updater.** `createUpdaterArtifacts: false` in the bundle config.
  Add `tauri-plugin-updater` + an update server later.
- **Deep-link registration.** The `single-instance` plugin is wired but no
  `tauri-plugin-deep-link` yet.
- **Dialog boxes.** Error surface is a tiny data-URL window; we deliberately
  skipped `tauri-plugin-dialog` to keep the dep graph minimal.
- **Tray icon.** Not included; matches the Electron build which also has no
  tray.

## CI

The `tauri-build` job in `.github/workflows/ci.yml` runs on push/PR across a
macOS arm64 / Ubuntu x64 / Windows x64 matrix. It only builds (no dev runtime)
and uploads the `.dmg` / `.deb` / `.AppImage` / `.msi` / `.exe` artifacts for
inspection. Electron release wiring in `.github/workflows/release.yml` is
untouched.

## Making Tauri the default later

When we decide to flip the default (separate PR):

1. Swap `.github/workflows/release.yml` to build Tauri artifacts instead of
   Electron.
2. Delete `packages/desktop/` and the `desktop-e2e` job.
3. Update `packages/desktop/INSTALL.md` install instructions accordingly
   (or move the content here).
4. Move this directory to `packages/desktop/` and retire the `-tauri` suffix.
5. Version bump (v0.17.0).
