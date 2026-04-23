/**
 * Regression test: hosted web server must thread the authenticated
 * `TenantContext` into the RPC router so that admin / role gates see the
 * caller's real role instead of defaulting to local-admin.
 *
 * Before the fix, `rpcRouter.dispatch(body)` omitted the third ctx arg,
 * causing the router to fall back to `localAdminContext()` and letting
 * viewer / member tokens bypass `requireAdmin(ctx)` on `admin/*` routes.
 *
 * Batch 1, Server P0-1 (docs/2026-04-22-code-quality-audit.md).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { startWebServer } from "../hosted/web.js";
import { allocatePort } from "../config/port-allocator.js";

let app: AppContext;
let server: { stop: () => void; url: string } | null = null;
let viewerKey: string;
let memberKey: string;
let adminKey: string;
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync({
    auth: { enabled: true, apiKeyEnabled: true },
  } as any);
  await app.boot();

  const created = await app.apiKeys.create("t-viewers", "viewer-key", "viewer");
  viewerKey = created.key;
  const memberCreated = await app.apiKeys.create("t-members", "member-key", "member");
  memberKey = memberCreated.key;
  const adminCreated = await app.apiKeys.create("t-admins", "admin-key", "admin");
  adminKey = adminCreated.key;

  port = await allocatePort();
  server = startWebServer(app, { port });
});

afterAll(async () => {
  server?.stop();
  server = null;
  await app?.shutdown();
});

async function rpc(method: string, params: Record<string, unknown>, token: string) {
  const resp = await fetch(`http://localhost:${port}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await resp.json()) as Record<string, unknown>;
}

describe("hosted/web: TenantContext threading", () => {
  it("viewer-role token receives FORBIDDEN from admin/tenant/list", async () => {
    const data = await rpc("admin/tenant/list", {}, viewerKey);
    expect(data.error).toBeDefined();
    // ErrorCodes.FORBIDDEN = -32006
    expect((data.error as any).code).toBe(-32006);
    expect((data.error as any).message).toMatch(/admin/i);
  });

  it("member-role token also receives FORBIDDEN from admin/tenant/list", async () => {
    const data = await rpc("admin/tenant/list", {}, memberKey);
    expect(data.error).toBeDefined();
    expect((data.error as any).code).toBe(-32006);
  });

  it("admin-role token succeeds on admin/tenant/list", async () => {
    // t-admins does not exist as a tenant row, but the handler list method
    // returns every tenant regardless of the admin's tenant_id -- only the
    // admin gate matters for authZ.
    const data = await rpc("admin/tenant/list", {}, adminKey);
    expect(data.error).toBeUndefined();
    expect(data.result).toBeDefined();
  });
});
