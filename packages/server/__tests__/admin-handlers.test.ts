/**
 * Admin JSON-RPC handler gate tests.
 *
 * Every `admin/*` route must reject non-admin TenantContexts with FORBIDDEN
 * and accept admin contexts. Local / single-user dispatches (no explicit
 * ctx) fall back to the router's local-admin default and should succeed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerAdminHandlers } from "../handlers/admin.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../protocol/types.js";
import { anonymousContext, localAdminContext, type TenantContext } from "../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerAdminHandlers(router, app);
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

describe("admin/* handler gate", () => {
  it("returns FORBIDDEN for every admin method when ctx is anonymous / non-admin", async () => {
    const anon = anonymousContext();
    const methods: Array<[string, Record<string, unknown>]> = [
      ["admin/tenant/list", {}],
      ["admin/tenant/get", { id: "t-x" }],
      ["admin/tenant/create", { slug: "x", name: "X" }],
      ["admin/tenant/update", { id: "t-x" }],
      ["admin/tenant/set-status", { id: "t-x", status: "active" }],
      ["admin/tenant/delete", { id: "t-x" }],
      ["admin/team/list", { tenant_id: "t-x" }],
      ["admin/team/get", { id: "tm-x" }],
      ["admin/team/create", { tenant_id: "t-x", slug: "s", name: "N" }],
      ["admin/team/update", { id: "tm-x" }],
      ["admin/team/delete", { id: "tm-x" }],
      ["admin/team/members/list", { team_id: "tm-x" }],
      ["admin/team/members/add", { team_id: "tm-x", email: "a@b.c" }],
      ["admin/team/members/remove", { team_id: "tm-x", email: "a@b.c" }],
      ["admin/team/members/set-role", { team_id: "tm-x", email: "a@b.c", role: "member" }],
      ["admin/user/list", {}],
      ["admin/user/get", { id: "u-x" }],
      ["admin/user/create", { email: "a@b.c" }],
      ["admin/user/upsert", { email: "a@b.c" }],
      ["admin/user/delete", { id: "u-x" }],
    ];

    for (const [method, params] of methods) {
      const res = (await dispatchAs(method, params, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/admin/i);
    }
  });

  it("admin ctx passes the gate and admin/tenant/list resolves", async () => {
    const admin = localAdminContext(null);
    const res = (await dispatchAs("admin/tenant/list", {}, admin)) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    expect((res.result as Record<string, unknown>).tenants).toBeDefined();
  });

  it("default dispatch (no explicit ctx) uses local-admin and succeeds", async () => {
    // The Router's default ctx falls back to a local-admin context when
    // callers don't thread one through (matches the single-user CLI flow).
    const res = (await router.dispatch(createRequest(1, "admin/tenant/list", {}))) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    expect((res.result as Record<string, unknown>).tenants).toBeDefined();
  });

  it("admin/tenant/create with a member-role ctx returns FORBIDDEN", async () => {
    const memberCtx: TenantContext = {
      tenantId: "t-member",
      userId: "u-member",
      role: "member",
      isAdmin: false,
    };
    const res = (await dispatchAs("admin/tenant/create", { slug: "abc", name: "Acme" }, memberCtx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });
});
