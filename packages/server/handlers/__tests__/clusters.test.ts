/**
 * cluster/* + admin/tenant/config/*-compute handler tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerClusterHandlers } from "../clusters.js";
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
  registerClusterHandlers(router, app);
  // Reset config.compute between tests -- tests mutate the shared AppConfig.
  (app.config as any).compute = { clusters: [] };
});

function dispatchAs(method: string, params: Record<string, unknown> | undefined, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params ?? {}), undefined, ctx);
}

describe("admin/tenant/config/*-compute gate", () => {
  it("returns FORBIDDEN for every admin method when ctx is anonymous", async () => {
    const anon = anonymousContext();
    const methods: Array<[string, Record<string, unknown>]> = [
      [
        "admin/tenant/config/set-compute",
        { tenant_id: "t-x", yaml: "- name: a\n  kind: k8s\n  apiEndpoint: https://x\n  auth:\n    kind: in_cluster" },
      ],
      ["admin/tenant/config/get-compute", { tenant_id: "t-x" }],
      ["admin/tenant/config/clear-compute", { tenant_id: "t-x" }],
    ];
    for (const [method, params] of methods) {
      const res = (await dispatchAs(method, params, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
    }
  });

  it("cluster/list does NOT require admin (any authed tenant can list)", async () => {
    const viewer: TenantContext = {
      tenantId: "t-viewer",
      userId: "u-v",
      role: "viewer",
      isAdmin: false,
    };
    const res = (await dispatchAs("cluster/list", {}, viewer)) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    expect((res.result as any).clusters).toEqual([]);
  });
});

describe("admin/tenant/config/*-compute happy path", () => {
  const admin = localAdminContext(null);

  it("set-compute validates the YAML shape before persisting", async () => {
    const res = (await dispatchAs(
      "admin/tenant/config/set-compute",
      {
        tenant_id: "t-bad",
        yaml: "- name: x\n  kind: not-a-kind\n  apiEndpoint: https://x\n  auth:\n    kind: in_cluster",
      },
      admin,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toMatch(/kind.*k8s/);
  });

  it("set -> get -> clear round-trips a valid YAML blob", async () => {
    const tenantId = `t-cluster-cfg-${Date.now()}`;
    const yaml = `
- name: prod
  kind: k8s
  apiEndpoint: https://prod.example.com
  auth:
    kind: in_cluster
`;

    const setRes = (await dispatchAs(
      "admin/tenant/config/set-compute",
      { tenant_id: tenantId, yaml },
      admin,
    )) as JsonRpcResponse;
    expect((setRes.result as any).ok).toBe(true);

    const getRes = (await dispatchAs(
      "admin/tenant/config/get-compute",
      { tenant_id: tenantId },
      admin,
    )) as JsonRpcResponse;
    expect((getRes.result as any).yaml).toBe(yaml);

    const clrRes = (await dispatchAs(
      "admin/tenant/config/clear-compute",
      { tenant_id: tenantId },
      admin,
    )) as JsonRpcResponse;
    expect((clrRes.result as any).ok).toBe(true);

    const getRes2 = (await dispatchAs(
      "admin/tenant/config/get-compute",
      { tenant_id: tenantId },
      admin,
    )) as JsonRpcResponse;
    expect((getRes2.result as any).yaml).toBeNull();
  });
});

describe("cluster/list merges system + tenant layers", () => {
  it("tenant overlay wins on name collision", async () => {
    (app.config as any).compute = {
      clusters: [
        {
          name: "prod",
          kind: "k8s",
          apiEndpoint: "https://prod.SYSTEM.example.com",
          auth: { kind: "in_cluster" },
        },
      ],
    };
    const tenantId = `t-list-${Date.now()}`;
    const admin: TenantContext = { ...localAdminContext(null), tenantId };
    await dispatchAs(
      "admin/tenant/config/set-compute",
      {
        tenant_id: tenantId,
        yaml: `
- name: prod
  kind: k8s-kata
  apiEndpoint: https://prod.TENANT.example.com
  auth:
    kind: token
    tokenSecret: T
`,
      },
      admin,
    );

    const res = (await dispatchAs("cluster/list", {}, admin)) as JsonRpcResponse;
    const clusters = (res.result as any).clusters as Array<{ name: string; kind: string; apiEndpoint: string }>;
    const prod = clusters.find((c) => c.name === "prod")!;
    expect(prod.kind).toBe("k8s-kata");
    expect(prod.apiEndpoint).toBe("https://prod.TENANT.example.com");
    // auth block never escapes over the wire
    expect((prod as any).auth).toBeUndefined();
  });
});
