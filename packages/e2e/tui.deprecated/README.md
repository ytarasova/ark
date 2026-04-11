# Deprecated TUI e2e tests

These tests are the old `TuiDriver` harness: they nest a second tmux
session inside the test's own tmux and parse `capture-pane` output
using heuristics for the divider column. They were replaced on
2026-04-11 by the browser-rendered harness at `packages/tui-e2e/`,
which runs `ark tui` inside a real pty, pipes stdin/stdout through
a WebSocket to `xterm.js` in a headless Chromium (via Playwright),
takes real screenshots, and reads back the actual rendered cells via
`window.__arkBuffer()`.

## Why they were deprecated

- Tmux-in-tmux is infamously fragile (nested escape sequences, partial
  terminal state leakage between the outer and inner tmux).
- Region parsing (`parseRegions`, `findDividerColumn`) used character-
  heuristics that break any time the layout or theme changes.
- No screenshots -- failures dump opaque terminal text.
- No pixel or color assertions -- regressions in the theme or in Ink's
  rendering layer were invisible.
- `packages/e2e/fixtures/tui-driver.ts` was intertwined with real
  orchestration imports, so the "test harness" and "system under test"
  shared state paths.

## Porting status

Each file below has an equivalent to write against the new harness.
None have been ported yet -- ported tests land in
`packages/tui-e2e/tests/` using the `startHarness` / `waitForText` /
`pressKey` / `readTerminal` helpers, not the old `TuiDriver`.

| Legacy file | New home | Owner | Status |
|---|---|---|---|
| `dispatch.test.ts` | `packages/tui-e2e/tests/dispatch.spec.ts` | -- | TODO |
| `sessions.test.ts` | `packages/tui-e2e/tests/sessions.spec.ts` | -- | TODO |
| `session-crud.test.ts` | `packages/tui-e2e/tests/session-crud.spec.ts` | -- | TODO |
| `talk.test.ts` | `packages/tui-e2e/tests/talk.spec.ts` | -- | TODO |
| `tabs.test.ts` | `packages/tui-e2e/tests/tabs.spec.ts` | -- | TODO |
| `worktree.test.ts` | `packages/tui-e2e/tests/worktree.spec.ts` | -- | TODO |

Port these one at a time (they are independent). Delete each legacy
file after its port lands and passes in CI. Once this directory is
empty, delete it and drop the `packages/e2e/fixtures/tui-driver.ts`
driver entirely.

## Don't add new tests here

Any new TUI coverage goes in `packages/tui-e2e/tests/`. See
`packages/tui-e2e/README.md` for the harness API.
