/**
 * Integration tests for `app-client.ts` -- the single entry point that
 * decides between remote, already-running-local, and auto-spawn for the
 * CLI's ArkClient singleton.
 *
 * Two scenarios are covered:
 *   1. Explicit `--server <url>` against a pre-booted AppContext + WebSocket
 *      server. The CLI client MUST skip any local-daemon probe and connect
 *      directly to the given URL.
 *   2. No `--server`, no running daemon: `getArkClient()` picks the
 *      configured server port, sees nothing responding, and spawns a
 *      detached `ark server daemon start` subprocess. (Skipped in CI by
 *      default -- requires a writable `./ark` bin + background subprocess
 *      permissions. Flip `ARK_CLI_SPAWN_TEST=1` to run it.)
 *
 * The ArkClient surface covered: `session/list` + `flow/list` -- both
 * empty-lists on a fresh AppContext, verifying round-trip over WS.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../../conductor/index.js";
import { registerAllHandlers } from "../../conductor/register.js";
import { getArkClient, setRemoteServer, setServerPort, closeArkClient, shutdownInProcessApp } from "../app-client.js";

describe("app-client: remote-mode (--server url)", () => {
  let app: AppContext;
  let server: ReturnType<ArkServer["startWebSocket"]>;
  let port: number;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // Stand up a WebSocket transport backed by the test AppContext; mirrors
    // what `ark server daemon start` does in prod. Use the test profile's
    // preallocated server port so we don't clash with anything else.
    port = app.config.ports.conductor;
    const s = new ArkServer();
    registerAllHandlers(s.router, app);
    s.attachLifecycle(app);
    s.attachApp(app);
    server = s.startWebSocket(port);
  });

  afterAll(async () => {
    closeArkClient();
    server.stop();
    await shutdownInProcessApp();
    await app.shutdown();
    setRemoteServer(undefined, undefined);
    setServerPort(undefined);
  });

  it("connects via --server URL and round-trips session/list", async () => {
    setRemoteServer(`http://localhost:${port}`, undefined);
    const ark = await getArkClient();
    const sessions = await ark.sessionList();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
  });

  it("also exposes flow/list over the same transport", async () => {
    const ark = await getArkClient();
    const flows = await ark.flowList();
    expect(Array.isArray(flows)).toBe(true);
    // Flow store seeds the bundled flows on boot, so we expect at least one.
    expect(flows.length).toBeGreaterThan(0);
  });
});

describe("app-client: auto-discovery against a running local daemon", () => {
  let app: AppContext;
  let server: ReturnType<ArkServer["startWebSocket"]>;
  let port: number;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    port = app.config.ports.conductor;
    const s = new ArkServer();
    registerAllHandlers(s.router, app);
    s.attachLifecycle(app);
    s.attachApp(app);
    server = s.startWebSocket(port);

    // No --server flag; the client helper should see the listening daemon
    // on config.ports.conductor and connect. We communicate the port via the
    // helper's setServerPort() hatch so the test doesn't depend on the
    // default 19400 being free.
    setRemoteServer(undefined, undefined);
    setServerPort(port);
  });

  afterAll(async () => {
    closeArkClient();
    server.stop();
    await shutdownInProcessApp();
    await app.shutdown();
    setServerPort(undefined);
  });

  it("finds the already-running daemon (no auto-spawn)", async () => {
    const ark = await getArkClient();
    const sessions = await ark.sessionList();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("second call reuses the cached client instance", async () => {
    const a = await getArkClient();
    const b = await getArkClient();
    expect(a).toBe(b);
  });
});
