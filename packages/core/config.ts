/**
 * ark config -- Spring-Boot-style typed configuration surface.
 *
 * One authoritative `AppConfig` value for every tunable -- ports, dirs,
 * feature flags, deployment profile. Assembled by `loadConfig()` from
 * the following layers, highest precedence first:
 *
 *   1. Explicit programmatic overrides (test harness, embedding host).
 *   2. CLI flags (surfaced via the overrides arg from Commander).
 *   3. `ARK_*` env vars, read by `./config/env-source.ts`.
 *   4. `{arkDir}/config.yaml`, read by `./config/yaml-source.ts`.
 *      Supports Spring-style `profiles.<name>:` overlay blocks.
 *   5. Compiled defaults baked into the profile module under
 *      `./config/profiles.ts`.
 *
 * The profile (`local` / `control-plane` / `test`) is selected first
 * (see `detectProfile`), then the profile's defaults load, then each
 * higher-precedence layer merges on top.
 *
 * The returned value carries BOTH the legacy flat fields (`arkDir`,
 * `conductorPort`, etc.) required by existing callers AND the new
 * nested sections (`config.ports.conductor`). New code should prefer
 * the nested accessors; legacy code keeps working unchanged.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import YAML from "yaml";
import { DEFAULT_CONDUCTOR_URL, DEFAULT_ROUTER_URL } from "./constants.js";
import type { AuthConfig } from "./auth/index.js";
import type {
  ArkProfile,
  DirsConfig,
  PortsConfig,
  ChannelsConfig,
  ObservabilityConfig,
  AuthSectionConfig,
  FeaturesConfig,
  DatabaseConfig,
  StorageConfig,
  ProfileDefaults,
} from "./config/types.js";
import { detectProfile, loadProfileDefaults } from "./config/profiles.js";
import { readEnv, type EnvOverrides } from "./config/env-source.js";
import { loadYamlOverrides, mergeOverrides } from "./config/yaml-source.js";
import { validateClusterConfig, type ClusterConfig } from "./config/clusters.js";

export type {
  ArkProfile,
  DirsConfig,
  PortsConfig,
  ChannelsConfig,
  ObservabilityConfig,
  AuthSectionConfig,
  FeaturesConfig,
  DatabaseConfig,
  StorageConfig,
} from "./config/types.js";
export type { ClusterConfig, ClusterAuth } from "./config/clusters.js";

/**
 * Compute-section config. Currently only carries the system-layer cluster
 * list; more compute-wide knobs (default provider, pool caps) may join in
 * future waves. Kept optional on `AppConfig` so existing call sites that
 * destructure config don't break when the section is absent.
 */
export interface ComputeConfig {
  /**
   * System-layer k8s clusters. Each entry is a fully-validated `ClusterConfig`.
   * Tenant overlays come from `tenant_policies.compute_config_yaml` at dispatch.
   */
  clusters: ClusterConfig[];
}

export interface OtlpSettings {
  enabled: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
}

export interface RollbackSettings {
  enabled: boolean;
  timeout: number;
  on_timeout: "rollback" | "ignore";
  auto_merge: boolean;
  health_url: string | null;
}

export interface TelemetrySettings {
  enabled: boolean;
  endpoint?: string;
}

export interface RouterSettings {
  enabled: boolean;
  url: string;
  policy: "quality" | "balanced" | "cost";
  /** Auto-start the router on boot (local mode). */
  autoStart: boolean;
}

export interface KnowledgeSettings {
  /** Auto-index codebase on first dispatch for a repo. */
  autoIndex: boolean;
  /** Run incremental re-index on subsequent dispatches. */
  incrementalIndex: boolean;
}

export interface TensorZeroSettings {
  /** Enable TensorZero as the LLM dispatch backend. */
  enabled: boolean;
  /** TensorZero gateway port (default: 3000). */
  port: number;
  /** Config directory for generated tensorzero.toml (default: ~/.ark/tensorzero). */
  configDir?: string;
  /** Auto-start Docker container on boot (local mode). Disabled in hosted/sidecar mode. */
  autoStart: boolean;
}

export interface ComputeTemplateConfig {
  /** Template name (key in config.yaml compute_templates map). */
  name: string;
  description?: string;
  provider: string;
  config: Record<string, unknown>;
}

/**
 * Authoritative app config.
 *
 * The `ArkConfig` name and its flat fields are retained for back-compat
 * with callers that have not yet migrated to nested accessors. The new
 * nested sections (`profile`, `dirs`, `ports`, `channels`, `observability`,
 * `auth`, `features`, `database`) are the preferred surface going forward.
 */
export interface ArkConfig {
  // ── New Spring-style nested sections ───────────────────────────────────

  /** Active profile -- `local` (default), `control-plane`, or `test`. */
  profile: ArkProfile;
  dirs: DirsConfig;
  ports: PortsConfig;
  channels: ChannelsConfig;
  observability: ObservabilityConfig;
  authSection: AuthSectionConfig;
  features: FeaturesConfig;
  database: DatabaseConfig;
  storage: StorageConfig;
  /** Compute-wide configuration. Includes the system-layer cluster list. */
  compute: ComputeConfig;

  // ── Legacy flat fields (derived from nested sections) ──────────────────

  /** @deprecated prefer `config.dirs.ark` */
  arkDir: string;
  /** Path to SQLite DB file (SQLite only; undefined with a postgres databaseUrl). */
  dbPath: string;
  /** @deprecated prefer `config.dirs.tracks` */
  tracksDir: string;
  /** @deprecated prefer `config.dirs.worktrees` */
  worktreesDir: string;
  /** @deprecated prefer `config.dirs.logs` */
  logDir: string;
  /** @deprecated prefer `config.ports.conductor` */
  conductorPort: number;
  conductorUrl: string;
  /** @deprecated prefer `config.ports.arkd` */
  arkdPort: number;
  env: "production" | "test";

  // ── Unchanged nested blocks (not yet part of the Spring-style surface) ──

  otlp: OtlpSettings;
  rollback: RollbackSettings;
  telemetry: TelemetrySettings;
  router: RouterSettings;
  default_compute: string | null;
  hotkeys?: Record<string, string | null>;
  budgets?: { dailyLimit?: number; weeklyLimit?: number; monthlyLimit?: number };
  theme?: string;
  notifications?: boolean;
  auth?: AuthConfig;
  /** Knowledge graph settings (auto-index, etc.). */
  knowledge?: KnowledgeSettings;
  /** TensorZero LLM gateway settings. */
  tensorZero?: TensorZeroSettings;
  /** Predefined compute templates (local mode). */
  computeTemplates?: ComputeTemplateConfig[];
  /**
   * Secrets backend configuration. The concrete provider is picked by
   * `AppMode`: local mode uses the file provider, hosted mode uses the
   * AWS SSM Parameter Store provider. The fields here are advisory.
   *
   * - `backend`: explicit override ("file" | "aws"). When unset the mode
   *   decides. Mostly useful for forcing the AWS provider in local dev
   *   against a real account, or the file provider inside a pod test.
   * - `awsRegion`: AWS region for SSM. Defaults to `AWS_REGION` or
   *   `us-east-1`.
   * - `awsKmsKeyId`: optional KMS key (alias/ARN/id) to encrypt the
   *   SecureString parameters. Unset uses the account default alias.
   */
  secrets?: {
    backend?: "file" | "aws";
    awsRegion?: string;
    awsKmsKeyId?: string;
  };
  /** @deprecated prefer `config.database.url` */
  databaseUrl?: string;
  /** Redis URL for hosted SSE bus and cross-instance pub/sub. redis://... */
  redisUrl?: string;
}

/** Alias -- future-facing name for the same shape. Use this in new code. */
export type AppConfig = ArkConfig;

/** Options accepted by `loadConfig`. */
export interface LoadConfigOptions extends Partial<ArkConfig> {
  /** Explicit profile override; skips auto-detect. */
  profile?: ArkProfile;
}

/** Load ~/.ark/config.yaml if it exists. Returns empty object on failure. */
function loadLegacyYaml(arkDir: string): Record<string, unknown> {
  const configPath = join(arkDir, "config.yaml");
  if (!existsSync(configPath)) return {};
  try {
    return (YAML.parse(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Resolve an AppConfig from profile + YAML + env + programmatic overrides.
 *
 * This is the async, profile-aware resolver. Because the `test` profile
 * allocates ports dynamically (bind :0 + read), it is async.
 *
 * Callers that cannot be async (legacy sync paths) should use `loadConfig()`
 * below, which skips dynamic port allocation and keeps the existing sync
 * semantics.
 */
export async function loadAppConfig(overrides: LoadConfigOptions = {}): Promise<ArkConfig> {
  const profile = detectProfile(overrides.profile);
  const defaults = await loadProfileDefaults(profile);
  return assemble(defaults, overrides, profile);
}

/**
 * Assemble a postgres URL from individual DB_* env vars when DATABASE_URL
 * isn't set directly. Used by the k8s deploy where the RDS-managed
 * password arrives as a separate secret key and shell-side URL
 * composition mishandles special chars (`$`, `:`, `@`, etc.). This
 * helper does the URL-encoding correctly, in-process.
 *
 * Returns undefined if any required part is missing.
 */
export function assembleDatabaseUrlFromParts(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const host = env.DB_HOST;
  const user = env.DB_USERNAME ?? env.DB_USER;
  const pass = env.DB_PASSWORD;
  const name = env.DB_NAME ?? env.DB_DATABASE;
  if (!host || !user || pass === undefined || !name) return undefined;
  const port = env.DB_PORT ?? "5432";
  const u = encodeURIComponent(user);
  const p = encodeURIComponent(pass);
  // RDS / managed Postgres typically reject unencrypted connections.
  // Default to sslmode=require; operator overrides via DB_SSLMODE for
  // self-hosted Postgres without TLS (rare).
  const sslmode = env.DB_SSLMODE ?? "require";
  return `postgresql://${u}:${p}@${host}:${port}/${name}?sslmode=${encodeURIComponent(sslmode)}`;
}

/**
 * Synchronous loader -- maintains the existing contract used across the
 * codebase. In `test` profile, the sync loader does NOT auto-allocate
 * ports; callers that want dynamic allocation use `loadAppConfig`
 * (which is what `AppContext.forTest` uses).
 */
export function loadConfig(overrides: LoadConfigOptions = {}): ArkConfig {
  // Synchronously pick a profile and use fixed defaults. Tests that want
  // dynamic ports go through AppContext.forTest(), which awaits
  // loadAppConfig().
  const profile = detectProfile(overrides.profile);
  const defaults: ProfileDefaults = {
    profile,
    ports: { conductor: 19100, arkd: 19300, server: 19400, web: 8420 },
    channels: { basePort: 19200, range: 10000 },
    auth: { requireToken: profile === "control-plane", defaultTenant: null },
    features: { autoRebase: profile === "control-plane", codegraph: false, codeIntelV2: false },
    observability: { logLevel: profile === "test" ? "error" : "info" },
    storage: { blobBackend: profile === "control-plane" ? "s3" : "local" },
  };
  return assemble(defaults, overrides, profile);
}

/** Merge profile defaults with env + YAML + programmatic overrides. */
function assemble(defaults: ProfileDefaults, overrides: LoadConfigOptions, profile: ArkProfile): ArkConfig {
  // Step 1: arkDir
  //   - overrides win always
  //   - in `test` profile, defaults.arkDir (freshly-mkdtemp'd) beats env
  //     (ARK_TEST_DIR is a legacy single-worker knob; the test profile
  //      replaces it with a per-call unique dir).
  //   - in other profiles: env beats defaults.
  const envOverrides = readEnv();
  const explicitArkDir = overrides.arkDir ?? (overrides.dirs as Partial<DirsConfig> | undefined)?.ark;
  const arkDir =
    explicitArkDir ??
    (profile === "test"
      ? (defaults.arkDir ?? envOverrides.arkDir ?? join(homedir(), ".ark"))
      : (envOverrides.arkDir ?? defaults.arkDir ?? join(homedir(), ".ark")));

  // Step 2: layered overrides (YAML + env + programmatic flat fields)
  const yamlOverrides = profile === "test" ? emptyEnvOverrides() : loadYamlOverrides(arkDir, profile);
  const layered = mergeOverrides(yamlOverrides, envOverrides);

  // Step 3: programmatic flat-field overrides as a final layer
  const programmaticOverrides = flatOverridesFromLegacy(overrides);
  const merged = mergeOverrides(layered, programmaticOverrides);

  // Step 4: compute final nested sections
  const ports: PortsConfig = {
    conductor: merged.ports.conductor ?? defaults.ports.conductor,
    arkd: merged.ports.arkd ?? defaults.ports.arkd,
    server: merged.ports.server ?? defaults.ports.server,
    web: merged.ports.web ?? defaults.ports.web,
  };
  const channels: ChannelsConfig = {
    basePort: merged.channels.basePort ?? defaults.channels.basePort,
    range: merged.channels.range ?? defaults.channels.range,
  };
  const observability: ObservabilityConfig = {
    logLevel: merged.observability.logLevel ?? defaults.observability.logLevel,
    otlpEndpoint: merged.observability.otlpEndpoint,
  };
  const authSection: AuthSectionConfig = {
    requireToken: merged.auth.requireToken ?? defaults.auth.requireToken,
    defaultTenant: merged.auth.defaultTenant ?? defaults.auth.defaultTenant,
  };
  const features: FeaturesConfig = {
    autoRebase: merged.features.autoRebase ?? defaults.features.autoRebase,
    codegraph: merged.features.codegraph ?? defaults.features.codegraph,
    codeIntelV2: merged.features.codeIntelV2 ?? defaults.features.codeIntelV2 ?? false,
  };
  // DATABASE_URL takes precedence; fall back to assembling from DB_* parts
  // (host/port/user/password/name). The latter is ergonomic for k8s where
  // RDS-managed credentials arrive as separate secret keys and shell-side
  // URL composition mishandles special chars in the password.
  const dbAssembled = assembleDatabaseUrlFromParts(process.env);
  // Note: empty string is treated as "not set" (some k8s configmap paths
  // inject DATABASE_URL="" which would otherwise win the ?? chain).
  const blankToUndef = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);
  const databaseUrl =
    blankToUndef(overrides.databaseUrl) ??
    blankToUndef(merged.databaseUrl) ??
    blankToUndef(process.env.DATABASE_URL) ??
    dbAssembled;
  const database: DatabaseConfig = { url: databaseUrl };

  const storage: StorageConfig = {
    blobBackend: merged.storage?.blobBackend ?? defaults.storage.blobBackend,
    s3:
      merged.storage?.s3 ??
      defaults.storage.s3 ??
      // Leave undefined when backend != s3 so callers can gate on presence.
      (defaults.storage.blobBackend === "s3" ? { bucket: "", region: "", prefix: "ark" } : undefined),
  };
  // Programmatic override wins outright so tests + embedding hosts can
  // inject a fully-shaped storage config without replaying env plumbing.
  if (overrides.storage) {
    storage.blobBackend = overrides.storage.blobBackend ?? storage.blobBackend;
    storage.s3 = overrides.storage.s3 ?? storage.s3;
  }

  const dirs: DirsConfig = {
    ark: arkDir,
    worktrees: overrides.worktreesDir ?? join(arkDir, "worktrees"),
    tracks: overrides.tracksDir ?? join(arkDir, "tracks"),
    logs: overrides.logDir ?? join(arkDir, "logs"),
    tmp: join(arkDir, "tmp"),
  };

  // Step 5: legacy YAML for sections not yet migrated to Spring-style
  const legacyYaml = profile === "test" ? {} : loadLegacyYaml(arkDir);

  // Step 6: synthesize the legacy-compat flat config
  const conductorUrl =
    overrides.conductorUrl ??
    process.env.ARK_CONDUCTOR_URL ??
    (ports.conductor !== 19100 ? `http://localhost:${ports.conductor}` : DEFAULT_CONDUCTOR_URL);

  // Legacy `env` field: matches original semantics (ARK_TEST_DIR presence only).
  // The new profile system captures test-mode more broadly via `profile`.
  const isTestEnv = process.env.ARK_TEST_DIR !== undefined;

  // Compute section: parse clusters out of the legacy YAML (compute.clusters)
  // layered with programmatic overrides. Env vars are skipped in Phase 1 --
  // cluster arrays are too structured for single-string env encoding.
  const yamlClusters = parseSystemClusters((legacyYaml as Record<string, unknown>).compute);
  const overrideClusters = overrides.compute?.clusters;
  const clusters: ClusterConfig[] = overrideClusters !== undefined ? overrideClusters : yamlClusters;

  const base: ArkConfig = {
    // Nested Spring-style sections (preferred)
    profile,
    dirs,
    ports,
    channels,
    observability,
    authSection,
    features,
    database,
    storage,
    compute: { clusters },

    // Legacy flat fields
    arkDir,
    dbPath: join(arkDir, "ark.db"),
    tracksDir: dirs.tracks,
    worktreesDir: dirs.worktrees,
    logDir: dirs.logs,
    conductorPort: ports.conductor,
    conductorUrl,
    arkdPort: ports.arkd,
    env: isTestEnv ? "test" : "production",

    otlp: {
      enabled: (legacyYaml.otlp as Record<string, unknown>)?.enabled === true,
      endpoint: (legacyYaml.otlp as Record<string, unknown>)?.endpoint as string | undefined,
      headers: (legacyYaml.otlp as Record<string, unknown>)?.headers as Record<string, string> | undefined,
    },
    rollback: {
      enabled: (legacyYaml.rollback as Record<string, unknown>)?.enabled === true,
      timeout: ((legacyYaml.rollback as Record<string, unknown>)?.timeout as number) ?? 600,
      on_timeout: ((legacyYaml.rollback as Record<string, unknown>)?.on_timeout as "rollback" | "ignore") ?? "ignore",
      auto_merge: (legacyYaml.rollback as Record<string, unknown>)?.auto_merge === true,
      health_url: ((legacyYaml.rollback as Record<string, unknown>)?.health_url as string) ?? null,
    },
    telemetry: {
      enabled: process.env.ARK_TELEMETRY === "1" || (legacyYaml.telemetry as Record<string, unknown>)?.enabled === true,
      endpoint: (legacyYaml.telemetry as Record<string, unknown>)?.endpoint as string | undefined,
    },
    router: {
      enabled: (legacyYaml.router as Record<string, unknown>)?.enabled === true,
      url: ((legacyYaml.router as Record<string, unknown>)?.url as string) ?? DEFAULT_ROUTER_URL,
      policy: ((legacyYaml.router as Record<string, unknown>)?.policy as "quality" | "balanced" | "cost") ?? "balanced",
      autoStart: (legacyYaml.router as Record<string, unknown>)?.auto_start === true,
    },
    knowledge: {
      autoIndex:
        (legacyYaml.knowledge as Record<string, unknown>)?.auto_index === true || process.env.ARK_AUTO_INDEX === "1",
      incrementalIndex: (legacyYaml.knowledge as Record<string, unknown>)?.incremental_index !== false,
    },
    default_compute: process.env.ARK_DEFAULT_COMPUTE ?? (legacyYaml.default_compute as string) ?? null,
    hotkeys: legacyYaml.hotkeys as Record<string, string | null> | undefined,
    budgets: legacyYaml.budgets as ArkConfig["budgets"],
    theme: legacyYaml.theme as string | undefined,
    notifications: legacyYaml.notifications as boolean | undefined,
    auth: {
      enabled: (legacyYaml.auth as Record<string, unknown>)?.enabled === true || authSection.requireToken,
      apiKeyEnabled:
        (legacyYaml.auth as Record<string, unknown>)?.apiKeyEnabled === true ||
        (legacyYaml.auth as Record<string, unknown>)?.api_key_enabled === true,
    },
    tensorZero: {
      enabled:
        process.env.ARK_TENSORZERO_ENABLED === "1" ||
        (legacyYaml.tensorzero as Record<string, unknown>)?.enabled === true ||
        (legacyYaml.tensor_zero as Record<string, unknown>)?.enabled === true,
      port: parseInt(process.env.ARK_TENSORZERO_PORT ?? "3000", 10),
      configDir:
        ((legacyYaml.tensorzero as Record<string, unknown>)?.config_dir as string) ??
        ((legacyYaml.tensor_zero as Record<string, unknown>)?.config_dir as string) ??
        undefined,
      autoStart:
        (legacyYaml.tensorzero as Record<string, unknown>)?.auto_start === true ||
        (legacyYaml.tensor_zero as Record<string, unknown>)?.auto_start === true,
    },
    computeTemplates: parseComputeTemplates(legacyYaml.compute_templates),
    secrets: parseSecretsConfig(legacyYaml.secrets, merged),
    databaseUrl: database.url,
    redisUrl: process.env.REDIS_URL ?? (legacyYaml.redis_url as string) ?? merged.redisUrl,
  };

  // Step 7: final programmatic override (legacy fields) wins
  if (overrides) {
    const { arkDir: _a, profile: _p, ...rest } = overrides;
    Object.assign(base, rest);
  }

  return base;
}

function emptyEnvOverrides(): EnvOverrides {
  return { ports: {}, channels: {}, observability: {}, auth: {}, features: {}, storage: {}, secrets: {} };
}

/** Extract partial Spring-style overrides from a legacy-flat overrides arg. */
function flatOverridesFromLegacy(o: LoadConfigOptions): EnvOverrides {
  const out = emptyEnvOverrides();
  if (o.conductorPort !== undefined) out.ports.conductor = o.conductorPort;
  if (o.arkdPort !== undefined) out.ports.arkd = o.arkdPort;
  if (o.ports) Object.assign(out.ports, o.ports);
  if (o.channels) Object.assign(out.channels, o.channels);
  if (o.observability) Object.assign(out.observability, o.observability);
  if (o.authSection) Object.assign(out.auth, o.authSection);
  if (o.features) Object.assign(out.features, o.features);
  if (o.storage) {
    if (o.storage.blobBackend) out.storage.blobBackend = o.storage.blobBackend;
    if (o.storage.s3) out.storage.s3 = o.storage.s3;
  }
  if (o.database?.url) out.databaseUrl = o.database.url;
  if (o.secrets) {
    if (o.secrets.backend === "file" || o.secrets.backend === "aws") out.secrets.backend = o.secrets.backend;
    if (o.secrets.awsRegion) out.secrets.awsRegion = o.secrets.awsRegion;
    if (o.secrets.awsKmsKeyId) out.secrets.awsKmsKeyId = o.secrets.awsKmsKeyId;
  }
  return out;
}

/**
 * Collapse YAML + env-derived secrets overrides into the ArkConfig.secrets block.
 * Returns undefined when nothing was specified -- callers then treat the mode
 * default as authoritative (file in local, aws in hosted).
 */
function parseSecretsConfig(rawYaml: unknown, merged: EnvOverrides): ArkConfig["secrets"] | undefined {
  const fromEnv = merged.secrets ?? {};
  const fromYaml = (rawYaml && typeof rawYaml === "object" ? (rawYaml as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const backend =
    fromEnv.backend ?? (fromYaml.backend === "file" || fromYaml.backend === "aws" ? fromYaml.backend : undefined);
  const awsRegion =
    fromEnv.awsRegion ??
    (typeof fromYaml.aws_region === "string" ? (fromYaml.aws_region as string) : undefined) ??
    (typeof fromYaml.awsRegion === "string" ? (fromYaml.awsRegion as string) : undefined);
  const awsKmsKeyId =
    fromEnv.awsKmsKeyId ??
    (typeof fromYaml.aws_kms_key_id === "string" ? (fromYaml.aws_kms_key_id as string) : undefined) ??
    (typeof fromYaml.awsKmsKeyId === "string" ? (fromYaml.awsKmsKeyId as string) : undefined);
  if (!backend && !awsRegion && !awsKmsKeyId) return undefined;
  const out: NonNullable<ArkConfig["secrets"]> = {};
  if (backend) out.backend = backend as "file" | "aws";
  if (awsRegion) out.awsRegion = awsRegion;
  if (awsKmsKeyId) out.awsKmsKeyId = awsKmsKeyId;
  return out;
}

/**
 * Parse the `compute:` block from config.yaml into a system-layer cluster
 * list. Invalid entries are DROPPED with a console warning rather than
 * crashing the daemon at boot -- the operator can still override via the
 * tenant YAML blob, and the misconfigured entry will show up in the
 * `cluster/list` RPC response as absent.
 */
function parseSystemClusters(raw: unknown): ClusterConfig[] {
  if (!raw || typeof raw !== "object") return [];
  const entries = (raw as Record<string, unknown>).clusters;
  if (!Array.isArray(entries)) return [];
  const out: ClusterConfig[] = [];
  for (let i = 0; i < entries.length; i++) {
    try {
      out.push(validateClusterConfig(entries[i], `config.yaml compute.clusters[${i}]`));
    } catch (e: any) {
      console.warn(`[config] ${e?.message ?? e} -- entry dropped`);
    }
  }
  return out;
}

/**
 * Parse compute_templates from config.yaml.
 * Accepts a map of name -> { provider, description?, ...config } entries.
 */
function parseComputeTemplates(raw: unknown): ComputeTemplateConfig[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const templates: ComputeTemplateConfig[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const provider = entry.provider as string;
    if (!provider) continue;
    const { provider: _p, description: _d, ...config } = entry;
    templates.push({
      name,
      description: entry.description as string | undefined,
      provider,
      config,
    });
  }
  return templates.length > 0 ? templates : undefined;
}
