/**
 * Tenant isolation e2e through the /mcp HTTP path.
 *
 * Closes the loop on Task 2's auth gate: not just "anonymous is
 * rejected" (auth.test.ts) but "a valid token only sees its own
 * tenant's rows". Two tenants seed disjoint sessions and call
 * `session_list` over MCP -- each must only see its own.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  h = await bootMcpTestServer({ authSection: { requireToken: true, defaultTenant: null } });
  // ApiKeyManager.create(tenantId, name, role) -- mirror the existing
  // conductor-auth.test.ts pattern. Tenants don't need to be pre-created
  // via the TenantManager -- the api keys + sessions just carry the
  // tenant_id string and the repos scope on it.
  const a = await h.app.apiKeys.create("tenant-a", "test-A", "admin");
  const b = await h.app.apiKeys.create("tenant-b", "test-B", "admin");
  tokenA = a.key;
  tokenB = b.key;
  // Seed a session in each tenant via the tenant-scoped repo view.
  await h.app.forTenant("tenant-a").sessions.create({ summary: "owned-by-A" });
  await h.app.forTenant("tenant-b").sessions.create({ summary: "owned-by-B" });
});
afterAll(async () => {
  await h.shutdown();
});

describe("tenant isolation", () => {
  it("tenant A only sees their own session via session_list", async () => {
    const list = (await h.callTool("session_list", {}, { token: tokenA })) as { summary: string }[];
    expect(list.find((s) => s.summary === "owned-by-A")).toBeDefined();
    expect(list.find((s) => s.summary === "owned-by-B")).toBeUndefined();
  });

  it("tenant B only sees their own session via session_list", async () => {
    const list = (await h.callTool("session_list", {}, { token: tokenB })) as { summary: string }[];
    expect(list.find((s) => s.summary === "owned-by-B")).toBeDefined();
    expect(list.find((s) => s.summary === "owned-by-A")).toBeUndefined();
  });
});
