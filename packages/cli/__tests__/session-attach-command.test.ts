/**
 * CLI `session attach` tests.
 *
 * Covers the `sessionAttachCommand` RPC wiring end-to-end through the
 * typed protocol client: attachable sessions return a tmux command,
 * completed sessions return attachable:false with a `reason`.
 *
 * The exec-side of --print-only vs interactive is not tested here; the
 * handler is small and its protocol contract is covered above.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
import { getArkClient, setRemoteServer, setServerPort, closeArkClient, shutdownInProcessApp } from "../app-client.js";

let app: AppContext;
let server: ReturnType<ArkServer["startWebSocket"]>;
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  port = app.config.ports.server;
  const s = new ArkServer();
  registerAllHandlers(s.router, app);
  s.attachLifecycle(app);
  server = s.startWebSocket(port, { app });
  setRemoteServer(`http://localhost:${port}`, undefined);
});

afterAll(async () => {
  closeArkClient();
  server.stop();
  await shutdownInProcessApp();
  await app.shutdown();
  setRemoteServer(undefined, undefined);
  setServerPort(undefined);
});

describe("ArkClient.sessionAttachCommand", () => {
  it("returns attachable:true with a tmux command for a dispatched running session", async () => {
    const s = await app.sessions.create({ summary: "attach-cli-ok" } as any);
    await app.sessions.update(s.id, { session_id: "ark-cli-test-1", status: "running" } as any);
    const ark = await getArkClient();
    const res = await ark.sessionAttachCommand(s.id);
    expect(res.attachable).toBe(true);
    expect(res.command).toContain("tmux attach");
    expect(res.command).toContain("ark-cli-test-1");
    expect(res.displayHint).toBeDefined();
  });

  it("returns attachable:false with a friendly reason for a completed session", async () => {
    const s = await app.sessions.create({ summary: "attach-cli-done" } as any);
    await app.sessions.update(s.id, { session_id: "ark-cli-done-1", status: "completed" } as any);
    const ark = await getArkClient();
    const res = await ark.sessionAttachCommand(s.id);
    expect(res.attachable).toBe(false);
    expect(res.command).toBe("");
    expect(res.reason).toContain("completed");
  });

  it("returns attachable:false when session has not been dispatched", async () => {
    const s = await app.sessions.create({ summary: "attach-cli-pending" } as any);
    const ark = await getArkClient();
    const res = await ark.sessionAttachCommand(s.id);
    expect(res.attachable).toBe(false);
    expect(res.reason).toContain("dispatched");
  });

  it("surfaces an RPC error for an unknown session id", async () => {
    const ark = await getArkClient();
    await expect(ark.sessionAttachCommand("s-nope-nonexistent")).rejects.toThrow(/not found/i);
  });
});
