import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("session_list", () => {
  it("returns empty array when no sessions exist", async () => {
    const result = (await h.callTool("session_list", {})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("returns sessions after they are created", async () => {
    await h.app.sessions.create({ summary: "tool-test-1", flow: "bare" });
    await h.app.sessions.create({ summary: "tool-test-2", flow: "bare" });
    const result = (await h.callTool("session_list", {})) as { id: string }[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.find((s) => s.id.startsWith("s-"))).toBeDefined();
  });
});

describe("session_show", () => {
  it("returns session by id", async () => {
    const created = await h.app.sessions.create({ summary: "show-me", flow: "bare" });
    const result = (await h.callTool("session_show", { sessionId: created.id })) as {
      id: string;
      summary: string;
    };
    expect(result.id).toBe(created.id);
    expect(result.summary).toBe("show-me");
  });

  it("errors on unknown session", async () => {
    let err: unknown = null;
    try {
      await h.callTool("session_show", { sessionId: "s-does-not-exist" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
  });
});

describe("session_events", () => {
  it("returns array for fresh session", async () => {
    const created = await h.app.sessions.create({ summary: "events-test", flow: "bare" });
    const result = (await h.callTool("session_events", { sessionId: created.id })) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("session_events with type filter", () => {
  it("only returns events of the requested type", async () => {
    const created = await h.app.sessions.create({ summary: "filter-test", flow: "bare" });
    // Use whatever signature app.events.log accepts. Reference call sites in
    // packages/core/services/dispatch/post-launch.ts.
    await h.app.events.log(created.id, "alpha_event", { actor: "system" });
    await h.app.events.log(created.id, "beta_event", { actor: "system" });
    await h.app.events.log(created.id, "alpha_event", { actor: "system" });
    const result = (await h.callTool("session_events", { sessionId: created.id, type: "alpha_event" })) as {
      type: string;
    }[];
    expect(result.length).toBe(2);
    expect(result.every((e) => e.type === "alpha_event")).toBe(true);
  });
});
