/**
 * admin/apikey/* gate + happy-path tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerAdminApiKeyHandlers } from "../admin-apikey.js";
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
  registerAdminApiKeyHandlers(router, app);
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

describe("admin/apikey/* handler gate", () => {
  it("returns FORBIDDEN for every apikey method when ctx is anonymous", async () => {
    const anon = anonymousContext();
    const methods: Array<[string, Record<string, unknown>]> = [
      ["admin/apikey/list", { tenant_id: "t-x" }],
      ["admin/apikey/create", { tenant_id: "t-x", name: "dev" }],
      ["admin/apikey/revoke", { id: "ak-xxxx" }],
      ["admin/apikey/rotate", { id: "ak-xxxx" }],
    ];

    for (const [method, params] of methods) {
      const res = (await dispatchAs(method, params, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/admin/i);
    }
  });

  it("viewer role is also denied", async () => {
    const viewerCtx: TenantContext = {
      tenantId: "t-v",
      userId: "u-v",
      role: "viewer",
      isAdmin: false,
    };
    const res = (await dispatchAs("admin/apikey/create", { tenant_id: "t-v", name: "dev" }, viewerCtx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("admin can create, list, rotate, and revoke an API key end-to-end", async () => {
    const admin = localAdminContext(null);
    const tenantId = `t-apikey-${Date.now()}`;

    // create
    const createRes = (await dispatchAs(
      "admin/apikey/create",
      { tenant_id: tenantId, name: "ci", role: "member" },
      admin,
    )) as JsonRpcResponse;
    const created = createRes.result as { id: string; key: string; tenant_id: string; role: string };
    expect(created.id).toMatch(/^ak-/);
    expect(created.key).toMatch(new RegExp(`^ark_${tenantId}_`));
    expect(created.role).toBe("member");

    // list
    const listRes = (await dispatchAs("admin/apikey/list", { tenant_id: tenantId }, admin)) as JsonRpcResponse;
    const listed = (listRes.result as any).keys as Array<{ id: string; name: string; role: string }>;
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].role).toBe("member");
    // defensive: no keyHash leak
    expect((listed[0] as any).keyHash).toBeUndefined();
    expect((listed[0] as any).key_hash).toBeUndefined();

    // rotate
    const rotateRes = (await dispatchAs(
      "admin/apikey/rotate",
      { id: created.id, tenant_id: tenantId },
      admin,
    )) as JsonRpcResponse;
    const rotated = rotateRes.result as { ok: boolean; key: string };
    expect(rotated.ok).toBe(true);
    expect(rotated.key).toMatch(new RegExp(`^ark_${tenantId}_`));
    expect(rotated.key).not.toBe(created.key);

    // list again -- still exactly one key (rotate = revoke+create with same meta)
    const listAfter = (await dispatchAs("admin/apikey/list", { tenant_id: tenantId }, admin)) as JsonRpcResponse;
    const listedAfter = (listAfter.result as any).keys as Array<{ id: string; name: string }>;
    expect(listedAfter.length).toBe(1);
    expect(listedAfter[0].name).toBe("ci");
    const rotatedId = listedAfter[0].id;
    expect(rotatedId).not.toBe(created.id);

    // revoke
    const revokeRes = (await dispatchAs(
      "admin/apikey/revoke",
      { id: rotatedId, tenant_id: tenantId },
      admin,
    )) as JsonRpcResponse;
    expect((revokeRes.result as any).ok).toBe(true);

    // list -> empty
    const listFinal = (await dispatchAs("admin/apikey/list", { tenant_id: tenantId }, admin)) as JsonRpcResponse;
    expect((listFinal.result as any).keys.length).toBe(0);
  });

  it("rotate on a non-existent key returns SESSION_NOT_FOUND", async () => {
    const admin = localAdminContext(null);
    const res = (await dispatchAs("admin/apikey/rotate", { id: "ak-does-not-exist" }, admin)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("create with invalid role throws INVALID_PARAMS", async () => {
    const admin = localAdminContext(null);
    const res = (await dispatchAs(
      "admin/apikey/create",
      { tenant_id: "t-x", name: "bad", role: "superuser" },
      admin,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
