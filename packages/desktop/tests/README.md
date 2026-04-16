# Ark Desktop -- Smoke Tests

Playwright-for-Electron tests that boot the real Ark Desktop app, drive the
embedded BrowserWindow, and verify baseline behavior.

## Running locally

From the desktop package directory:

```bash
cd packages/desktop
npm install            # first time only
npm test               # headless (default)
npm run test:headed    # with visible window
npm run test:ui        # Playwright UI mode
```

From the repo root:

```bash
bun run --filter desktop test
```

Requires `packages/web/dist/` to be built (the desktop shell serves it).
Run `bun run build:web` if the web dist is missing.

## What each spec covers

| File                    | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `launch.spec.ts`        | Electron boots, window appears, React SPA mounts        |
| `branding.spec.ts`      | App name = Ark, macOS menu label, dock icon             |
| `window-chrome.spec.ts` | Sidebar brand does not overlap macOS traffic lights     |
| `daemon-status.spec.ts` | Dashboard System Health card renders with 4 daemon rows |

## Updating the baseline screenshot

`launch.spec.ts` captures `tests/__snapshots__/dashboard-baseline.png` on every
run. It is not yet a visual-regression assertion -- it is stored for future
diff work. To refresh it, delete the file and re-run the suite.

## CI

Runs on every PR via the `desktop-e2e` job in `.github/workflows/ci.yml`.
Matrix: `macos-latest` + `ubuntu-latest`. Ubuntu runs under `xvfb-run`.
Artifacts (screenshots, traces, HTML report) are uploaded on failure only.

## Packaged-app mode (future)

Set `ARK_E2E_PACKAGED=1` to flip `branding.spec.ts` dock-icon check into a
hard assertion. Currently dev mode uses Electron's default dock icon.
