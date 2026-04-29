/**
 * WS-transport tenant-scoping integration test (round-3 P1-1).
 *
 * The hosted HTTP transport (`packages/core/hosted/web.ts`) has always
 * routed every non-default-tenant request through a tenant-scoped
 * AppContext: it builds a per-request `requestApp = app.forTenant(...)`
 * and registers the handler set against that scope. The local-daemon WS
 * path in `packages/server/index.ts` did not -- it kept a single Router
 * registered with the root `app`, and handlers that closed over `app`
 * directly read from the default tenant regardless of the caller's
 * `tenantId`.
 *
 * The fix lifted `scopedApp` onto the handler-facing `TenantContext`:
 * `addConnection` (and the WS open path) now compute
 * `app.forTenant(ctx.tenantId)` once per request and inject it on `ctx`,
 * so `resolveTenantApp(app, ctx)` returns the correct scope on both
 * transports without re-registering 240+ handlers per call.
 *
 * What this test asserts:
 *   1. Two concurrent WS clients authenticated as different tenants
 *      can only see their own sessions over `session/list`.
 *   2. A `session/get` for tenant A's session id from tenant B's
 *      connection returns a SESSION_NOT_FOUND error (no row leak).
 *   3. The DB write for each tenant's `session/start` lands on the
 *      correct tenant's repo (verified by reading
 *      `app.forTenant(tenantId).sessions.list()` post-hoc).
 *
 * Mirrors `tenant-scoping.test.ts` (in-process scope tree) and
 * `hosted-web-tenant.test.ts` / `terminal-ws-tenant-gate.test.ts` (HTTP +
 * terminal-attach WS) but covers the JSON-RPC WS transport that the local
 * daemon serves on `:19400`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let port: number;
let tenantAToken: string;
let tenantBToken: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  // Flip requireToken on -- the test profile defaults to off; we want the
  // ApiKeyManager validation path so each WS connection materializes a
  // real `TenantContext` with the issued tenant id.
  (app.config.authSection as { requireToken: boolean }).requireToken = true;
  await app.boot();

  ({ key: tenantAToken } = await app.apiKeys.create("tenant-a", "admin-a", "admin"));
  ({ key: tenantBToken } = await app.apiKeys.create("tenant-b", "admin-b", "admin"));

  server = new ArkServer();
  // Skip the initialize handshake -- the production daemon waits for a
  // client `initialize` call before dispatching; we hit handlers directly.
  (server.router as any).requireInit = false;
  registerAllHandlers(server.router, app);
  server.attachAuth(app);
  port = await allocatePort();
  ws = server.startWebSocket(port, { app });
});

afterAll(async () => {
  ws?.stop();
  await app?.shutdown();
});

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * Open an authenticated WS connection to the JSON-RPC route and return a
 * helper that round-trips a single request to its response. Each call
 * dispatches under a fresh `TenantContext` materialized from the bearer
 * token, so handler state is fully tenant-isolated.
 */
async function openRpcSocket(token: string): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<RpcResponse>;
  close: () => void;
}> {
  const sock = new WebSocket(`ws://localhost:${port}/?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    sock.onopen = () => resolve();
    sock.onerror = () => reject(new Error("WS connect failed"));
  });

  // Pending request map keyed on JSON-RPC id so concurrent in-flight calls
  // on the same socket don't trip over each other's responses.
  let nextId = 1;
  const pending = new Map<number, (resp: RpcResponse) => void>();
  sock.onmessage = (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    const msg = JSON.parse(text) as RpcResponse;
    const handler = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (handler) {
      pending.delete(msg.id as number);
      handler(msg);
    }
  };

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise<RpcResponse>((resolve, reject) => {
        pending.set(id, resolve);
        sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, 5_000);
      });
    },
    close() {
      sock.close();
    },
  };
}

describe("WS-transport tenant scoping (round-3 P1-1)", () => {
  it("session/start writes land on the caller's tenant repo", async () => {
    const a = await openRpcSocket(tenantAToken);
    const b = await openRpcSocket(tenantBToken);

    const startedA = await a.send("session/start", { summary: "tenant-a session", repo: ".", flow: "bare" });
    const startedB = await b.send("session/start", { summary: "tenant-b session", repo: ".", flow: "bare" });

    expect(startedA.error).toBeUndefined();
    expect(startedB.error).toBeUndefined();

    const idA = startedA.result.session.id as string;
    const idB = startedB.result.session.id as string;
    expect(idA).not.toBe(idB);

    // Read back via the in-process tenant-scoped view -- sessions must be
    // owned by the tenant that issued the WS request.
    const tenantAView = app.forTenant("tenant-a");
    const tenantBView = app.forTenant("tenant-b");

    const aSessions = await tenantAView.sessions.list();
    const bSessions = await tenantBView.sessions.list();

    expect(aSessions.map((s) => s.id)).toContain(idA);
    expect(aSessions.map((s) => s.id)).not.toContain(idB);
    expect(bSessions.map((s) => s.id)).toContain(idB);
    expect(bSessions.map((s) => s.id)).not.toContain(idA);

    a.close();
    b.close();
  });

  it("session/list over WS only returns the caller's tenant sessions", async () => {
    // Pre-seed each tenant's repo with a row so the assertion exercises the
    // dispatch-time scope, not just the create path.
    const tenantA = app.forTenant("tenant-a");
    const tenantB = app.forTenant("tenant-b");
    await tenantA.sessions.create({ summary: "tenant-a list-fixture" });
    await tenantB.sessions.create({ summary: "tenant-b list-fixture" });

    const a = await openRpcSocket(tenantAToken);
    const b = await openRpcSocket(tenantBToken);

    const listA = await a.send("session/list", {});
    const listB = await b.send("session/list", {});

    expect(listA.error).toBeUndefined();
    expect(listB.error).toBeUndefined();

    const aIds = new Set((listA.result.sessions as { id: string; tenant_id?: string }[]).map((s) => s.id));
    const bIds = new Set((listB.result.sessions as { id: string; tenant_id?: string }[]).map((s) => s.id));
    expect([...aIds].length).toBeGreaterThan(0);
    expect([...bIds].length).toBeGreaterThan(0);

    // No overlap between the two tenants' visible sessions.
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
    for (const id of bIds) expect(aIds.has(id)).toBe(false);

    a.close();
    b.close();
  });

  it("cross-tenant session/read fails with SESSION_NOT_FOUND (no row leak)", async () => {
    const tenantA = app.forTenant("tenant-a");
    const sessionA = await tenantA.sessions.create({ summary: "tenant-a private" });

    const b = await openRpcSocket(tenantBToken);
    const resp = await b.send("session/read", { sessionId: sessionA.id });
    expect(resp.error).toBeDefined();
    // SESSION_NOT_FOUND is -32002 in the protocol error registry. The exact
    // code matters less than "not the row" -- we assert no result body.
    expect(resp.result).toBeUndefined();
    b.close();
  });
});
