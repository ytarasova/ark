/**
 * AppMode -- polymorphic deployment-mode descriptor.
 *
 * Ark has two deployment modes: **local** (single-user, stable local filesystem,
 * no multi-tenancy) and **hosted** (multi-tenant, Postgres-backed, no per-tenant
 * filesystem view on the server).
 *
 * Historically, handlers and components read a `isHostedMode()` boolean and
 * branched at runtime. That scatters a cross-cutting concern across the codebase
 * and makes it easy to add new handlers that forget the check.
 *
 * Instead, we compose the right implementation at startup and resolve it
 * polymorphically thereafter:
 *
 *   1. A single conditional at DI composition picks `LocalAppMode` or
 *      `HostedAppMode` based on `config.database.url` presence.
 *   2. Each capability (filesystem, knowledge-graph, MCP-by-dir, FTS rebuild)
 *      is either a real implementation (local) or `null` (hosted).
 *   3. Handlers that are local-only are registered conditionally via
 *      `registerLocalOnlyHandlers` -- they never see a mode flag.
 *   4. A thin safety net: handlers that are still shared read
 *      `app.mode.<capability>` and throw a consistent `RpcError` when the
 *      capability is absent. No handler body contains `isHostedMode(...)`.
 */

import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import { buildLocalAppMode } from "./local-app-mode.js";
import { buildHostedAppMode } from "./hosted-app-mode.js";

// ── Capability interfaces ──────────────────────────────────────────────────

/** Read-only directory listings. Local filesystem browser. */
export interface FsCapability {
  listDir(path: string): Promise<FsListDirResult>;
}

export interface FsDirEntry {
  name: string;
  path: string;
  isGitRepo?: boolean;
}

export interface FsListDirResult {
  cwd: string;
  parent: string | null;
  home: string;
  entries: FsDirEntry[];
}

/** MCP-by-directory attach / detach (writes to `<dir>/.claude.json`). */
export interface McpDirCapability {
  attach(dir: string, name: string, config: Record<string, unknown>): void;
  detach(dir: string, name: string): void;
}

/** Repo-map generation (reads arbitrary local directories). */
export interface RepoMapCapability {
  generate(dir: string): Promise<Record<string, unknown>>;
}

/** Knowledge-graph filesystem operations (index/export/import). */
export interface KnowledgeCapability {
  index(repoPath: string): Promise<Record<string, unknown>>;
  export(dir: string): Promise<Record<string, unknown>>;
  import(dir: string): Promise<Record<string, unknown>>;
}

/** FTS index rebuild -- wipes the shared `claude_sessions_cache` + `transcript_index`
 * tables. Only safe in single-tenant local mode. */
export interface FtsRebuildCapability {
  rebuild(): Promise<{ sessionCount: number; indexCount: number; items: unknown[] }>;
}

/** Privileged host commands (kill, docker). Only safe in local single-user mode. */
export interface HostCommandCapability {
  killProcess(pid: number): Promise<void>;
  dockerLogs(container: string, tail: number): Promise<string>;
  dockerAction(container: string, action: "stop" | "restart"): Promise<void>;
}

// ── AppMode contract ───────────────────────────────────────────────────────

/**
 * Deployment-mode descriptor. Composed once at DI startup and resolved
 * polymorphically thereafter -- handlers/services/components never branch on
 * `kind`. Capabilities that are absent in the current mode are `null`; handler
 * registrations that require them are skipped at registration time.
 */
export interface AppMode {
  readonly kind: "local" | "hosted";
  readonly fsCapability: FsCapability | null;
  readonly knowledgeCapability: KnowledgeCapability | null;
  readonly mcpDirCapability: McpDirCapability | null;
  readonly repoMapCapability: RepoMapCapability | null;
  readonly ftsRebuildCapability: FtsRebuildCapability | null;
  readonly hostCommandCapability: HostCommandCapability | null;
}

// ── Factory (the ONE remaining mode conditional) ───────────────────────────

/**
 * Build the AppMode implementation appropriate for the given config.
 *
 * This is the single source-of-truth for "which mode are we in" and lives at
 * DI composition. Every other caller goes through `app.mode.*`.
 *
 * The optional `app` param is required for capabilities that close over runtime
 * dependencies (knowledge store, db). When omitted (e.g. in unit tests that
 * only need the `kind` or capabilities that don't touch app state), those
 * capabilities are still populated but operations against them will fail at
 * first use -- not what you want at runtime.
 */
export function buildAppMode(config: ArkConfig, app?: AppContext): AppMode {
  const url =
    (config.database as { url?: string } | undefined)?.url ?? (config as { databaseUrl?: string }).databaseUrl;
  const isHosted = typeof url === "string" && url.length > 0;
  if (isHosted) {
    return buildHostedAppMode();
  }
  return buildLocalAppMode(app);
}

export { buildLocalAppMode, buildHostedAppMode };
