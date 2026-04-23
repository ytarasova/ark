/**
 * Miscellaneous routes that don't fit a larger family:
 *   - /codegraph/index (codegraph builder + SQLite read)
 *   - /config (mutable conductor URL read/write)
 *   - /v1/chat/completions + /v1/models (LLM proxy → conductor)
 *
 * Extracted from server.ts with no behavior change.
 */

import { join } from "path";
import type { ConfigReq, ConfigRes } from "../types.js";
import { json, type BunLike, type RouteCtx } from "../internal.js";

async function handleCodegraph(req: Request, ctx: RouteCtx): Promise<Response> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  const body = (await req.json()) as { repoPath: string; incremental?: boolean };
  // Confine the attacker-supplied repoPath to the workspace root (P0-4).
  // When workspaceRoot is unset (legacy single-user mode) confine is a no-op
  // after a type check, preserving back-compat.
  const repoPath = ctx.confine(body.repoPath);

  // Find codegraph binary: node_modules/.bin -> PATH
  const { existsSync: existsSyncFs } = await import("fs");
  const localBin = join(process.cwd(), "node_modules", ".bin", "codegraph");
  const cgBin = existsSyncFs(localBin) ? localBin : "codegraph";

  const args = ["build"];
  if (!body.incremental) args.push("--no-incremental");
  args.push(repoPath);

  let buildExitCode = -1;
  let buildStderr = "";
  try {
    const proc = Bun.spawn({ cmd: [cgBin, ...args], cwd: repoPath, stdout: "pipe", stderr: "pipe" });
    buildExitCode = await proc.exited;
    buildStderr = await new Response(proc.stderr).text();
  } catch (e: any) {
    return json({ ok: false, error: `codegraph spawn failed: ${e.message}` }, 500);
  }

  if (buildExitCode !== 0) {
    return json({ ok: false, error: `codegraph build exited ${buildExitCode}: ${buildStderr.slice(0, 500)}` }, 500);
  }

  const dbPath = join(repoPath, ".codegraph", "graph.db");
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);

    const nodes = db
      .query("SELECT id, kind, name, file, line, end_line, visibility, exported, qualified_name FROM nodes")
      .all();
    const edges = db.query("SELECT source_id, target_id, kind FROM edges").all();

    const files = new Set(nodes.map((n: any) => n.file)).size;
    const symbols = nodes.length;

    db.close();
    return json({ ok: true, nodes, edges, files, symbols });
  } catch (e: any) {
    return json({ ok: false, error: `Failed to read codegraph DB at ${dbPath}: ${e.message}` }, 500);
  }
}

/**
 * Proxy an HTTP request to the conductor, streaming the response back.
 * Used for LLM router passthrough (agent -> arkd -> conductor -> router).
 */
async function proxyToCondutor(req: Request, conductorUrl: string | null, path: string): Promise<Response> {
  if (!conductorUrl) {
    return json({ error: "no conductor URL configured" }, 502);
  }
  try {
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "authorization", "accept"]) {
      const val = req.headers.get(key);
      if (val) headers[key] = val;
    }
    const init: RequestInit = { method: req.method, headers };
    if (req.method === "POST") init.body = req.body;
    const upstream = await fetch(`${conductorUrl}${path}`, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e: any) {
    return json({ error: `proxy failed: ${e?.message ?? e}` }, 502);
  }
}

export async function handleMiscRoutes(req: Request, path: string, ctx: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && path === "/codegraph/index") {
    return handleCodegraph(req, ctx);
  }

  if (req.method === "POST" && path === "/config") {
    const body = (await req.json()) as ConfigReq;
    if (body.conductorUrl !== undefined) ctx.setConductorUrl(body.conductorUrl || null);
    return json<ConfigRes>({ ok: true, conductorUrl: ctx.getConductorUrl() });
  }
  if (req.method === "GET" && path === "/config") {
    return json<ConfigRes>({ ok: true, conductorUrl: ctx.getConductorUrl() });
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    return proxyToCondutor(req, ctx.getConductorUrl(), "/v1/chat/completions");
  }
  if (req.method === "GET" && path === "/v1/models") {
    return proxyToCondutor(req, ctx.getConductorUrl(), "/v1/models");
  }

  return null;
}
