/**
 * Test helper for MCP tool tests. Boots a per-test AppContext + ArkServer
 * (each call gets its own ports via the `test` config profile so files run
 * in parallel without colliding) and exposes a `callTool` that posts a
 * single JSON-RPC `tools/call` to /mcp and returns the parsed tool result.
 *
 * Streamable HTTP frames responses as SSE; the helper extracts the
 * envelope by scanning `data:` lines rather than regex-matching the JSON,
 * which is robust to nested braces inside payloads.
 */

import { expect } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { ArkServer } from "../../index.js";
import { registerAllHandlers } from "../../register.js";

export interface McpTestHandle {
  app: AppContext;
  server: ArkServer;
  ws: { stop(): void };
  port: number;
  callTool: (name: string, args: Record<string, unknown>, opts?: { token?: string }) => Promise<unknown>;
  shutdown: () => Promise<void>;
}

export interface BootMcpTestServerOpts {
  authSection?: { requireToken: boolean; defaultTenant: string | null };
}

export async function bootMcpTestServer(opts?: BootMcpTestServerOpts): Promise<McpTestHandle> {
  const app = await AppContext.forTestAsync();
  if (opts?.authSection) {
    app.config.authSection.requireToken = opts.authSection.requireToken;
    app.config.authSection.defaultTenant = opts.authSection.defaultTenant;
  }
  await app.boot();
  const server = new ArkServer();
  registerAllHandlers(server.router, app);
  if (opts?.authSection?.requireToken) server.attachAuth(app);
  server.attachApp(app);
  const port = app.config.ports.conductor;
  const ws = server.startWebSocket(port);

  let nextId = 1;
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    callOpts?: { token?: string },
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (callOpts?.token) headers.Authorization = `Bearer ${callOpts.token}`;
    const id = nextId++;
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    let env: {
      id?: number;
      error?: unknown;
      result?: { isError?: boolean; content?: { text?: string }[] };
    } | null = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const json = trimmed.slice("data:".length).trim();
      if (!json.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(json) as typeof env;
        if (parsed?.id === id) {
          env = parsed;
          break;
        }
      } catch {
        // not a JSON-RPC envelope on this line; skip
      }
    }
    if (!env) throw new Error(`No envelope for id=${id} in response: ${text.slice(0, 300)}`);
    if (env.error) throw new Error(JSON.stringify(env.error));
    if (env.result?.isError) throw new Error(env.result.content?.[0]?.text ?? "tool error");
    const content = env.result?.content?.[0]?.text;
    if (typeof content !== "string") throw new Error("Tool result missing content text");
    return JSON.parse(content);
  };

  const shutdown = async () => {
    ws?.stop();
    await app?.shutdown();
  };

  return { app, server, ws, port, callTool, shutdown };
}
