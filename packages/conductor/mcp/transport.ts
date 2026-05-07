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
  // Best-effort close. The SDK Server holds references on the transport;
  // without this, internal listeners and any per-session timers stay
  // attached after the response is sent. Failure here is benign — the
  // request already completed — so swallow rather than leak the error
  // out of the request path.
  const closeServer = () => {
    server.close().catch(() => {});
  };

  const response = await transport.handleRequest(req);

  // SSE responses are still streaming when handleRequest returns: the SDK
  // pushes JSON-RPC envelopes into the body's ReadableStream as handlers
  // resolve, then closes the controller in its `cleanup` hook. Closing the
  // server right here would tear those controllers down before any payload
  // is written. For streamed bodies we tee the stream so we can detect end
  // of body and close the server only after the runtime has finished
  // serializing the response. For empty bodies (e.g. 202/4xx) we close
  // immediately.
  if (!response.body) {
    closeServer();
    return response;
  }

  const [forClient, forSentinel] = response.body.tee();
  // Drain the sentinel branch in the background. Once it completes (the SDK
  // closed the controller after sending all related responses), we tear
  // down the server. This runs out of band; the consumer sees `forClient`.
  (async () => {
    const reader = forSentinel.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Reader cancelled or stream errored; close anyway.
    } finally {
      closeServer();
    }
  })();

  return new Response(forClient, { status: response.status, headers: response.headers });
}
