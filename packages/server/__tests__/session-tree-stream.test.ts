/**
 * Tests for the session/tree-stream subscription handler (B7).
 *
 * Covers:
 *   1. Initial snapshot is returned immediately.
 *   2. A `session/tree-update` notification is pushed (debounced) after a
 *      descendant status change emitted on the event bus.
 *   3. After the connection's Subscription is flushed (simulated close),
 *      subsequent bus events do NOT produce further notifications.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router, Subscription } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";
import { eventBus } from "../../core/hooks.js";
import { localAdminContext } from "../../core/auth/context.js";

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
  eventBus.clear();
});

/** Seed a root session + one child. Returns their ids. */
async function seedTree(): Promise<{ rootId: string; childId: string }> {
  const root = await app.sessions.create({ summary: `root-${Date.now()}-${Math.random()}` });
  const child = await app.sessions.create({ summary: "child" });
  await app.sessions.update(child.id, { parent_id: root.id });
  return { rootId: root.id, childId: child.id };
}

describe("session/tree-stream", () => {
  it("returns initial tree snapshot in the result", async () => {
    const { rootId } = await seedTree();
    const sub = new Subscription();
    const req = createRequest(1, "session/tree-stream", { sessionId: rootId });

    const res = (await router.dispatch(req, () => {}, localAdminContext(null), sub)) as JsonRpcResponse;

    expect(res.result).toBeDefined();
    const tree = (res.result as { tree: { id: string; children: unknown[] } }).tree;
    expect(tree.id).toBe(rootId);
    expect(Array.isArray(tree.children)).toBe(true);
    expect(tree.children.length).toBeGreaterThanOrEqual(1);

    // Cleanup so the bus listener doesn't leak between tests.
    sub.flush();
  });

  it("pushes session/tree-update notification when a descendant event fires", async () => {
    const { rootId, childId } = await seedTree();
    const sub = new Subscription();
    const notifications: Array<{ method: string; params: unknown }> = [];

    const notify = (method: string, params: unknown) => {
      notifications.push({ method, params: params as unknown });
    };

    const req = createRequest(2, "session/tree-stream", { sessionId: rootId });
    await router.dispatch(req, notify as any, localAdminContext(null), sub);

    // Emit a hook_status event for the child -- matches the SSE handler's filter.
    eventBus.emit("hook_status", childId, { data: { status: "completed" } });

    // The handler debounces at 200ms; wait long enough to observe the push.
    await Bun.sleep(350);

    const treeUpdates = notifications.filter((n) => n.method === "session/tree-update");
    expect(treeUpdates.length).toBeGreaterThanOrEqual(1);
    const payload = treeUpdates[0]!.params as { sessionId: string; root: { id: string } };
    expect(payload.sessionId).toBe(rootId);
    expect(payload.root.id).toBe(rootId);

    sub.flush();
  });

  it("stops pushing notifications after the subscription is flushed (simulated close)", async () => {
    const { rootId, childId } = await seedTree();
    const sub = new Subscription();
    const notifications: Array<{ method: string }> = [];

    const notify = (method: string) => {
      notifications.push({ method });
    };

    const req = createRequest(3, "session/tree-stream", { sessionId: rootId });
    await router.dispatch(req, notify as any, localAdminContext(null), sub);

    // Simulate the WS connection closing: flush registered cleanup functions.
    sub.flush();

    // Emit a bus event AFTER flush -- should not produce any notification.
    eventBus.emit("hook_status", childId, { data: { status: "running" } });

    await Bun.sleep(350);

    const treeUpdates = notifications.filter((n) => n.method === "session/tree-update");
    expect(treeUpdates.length).toBe(0);
  });

  it("returns error for unknown session id", async () => {
    const sub = new Subscription();
    const req = createRequest(4, "session/tree-stream", { sessionId: "s-nonexistent-xyz" });
    const res = await router.dispatch(req, () => {}, localAdminContext(null), sub);
    const err = (res as { error?: { code: number; message: string } }).error;
    expect(err).toBeDefined();
    expect(err!.code).toBe(-32002); // SESSION_NOT_FOUND
    sub.flush();
  });
});
