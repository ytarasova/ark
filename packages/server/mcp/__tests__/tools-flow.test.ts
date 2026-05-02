import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("flow_list", () => {
  it("includes the builtin bare flow", async () => {
    const result = (await h.callTool("flow_list", {})) as { name: string }[];
    expect(result.find((f) => f.name === "bare")).toBeDefined();
  });
});

describe("flow_show", () => {
  it("returns the bare flow definition", async () => {
    const result = (await h.callTool("flow_show", { name: "bare" })) as { name: string; stages: unknown };
    expect(result.name).toBe("bare");
    expect(result.stages).toBeDefined();
  });
});

describe("flow_create + flow_update", () => {
  it("creates and reads back a flow", async () => {
    await h.callTool("flow_create", {
      definition: {
        name: "mcp-test-flow",
        description: "Created via MCP",
        stages: [{ name: "work", agent: "worker" }],
      },
    });
    const fetched = h.app.flows.get("mcp-test-flow");
    expect(fetched).toBeTruthy();
    expect(fetched?.description).toBe("Created via MCP");

    await h.callTool("flow_update", {
      name: "mcp-test-flow",
      patch: { description: "Updated via MCP" },
    });
    const updated = h.app.flows.get("mcp-test-flow");
    expect(updated?.description).toBe("Updated via MCP");
  });
});
