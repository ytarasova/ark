/**
 * LLM Router -- configuration loader.
 *
 * Loads from ~/.ark/router.yaml or env vars. Falls back to sensible defaults
 * with a default model pool covering Anthropic, OpenAI, and Google.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import YAML from "yaml";
import type { RouterConfig, ProviderConfig, ModelConfig, RoutingPolicy } from "./types.js";

// ── Default model pool ───────────────────────────────────────────────────────

export const DEFAULT_MODELS: ModelConfig[] = [
  // Anthropic
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    tier: "frontier",
    cost_input: 15.0,
    cost_output: 75.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.98,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    tier: "standard",
    cost_input: 3.0,
    cost_output: 15.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.92,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    tier: "economy",
    cost_input: 0.8,
    cost_output: 4.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.82,
  },
  // OpenAI
  {
    id: "gpt-4.1",
    provider: "openai",
    tier: "frontier",
    cost_input: 2.0,
    cost_output: 8.0,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.95,
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    tier: "standard",
    cost_input: 0.4,
    cost_output: 1.6,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.88,
  },
  {
    id: "gpt-4.1-nano",
    provider: "openai",
    tier: "economy",
    cost_input: 0.1,
    cost_output: 0.4,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.75,
  },
  // Google
  {
    id: "gemini-2.5-pro",
    provider: "google",
    tier: "frontier",
    cost_input: 1.25,
    cost_output: 10.0,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.94,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    tier: "economy",
    cost_input: 0.15,
    cost_output: 0.6,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.8,
  },
];

// ── Default provider configs ─────────────────────────────────────────────────

function defaultProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.push({
      name: "anthropic",
      api_key: anthropicKey,
      base_url: "https://api.anthropic.com",
      models: DEFAULT_MODELS.filter((m) => m.provider === "anthropic"),
      timeout_ms: 60000,
      max_retries: 2,
    });
  }

  // OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.push({
      name: "openai",
      api_key: openaiKey,
      base_url: "https://api.openai.com",
      models: DEFAULT_MODELS.filter((m) => m.provider === "openai"),
      timeout_ms: 60000,
      max_retries: 2,
    });
  }

  // Google
  const googleKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (googleKey) {
    providers.push({
      name: "google",
      api_key: googleKey,
      base_url: "https://generativelanguage.googleapis.com",
      models: DEFAULT_MODELS.filter((m) => m.provider === "google"),
      timeout_ms: 60000,
      max_retries: 2,
    });
  }

  return providers;
}

// ── YAML config loader ───────────────────────────────────────────────────────

function loadYamlConfig(arkDir: string): Record<string, unknown> {
  const configPath = join(arkDir, "router.yaml");
  if (!existsSync(configPath)) return {};
  try {
    return (YAML.parse(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const DEFAULT_ROUTER_PORT = 8430;

export function loadRouterConfig(overrides?: Partial<RouterConfig>): RouterConfig {
  const arkDir = process.env.ARK_TEST_DIR ?? join(homedir(), ".ark");
  const yaml = loadYamlConfig(arkDir);

  // Merge YAML providers with env-based defaults
  const yamlProviders = yaml.providers as ProviderConfig[] | undefined;
  const envProviders = defaultProviders();

  // If YAML specifies providers, use those (with env key fallback); otherwise use env-detected providers
  let providers: ProviderConfig[];
  if (yamlProviders && yamlProviders.length > 0) {
    providers = yamlProviders.map((p) => ({
      ...p,
      api_key: p.api_key || getProviderKeyFromEnv(p.name),
      models: p.models?.length ? p.models : DEFAULT_MODELS.filter((m) => m.provider === p.name),
    }));
  } else {
    providers = envProviders;
  }

  const config: RouterConfig = {
    port: asNumber(yaml.port) ?? parseInt(process.env.ARK_ROUTER_PORT ?? String(DEFAULT_ROUTER_PORT), 10),
    policy: (yaml.policy as RoutingPolicy) ?? (process.env.ARK_ROUTER_POLICY as RoutingPolicy) ?? "balanced",
    quality_floor: asNumber(yaml.quality_floor) ?? 0.8,
    providers,
    sticky_session_ttl_ms: asNumber(yaml.sticky_session_ttl_ms) ?? 3600000,
    cascade_enabled: yaml.cascade_enabled === true,
    cascade_confidence_threshold: asNumber(yaml.cascade_confidence_threshold) ?? 0.7,
    log_decisions: yaml.log_decisions !== false,
  };

  if (overrides) {
    Object.assign(config, overrides);
  }

  return config;
}

/** Get all models from all providers in a config. */
export function allModels(config: RouterConfig): ModelConfig[] {
  return config.providers.flatMap((p) => p.models);
}

/** Find a model by ID across all providers. */
export function findModel(config: RouterConfig, modelId: string): ModelConfig | undefined {
  for (const p of config.providers) {
    const m = p.models.find((m) => m.id === modelId);
    if (m) return m;
  }
  return undefined;
}

/** Find which provider owns a model. */
export function findProviderForModel(config: RouterConfig, modelId: string): ProviderConfig | undefined {
  return config.providers.find((p) => p.models.some((m) => m.id === modelId));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getProviderKeyFromEnv(name: string): string | undefined {
  switch (name) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    default:
      return undefined;
  }
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}
