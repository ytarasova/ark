/**
 * MCP server factory. Builds a fresh `Server` per request -- stateless,
 * since none of our tools hold per-session state on the SDK side.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";
import type { ToolRegistry } from "./registry.js";
import { VERSION } from "../../core/version.js";

export function createMcpServer(registry: ToolRegistry, app: AppContext, ctx: TenantContext): Server {
  const server = new Server({ name: "ark-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      // Zod 4's native converter. The old `zod-to-json-schema` package walks
      // `_def.typeName` (a Zod 3 internal) and emits `{}` for every Zod 4
      // schema -- which made Claude Code's MCP client reject every tool
      // because `inputSchema` lacked `type: "object"`.
      inputSchema: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = registry.get(req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    try {
      const result = await tool.handler(parsed.data, { app, ctx });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true };
    }
  });

  return server;
}
