/**
 * Local AppMode -- populates every capability with a real implementation.
 *
 * "Local" means the server has a stable local filesystem, no multi-tenancy,
 * and the process owner is the same user whose `~/.ark` / `~/.claude` trees
 * we're touching. Every capability that depends on filesystem stability
 * (fs/knowledge/mcp-by-dir/repo-map/fts-rebuild) is available here.
 */

import { readdirSync, existsSync, statSync } from "fs";
import { resolve, join, parse, isAbsolute } from "path";
import { homedir } from "os";
import { promisify } from "util";
import { execFile } from "child_process";
import type { AppContext } from "../app.js";
import { RpcError } from "../../protocol/types.js";
import { logDebug } from "../observability/structured-log.js";
import { addMcpServer, removeMcpServer } from "../tools.js";
import { generateRepoMap } from "../repo-map.js";
import { listClaudeSessions, refreshClaudeSessionsCache } from "../claude/sessions.js";
import { indexTranscripts } from "../search/search.js";
import type {
  AppMode,
  FsCapability,
  FsListDirResult,
  FsDirEntry,
  KnowledgeCapability,
  McpDirCapability,
  RepoMapCapability,
  FtsRebuildCapability,
  HostCommandCapability,
} from "./app-mode.js";

const execFileAsync = promisify(execFile);

// ── Filesystem ─────────────────────────────────────────────────────────────

function makeFsCapability(): FsCapability {
  return {
    async listDir(rawPath: string): Promise<FsListDirResult> {
      const home = homedir();

      // Default to the user's home directory when no path is provided or when
      // the caller passes "." / "" -- more predictable than the server's cwd.
      let raw = rawPath;
      if (!raw || raw === "." || raw.trim() === "") {
        raw = home;
      }

      // Expand a leading ~ so users can type ~/projects in the address bar.
      if (raw.startsWith("~")) {
        raw = join(home, raw.slice(1));
      }

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

      const entries: FsDirEntry[] = [];
      for (const ent of rawEntries) {
        let isDir = false;
        try {
          if (ent.isDirectory()) {
            isDir = true;
          } else if (ent.isSymbolicLink()) {
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
        const entry: FsDirEntry = { name: ent.name, path: entryPath };
        try {
          if (existsSync(join(entryPath, ".git"))) {
            entry.isGitRepo = true;
          }
        } catch {
          logDebug("web", "ignore -- non-fatal");
        }
        entries.push(entry);
      }

      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      const parsed = parse(cwd);
      const parent = cwd === parsed.root ? null : resolve(cwd, "..");

      return { cwd, parent, home, entries };
    },
  };
}

// ── MCP by directory ───────────────────────────────────────────────────────

function makeMcpDirCapability(): McpDirCapability {
  return {
    attach(dir, name, config) {
      addMcpServer(dir, name, config);
    },
    detach(dir, name) {
      removeMcpServer(dir, name);
    },
  };
}

// ── Repo map ───────────────────────────────────────────────────────────────

function makeRepoMapCapability(): RepoMapCapability {
  return {
    async generate(dir) {
      return generateRepoMap(dir) as unknown as Record<string, unknown>;
    },
  };
}

// ── Knowledge graph ────────────────────────────────────────────────────────

function makeKnowledgeCapability(app: AppContext): KnowledgeCapability {
  return {
    async index(repoPath) {
      const { indexCodebase } = await import("../knowledge/indexer.js");
      const result = await indexCodebase(repoPath, app.knowledge, { incremental: true });
      return result as unknown as Record<string, unknown>;
    },
    async export(dir) {
      const { exportToMarkdown } = await import("../knowledge/export.js");
      return exportToMarkdown(app.knowledge, dir) as unknown as Record<string, unknown>;
    },
    async import(dir) {
      const { importFromMarkdown } = await import("../knowledge/export.js");
      return importFromMarkdown(app.knowledge, dir) as unknown as Record<string, unknown>;
    },
  };
}

// ── FTS rebuild ─────────────────────────────────────────────────────────────

function makeFtsRebuildCapability(app: AppContext): FtsRebuildCapability {
  return {
    async rebuild() {
      const db = app.db;
      // claude_sessions_cache + transcript_index index the local user's
      // `~/.claude` transcripts and are NOT tenant-scoped. Wiping them is
      // only safe in single-user local mode.
      db.run("DELETE FROM claude_sessions_cache");
      db.run("DELETE FROM transcript_index");
      const sessionCount = await refreshClaudeSessionsCache(app, {});
      const indexCount = await indexTranscripts(app, {});
      const items = listClaudeSessions(app);
      return { sessionCount, indexCount, items };
    },
  };
}

// ── Host commands (kill, docker) ───────────────────────────────────────────

function makeHostCommandCapability(): HostCommandCapability {
  return {
    async killProcess(pid: number): Promise<void> {
      await execFileAsync("kill", ["-15", String(pid)], { timeout: 5000 });
    },
    async dockerLogs(container: string, tail: number): Promise<string> {
      const { stdout } = await execFileAsync("docker", ["logs", container, "--tail", String(tail)], {
        timeout: 10_000,
        encoding: "utf-8",
      });
      return stdout;
    },
    async dockerAction(container: string, action: "stop" | "restart"): Promise<void> {
      await execFileAsync("docker", [action, container], { timeout: 30_000 });
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a `LocalAppMode` instance bound to the given app context. Uses a
 * deferred-resolution strategy for capabilities that reach into `app.knowledge`
 * or `app.db`: the capability closure is constructed lazily on first use so it
 * can run before `AppContext.boot()` wires the knowledge/db cradle entries
 * (tests + container-building callers).
 */
function makeLocalComputeBootstrap(dialect: "sqlite" | "postgres"): ComputeBootstrapCapability {
  return {
    seed(db) {
      // Local mode: agents run on the same host as ark via tmux. Seed the
      // canonical `local` compute target so a fresh laptop install works
      // without any operator action.
      if (dialect === "postgres") seedLocalComputePostgres(db);
      else seedLocalCompute(db);
    },
  };
}

export function buildLocalAppMode(app?: AppContext, dialect: "sqlite" | "postgres" = "sqlite"): AppMode {
  const fsCapability = makeFsCapability();
  const mcpDirCapability = makeMcpDirCapability();
  const repoMapCapability = makeRepoMapCapability();
  const knowledgeCapability = app ? makeKnowledgeCapability(app) : null;
  const ftsRebuildCapability = app ? makeFtsRebuildCapability(app) : null;
  const hostCommandCapability = makeHostCommandCapability();
  return {
    kind: "local",
    fsCapability,
    knowledgeCapability,
    mcpDirCapability,
    repoMapCapability,
    ftsRebuildCapability,
    hostCommandCapability,
    computeBootstrap: makeLocalComputeBootstrap(dialect),
  };
}
