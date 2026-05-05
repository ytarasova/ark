/**
 * session/attach-command handler tests.
 *
 * The handler is a thin wrapper around SessionAttachService.planFor.
 * Tests assert the discriminated AttachPlan shape one variant at a time:
 *
 *   - mode: "interactive"  for a dispatched tmux-runtime session.
 *     Carries `command` (ark-native, user-facing) AND `transportCommand`
 *     (raw tmux/SSM/kubectl, CLI-only).
 *   - mode: "tail"         for non-interactive runtimes (claude-agent).
 *     Carries transcript + stdio paths and a reason.
 *   - mode: "none"         for terminal status / not-yet-dispatched.
 *     Carries reason only.
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

async function plan(id: string) {
  const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
  expect("error" in res).toBe(false);
  return (res as any).result;
}

describe("session/attach-command", () => {
  it("interactive plan for a dispatched tmux-runtime session", async () => {
    const id = await createSession({ session_id: "ark-foo-bar-1234", status: "running" });
    const p = await plan(id);
    expect(p.mode).toBe("interactive");
    // User-facing command is ark-native -- never the raw transport.
    expect(p.command).toBe(`ark session attach ${id}`);
    // Transport command IS the raw transport, for the CLI to exec.
    expect(p.transportCommand).toBe("tmux attach -t ark-foo-bar-1234");
    expect(p.displayHint).toContain("ark");
  });

  it("none plan when the session has no tmux session_id yet", async () => {
    const id = await createSession({ session_id: null, status: "pending" });
    const p = await plan(id);
    expect(p.mode).toBe("none");
    expect(p.reason).toContain("dispatched");
  });

  it("none plan for a completed session", async () => {
    const id = await createSession({ session_id: "ark-done-1", status: "completed" });
    const p = await plan(id);
    expect(p.mode).toBe("none");
    expect(p.reason).toContain("completed");
  });

  it("none plan for a failed session", async () => {
    const id = await createSession({ session_id: "ark-oops-1", status: "failed" });
    const p = await plan(id);
    expect(p.mode).toBe("none");
    expect(p.reason).toContain("failed");
  });

  it("none plan for an archived session", async () => {
    const id = await createSession({ session_id: "ark-old-1", status: "archived" });
    const p = await plan(id);
    expect(p.mode).toBe("none");
    expect(p.reason).toContain("archived");
  });

  it("tail plan for claude-agent (runtime.interactive === false)", async () => {
    // claude-agent runs as a plain process via arkd /process/spawn -- no
    // PTY. The runtime YAML declares `interactive: false`; the handler
    // resolves the runtime through the executor name and returns "tail".
    const id = await createSession({
      session_id: "ark-process-1",
      status: "running",
      config: { launch_executor: "claude-agent" },
    });
    const p = await plan(id);
    expect(p.mode).toBe("tail");
    expect(p.transcriptPath).toContain(`/${id}/transcript.jsonl`);
    expect(p.stdioPath).toContain(`/${id}/stdio.log`);
    expect(p.reason).toMatch(/plain process|no interactive/i);
  });

  it("rpc error for an unknown sessionId", async () => {
    const res = (await dispatch("session/attach-command", { sessionId: "s-does-not-exist" })) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("interactive plan for remote compute -- ark-native command, transport from provider", async () => {
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
      setApp(): void {}
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
        return ["aws", "ssm", "start-session", "--target", "i-fake", "--", `tmux attach -t ${s.session_id}`];
      }
      buildChannelConfig(): Record<string, unknown> {
        return {};
      }
      buildLaunchEnv(): Record<string, string> {
        return {};
      }
    }
    app.registerProvider(new FakeRemoteProvider() as any);
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
    const p = await plan(id);
    expect(p.mode).toBe("interactive");
    // User-facing command never leaks the raw transport.
    expect(p.command).toBe(`ark session attach ${id}`);
    expect(p.command).not.toContain("aws");
    expect(p.command).not.toContain("ssm");
    expect(p.command).not.toContain("tmux");
    // Transport command IS the raw provider output for the CLI to exec.
    expect(p.transportCommand).toContain("aws ssm start-session");
    expect(p.transportCommand).toContain("ark-remote-1");
  });
});
