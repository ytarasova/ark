/**
 * File operation routes: read, write, stat, mkdir, list.
 *
 * Extracted from server.ts; behavior unchanged. Every path in a request
 * body is run through `ctx.confine()` before touching the filesystem.
 */

import { readFile, writeFile, stat, mkdir, readdir } from "fs/promises";
import { join } from "path";
import type {
  ReadFileReq,
  ReadFileRes,
  WriteFileReq,
  WriteFileRes,
  ListDirReq,
  ListDirRes,
  DirEntry,
  StatReq,
  StatRes,
  MkdirReq,
  MkdirRes,
} from "../../common/types.js";
import { logInfo } from "../../../core/observability/structured-log.js";
import { json } from "../helpers.js";
import { type RouteCtx } from "../route-ctx.js";

async function listDirectory(dirPath: string, recursive?: boolean): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  const items = await readdir(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dirPath, item.name);
    const type = item.isFile() ? ("file" as const) : item.isDirectory() ? ("dir" as const) : ("symlink" as const);

    let size = 0;
    if (item.isFile()) {
      try {
        size = (await stat(fullPath)).size;
      } catch {
        logInfo("compute", "stat may fail for broken symlinks");
      }
    }

    entries.push({ name: item.name, path: fullPath, type, size });

    if (recursive && item.isDirectory()) {
      const sub = await listDirectory(fullPath, true);
      entries.push(...sub);
    }
  }
  return entries;
}

export async function handleFileRoutes(req: Request, path: string, ctx: RouteCtx): Promise<Response | null> {
  // ── File: read ────────────────────────────────────────────────
  if (req.method === "POST" && path === "/file/read") {
    const body = (await req.json()) as ReadFileReq;
    const safePath = ctx.confine(body.path);
    try {
      const content = await readFile(safePath, "utf-8");
      return json<ReadFileRes>({ content, size: Buffer.byteLength(content) });
    } catch (e: any) {
      if (e.code === "ENOENT") return json({ error: "file not found", code: "ENOENT" }, 404);
      throw e;
    }
  }

  // ── File: write ───────────────────────────────────────────────
  if (req.method === "POST" && path === "/file/write") {
    const body = (await req.json()) as WriteFileReq;
    const safePath = ctx.confine(body.path);
    await writeFile(safePath, body.content, body.mode ? { mode: body.mode } : undefined);
    return json<WriteFileRes>({ ok: true, bytesWritten: Buffer.byteLength(body.content) });
  }

  // ── File: stat ────────────────────────────────────────────────
  if (req.method === "POST" && path === "/file/stat") {
    const body = (await req.json()) as StatReq;
    const safePath = ctx.confine(body.path);
    try {
      const s = await stat(safePath);
      const type = s.isFile() ? "file" : s.isDirectory() ? "dir" : "symlink";
      return json<StatRes>({
        exists: true,
        type,
        size: s.size,
        mtime: s.mtime.toISOString(),
      });
    } catch (e: any) {
      if (e.code === "ENOENT") return json<StatRes>({ exists: false });
      throw e;
    }
  }

  // ── File: mkdir ───────────────────────────────────────────────
  if (req.method === "POST" && path === "/file/mkdir") {
    const body = (await req.json()) as MkdirReq;
    const safePath = ctx.confine(body.path);
    await mkdir(safePath, { recursive: body.recursive ?? true });
    return json<MkdirRes>({ ok: true });
  }

  // ── File: list ────────────────────────────────────────────────
  if (req.method === "POST" && path === "/file/list") {
    const body = (await req.json()) as ListDirReq;
    const safePath = ctx.confine(body.path);
    const entries = await listDirectory(safePath, body.recursive);
    return json<ListDirRes>({ entries });
  }

  return null;
}
