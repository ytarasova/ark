/**
 * Streamable-HTTP transport entry. One transport + Server pair per request.
 *
 * Stateless mode: we do not pass `sessionIdGenerator`, so every request gets a
 * fresh handler. The MCP SDK handles `Mcp-Session-Id` correlation internally
 * for clients that opt into it, but we don't rely on it because none of our
 * tools maintain server-side session state.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";
import { ToolRegistry } from "./registry.js";
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";

export const sharedRegistry = new ToolRegistry();

export async function handleMcpRequest(req: Request, app: AppContext, ctx: TenantContext): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createMcpServer(sharedRegistry, app, ctx);
  await server.connect(transport);
  return transport.handleRequest(req);
}
