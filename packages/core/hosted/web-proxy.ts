/**
 * Web proxy server -- forwards /api/* requests to a remote Ark control plane.
 *
 * Used when `ark web --server <url>` is specified. The local server still
 * serves static files for the SPA, but all API calls are proxied to the
 * remote server with optional auth headers.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { resolveWebDist } from "../install-paths.js";

// Shared install-aware resolver. In a compiled binary this points at
// <prefix>/web/, in dev mode at <repo>/packages/web/dist. Fixes the same
// bug class as web.ts -- `import.meta.dir` does not point at the on-disk
// binary location in `bun build --compile` output.
const WEB_DIST = resolveWebDist();

export interface WebProxyOptions {
  port?: number;
  remoteUrl: string;
  /** Auth token for the remote server (sent as Bearer header). */
  token?: string;
  readOnly?: boolean;
  apiOnly?: boolean;
  /** Local token for protecting the local proxy itself. */
  localToken?: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function startWebProxy(opts: WebProxyOptions): { stop: () => void; url: string } {
  const port = opts.port ?? 8420;
  const remoteUrl = opts.remoteUrl.replace(/\/$/, "");
  const apiOnly = opts.apiOnly ?? false;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Local token auth (protects the proxy endpoint itself)
      if (opts.localToken) {
        const provided = url.searchParams.get("token") ?? req.headers.get("authorization")?.replace("Bearer ", "");
        if (provided !== opts.localToken) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      // SSE proxy -- special handling for event streams (must come before generic /api/* proxy)
      if (url.pathname === "/api/events/stream") {
        try {
          const targetUrl = `${remoteUrl}/api/events/stream`;
          const headers: Record<string, string> = {};
          if (opts.token) {
            headers["Authorization"] = `Bearer ${opts.token}`;
          }

          const proxyRes = await fetch(targetUrl, { headers });
          return new Response(proxyRes.body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              ...CORS,
            },
          });
        } catch {
          return new Response("Proxy SSE error", { status: 502, headers: CORS });
        }
      }

      // Proxy all /api/* requests to remote
      if (url.pathname.startsWith("/api/")) {
        try {
          const targetUrl = `${remoteUrl}${url.pathname}${url.search}`;
          const headers: Record<string, string> = {
            "Content-Type": req.headers.get("Content-Type") || "application/json",
          };
          if (opts.token) {
            headers["Authorization"] = `Bearer ${opts.token}`;
          }

          const proxyRes = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
          });

          // Forward the response with CORS headers
          const responseHeaders: Record<string, string> = { ...CORS };
          proxyRes.headers.forEach((value, key) => {
            // Forward content-type and other relevant headers
            if (key.toLowerCase() !== "transfer-encoding") {
              responseHeaders[key] = value;
            }
          });

          return new Response(proxyRes.body, {
            status: proxyRes.status,
            headers: responseHeaders,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, message: `Proxy error: ${message}` }, { status: 502, headers: CORS });
        }
      }

      // ── Static file serving ────────────────────────────────────────────────
      if (apiOnly) return new Response("Not Found", { status: 404, headers: CORS });

      const staticExts: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      const ext = url.pathname.slice(url.pathname.lastIndexOf("."));
      if (staticExts[ext]) {
        const filePath = join(WEB_DIST, url.pathname);
        if (existsSync(filePath)) {
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": staticExts[ext], ...CORS },
          });
        }
      }

      // SPA index.html
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const indexPath = join(WEB_DIST, "index.html");
        if (existsSync(indexPath)) {
          let html = readFileSync(indexPath, "utf-8");
          const authAttr = opts.localToken ? ' data-auth="true"' : "";
          const readOnlyAttr = opts.readOnly ? ' data-readonly="true"' : "";
          const remoteAttr = ` data-remote="${remoteUrl}"`;
          const rootAttrs = `id="root"${readOnlyAttr}${authAttr}${remoteAttr}`;
          html = html.replace('id="root"', rootAttrs);
          return new Response(html, {
            headers: { "Content-Type": "text/html", ...CORS },
          });
        }
      }

      return new Response("Not Found", { status: 404, headers: CORS });
    },
  });

  const localUrl = `http://localhost:${port}${opts.localToken ? `?token=${opts.localToken}` : ""}`;

  return {
    url: localUrl,
    stop: () => {
      server.stop();
    },
  };
}
