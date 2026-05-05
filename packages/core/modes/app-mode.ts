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
 *   2. Each capability (filesystem, MCP-by-dir, FTS rebuild) is either a
 *      real implementation (local) or `null` (hosted).
 *   3. Handlers that are local-only are registered conditionally via
 *      `registerLocalOnlyHandlers` -- they never see a mode flag.
 *   4. A thin safety net: handlers that are still shared read
 *      `app.mode.<capability>` and throw a consistent `RpcError` when the
 *      capability is absent. No handler body contains `isHostedMode(...)`.
 */

import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import type { SecretsCapability } from "../secrets/types.js";
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

/** Privileged host commands (kill, docker). Only safe in local single-user mode. */
export interface HostCommandCapability {
  killProcess(pid: number): Promise<void>;
  dockerLogs(container: string, tail: number): Promise<string>;
  dockerAction(container: string, action: "stop" | "restart"): Promise<void>;
}

/**
 * Default compute targets to seed at first DB init. Local-mode bootstrap
 * inserts a `local` row (single-user laptop semantics: agents spawn via
 * tmux on the same host). Hosted-mode bootstrap inserts nothing -- the
 * operator registers a real compute target (k8s / docker / ec2 / firecracker)
 * after onboarding. Hosted MUST NOT silently get a `local` row because
 * "local" inside a control-plane pod means "spawn agents inside the pod
 * itself" which has no isolation and competes with the control plane.
 */
export interface ComputeBootstrapCapability {
  seed(db: import("../database/index.js").DatabaseAdapter): Promise<void>;
}

/**
 * Schema migrations capability. Always non-null (every mode has migrations).
 * The polymorphic surface here is the bound dialect: local mode is usually
 * sqlite (laptop default) but flips to postgres if a `DATABASE_URL` is set;
 * hosted mode is postgres-only by definition. Downstream callers
 * (AppContext.boot, the `ark db` CLI) read `app.mode.migrations.*` and
 * never branch on dialect themselves.
 */
export interface MigrationsCapability {
  readonly dialect: "sqlite" | "postgres";
  apply(db: import("../database/index.js").DatabaseAdapter, opts?: { targetVersion?: number }): Promise<void>;
  status(db: import("../database/index.js").DatabaseAdapter): Promise<import("../migrations/types.js").MigrationStatus>;
  /** Phase 1: rejects with "not implemented". Stubbed so the CLI compiles. */
  down(db: import("../database/index.js").DatabaseAdapter, opts: { targetVersion: number }): Promise<never>;
}

/**
 * Database dialect + connection URL. Populated once at DI composition from
 * the resolved config -- handlers read `app.mode.database.dialect` instead
 * of each re-sniffing `config.database.url` with their own regex. Callers
 * that need the raw URL (e.g. the adapter factory) get it here too.
 *
 * The `MigrationsCapability` binds the same dialect at construction, so
 * `app.mode.database.dialect === app.mode.migrations.dialect` is an
 * invariant that both capabilities preserve.
 */
export interface DatabaseMode {
  readonly dialect: "sqlite" | "postgres";
  /** Connection string for Postgres, or null for file-backed SQLite. */
  readonly url: string | null;
}

/**
 * Derive the `DatabaseMode` descriptor from a resolved config. Exported so
 * `app.ts` can compute it once at boot (before the container is built and
 * `buildAppMode` runs) and hand the same object to `buildAppMode`.
 */
export function resolveDatabaseMode(config: { database?: { url?: string }; databaseUrl?: string }): DatabaseMode {
  // Prefer the new nested config.database.url; fall back to the legacy
  // flat `databaseUrl` field for back-compat with older config shapes.
  const raw = config.database?.url ?? config.databaseUrl ?? null;
  // Normalise empty strings to null so callers get a consistent "no URL"
  // signal -- otherwise `!!url` passes on "" and `startsWith` returns false,
  // but `url` is then still "" which is a footgun for downstream loggers.
  const url = raw && raw.length > 0 ? raw : null;
  const isPostgres = !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"));
  return { dialect: isPostgres ? "postgres" : "sqlite", url };
}

/**
 * Build a tenant-scoped view of an AppContext. Local mode is single-tenant
 * by definition, so it returns the same instance unchanged -- there's no
 * isolation to enforce, and creating a child DI scope would silently
 * detach the per-tenant SessionService from the registered lifecycle
 * dispatcher (the listener registry is per-instance).
 *
 * Hosted mode builds a real child container scope with per-tenant repos,
 * stores, and re-registered services. Already-scoped contexts (the same
 * tenantId) short-circuit to avoid nesting scopes.
 *
 * Implementations live in `local-app-mode.ts` / `hosted-app-mode.ts`. Call
 * sites go through `app.forTenant(id)` and never branch on `mode.kind`.
 */
export interface TenantScopeCapability {
  forTenant(app: AppContext, tenantId: string): AppContext;
}

/**
 * Inbound HTTP tenant resolution (Authorization + X-Ark-Tenant-Id headers).
 *
 * The conductor's HTTP surface is the same endpoints in both modes, but the
 * trust rules for the two headers differ:
 *   - Local single-tenant: no token required; a bare `X-Ark-Tenant-Id`
 *     header is informational (the channel MCP subprocess always sets it
 *     to `"default"` at dispatch).
 *   - Hosted multi-tenant: a Bearer token is mandatory for any request that
 *     carries (or needs) a tenant scope; an unaccompanied tenant header is
 *     a cross-tenant exposure vector and MUST be rejected with 401.
 *
 * The resolver is the single place the trust rule is expressed. Handlers go
 * through `app.mode.tenantResolver.resolve(...)` and never branch on
 * `app.mode.kind`.
 */
export interface TenantResolverCapability {
  resolve(args: TenantResolverInput): Promise<TenantResolverResult>;
}

export interface TenantResolverInput {
  authHeader: string | null;
  tenantHeader: string | null;
  validateToken: (token: string) => Promise<{ tenantId: string } | null>;
}

export type TenantResolverResult = { ok: true; tenantId: string } | { ok: false; status: number; error: string };

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
  readonly hostCommandCapability: HostCommandCapability | null;
  /** Bootstrap seed (local: insert the "local" compute row; hosted: no-op). */
  readonly computeBootstrap: ComputeBootstrapCapability;
  /** Dialect-bound migrations runner. */
  readonly migrations: MigrationsCapability;
  /**
   * Tenant-scoped secrets backend. Always present. Local mode gets the
   * file-backed provider rooted at `${arkDir}/secrets.json`; hosted mode
   * gets the AWS SSM Parameter Store provider. See
   * `packages/core/secrets/` for the implementations.
   */
  readonly secrets: SecretsCapability;
  /**
   * Always present (both modes use HTTP auth). The implementation encodes
   * the mode-specific trust rules for tenant + Bearer headers.
   */
  readonly tenantResolver: TenantResolverCapability;
  /**
   * Tenant-scoping policy. Local mode returns the same AppContext (no
   * isolation); hosted mode builds a child DI scope. See
   * `TenantScopeCapability`.
   */
  readonly tenantScope: TenantScopeCapability;
  /** Dialect + URL of the configured database. Set once at boot. */
  readonly database: DatabaseMode;
  /**
   * Name of the default compute provider used when a session / call site
   * does not carry an explicit `compute_name`. Local mode returns "local"
   * (tmux single-user laptop semantics). Hosted mode returns `null` --
   * every session MUST carry an explicit `compute_name` in the control
   * plane; silent fall-through to "local" would mean agents spawn inside
   * the control-plane pod itself.
   */
  readonly defaultProvider: string | null;
}

// ── Shared helper: Bearer-token path is identical in both modes ────────────

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Given an Authorization header that claims Bearer auth, validate the token
 * and resolve its tenant. Used by both LocalTenantResolver and HostedTenantResolver
 * -- the only difference between the two is what they do when the header is ABSENT.
 */
export async function resolveBearerAuth(
  authHeader: string,
  tenantHeader: string | null,
  validateToken: (token: string) => Promise<{ tenantId: string } | null>,
): Promise<TenantResolverResult> {
  const match = authHeader.match(BEARER_PATTERN);
  const token = match?.[1]?.trim();
  if (!token) {
    return { ok: false, status: 401, error: "malformed Authorization header" };
  }
  const ctx = await validateToken(token);
  if (!ctx) {
    return { ok: false, status: 401, error: "invalid or expired API key" };
  }
  if (tenantHeader && tenantHeader !== ctx.tenantId) {
    return { ok: false, status: 403, error: "tenant header does not match API key" };
  }
  return { ok: true, tenantId: ctx.tenantId };
}

// ── Factory (the ONE remaining mode conditional) ───────────────────────────

/**
 * Build the AppMode implementation appropriate for the given config.
 *
 * This is the single source-of-truth for "which mode are we in" and lives at
 * DI composition. Every other caller goes through `app.mode.*`.
 *
 * The optional `app` param is required for capabilities that close over runtime
 * dependencies (db). When omitted (e.g. in unit tests that
 * only need the `kind` or capabilities that don't touch app state), those
 * capabilities are still populated but operations against them will fail at
 * first use -- not what you want at runtime.
 */
export function buildAppMode(config: ArkConfig, app?: AppContext): AppMode {
  const database = resolveDatabaseMode(config);
  // Only a postgres URL selects hosted mode. The older "any URL is hosted"
  // rule classified `sqlite://...` URLs as hosted even though the DB
  // adapter then opened SQLite anyway -- dialect + mode now agree.
  const isHosted = database.dialect === "postgres";
  return isHosted ? buildHostedAppMode(database, config) : buildLocalAppMode(app, database);
}

export { buildLocalAppMode, buildHostedAppMode };
