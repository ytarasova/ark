import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";
import { startConductor, type ConductorHandle } from "../../core/conductor/server/conductor.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import { eventBus } from "../../core/hooks.js";

// End-to-end coverage for the parent/child tree API added on top of
// session/list + the conductor REST surface. Each test boots a fresh
// AppContext per the CLAUDE.md guidance on parallel test isolation.

let app: AppContext;
let router: Router;
let conductor: ConductorHandle;
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  port = await allocatePort();
  conductor = startConductor(app, port, { quiet: true });
});

afterAll(async () => {
  conductor?.stop();
  await app?.shutdown();
  eventBus.clear();
});

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

/** Create root + 2 children + 1 grandchild. Returns the ids. */
async function seedFamily(): Promise<{ root: string; c1: string; c2: string; gc: string }> {
  const root = await app.sessions.create({ summary: `root-${Date.now()}-${Math.random()}` });
  const c1 = await app.sessions.create({ summary: "c1" });
  const c2 = await app.sessions.create({ summary: "c2" });
  const gc = await app.sessions.create({ summary: "gc" });
  await app.sessions.update(c1.id, { parent_id: root.id });
  await app.sessions.update(c2.id, { session_id: `ark-s-${c2.id}`, parent_id: root.id, status: "running" });
  await app.sessions.update(gc.id, { parent_id: c1.id });
  return { root: root.id, c1: c1.id, c2: c2.id, gc: gc.id };
}

describe("session/list with rootsOnly", async () => {
  it("returns only roots and attaches child_stats", async () => {
    const ids = await seedFamily();
    const res = ok(await router.dispatch(createRequest(1, "session/list", { rootsOnly: true })));
    const sessions = res.sessions as Array<{ id: string; child_stats: unknown; parent_id: string | null }>;
    expect(sessions.some((s) => s.id === ids.root)).toBe(true);
    // Children and grandchildren must be absent.
    expect(sessions.some((s) => s.id === ids.c1)).toBe(false);
    expect(sessions.some((s) => s.id === ids.gc)).toBe(false);
    // The root row carries a child_stats rollup.
    const rootRow = sessions.find((s) => s.id === ids.root)!;
    expect(rootRow.child_stats).not.toBeNull();
  });

  it("flat list behaviour is preserved when rootsOnly is absent", async () => {
    const ids = await seedFamily();
    const res = ok(await router.dispatch(createRequest(1, "session/list", {})));
    const sessions = res.sessions as Array<{ id: string }>;
    expect(sessions.some((s) => s.id === ids.root)).toBe(true);
    expect(sessions.some((s) => s.id === ids.c1)).toBe(true);
  });
});

describe("session/list_children", async () => {
  it("returns direct children only", async () => {
    const ids = await seedFamily();
    const res = ok(await router.dispatch(createRequest(1, "session/list_children", { sessionId: ids.root })));
    const sessions = res.sessions as Array<{ id: string; child_stats: unknown }>;
    expect(sessions.map((s) => s.id).sort()).toEqual([ids.c1, ids.c2].sort());
    // Grandchild must not appear in direct-children list.
    expect(sessions.some((s) => s.id === ids.gc)).toBe(false);
    // c1 has a grandchild -- its child_stats should be non-null.
    const c1Row = sessions.find((s) => s.id === ids.c1)!;
    expect(c1Row.child_stats).not.toBeNull();
  });
});

describe("session/tree", async () => {
  it("returns the recursive tree shape", async () => {
    const ids = await seedFamily();
    const res = ok(await router.dispatch(createRequest(1, "session/tree", { sessionId: ids.root })));
    const root = res.root as { id: string; children: Array<{ id: string; children: unknown[] }> };
    expect(root.id).toBe(ids.root);
    expect(root.children.length).toBe(2);
    const c1Node = root.children.find((n) => n.id === ids.c1)!;
    expect(c1Node.children.length).toBe(1);
    expect((c1Node.children[0] as { id: string }).id).toBe(ids.gc);
  });

  it("rejects non-root session ids with Parent-session required", async () => {
    const ids = await seedFamily();
    const res = await router.dispatch(createRequest(1, "session/tree", { sessionId: ids.c1 }));
    // RpcError surfaces with SESSION_NOT_FOUND code (-32002) wrapping the
    // "Parent-session required" message.
    const err = (res as { error?: { message: string } }).error;
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/Parent-session required/);
  });
});

describe("HTTP GETs for tree endpoints", async () => {
  it("GET /api/sessions?roots=true returns the rootsOnly list", async () => {
    const ids = await seedFamily();
    const resp = await fetch(`http://localhost:${port}/api/sessions?roots=true`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Array<{ id: string; child_stats: unknown }>;
    const row = body.find((s) => s.id === ids.root);
    expect(row).toBeDefined();
    expect(row!.child_stats).not.toBeNull();
  });

  it("GET /api/sessions/:id/children returns direct children", async () => {
    const ids = await seedFamily();
    const resp = await fetch(`http://localhost:${port}/api/sessions/${ids.root}/children`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions.map((s) => s.id).sort()).toEqual([ids.c1, ids.c2].sort());
  });

  it("GET /api/sessions/:id/tree returns the recursive tree", async () => {
    const ids = await seedFamily();
    const resp = await fetch(`http://localhost:${port}/api/sessions/${ids.root}/tree`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { root: { id: string; children: unknown[] } };
    expect(body.root.id).toBe(ids.root);
    expect(body.root.children.length).toBe(2);
  });

  it("GET /api/sessions/:id/tree returns 400 for non-root id", async () => {
    const ids = await seedFamily();
    const resp = await fetch(`http://localhost:${port}/api/sessions/${ids.c1}/tree`);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/Parent-session required/);
  });
});

describe("SSE /api/sessions/:id/tree/stream", async () => {
  it("emits initial snapshot, then a delta when a descendant status changes", async () => {
    const ids = await seedFamily();

    // Start the stream. We use Bun's fetch which exposes the body as a
    // ReadableStream; we decode chunks until we've seen two `tree-update`
    // events (the initial snapshot + one delta).
    const resp = await fetch(`http://localhost:${port}/api/sessions/${ids.root}/tree/stream`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/event-stream/);

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();

    const events: string[] = [];
    const readOneEvent = async (): Promise<string> => {
      let buf = "";
      // Read until we hit the SSE record terminator (double newline).
      while (!buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      const idx = buf.indexOf("\n\n");
      const record = buf.slice(0, idx);
      events.push(record);
      return record;
    };

    const first = await readOneEvent();
    expect(first).toContain("event: tree-update");
    expect(first).toContain(ids.root);

    // Trigger a change on a descendant; the conductor's SSE bus hook
    // subscribes to `hook_status`, so we emit that directly.
    eventBus.emit("hook_status", ids.c2, { data: { status: "completed" } });

    // The SSE handler debounces at 200ms, so the second event arrives after
    // that window. The reader blocks until bytes arrive.
    const second = await readOneEvent();
    expect(second).toContain("event: tree-update");

    // Cancel the reader so the SSE handler's cancel() runs and the stream
    // unsubscribes from the event bus.
    await reader.cancel();
  });
});
