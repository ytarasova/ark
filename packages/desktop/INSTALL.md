# Ark Desktop -- Installation

Ark Desktop is a fully self-contained Electron app that bundles the Ark web
dashboard and the `ark-native` CLI binary. No prerequisites needed -- just
download, install, and launch.

## Prerequisites

None. The desktop app ships with everything it needs.

On first launch, Ark will offer to install CLI tools so you can use `ark` from
the terminal. You can also do this later via the menu:
- **macOS**: Ark > Install CLI Tools...
- **Linux/Windows**: Tools > Install CLI Tools...

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

- **Unsigned macOS build**: see the Gatekeeper workaround above.
- **Unsigned Windows build**: SmartScreen warns about unverified publisher.
- **No auto-updater**: new versions must be downloaded manually.
- **No system tray**: closing the window quits the app on Windows/Linux; on
  macOS it stays in the dock per platform convention.

## Bundle size

The desktop app is approximately 172 MB:
- Electron shell: ~94 MB
- ark-native binary: ~78 MB

This is larger than a minimal Electron app, but the trade-off is a fully
self-contained install with zero prerequisites.

## Troubleshooting

**"Ark Not Found" dialog**: this should not happen in v0.17.0+ since the
ark-native binary is bundled. If you see this dialog, the app bundle may be
corrupted -- re-download from the releases page.

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
