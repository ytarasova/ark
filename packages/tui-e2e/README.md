# @ark/tui-e2e

Browser-rendered end-to-end test harness for the Ark TUI.

## Why this exists

The legacy harness (`packages/e2e/tui/` + `packages/e2e/fixtures/tui-driver.ts`)
drove the TUI by nesting a second tmux session inside the test's own tmux
and parsing `capture-pane` output with heuristics for the divider column.
That approach:

- Was fragile (tmux-in-tmux is infamously finicky)
- Couldn't take screenshots
- Couldn't catch layout or color regressions
- Was hard to debug -- tests either passed or dumped opaque terminal text

This package replaces it with a real pty + a real browser:

```
Playwright → xterm.js → WebSocket → node-pty → ark tui → real tmux → real agents
```

Each harness instance owns:

- Its own ephemeral `ARK_DIR` (isolated config + SQLite DB + tracks dir)
- Its own ephemeral `TMUX_TMPDIR` (isolated tmux socket, no host pollution)
- Its own HTTP port (so Playwright workers are parallel-safe)
- A real xterm.js terminal rendered in headless Chromium

Tests drive the TUI via `page.keyboard.press("q")` and read back the
actual rendered cells via `window.__arkBuffer()`. Screenshots are real
image assertions, not text diffs.

## Running

```bash
cd packages/tui-e2e
bun install
bunx playwright install chromium   # first time only
bunx playwright test                # all tests
bunx playwright test --headed       # watch the xterm in a visible browser
bunx playwright test --debug        # Playwright inspector
```

Or from the repo root via the Makefile:

```bash
make test-tui-e2e
```

## Watching the TUI live in a browser (dev mode)

```bash
cd packages/tui-e2e
bun run serve
# open http://127.0.0.1:9876/ in a real browser
```

You're now looking at a real `ark tui` running inside an isolated
`ARK_DIR` / `TMUX_TMPDIR`. Type into the page as if it were a terminal.

## Writing a test

```ts
import { test, expect } from "@playwright/test";
import { startHarness, waitForText, pressKey } from "../harness.js";

test("sessions tab opens", async ({ page }) => {
  const harness = await startHarness();
  try {
    await page.goto(harness.pageUrl);
    await waitForText(page, "Sessions");

    await pressKey(page, "n");
    await waitForText(page, "New session");

    await page.keyboard.type("demo-task");
    await pressKey(page, "Enter");
    await waitForText(page, "demo-task");
  } finally {
    await harness.stop();
  }
});
```

The `harness` object exposes `pageUrl`, `arkDir`, `tmuxTmpDir`, the
underlying `pty`, and `stop()` / `write()` / `resize()` / `readOutput()`.

## What the legacy harness still covers

`packages/e2e/tui.deprecated/` contains the 6 pre-existing TuiDriver
tests: `dispatch`, `sessions`, `session-crud`, `talk`, `tabs`, `worktree`.
They're preserved for reference while we port coverage over -- each one
has an equivalent to write against this harness, and the port is on the
roadmap as a Camp 1 follow-up. Do not add new tests to the deprecated
directory.
