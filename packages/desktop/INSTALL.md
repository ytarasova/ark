# Ark Desktop -- Installation

Ark Desktop is an Electron wrapper around the Ark web dashboard. It renders the
same UI as `ark web`, inside a native window, with native menus.

## Prerequisites

Ark Desktop is a thin shell and does **not** bundle the `ark` CLI runtime yet
(known limitation, see below). Before launching the desktop app, install the
Ark CLI:

```bash
curl -fsSL https://ytarasova.github.io/ark/install.sh | bash
```

This puts `ark` on your `PATH`. On macOS it typically ends up in
`/usr/local/bin/ark` or `~/.bun/bin/ark`. The desktop app searches both.

Verify with `ark --version`.

## Downloads

Grab the artifact for your platform from the
[latest release](https://github.com/ytarasova/ark/releases/latest):

| Platform         | Artifact                          |
| ---------------- | --------------------------------- |
| macOS (Apple)    | `Ark-<version>-arm64.dmg`         |
| macOS (Intel)    | `Ark-<version>.dmg`               |
| Windows          | `Ark Setup <version>.exe`         |
| Linux (AppImage) | `Ark-<version>.AppImage`          |
| Linux (Debian)   | `ark-desktop_<version>_amd64.deb` |

## macOS first-launch workaround (IMPORTANT)

The current release is **unsigned and unnotarized** (no Apple Developer ID is
configured yet). macOS Gatekeeper will refuse to open the app with a message
like _"Ark is damaged and can't be opened"_.

To bypass quarantine on first launch, run this once in Terminal after dragging
Ark to `/Applications`:

```bash
xattr -dr com.apple.quarantine /Applications/Ark.app
```

Then re-open Ark from Launchpad or the Applications folder. Subsequent launches
work normally.

If you built the `.dmg` yourself or placed the app somewhere else, adjust the
path accordingly.

We plan to ship signed + notarized builds once an Apple Developer certificate
is available. Track: https://github.com/ytarasova/ark/issues (search "signing").

## Windows

Run `Ark Setup <version>.exe`. SmartScreen may warn about an unverified
publisher -- click _More info_ -> _Run anyway_. A code-signing certificate is
not configured yet.

## Linux

**AppImage:**

```bash
chmod +x Ark-<version>.AppImage
./Ark-<version>.AppImage
```

**Debian/Ubuntu:**

```bash
sudo dpkg -i ark-desktop_<version>_amd64.deb
```

## Known limitations

- **Bundled CLI runtime**: the desktop app currently calls out to an `ark`
  binary that must already be installed on `PATH`. A future release will
  package a platform-specific `ark-native` binary inside the app bundle via
  `extraResources`, so the desktop experience works with zero CLI setup.
- **Unsigned macOS build**: see the Gatekeeper workaround above.
- **Unsigned Windows build**: SmartScreen warns about unverified publisher.
- **No auto-updater**: new versions must be downloaded manually.
- **No system tray**: closing the window quits the app on Windows/Linux; on
  macOS it stays in the dock per platform convention.

## Troubleshooting

**"Ark Not Found" dialog**: install the Ark CLI first (see Prerequisites).

**Port already in use**: the desktop app auto-picks a free port starting at 8420. If you see the server fail to start, another Ark process may already be
running. Close it and relaunch. Ark Desktop now enforces a single-instance
lock, so opening the app a second time will focus the existing window rather
than spawn another server.

**Server startup timeout**: check the Terminal where you launched Ark Desktop
for error output from the embedded `ark web` process.

## Testing

Ark Desktop has Playwright-for-Electron smoke tests under
[`tests/`](./tests/). See [`tests/README.md`](./tests/README.md) for the
local run command, CI job name, and what each spec covers.
