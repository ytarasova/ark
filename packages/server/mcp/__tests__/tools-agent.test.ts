import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("agent_list", () => {
  it("includes the builtin worker agent", async () => {
    const result = (await h.callTool("agent_list", {})) as { name: string }[];
    expect(result.find((a) => a.name === "worker")).toBeDefined();
  });
});

describe("agent_show", () => {
  it("returns the worker agent definition", async () => {
    const result = (await h.callTool("agent_show", { name: "worker" })) as { name: string; system_prompt: string };
    expect(result.name).toBe("worker");
    expect(typeof result.system_prompt).toBe("string");
  });
});

describe("agent_create + agent_update", () => {
  it("creates and reads back an agent", async () => {
    await h.callTool("agent_create", {
      definition: {
        name: "mcp-test-agent",
        description: "Created via MCP",
        model: "claude-opus-4-7",
        max_turns: 10,
        system_prompt: "You are a test agent.",
        tools: ["Bash"],
        mcp_servers: [],
        skills: [],
        memories: [],
        context: [],
        permission_mode: "bypassPermissions",
        env: {},
      },
    });
    const fetched = h.app.agents.get("mcp-test-agent");
    expect(fetched).toBeTruthy();
    expect(fetched?.description).toBe("Created via MCP");

    await h.callTool("agent_update", {
      name: "mcp-test-agent",
      patch: { description: "Updated via MCP" },
    });
    const updated = h.app.agents.get("mcp-test-agent");
    expect(updated?.description).toBe("Updated via MCP");
  });
});
