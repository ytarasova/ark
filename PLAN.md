# Plan: Daemon-Client Architecture -- TUI as Thin WebSocket Client

## Summary

The TUI already uses ArkClient over JSON-RPC 2.0 exclusively (no direct core imports, enforced by `packages/tui/__tests__/daemon-client-boundary.test.ts`). However, in local mode it still boots the entire AppContext (DB, conductor, arkd, metrics, providers) in-process via `packages/tui/index.tsx:22-26`. This plan introduces a persistent **control plane daemon** (`ark server daemon start`) that owns all heavyweight services, and refactors the TUI to always connect via WebSocket -- even locally. The result: instant TUI startup, daemon persistence across TUI restarts, and a clean process boundary.

## Files to Modify/Create

### New Files

| File | Description |
|------|-------------|
| `packages/cli/commands/server-daemon.ts` | `ark server daemon start/stop/status` subcommands -- PID file management, `--detach` mode, health checks, auto-start logic |
| `packages/protocol/__tests__/transport-reconnect.test.ts` | Tests for WebSocket reconnection and message buffering |
| `packages/tui/__tests__/daemon-connect.test.ts` | Integration test: daemon boot + TUI WebSocket connect |

### Modified Files

| File | Change |
|------|-------------|
| `packages/core/constants.ts` | Add `DEFAULT_SERVER_PORT` (19400) and `DEFAULT_SERVER_URL` constants |
| `packages/cli/commands/server.ts` | Wire `server-daemon.ts` subcommands into the `server` command group |
| `packages/server/index.ts` | Add JSON health endpoint to `startWebSocket()` HTTP fallback (line 109) |
| `packages/tui/index.tsx` | Replace in-process AppContext boot with daemon auto-discovery + WebSocket connect |
| `packages/tui/context/ArkClientProvider.tsx` | Remove `app` prop, `createInMemoryPair()`, `ArkServer` import; always use WebSocket transport |
| `packages/protocol/transport.ts` | Add reconnection logic + `onStatus` callback to `createWebSocketTransport()` |
| `packages/protocol/client.ts` | Add `connectionStatus` property + `onConnectionStatus()` listener |
| `packages/tui/App.tsx` | Show connection status indicator in status bar (reconnecting/disconnected) |
| `packages/tui/__tests__/daemon-client-boundary.test.ts` | Strengthen: no TUI source imports `AppContext`, `ArkServer`, or `registerAllHandlers` |
| `Makefile` | Update `tui` target to not assume in-process boot (daemon auto-starts from TUI) |

## Implementation Steps

### Phase 1: Control Plane Daemon

**Step 1: Add server port constants**
- File: `packages/core/constants.ts` (after line 24)
- Add:
  ```ts
  export const DEFAULT_SERVER_PORT = parseInt(process.env.ARK_SERVER_PORT ?? "19400", 10);
  export const DEFAULT_SERVER_URL = process.env.ARK_SERVER_URL || "http://localhost:19400";
  ```
- This formalizes the 19400 port already used by `ark server start --ws` (`packages/cli/commands/server.ts:19`).

**Step 2: Add health endpoint to ArkServer WebSocket server**
- File: `packages/server/index.ts`, method `startWebSocket()`, line 108-110
- Replace the plain text HTTP fallback with a proper health check:
  ```ts
  fetch(req, server) {
    if (server.upgrade(req)) return;
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
    }
    return new Response("Ark Server -- connect via WebSocket", { status: 200 });
  }
  ```

**Step 3: Create `ark server daemon` subcommands**
- File: `packages/cli/commands/server-daemon.ts` (new)
- Reuse PID file pattern from `packages/cli/commands/daemon.ts:8-47` but with `server.pid` filename
- **`server daemon start [--detach] [--port 19400]`**:
  1. Check for existing daemon via PID file (`~/.ark/server.pid`) + process liveness
  2. If `--detach`: spawn background process via `Bun.spawn()` (same pattern as `daemon.ts:76-114`), verify health, write PID file
  3. If foreground: boot `AppContext` (full: conductor:19100 + arkd:19300), start `ArkServer.startWebSocket(port)`, write PID file, block on `await new Promise(() => {})`
  4. Signal handlers: SIGINT/SIGTERM -> `app.shutdown()`, remove PID file, exit
- **`server daemon stop`**: read PID file, `process.kill(pid, "SIGTERM")`, remove PID file
- **`server daemon status`**: read PID file, check liveness, probe `/health` endpoint, report

- File: `packages/cli/commands/server.ts`
- Import and wire `registerServerDaemonCommands(serverCmd)` so it becomes `ark server daemon start/stop/status`

### Phase 2: WebSocket Transport Resilience

**Step 4: Add reconnection to WebSocket transport**
- File: `packages/protocol/transport.ts`, function `createWebSocketTransport()`
- Add options interface:
  ```ts
  interface WebSocketTransportOptions {
    token?: string;
    reconnect?: boolean;       // default: false (backwards compatible)
    maxReconnectDelay?: number; // default: 30000ms
    onStatus?: (status: "connected" | "reconnecting" | "disconnected") => void;
  }
  ```
- On `ws.onclose`: if `reconnect` is true, enter reconnect loop:
  - Exponential backoff: 1s, 2s, 4s, 8s... capped at `maxReconnectDelay`
  - Each attempt: create new `WebSocket(connectUrl)`, on success: replay `onMessage` handlers, emit `onStatus("connected")`
  - On failure after timeout: emit `onStatus("disconnected")`
- Buffer outgoing `send()` calls during reconnect (cap at 100, FIFO drop)
- Existing behavior unchanged when `reconnect` is false/omitted

**Step 5: Add connection status to ArkClient**
- File: `packages/protocol/client.ts`
- Add `connectionStatus: "connected" | "reconnecting" | "disconnected"` readonly property
- Add `onConnectionStatus(handler: (status) => void): () => void` method (returns unsubscribe fn)
- Constructor: if transport has `onStatus`, wire it to update `connectionStatus` and fire handlers
- On reconnect: automatically re-send `initialize({ subscribe: [...] })` using the last-used subscription patterns

### Phase 3: TUI as Pure WebSocket Client

**Step 6: Refactor TUI entry point**
- File: `packages/tui/index.tsx`
- **Remove** lines 6-7 (`import { AppContext, setApp }`, `import { loadConfig }`):
  ```ts
  // BEFORE:
  import { AppContext, setApp } from "../core/app.js";
  import { loadConfig } from "../core/config.js";
  
  // AFTER:
  // Only import what's needed for minimal config reading
  import { join } from "path";
  import { existsSync, readFileSync } from "fs";
  ```
- **Remove** lines 20-26 (in-process AppContext boot):
  ```ts
  // REMOVE:
  let app: AppContext | null = null;
  const config = loadConfig();
  if (!isRemote) {
    app = new AppContext(config);
    setApp(app);
    await app.boot();
  }
  ```
- **New boot sequence** (replace lines 12-26):
  ```ts
  const remoteServerUrl = process.env.ARK_TUI_SERVER || process.env.ARK_SERVER;
  const remoteToken = process.env.ARK_TUI_TOKEN || process.env.ARK_TOKEN;
  
  // Resolve server URL: remote mode or local daemon
  let serverUrl: string;
  let token: string | undefined = remoteToken;
  
  if (remoteServerUrl) {
    serverUrl = remoteServerUrl;
  } else {
    const port = parseInt(process.env.ARK_SERVER_PORT ?? "19400", 10);
    serverUrl = `http://localhost:${port}`;
    // Auto-start daemon if not running
    await ensureDaemon(port);
  }
  ```
- **New `ensureDaemon(port)` function** (in same file or small util):
  1. Probe `http://localhost:${port}/health` with 2s timeout
  2. If healthy: return (daemon already running)
  3. If not: spawn `Bun.spawn(["bun", process.argv[1].replace(/tui$/, ""), "server", "daemon", "start", "--detach", "--port", String(port)])`
  4. Poll health every 500ms for up to 8s
  5. If still unhealthy: print error, exit(1)
- **Remove** `app.shutdown()` calls (lines 45, 59, 79, 84) -- TUI no longer owns the daemon
- **Render**: pass `serverUrl` (not `app`) to `ArkClientProvider`

**Step 7: Simplify ArkClientProvider**
- File: `packages/tui/context/ArkClientProvider.tsx`
- **Remove**: `import { ArkServer }` (line 4), `import { registerAllHandlers }` (line 5), `import type { AppContext }` (line 7)
- **Remove**: `createInMemoryPair()` function (lines 11-28)
- **Remove**: `app?: AppContext` from Props interface (line 38)
- **Remove**: the `else if (app)` branch (lines 63-76)
- **Simplified** component:
  ```tsx
  interface Props {
    children: React.ReactNode;
    onReady?: () => void;
    serverUrl: string;  // required now
    token?: string;
  }
  
  export function ArkClientProvider({ children, onReady, serverUrl, token }: Props) {
    // Always WebSocket transport
    const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    const { transport, ready } = createWebSocketTransport(wsUrl, {
      token,
      reconnect: true,
      onStatus: (status) => { /* forwarded to client */ },
    });
    // ... rest unchanged
  }
  ```

**Step 8: Add connection status to TUI**
- File: `packages/tui/App.tsx`
- Subscribe to `ark.onConnectionStatus()` in `AppInner` component
- Add state: `const [connStatus, setConnStatus] = useState<string>("connected")`
- Render in status bar area:
  - `"connected"`: nothing (clean state)
  - `"reconnecting"`: yellow text "Reconnecting..."
  - `"disconnected"`: red text "Disconnected"
- Integrate with existing `useStatusMessage` hook pattern

### Phase 4: Boundary Hardening & Cleanup

**Step 9: Strengthen boundary test**
- File: `packages/tui/__tests__/daemon-client-boundary.test.ts`
- Add tests:
  ```ts
  it("no TUI source imports AppContext constructor", () => { ... });
  it("no TUI source imports ArkServer or registerAllHandlers", () => { ... });
  it("no TUI source imports from ../core/ except type-only", () => { ... });
  ```
- Existing `getApp` tests remain. The `index.tsx` exclusion for `loadConfig` may need special casing -- or better, extract config reading to a tiny shared module.

**Step 10: Update Makefile and docs**
- `Makefile`: `tui` target runs `bun packages/tui/index.tsx` (unchanged, but TUI now auto-starts daemon)
- `CLAUDE.md`: document:
  - Port map: 19100 (conductor), 19300 (arkd), 19400 (ArkServer/daemon)
  - `ark server daemon start [--detach]`, `stop`, `status`
  - TUI auto-starts daemon if not running
  - `ARK_TUI_EMBEDDED=1` fallback env var (Phase 5)

### Phase 5: Fallback (Safety Net)

**Step 11: Keep embedded mode as escape hatch**
- File: `packages/tui/index.tsx`
- If `ARK_TUI_EMBEDDED=1` is set, fall back to old behavior:
  - Import AppContext dynamically
  - Boot in-process
  - Use in-memory transport
- This preserves a working fallback for edge cases. Remove after confidence builds (one release cycle).

## Testing Strategy

### Unit Tests

1. **Transport reconnection** (`packages/protocol/__tests__/transport-reconnect.test.ts`):
   - WebSocket transport reconnects after server close
   - `onStatus` callbacks fire: connected -> reconnecting -> connected
   - Messages buffered during reconnect are flushed after reconnection
   - Backoff caps at `maxReconnectDelay`
   - `reconnect: false` (default) does not reconnect

2. **Server health endpoint** (add to existing `packages/server/__tests__/server.test.ts`):
   - `GET /health` returns `{ status: "ok", pid, uptime }` JSON
   - WebSocket upgrade still works on same port

3. **PID file lifecycle** (`packages/cli/__tests__/server-daemon.test.ts`):
   - Start writes PID file, stop removes it
   - Stale PID file (dead process) is cleaned up
   - Double start is rejected

### Integration Tests

4. **Daemon boot + client connect** (`packages/tui/__tests__/daemon-connect.test.ts`):
   - Start daemon in foreground (port offset for test isolation)
   - Connect ArkClient via WebSocket
   - Call `sessionList()`, verify valid response
   - Stop daemon, verify clean exit

### Boundary Tests (Strengthened)

5. **No AppContext in TUI** (updated `daemon-client-boundary.test.ts`):
   - No TUI source imports `AppContext` (class or constructor)
   - No TUI source imports `ArkServer` or `registerAllHandlers`
   - Only allowed core imports are type-only or config-reading

### Manual Verification Checklist

- [ ] `ark server daemon start --detach` starts daemon, PID file created
- [ ] `ark server daemon status` shows running
- [ ] `ark tui` connects to running daemon instantly (no boot delay)
- [ ] Kill TUI (Ctrl+Q), reopen `ark tui` -- instant reconnect, sessions preserved
- [ ] Kill daemon while TUI running -- TUI shows "Reconnecting..."
- [ ] Restart daemon -- TUI auto-reconnects, resumes working
- [ ] `ark server daemon stop` -- clean shutdown
- [ ] `ark tui` with no daemon -- auto-starts daemon, then connects
- [ ] `ARK_TUI_EMBEDDED=1 ark tui` -- falls back to in-process mode

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **TUI no longer works without daemon** | High -- behavioral change for all users | Phase 5: `ARK_TUI_EMBEDDED=1` fallback. Auto-start daemon on TUI launch so no extra step needed. |
| **Port 19400 conflict** | Medium -- another process holds the port | Clear error message + `--port` override. Status command detects and reports. |
| **Stale PID file after crash** | Low -- daemon crashes without cleanup | Status/start commands check process liveness, clean stale file automatically. |
| **Multiple TUI instances** | None -- intentional | Multiple WebSocket clients connect to same daemon. Notifications broadcast to all. |
| **Daemon dies mid-operation** | Medium -- TUI loses connection | WebSocket reconnection (Step 4) + message buffering. TUI shows status indicator. |
| **SQLite lock contention** | Low -- single daemon holds DB | Non-issue: only the daemon touches the DB. TUI goes through RPC. This is actually an improvement over the current architecture. |
| **Race at auto-start** | Low -- two TUIs start daemon simultaneously | Second spawn fails on port bind, falls through to health check, connects to first. |
| **`make tui` in CI/scripts** | Low -- automated usage may break | `ARK_TUI_EMBEDDED=1` preserves old behavior. CI tests that need it can set the env var. |

## Open Questions

1. **Should `make tui` auto-start the daemon, or require `ark server daemon start` first?**
   Recommendation: auto-start (Step 6). Better DX -- no extra command. The daemon persists after TUI exit for instant reconnect.

2. **Should the daemon auto-stop when the last client disconnects?**
   Recommendation: no. Keep running persistently. Benefits: instant reconnect, conductor stays up for running agents, schedules keep ticking. Users stop with `ark server daemon stop`.

3. **Should CLI commands (e.g. `ark session list`) also route through the daemon?**
   Recommendation: defer to a follow-up issue. CLI currently boots its own AppContext with `skipConductor: true` (read-only, fast). Routing through daemon is better long-term (no DB lock contention) but increases scope.

4. **Should `ark server start --ws` and `ark server daemon start` be unified?**
   Recommendation: yes, eventually. `server daemon` is `server start --ws --detach` with PID management. For now, keep them separate to avoid breaking existing `server start` behavior. Unify in a follow-up.

5. **How should the daemon handle config changes?**
   Currently `loadConfig()` runs once at boot. If the user edits `~/.ark/config.yaml`, they need to restart the daemon. This matches the current behavior (TUI reads config once at startup). A SIGHUP-triggered config reload could be added later.
