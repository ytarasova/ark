import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

describe("session/fan-out handler", () => {
  it("creates child sessions with parent_id set and parent goes to waiting", async () => {
    // Create parent session
    const startRes = await router.dispatch(createRequest(1, "session/start", {
      summary: "parent session",
      repo: ".",
      flow: "bare",
    }));
    const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
    const parentId = (startResult.session as Record<string, unknown>).id as string;
    expect(parentId).toMatch(/^s-/);

    // Fan out into two child sessions
    const notifications: any[] = [];
    const fanOutRes = await router.dispatch(
      createRequest(2, "session/fan-out", {
        sessionId: parentId,
        tasks: [
          { summary: "child task one" },
          { summary: "child task two", agent: "worker" },
        ],
      }),
      (_method, data) => notifications.push(data),
    );

    const result = (fanOutRes as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const childIds = result.childIds as string[];
    expect(childIds).toHaveLength(2);
    expect(childIds[0]).toMatch(/^s-/);
    expect(childIds[1]).toMatch(/^s-/);

    // Notifications emitted for each child
    expect(notifications.length).toBe(2);

    // Parent should be in "waiting" status
    const parent = app.sessions.get(parentId);
    expect(parent?.status).toBe("waiting");

    // Each child should have parent_id set
    for (const childId of childIds) {
      const child = app.sessions.get(childId);
      expect(child).toBeDefined();
      expect(child?.parent_id).toBe(parentId);
    }
  });

  it("children summaries match tasks provided", async () => {
    const startRes = await router.dispatch(createRequest(1, "session/start", {
      summary: "parent for summaries test",
      repo: ".",
      flow: "bare",
    }));
    const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
    const parentId = (startResult.session as Record<string, unknown>).id as string;

    const fanOutRes = await router.dispatch(
      createRequest(2, "session/fan-out", {
        sessionId: parentId,
        tasks: [
          { summary: "first task" },
          { summary: "second task" },
        ],
      }),
    );

    const result = (fanOutRes as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    const childIds = result.childIds as string[];

    const summaries = childIds.map((id) => app.sessions.get(id)?.summary);
    expect(summaries).toContain("first task");
    expect(summaries).toContain("second task");
  });

  it("returns error for unknown parent session", async () => {
    const fanOutRes = await router.dispatch(
      createRequest(3, "session/fan-out", {
        sessionId: "s-nonexistent",
        tasks: [{ summary: "orphan task" }],
      }),
    );

    const err = (fanOutRes as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.message).toBeTruthy();
  });

  it("returns error when no tasks provided", async () => {
    const startRes = await router.dispatch(createRequest(1, "session/start", {
      summary: "parent empty tasks",
      repo: ".",
      flow: "bare",
    }));
    const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
    const parentId = (startResult.session as Record<string, unknown>).id as string;

    const fanOutRes = await router.dispatch(
      createRequest(4, "session/fan-out", {
        sessionId: parentId,
        tasks: [],
      }),
    );

    const err = (fanOutRes as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.message).toBeTruthy();
  });
});
