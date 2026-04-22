/**
 * session/attach-command handler tests.
 *
 * Covers the three cases the UI cares about: attachable (returns a real
 * `tmux attach` command), completed/failed/archived (returns attachable:false
 * with a reason), and not-yet-dispatched (no session_id on the row).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerSessionHandlers } from "../session.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";
import { localAdminContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerSessionHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

async function dispatch(method: string, params: Record<string, unknown>) {
  const ctx = localAdminContext(null);
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

async function createSession(fields: Record<string, unknown>): Promise<string> {
  const s = await app.sessions.create({ summary: "attach-command test" } as any);
  if (Object.keys(fields).length > 0) {
    await app.sessions.update(s.id, fields as any);
  }
  return s.id;
}

describe("session/attach-command", () => {
  it("returns attachable:true + a tmux attach command for a dispatched session", async () => {
    const id = await createSession({ session_id: "ark-foo-bar-1234", status: "running" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    expect("error" in res).toBe(false);
    const result = (res as any).result;
    expect(result.attachable).toBe(true);
    expect(result.command).toBe("tmux attach -t ark-foo-bar-1234");
    expect(result.displayHint).toContain("terminal");
    expect(result.reason).toBeUndefined();
  });

  it("returns attachable:false when the session has no tmux session_id yet", async () => {
    const id = await createSession({ session_id: null, status: "pending" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    expect("error" in res).toBe(false);
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.command).toBe("");
    expect(result.reason).toContain("dispatched");
  });

  it("returns attachable:false for a completed session", async () => {
    const id = await createSession({ session_id: "ark-done-1", status: "completed" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.reason).toContain("completed");
  });

  it("returns attachable:false for a failed session", async () => {
    const id = await createSession({ session_id: "ark-oops-1", status: "failed" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("returns attachable:false for an archived session", async () => {
    const id = await createSession({ session_id: "ark-old-1", status: "archived" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.reason).toContain("archived");
  });

  it("returns an RPC error for an unknown sessionId", async () => {
    const res = (await dispatch("session/attach-command", { sessionId: "s-does-not-exist" })) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("delegates to provider.getAttachCommand when the session has a compute", async () => {
    // Register a fake provider that returns an SSH-prefixed command so we can
    // assert the handler delegates to it rather than the plain local path.
    class FakeRemoteProvider {
      readonly name = "fake-remote";
      readonly singleton = false;
      readonly canReboot = true;
      readonly canDelete = true;
      readonly supportsWorktree = false;
      readonly initialStatus = "running";
      readonly needsAuth = false;
      readonly isolationModes: { value: string; label: string }[] = [];
      setApp(): void {
        /* no-op */
      }
      async provision(): Promise<void> {}
      async destroy(): Promise<void> {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async attach(): Promise<void> {}
      async cleanupSession(): Promise<void> {}
      async syncEnvironment(): Promise<void> {}
      async launch(): Promise<string> {
        return "";
      }
      async killAgent(): Promise<void> {}
      async captureOutput(): Promise<string> {
        return "";
      }
      async getMetrics(): Promise<any> {
        return {};
      }
      async probePorts(): Promise<any[]> {
        return [];
      }
      async checkSession(): Promise<boolean> {
        return true;
      }
      getAttachCommand(_c: any, s: any) {
        return ["ssh", "-i", "/tmp/key", "ubuntu@1.2.3.4", `tmux attach -t ${s.session_id}`];
      }
      buildChannelConfig(): Record<string, unknown> {
        return {};
      }
      buildLaunchEnv(): Record<string, string> {
        return {};
      }
    }
    app.registerProvider(new FakeRemoteProvider() as any);
    // Insert a compute row that points at the fake provider.
    await app.computes.insert({
      name: "fake-remote-1",
      provider: "fake-remote" as any,
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "running",
      config: { ip: "1.2.3.4" },
    } as any);
    const id = await createSession({
      session_id: "ark-remote-1",
      status: "running",
      compute_name: "fake-remote-1",
    });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(true);
    expect(result.command).toContain("ssh");
    expect(result.command).toContain("ubuntu@1.2.3.4");
    expect(result.command).toContain("tmux attach -t ark-remote-1");
    expect(result.displayHint).toContain("remote compute");
  });
});
