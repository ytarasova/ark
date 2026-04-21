/**
 * code-intel/* RPC handler tests -- happy path + one error path per method.
 *
 * The heavy surface (extractor pipeline, indexing-run schema) is covered at
 * the store + pipeline layers. Here we just verify the RPC handlers round
 * their inputs through `app.codeIntel` correctly and respond with the
 * shapes the CLI + ArkClient expect.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerCodeIntelHandlers } from "../code-intel.js";
import { createRequest, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";

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
  registerCodeIntelHandlers(router, app);
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}
function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("code-intel/health", () => {
  it("returns the health shape", async () => {
    const res = ok(await router.dispatch(createRequest(1, "code-intel/health", {})));
    expect(typeof res.schemaVersion).toBe("number");
    expect(typeof res.pending).toBe("number");
    expect(typeof res.deploymentMode).toBe("string");
    expect(typeof res.storeBackend).toBe("string");
    expect(typeof res.tenantCount).toBe("number");
    expect(typeof res.defaultTenantRepoCount).toBe("number");
  });
});

describe("code-intel/migration-status", () => {
  it("reports no pending migrations in a fresh app", async () => {
    const res = ok(await router.dispatch(createRequest(1, "code-intel/migration-status", {})));
    expect(typeof res.currentVersion).toBe("number");
    expect(Array.isArray(res.pending)).toBe(true);
    // Boot runs migrate() already; pending should be empty.
    expect(res.pending.length).toBe(0);
  });
});

describe("code-intel/reset", () => {
  it("refuses without confirm", async () => {
    const res = err(await router.dispatch(createRequest(1, "code-intel/reset", {})));
    expect(res.message).toContain("confirm");
  });
});

describe("code-intel/tenant/list", () => {
  it("returns the default tenant", async () => {
    const res = ok(await router.dispatch(createRequest(1, "code-intel/tenant/list", {})));
    const tenants = res.tenants as Array<{ id: string; slug: string }>;
    expect(tenants.length).toBeGreaterThanOrEqual(1);
    expect(tenants.some((t) => t.slug === "default")).toBe(true);
  });
});

describe("code-intel/repo/add + code-intel/repo/list", () => {
  it("registers a repo and lists it; duplicate url is idempotent", async () => {
    const repoUrl = `https://example.com/ark-ci-rpc-${Date.now()}.git`;
    const first = ok(await router.dispatch(createRequest(1, "code-intel/repo/add", { repoUrl, name: "rpc-test" })));
    expect(first.created).toBe(true);
    expect(first.repo.name).toBe("rpc-test");

    const second = ok(await router.dispatch(createRequest(2, "code-intel/repo/add", { repoUrl, name: "rpc-test" })));
    expect(second.created).toBe(false);
    expect(second.repo.id).toBe(first.repo.id);

    const list = ok(await router.dispatch(createRequest(3, "code-intel/repo/list", {})));
    const repos = list.repos as Array<{ id: string }>;
    expect(repos.some((r) => r.id === first.repo.id)).toBe(true);
  });

  it("rejects an empty repoUrl", async () => {
    const res = err(await router.dispatch(createRequest(1, "code-intel/repo/add", { repoUrl: "" })));
    expect(res.message).toContain("repoUrl");
  });
});

describe("code-intel/search", () => {
  it("rejects an empty query", async () => {
    const res = err(await router.dispatch(createRequest(1, "code-intel/search", { query: "" })));
    expect(res.message).toContain("query");
  });

  it("returns a hits array shape for a valid query (may be empty)", async () => {
    const res = ok(await router.dispatch(createRequest(1, "code-intel/search", { query: "anything" })));
    expect(Array.isArray(res.hits)).toBe(true);
  });
});

describe("code-intel/reindex", () => {
  it("errors when no repos are registered in the tenant and none match", async () => {
    // Use a repoId that definitely doesn't match anything.
    const res = err(
      await router.dispatch(createRequest(1, "code-intel/reindex", { repoId: "nonexistent-repo-id-xyz" })),
    );
    expect(res.message).toBeDefined();
  });
});
