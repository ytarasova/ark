import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("recipe_list + recipe_create + recipe_show + recipe_update", () => {
  it("round-trips a recipe", async () => {
    expect(Array.isArray(await h.callTool("recipe_list", {}))).toBe(true);
    await h.callTool("recipe_create", {
      definition: { name: "mcp-test-recipe", description: "Test", template: "echo {{name}}" },
    });
    const fetched = (await h.callTool("recipe_show", { name: "mcp-test-recipe" })) as { description: string };
    expect(fetched.description).toBe("Test");
    await h.callTool("recipe_update", { name: "mcp-test-recipe", patch: { description: "Updated" } });
    const updated = (await h.callTool("recipe_show", { name: "mcp-test-recipe" })) as { description: string };
    expect(updated.description).toBe("Updated");
  });
});
