/**
 * Conductor -> LLM router HTTP proxy.
 *
 * Used by the arkd -> conductor -> router proxy chain so agents on remote
 * compute can reach the router through the single conductor hostname.
 */

import type { AppContext } from "../app.js";

/**
 * Proxy an HTTP request to the LLM router, streaming the response back.
 */
export async function proxyToRouter(app: AppContext, req: Request, path: string): Promise<Response> {
  const routerUrl = app.config.router.url;
  try {
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "authorization", "accept"]) {
      const val = req.headers.get(key);
      if (val) headers[key] = val;
    }
    const init: RequestInit = { method: req.method, headers };
    if (req.method === "POST") init.body = req.body;
    const upstream = await fetch(`${routerUrl}${path}`, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e: any) {
    return Response.json({ error: `router proxy failed: ${e?.message ?? e}` }, { status: 502 });
  }
}
