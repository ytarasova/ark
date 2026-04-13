/**
 * Integration test for the daemon.
 *
 * Boots a daemon with a test AppContext, connects via WebSocket, sends
 * JSON-RPC requests, and verifies the full round trip.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { loadConfig } from "../../core/config.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
import { ArkClient } from "../../protocol/client.js";
import { createWebSocketTransport } from "../../protocol/transport.js";
import { writeLockfile, readLockfile, removeLockfile, lockfilePath } from "../lockfile.js";
import { checkDaemonHealth } from "../health.js";

describe("daemon integration", () => {
  let app: AppContext | null = null;
  let wsStop: (() => void) | null = null;
  let tempDir: string;

  afterEach(async () => {
    if (wsStop) { wsStop(); wsStop = null; }
    if (app) { await app.shutdown(); clearApp(); app = null; }
  });

  it("boots daemon, serves RPC over WebSocket, and shuts down cleanly", async () => {
    // 1. Create test AppContext (skips conductor/arkd to avoid port conflicts in tests)
    tempDir = mkdtempSync(join(tmpdir(), "ark-daemon-test-"));
    const config = loadConfig({ arkDir: tempDir, env: "test" });
    app = new AppContext(config, {
      skipConductor: true,
      skipMetrics: true,
      skipSignals: true,
      cleanupOnShutdown: true,
    });
    setApp(app);
    await app.boot();

    // 2. Start WS server (ArkServer) on a random port
    const server = new ArkServer();
    registerAllHandlers(server.router, app);
    // Use port 0 equivalent: find a free port
    const port = 19450 + Math.floor(Math.random() * 50);
    const handle = server.startWebSocket(port);
    wsStop = () => handle.stop();

    // 3. Write lockfile
    const wsUrl = `ws://127.0.0.1:${port}`;
    writeLockfile(tempDir, {
      pid: process.pid,
      ws_url: wsUrl,
      conductor_port: 19100,
      arkd_port: 19300,
      started_at: new Date().toISOString(),
    });

    // 4. Verify lockfile was written
    expect(existsSync(lockfilePath(tempDir))).toBe(true);
    const lockInfo = readLockfile(tempDir);
    expect(lockInfo?.ws_url).toBe(wsUrl);

    // 5. Health check
    const healthy = await checkDaemonHealth(wsUrl);
    expect(healthy).toBe(true);

    // 6. Connect a client via WS and send RPCs
    const { transport, ready } = createWebSocketTransport(wsUrl);
    await ready;

    const client = new ArkClient(transport);
    const initResult = await client.initialize({ subscribe: ["**"] });
    expect(initResult.server.name).toBe("ark-server");

    // 7. List sessions (start requires tmux, so just verify the RPC round-trip)
    const sessions = await client.sessionList({ limit: 10 });
    expect(Array.isArray(sessions)).toBe(true);

    // 8. Cleanup
    client.close();
    handle.stop();
    wsStop = null;
    removeLockfile(tempDir);
    expect(existsSync(lockfilePath(tempDir))).toBe(false);
  });
});
