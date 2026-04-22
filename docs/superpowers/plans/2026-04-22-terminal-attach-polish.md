# Terminal-attach polish pass

Landed MVP: `f2a83506` + `28422bb4` + `1c0ce84a`. The MVP shipped with known
deviations; this dispatch closes them.

Tracks #396 (reopen on completion). Absorbs #397 (close when Wave P2 lands).

## Wave P1 - Consolidate

Goal: one terminal path, no legacy.

- Delete `packages/web/src/components/Terminal.tsx` (dead code, not imported).
- Delete the `/api/terminal` bridge on :8420 (`packages/core/hosted/web.ts`
  + the whole `packages/core/hosted/terminal-bridge.ts` file).
- Prune the matching tests in `packages/core/__tests__/web.test.ts`.
- Replace the inline `script tmux attach` bridge in
  `packages/server/index.ts` with an arkd-backed path:
  - new arkd endpoint `GET /agent/attach/stream?handle=<streamHandle>` returns
    a chunked stream of pane bytes from a `tmux pipe-pane` fifo; closes when
    the handle is closed.
  - Rewrite `/terminal/:sessionId` to: resolve compute - get arkd URL via
    `provider.getArkdUrl(compute)`, call `agentAttachOpen`, send the initial
    buffer as a tagged text frame, proxy the HTTP stream body to WS binary
    frames, forward binary input to `agentAttachInput`, forward JSON
    `{resize: {cols, rows}}` to `agentAttachResize`, and call
    `agentAttachClose` on WS close.

## Wave P2 - Remote-compute support (absorbs #397)

- The WS proxy resolves arkd URL per-session via provider.getArkdUrl(compute).
  For any arkd-backed session (local + ec2 + k8s + firecracker), the same
  code path works because it's arkd-to-arkd.
- Token plumbing: `ArkdClient` pulls from `ARK_ARKD_TOKEN` in the daemon
  process env. The server-daemon run on the same host as the compute's arkd
  (for local) or reads the remote's token from the compute config
  (for remote) and passes it to ArkdClient when instantiating.
- Cleanup on WS close or tmux death: `agentAttachClose` always runs. The
  arkd-side fifo is unlinked in the close handler.
- Test matrix:
  - local-arkd path: unit-tested via `packages/server/__tests__/terminal-ws.test.ts`.
  - remote-arkd (ec2): covered when the e2e harness runs with real EC2;
    otherwise unit-tested at the provider level.

Close #397 referencing the commit.

## Wave P3 - UX polish

- Connection-status pill (connecting / connected / reconnecting N/4 /
  disconnected + Retry).
- Explicit Disconnect button (user-initiated close, no auto-reconnect).
- Exponential backoff: 1s / 2s / 4s / 8s, max 4 attempts, then error state
  with Retry.
- Theme: dark background, 14px monospace using Ark's font tokens, 10k scrollback.
- Copy-on-select + `Cmd+V` / `Ctrl+Shift+V` paste via xterm custom key
  event handler.
- `FitAddon` with 100ms resize debounce.
- Keep `LiveTerminalPanel` mounted but `display: none` when tab is hidden
  (state persistence across tab switches inside session-detail).

Tests:
- Extend `useTerminalSocket.test.ts` with reconnect schedule + user-disconnect
  paths.
- Extend the Playwright spec with force-close / reconnecting badge / auto-
  reconnect assertions.

## Constraints

- Bun + tmux only; ESM `.js` extensions everywhere.
- `make format` + `make lint` zero-warning + targeted `make test-file` per
  wave before commit.
- No em dashes.
- No amend, no skip-hooks. Commit per wave.
