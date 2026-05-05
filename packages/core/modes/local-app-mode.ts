/**
 * Local AppMode -- populates every capability with a real implementation.
 *
 * "Local" means the server has a stable local filesystem, no multi-tenancy,
 * and the process owner is the same user whose `~/.ark` / `~/.claude` trees
 * we're touching. Every capability that depends on filesystem stability
 * (fs / host-command) is available here.
 */

import { readdirSync, existsSync, statSync } from "fs";
import { resolve, join, parse, isAbsolute } from "path";
import { homedir } from "os";
import { promisify } from "util";
import { execFile } from "child_process";
import type { AppContext } from "../app.js";
import { RpcError } from "../../protocol/types.js";
import { logDebug } from "../observability/structured-log.js";
import { buildTenantScope } from "../tenant-scope.js";
import type {
  AppMode,
  ComputeBootstrapCapability,
  DatabaseMode,
  FsCapability,
  FsListDirResult,
  FsDirEntry,
  HostCommandCapability,
  TenantResolverCapability,
  TenantScopeCapability,
} from "./app-mode.js";
import { resolveBearerAuth, resolveDatabaseMode } from "./app-mode.js";
import { seedLocalCompute } from "../repositories/schema.js";
import { seedLocalComputePostgres } from "../repositories/schema-postgres.js";
import { buildMigrationsCapability } from "./migrations-capability.js";
import { FileSecretsProvider } from "../secrets/file-provider.js";
import { AwsSecretsProvider } from "../secrets/aws-provider.js";
import type { SecretsCapability } from "../secrets/types.js";

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

// ── Tenant resolver ────────────────────────────────────────────────────────

/**
 * Local single-tenant resolver.
 *
 *   - Authorization: Bearer <token>  -> validate + use its tenant (shared path)
 *   - Only X-Ark-Tenant-Id            -> accept it verbatim. Local mode serves
 *                                        a single user/tenant; the header is
 *                                        informational and can't widen access.
 *                                        The channel MCP subprocess always
 *                                        sets this at dispatch, so rejecting
 *                                        would break `report`, relay, and
 *                                        /hooks/status on every local session.
 *   - No headers                      -> fall back to "default".
 */
function makeLocalTenantResolver(): TenantResolverCapability {
  return {
    async resolve({ authHeader, tenantHeader, validateToken }) {
      if (authHeader) return resolveBearerAuth(authHeader, tenantHeader, validateToken);
      if (tenantHeader) return { ok: true, tenantId: tenantHeader };
      return { ok: true, tenantId: "default" };
    },
  };
}

// ── Compute bootstrap ──────────────────────────────────────────────────────

function makeLocalComputeBootstrap(dialect: "sqlite" | "postgres"): ComputeBootstrapCapability {
  return {
    async seed(db) {
      // Local mode: agents run on the same host as ark via tmux. Seed the
      // canonical `local` compute target so a fresh laptop install works
      // without any operator action.
      if (dialect === "postgres") await seedLocalComputePostgres(db);
      else await seedLocalCompute(db);
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a `LocalAppMode` instance bound to the given app context. Uses a
 * deferred-resolution strategy for capabilities that reach into `app.db`:
 * the capability closure is constructed lazily on first use so it can run
 * before `AppContext.boot()` wires the db cradle entries (tests +
 * container-building callers).
 */
export function buildLocalAppMode(app?: AppContext, database?: DatabaseMode): AppMode {
  const fsCapability = makeFsCapability();
  const hostCommandCapability = makeHostCommandCapability();
  // Default to the user's home when no AppContext is available (bare
  // AppMode construction used by a few tests). The first real mutation
  // creates the directory, so this is safe to derive up front.
  const arkDir = app?.config?.dirs?.ark ?? `${process.env.HOME ?? "."}/.ark`;
  const secretsCfg = app?.config?.secrets;
  const secrets: SecretsCapability =
    secretsCfg?.backend === "aws"
      ? new AwsSecretsProvider({ region: secretsCfg.awsRegion, kmsKeyId: secretsCfg.awsKmsKeyId })
      : new FileSecretsProvider(arkDir);
  const tenantResolver = makeLocalTenantResolver();
  // Default to SQLite/null when no config was passed (tests that build a
  // bare local mode without going through `buildAppMode`).
  const db: DatabaseMode = database ?? resolveDatabaseMode(app?.config ?? {});
  return {
    kind: "local",
    fsCapability,
    hostCommandCapability,
    computeBootstrap: makeLocalComputeBootstrap(db.dialect),
    migrations: buildMigrationsCapability(db.dialect),
    secrets,
    tenantResolver,
    tenantScope: makeLocalTenantScope(),
    database: db,
    // Local mode runs agents via tmux on the same host; a session without
    // an explicit `compute_name` falls back to the seeded "local" row.
    defaultProvider: "local",
  };
}

/**
 * Local mode is single-tenant by design. Production traffic always lands on
 * the local-admin context (`tenantId === "default"` -- the bookkeeping
 * sentinel), and there is no isolation to enforce: building a child DI
 * scope for that path silently detaches the per-tenant SessionService
 * from the lifecycle dispatcher (listener registries are per-instance)
 * and breaks auto-dispatch.
 *
 * For the sentinel we therefore return the same AppContext. Tests that
 * explicitly call `app.forTenant("non-default")` to seed multi-tenant
 * fixtures against the local SQLite DB still get a real child scope so
 * their tenant-scoped repos exercise `setTenant()` paths.
 */
function makeLocalTenantScope(): TenantScopeCapability {
  return {
    forTenant: (app, tenantId) => {
      const sentinel = app.config.authSection.defaultTenant ?? "default";
      if (tenantId === sentinel) return app;
      if (app.tenantId === tenantId) return app;
      return buildTenantScope(app, tenantId);
    },
  };
}
