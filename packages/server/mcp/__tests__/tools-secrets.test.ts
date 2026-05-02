import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;
beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("secrets_list", () => {
  it("returns names + types but NEVER values", async () => {
    // The MCP /mcp route resolves the tenant from the request and scopes
    // app.forTenant(...). With no auth header in this test, the tenant is
    // the configured default ("default"). Seed the secret on that tenant
    // so the listing returns it.
    const tenantId = h.app.config.authSection.defaultTenant ?? "default";
    await h.app.secrets.set(tenantId, "MCP_TEST_SECRET", "supersecret-do-not-leak", { description: "test" });
    const result = (await h.callTool("secrets_list", {})) as { name: string; type: string }[];
    const entry = result.find((s) => s.name === "MCP_TEST_SECRET");
    expect(entry).toBeDefined();
    expect(entry?.type).toBeTruthy();
    // Critical: response must not contain the raw value anywhere
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("supersecret-do-not-leak");
  });
});
