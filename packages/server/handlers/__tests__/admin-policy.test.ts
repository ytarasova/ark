/**
 * admin/tenant/policy/* gate + happy-path tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerAdminPolicyHandlers } from "../admin-policy.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";
import { anonymousContext, localAdminContext, type TenantContext } from "../../../core/auth/context.js";

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
  registerAdminPolicyHandlers(router, app);
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

describe("admin/tenant/policy/* handler gate", () => {
  it("returns FORBIDDEN for every policy method when ctx is anonymous", async () => {
    const anon = anonymousContext();
    const methods: Array<[string, Record<string, unknown>]> = [
      ["admin/tenant/policy/list", {}],
      ["admin/tenant/policy/get", { tenant_id: "t-x" }],
      ["admin/tenant/policy/set", { tenant_id: "t-x" }],
      ["admin/tenant/policy/delete", { tenant_id: "t-x" }],
    ];

    for (const [method, params] of methods) {
      const res = (await dispatchAs(method, params, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/admin/i);
    }
  });

  it("member role is also denied", async () => {
    const memberCtx: TenantContext = {
      tenantId: "t-mem",
      userId: "u-mem",
      role: "member",
      isAdmin: false,
    };
    const res = (await dispatchAs("admin/tenant/policy/set", { tenant_id: "t-mem" }, memberCtx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("admin can set, get, list, and delete a policy end-to-end", async () => {
    const admin = localAdminContext(null);
    const tenantId = `t-policy-${Date.now()}`;

    // set (new)
    const setRes = (await dispatchAs(
      "admin/tenant/policy/set",
      {
        tenant_id: tenantId,
        allowed_providers: ["k8s", "ec2"],
        default_provider: "k8s",
        max_concurrent_sessions: 7,
        max_cost_per_day_usd: 50,
      },
      admin,
    )) as JsonRpcResponse;
    expect(setRes.result).toBeDefined();
    const setPolicy = (setRes.result as any).policy;
    expect(setPolicy.tenant_id).toBe(tenantId);
    expect(setPolicy.allowed_providers).toEqual(["k8s", "ec2"]);
    expect(setPolicy.max_concurrent_sessions).toBe(7);
    expect(setPolicy.max_cost_per_day_usd).toBe(50);

    // get
    const getRes = (await dispatchAs("admin/tenant/policy/get", { tenant_id: tenantId }, admin)) as JsonRpcResponse;
    expect((getRes.result as any).policy.tenant_id).toBe(tenantId);
    expect((getRes.result as any).policy.max_concurrent_sessions).toBe(7);

    // partial update -- only bump max_concurrent_sessions, providers should persist
    const updateRes = (await dispatchAs(
      "admin/tenant/policy/set",
      { tenant_id: tenantId, max_concurrent_sessions: 12 },
      admin,
    )) as JsonRpcResponse;
    const updated = (updateRes.result as any).policy;
    expect(updated.max_concurrent_sessions).toBe(12);
    expect(updated.allowed_providers).toEqual(["k8s", "ec2"]);

    // list (our tenant should appear)
    const listRes = (await dispatchAs("admin/tenant/policy/list", {}, admin)) as JsonRpcResponse;
    const all = (listRes.result as any).policies as Array<{ tenant_id: string }>;
    expect(all.some((p) => p.tenant_id === tenantId)).toBe(true);

    // delete
    const delRes = (await dispatchAs("admin/tenant/policy/delete", { tenant_id: tenantId }, admin)) as JsonRpcResponse;
    expect((delRes.result as any).ok).toBe(true);

    // get after delete -> policy is null
    const getAfter = (await dispatchAs("admin/tenant/policy/get", { tenant_id: tenantId }, admin)) as JsonRpcResponse;
    expect((getAfter.result as any).policy).toBeNull();
  });
});
