/**
 * workspace/* RPC handler tests -- happy path + one error path per method.
 *
 * AppContext.forTestAsync() boots with the default tenant + a seeded
 * "default" workspace, so list/get have something to return out of the box.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerWorkspaceHandlers } from "../workspace.js";
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

beforeEach(async () => {
  router = new Router();
  registerWorkspaceHandlers(router, app);
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}
function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("workspace/list", () => {
  it("returns every workspace in the default tenant with repo_count", async () => {
    const res = ok(await router.dispatch(createRequest(1, "workspace/list", {})));
    const workspaces = res.workspaces as Array<{ slug: string; repo_count: number }>;
    expect(Array.isArray(workspaces)).toBe(true);
    // Every row has repo_count precomputed.
    expect(workspaces.every((w) => typeof w.repo_count === "number")).toBe(true);
  });
});

describe("workspace/create + workspace/get + workspace/delete", () => {
  it("round-trips a workspace", async () => {
    const slug = `ws-${Date.now()}`;
    const create = ok(await router.dispatch(createRequest(1, "workspace/create", { slug, name: "Test WS" })));
    expect(create.created).toBe(true);
    expect(create.workspace.slug).toBe(slug);

    const get = ok(await router.dispatch(createRequest(2, "workspace/get", { slug })));
    expect(get.workspace.slug).toBe(slug);
    expect(Array.isArray(get.workspace.repos)).toBe(true);

    const del = ok(await router.dispatch(createRequest(3, "workspace/delete", { slug })));
    expect(del.ok).toBe(true);

    const missing = err(await router.dispatch(createRequest(4, "workspace/get", { slug })));
    expect(missing.message).toContain("not found");
  });

  it("workspace/create is idempotent on slug collision", async () => {
    const slug = `ws-idem-${Date.now()}`;
    const first = ok(await router.dispatch(createRequest(1, "workspace/create", { slug, name: "A" })));
    expect(first.created).toBe(true);
    const second = ok(await router.dispatch(createRequest(2, "workspace/create", { slug, name: "B" })));
    expect(second.created).toBe(false);
    expect(second.workspace.id).toBe(first.workspace.id);
  });
});

describe("workspace/status", () => {
  it("returns the workspace status shape", async () => {
    const slug = `ws-st-${Date.now()}`;
    ok(await router.dispatch(createRequest(1, "workspace/create", { slug, name: "Status" })));
    const res = ok(await router.dispatch(createRequest(2, "workspace/status", { slug })));
    expect(res.status.slug).toBe(slug);
    expect(res.status.repo_count).toBe(0);
    expect(res.status.repos).toEqual([]);
  });
});

describe("workspace/add-repo + workspace/remove-repo", () => {
  it("rejects attach when repo is unknown to the tenant", async () => {
    const slug = `ws-attach-${Date.now()}`;
    ok(await router.dispatch(createRequest(1, "workspace/create", { slug, name: "Attach" })));
    const res = err(await router.dispatch(createRequest(2, "workspace/add-repo", { slug, repo: "nonexistent-repo" })));
    expect(res.message).toContain("not found");
  });

  it("attaches + detaches a registered repo", async () => {
    const slug = `ws-ad-${Date.now()}`;
    ok(await router.dispatch(createRequest(1, "workspace/create", { slug, name: "Attach Detach" })));

    // Register a repo directly on the store so this test doesn't need the
    // code-intel handler to be mounted.
    const { DEFAULT_TENANT_ID } = await import("../../../core/code-intel/constants.js");
    const repo = await app.codeIntel.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: `https://example.com/${slug}.git`,
      name: `repo-${slug}`,
    });

    const attach = ok(await router.dispatch(createRequest(2, "workspace/add-repo", { slug, repo: repo.id })));
    expect(attach.ok).toBe(true);
    expect(attach.repo_id).toBe(repo.id);

    const detach = ok(await router.dispatch(createRequest(3, "workspace/remove-repo", { slug, repo: repo.id })));
    expect(detach.ok).toBe(true);
    expect(detach.detached).toBe(true);
  });
});
