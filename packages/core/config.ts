import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { DEFAULT_CONDUCTOR_URL, DEFAULT_ROUTER_URL } from "./constants.js";
import type { AuthConfig } from "./auth/index.js";

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

export interface ArkConfig {
  arkDir: string;
  dbPath: string;
  tracksDir: string;
  worktreesDir: string;
  logDir: string;
  conductorPort: number;
  conductorUrl: string;
  env: "production" | "test";
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
  /** TensorZero LLM gateway settings. */
  tensorZero?: TensorZeroSettings;
  /** Predefined compute templates (local mode). */
  computeTemplates?: ComputeTemplateConfig[];
  /** Database URL for hosted deployments. postgres://... uses PostgresAdapter; empty/undefined uses SQLite. */
  databaseUrl?: string;
  /** Redis URL for hosted SSE bus and cross-instance pub/sub. redis://... */
  redisUrl?: string;
}

/** Load ~/.ark/config.yaml if it exists. Returns empty object on failure. */
function loadYamlConfig(arkDir: string): Record<string, unknown> {
  const configPath = join(arkDir, "config.yaml");
  if (!existsSync(configPath)) return {};
  try {
    // Lazy import YAML to avoid loading it when not needed (test mode)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const YAML = require("yaml");
    return (YAML.parse(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadConfig(overrides?: Partial<ArkConfig>): ArkConfig {
  const arkDir = overrides?.arkDir ?? process.env.ARK_TEST_DIR ?? join(homedir(), ".ark");
  const conductorPort = overrides?.conductorPort
    ?? parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100", 10);

  // Load user config from ~/.ark/config.yaml
  const yaml = overrides?.env === "test" ? {} : loadYamlConfig(arkDir);

  const base: ArkConfig = {
    arkDir,
    dbPath: join(arkDir, "ark.db"),
    tracksDir: join(arkDir, "tracks"),
    worktreesDir: join(arkDir, "worktrees"),
    logDir: join(arkDir, "logs"),
    conductorPort,
    conductorUrl: process.env.ARK_CONDUCTOR_URL ?? (conductorPort !== 19100 ? `http://localhost:${conductorPort}` : DEFAULT_CONDUCTOR_URL),
    env: process.env.ARK_TEST_DIR !== undefined ? "test" : "production",
    otlp: {
      enabled: (yaml.otlp as Record<string, unknown>)?.enabled === true,
      endpoint: (yaml.otlp as Record<string, unknown>)?.endpoint as string | undefined,
      headers: (yaml.otlp as Record<string, unknown>)?.headers as Record<string, string> | undefined,
    },
    rollback: {
      enabled: (yaml.rollback as Record<string, unknown>)?.enabled === true,
      timeout: ((yaml.rollback as Record<string, unknown>)?.timeout as number) ?? 600,
      on_timeout: ((yaml.rollback as Record<string, unknown>)?.on_timeout as "rollback" | "ignore") ?? "ignore",
      auto_merge: (yaml.rollback as Record<string, unknown>)?.auto_merge === true,
      health_url: ((yaml.rollback as Record<string, unknown>)?.health_url as string) ?? null,
    },
    telemetry: {
      enabled: process.env.ARK_TELEMETRY === "1" || (yaml.telemetry as Record<string, unknown>)?.enabled === true,
      endpoint: (yaml.telemetry as Record<string, unknown>)?.endpoint as string | undefined,
    },
    router: {
      enabled: (yaml.router as Record<string, unknown>)?.enabled === true,
      url: ((yaml.router as Record<string, unknown>)?.url as string) ?? DEFAULT_ROUTER_URL,
      policy: ((yaml.router as Record<string, unknown>)?.policy as "quality" | "balanced" | "cost") ?? "balanced",
    },
    default_compute: process.env.ARK_DEFAULT_COMPUTE ?? (yaml.default_compute as string) ?? null,
    hotkeys: yaml.hotkeys as Record<string, string | null> | undefined,
    budgets: yaml.budgets as ArkConfig["budgets"],
    theme: yaml.theme as string | undefined,
    notifications: yaml.notifications as boolean | undefined,
    auth: {
      enabled: (yaml.auth as Record<string, unknown>)?.enabled === true,
      apiKeyEnabled: (yaml.auth as Record<string, unknown>)?.apiKeyEnabled === true
        || (yaml.auth as Record<string, unknown>)?.api_key_enabled === true,
    },
    tensorZero: {
      enabled: process.env.ARK_TENSORZERO_ENABLED === "1"
        || (yaml.tensorzero as Record<string, unknown>)?.enabled === true
        || (yaml.tensor_zero as Record<string, unknown>)?.enabled === true,
      port: parseInt(process.env.ARK_TENSORZERO_PORT ?? "3000", 10),
      configDir: (yaml.tensorzero as Record<string, unknown>)?.config_dir as string
        ?? (yaml.tensor_zero as Record<string, unknown>)?.config_dir as string
        ?? undefined,
      autoStart: (yaml.tensorzero as Record<string, unknown>)?.auto_start === true
        || (yaml.tensor_zero as Record<string, unknown>)?.auto_start === true,
    },
    computeTemplates: parseComputeTemplates(yaml.compute_templates),
    databaseUrl: process.env.DATABASE_URL ?? (yaml.database_url as string) ?? undefined,
    redisUrl: process.env.REDIS_URL ?? (yaml.redis_url as string) ?? undefined,
  };

  if (overrides) {
    const { arkDir: _a, ...rest } = overrides;
    Object.assign(base, rest);
  }

  return base;
}

/**
 * Parse compute_templates from config.yaml.
 * Accepts a map of name → { provider, description?, ...config } entries.
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
