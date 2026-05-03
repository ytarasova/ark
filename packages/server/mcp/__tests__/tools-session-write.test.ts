import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("session_start", () => {
  it("creates a session and returns its id", async () => {
    const result = (await h.callTool("session_start", {
      flow: "bare",
      summary: "mcp-start-test",
      compute: "local",
    })) as { sessionId: string };
    expect(result.sessionId).toMatch(/^s-/);
    const session = await h.app.sessions.get(result.sessionId);
    expect(session?.summary).toBe("mcp-start-test");
    expect(session?.flow).toBe("bare");
  });
});

describe("session_kill", () => {
  it("kills a target session -- sets status=killed, not failed (#419)", async () => {
    const created = await h.app.sessions.create({ summary: "kill-target", flow: "bare" });
    const result = (await h.callTool("session_kill", { sessionId: created.id })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const after = await h.app.sessions.get(created.id);
    expect(after?.status).toBe("killed");
    // Kill is not an error condition -- the status itself carries the intent.
    expect(after?.error).toBeNull();
  });

  it("does not overwrite an already-failed session with killed", async () => {
    const created = await h.app.sessions.create({ summary: "kill-terminal-failed", flow: "bare" });
    await h.app.sessions.update(created.id, { status: "failed", error: "boom" } as any);
    const result = (await h.callTool("session_kill", { sessionId: created.id })) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("terminal");
    const after = await h.app.sessions.get(created.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("boom");
  });

  it("is a no-op on an already-completed session", async () => {
    const created = await h.app.sessions.create({ summary: "kill-terminal-completed", flow: "bare" });
    await h.app.sessions.update(created.id, { status: "completed" } as any);
    const result = (await h.callTool("session_kill", { sessionId: created.id })) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("terminal");
    const after = await h.app.sessions.get(created.id);
    expect(after?.status).toBe("completed");
  });
});

describe("session_steer", () => {
  it("delegates to sessionService.send for the target session", async () => {
    // Freshly-created sessions have no live tmux pane, so sessionService.send
    // returns { ok: false, message: "No active session" }. The tool's job is
    // to delegate; we assert that delegation reached send by checking the
    // recognisable rejection shape.
    const created = await h.app.sessions.create({ summary: "steer-target", flow: "bare" });
    const result = (await h.callTool("session_steer", {
      sessionId: created.id,
      message: "hello from mcp",
    })) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toBe("No active session");
  });
});
