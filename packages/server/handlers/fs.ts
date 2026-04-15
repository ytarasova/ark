/**
 * Filesystem handlers -- exposes local directory listings to the web UI so the
 * "New Session" modal can offer a folder picker. READ-ONLY; hosted/multi-tenant
 * mode is explicitly refused.
 */

import { readdirSync, existsSync, statSync } from "fs";
import { resolve, join, parse, isAbsolute } from "path";
import { homedir } from "os";
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { RpcError } from "../../protocol/types.js";

interface DirEntry {
  name: string;
  path: string;
  isGitRepo?: boolean;
}

interface ListDirResult {
  cwd: string;
  parent: string | null;
  home: string;
  entries: DirEntry[];
}

interface ListDirParams {
  path?: string;
}

/** True when Ark is running in hosted/multi-tenant mode (Postgres backend). */
function isHostedMode(app: AppContext): boolean {
  return typeof app.config.databaseUrl === "string" && app.config.databaseUrl.length > 0;
}

export function registerFsHandlers(router: Router, app: AppContext): void {
  router.handle("fs/list-dir", async (p) => {
    if (isHostedMode(app)) {
      throw new RpcError(
        "fs/list-dir is disabled in hosted mode (multi-tenant filesystem exposure is not allowed)",
        -32601,
      );
    }

    const params = (p ?? {}) as ListDirParams;
    const home = homedir();

    // Default to the user's home directory when no path is provided or when
    // the caller passes "." / "" -- more predictable than the server's cwd.
    let raw = params.path;
    if (!raw || raw === "." || raw.trim() === "") {
      raw = home;
    }

    // Expand a leading ~ so users can type ~/projects in the address bar.
    if (raw.startsWith("~")) {
      raw = join(home, raw.slice(1));
    }

    // Reject non-absolute paths that slipped past the defaults -- otherwise
    // path.resolve() would silently join against the server's cwd.
    if (!isAbsolute(raw)) {
      throw new RpcError(`Path must be absolute: ${raw}`, -32602);
    }

    const cwd = resolve(raw);

    if (!existsSync(cwd)) {
      throw new RpcError(`Path does not exist: ${cwd}`, -32602);
    }

    let stat;
    try {
      stat = statSync(cwd);
    } catch (err: any) {
      throw new RpcError(`Cannot stat path: ${err.message ?? String(err)}`, -32602);
    }
    if (!stat.isDirectory()) {
      throw new RpcError(`Not a directory: ${cwd}`, -32602);
    }

    let rawEntries;
    try {
      rawEntries = readdirSync(cwd, { withFileTypes: true });
    } catch (err: any) {
      throw new RpcError(`Cannot read directory: ${err.message ?? String(err)}`, -32602);
    }

    const entries: DirEntry[] = [];
    for (const ent of rawEntries) {
      // Only offer directories -- the picker is choosing a repo, not a file.
      // Wrap each probe in try/catch so one unreadable sub-entry does not
      // break the whole listing (permission errors, broken symlinks, etc.).
      let isDir = false;
      try {
        if (ent.isDirectory()) {
          isDir = true;
        } else if (ent.isSymbolicLink()) {
          // Resolve the symlink target so "~/work" style aliases still show.
          try {
            isDir = statSync(join(cwd, ent.name)).isDirectory();
          } catch {
            isDir = false;
          }
        }
      } catch {
        continue;
      }
      if (!isDir) continue;

      const entryPath = join(cwd, ent.name);
      const entry: DirEntry = { name: ent.name, path: entryPath };
      try {
        if (existsSync(join(entryPath, ".git"))) {
          entry.isGitRepo = true;
        }
      } catch {
        // ignore -- non-fatal
      }
      entries.push(entry);
    }

    entries.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    const parsed = parse(cwd);
    const parent = cwd === parsed.root ? null : resolve(cwd, "..");

    const result: ListDirResult = { cwd, parent, home, entries };
    return result;
  });
}
