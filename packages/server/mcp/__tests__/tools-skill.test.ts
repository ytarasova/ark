import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("skill_list", () => {
  it("returns an array (may be empty in test fixture)", async () => {
    const result = (await h.callTool("skill_list", {})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("skill_create + skill_show + skill_update", () => {
  it("creates, reads, and updates a skill", async () => {
    await h.callTool("skill_create", {
      definition: { name: "mcp-test-skill", description: "Test skill", body: "Just a test." },
    });
    const fetched = (await h.callTool("skill_show", { name: "mcp-test-skill" })) as { description: string };
    expect(fetched.description).toBe("Test skill");
    await h.callTool("skill_update", { name: "mcp-test-skill", patch: { description: "Updated" } });
    const updated = (await h.callTool("skill_show", { name: "mcp-test-skill" })) as { description: string };
    expect(updated.description).toBe("Updated");
  });
});
