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
  it("returns attachable:true + an ark session attach command for a dispatched tmux-runtime session", async () => {
    // Tmux-based runtimes (no launch_executor field, or claude-code /
    // codex / gemini / goose) get the ark-native attach command. The
    // raw transport (`tmux attach`, `aws ssm start-session`, `kubectl
    // exec`) is intentionally NOT surfaced -- that's an ark-internal
    // detail, not user-facing.
    const id = await createSession({ session_id: "ark-foo-bar-1234", status: "running" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    expect("error" in res).toBe(false);
    const result = (res as any).result;
    expect(result.attachable).toBe(true);
    expect(result.command).toBe(`ark session attach ${id}`);
    expect(result.command).not.toContain("tmux");
    expect(result.command).not.toContain("aws ssm");
    expect(result.command).not.toContain("kubectl");
    expect(result.displayHint).toContain("ark");
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

  it("returns attachable:false for claude-agent (no interactive PTY)", async () => {
    // claude-agent / agent-sdk runtimes spawn a plain process via arkd
    // /process/spawn. There is no tmux pane and no PTY; attaching just
    // reconnect-loops. Surface the right empty-state instead.
    const id = await createSession({
      session_id: "ark-process-1",
      status: "running",
      config: { launch_executor: "claude-agent" },
    });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.command).toBe("");
    expect(result.reason).toMatch(/no interactive terminal|plain process/i);
  });

  it("returns an RPC error for an unknown sessionId", async () => {
    const res = (await dispatch("session/attach-command", { sessionId: "s-does-not-exist" })) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("returns the ark-native command for remote compute (no transport leak)", async () => {
    // Pre-existing design surfaced raw `aws ssm start-session ...` /
    // `kubectl exec ...` strings, which forced users to install AWS CLI
    // / kubectl just to attach and leaked instance ids + document names
    // to the UI. The new design always returns `ark session attach <id>`
    // and lets ark do the SSM / kubectl tunneling internally.
    class FakeRemoteProvider {
      readonly name = "ec2";
      readonly singleton = false;
      readonly canReboot = true;
      readonly canDelete = true;
      readonly supportsWorktree = false;
      readonly initialStatus = "running";
      readonly needsAuth = false;
      readonly supportsSecretMount = false;
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
      isolation_kind: "direct",
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
    // ark-native command -- never the raw transport. The provider's
    // `getAttachCommand` is used by `ark session attach` internally;
    // we don't surface it to the UI any more.
    expect(result.command).toBe(`ark session attach ${id}`);
    expect(result.command).not.toContain("ssh");
    expect(result.command).not.toContain("aws ssm");
    expect(result.command).not.toContain("kubectl");
    expect(result.command).not.toContain("ubuntu@");
    expect(result.displayHint).toContain("ark");
  });
});
