/**
 * Env-var source: collect ARK_* variables and coerce them into
 * partial-shape overrides for the config resolver.
 *
 * Unknown env vars are ignored -- this is not the place to error on
 * typos (Spring Boot's approach: log once, don't crash). Type coercion
 * is strict: a malformed integer logs a warning and is dropped, rather
 * than silently becoming NaN.
 *
 * This module is pure: given `env`, it returns a partial overrides
 * object. The resolver composes it with YAML / profile defaults.
 */

import type {
  PortsConfig,
  ChannelsConfig,
  ObservabilityConfig,
  AuthSectionConfig,
  FeaturesConfig,
  StorageConfig,
} from "./types.js";

export interface EnvSecretsOverrides {
  backend?: "file" | "aws";
  awsRegion?: string;
  awsKmsKeyId?: string;
}

export interface EnvOverrides {
  arkDir?: string;
  ports: Partial<PortsConfig>;
  channels: Partial<ChannelsConfig>;
  observability: Partial<ObservabilityConfig>;
  auth: Partial<AuthSectionConfig>;
  features: Partial<FeaturesConfig>;
  storage: Partial<StorageConfig>;
  secrets: EnvSecretsOverrides;
  databaseUrl?: string;
  redisUrl?: string;
}

function parseIntStrict(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    // Non-fatal: warn and drop so the rest of the config still resolves.
    // We can't use the structured logger here (it depends on config),
    // so fall back to console.
    console.warn(`[config] ${name}=${raw} is not an integer -- ignored`);
    return undefined;
  }
  return n;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function parseLogLevel(raw: string | undefined): ObservabilityConfig["logLevel"] | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return undefined;
}

/** Read the current process env into a typed overrides object. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvOverrides {
  const out: EnvOverrides = {
    ports: {},
    channels: {},
    observability: {},
    auth: {},
    features: {},
    storage: {},
    secrets: {},
  };

  // Dirs
  if (env.ARK_DIR) out.arkDir = env.ARK_DIR;
  else if (env.ARK_TEST_DIR) out.arkDir = env.ARK_TEST_DIR;

  // Ports
  // ARK_CONDUCTOR_PORT sets the merged conductor port (was 19100, now 19400).
  // ARK_SERVER_PORT is a legacy alias for the same port -- A3 will remove it.
  const conductor =
    parseIntStrict(env.ARK_CONDUCTOR_PORT, "ARK_CONDUCTOR_PORT") ??
    parseIntStrict(env.ARK_SERVER_PORT, "ARK_SERVER_PORT");
  if (conductor !== undefined) out.ports.conductor = conductor;
  const arkd = parseIntStrict(env.ARK_ARKD_PORT, "ARK_ARKD_PORT");
  if (arkd !== undefined) out.ports.arkd = arkd;
  const web = parseIntStrict(env.ARK_WEB_PORT, "ARK_WEB_PORT");
  if (web !== undefined) out.ports.web = web;

  // Channels
  const chBase = parseIntStrict(env.ARK_CHANNEL_BASE_PORT, "ARK_CHANNEL_BASE_PORT");
  if (chBase !== undefined) out.channels.basePort = chBase;
  const chRange = parseIntStrict(env.ARK_CHANNEL_RANGE, "ARK_CHANNEL_RANGE");
  if (chRange !== undefined) out.channels.range = chRange;

  // Observability
  const level = parseLogLevel(env.ARK_LOG_LEVEL);
  if (level) out.observability.logLevel = level;
  if (env.ARK_OTLP_ENDPOINT) out.observability.otlpEndpoint = env.ARK_OTLP_ENDPOINT;

  // Auth
  const requireTok = parseBool(env.ARK_AUTH_REQUIRE_TOKEN);
  if (requireTok !== undefined) out.auth.requireToken = requireTok;
  if (env.ARK_DEFAULT_TENANT) out.auth.defaultTenant = env.ARK_DEFAULT_TENANT;

  // Features
  const autoRebase = parseBool(env.ARK_AUTO_REBASE);
  if (autoRebase !== undefined) out.features.autoRebase = autoRebase;

  // Storage
  const blobBackend = env.ARK_BLOB_BACKEND?.toLowerCase();
  if (blobBackend === "local" || blobBackend === "s3") {
    out.storage.blobBackend = blobBackend;
  }
  if (env.ARK_S3_BUCKET || env.ARK_S3_REGION || env.ARK_S3_PREFIX || env.ARK_S3_ENDPOINT) {
    out.storage.s3 = {
      bucket: env.ARK_S3_BUCKET ?? "",
      region: env.ARK_S3_REGION ?? "",
      prefix: env.ARK_S3_PREFIX,
      endpoint: env.ARK_S3_ENDPOINT,
    };
  }

  // Secrets backend
  const secretsBackend = env.ARK_SECRETS_BACKEND?.toLowerCase();
  if (secretsBackend === "file" || secretsBackend === "aws") {
    out.secrets.backend = secretsBackend;
  }
  if (env.ARK_SECRETS_AWS_REGION) out.secrets.awsRegion = env.ARK_SECRETS_AWS_REGION;
  if (env.ARK_SECRETS_AWS_KMS_KEY_ID) out.secrets.awsKmsKeyId = env.ARK_SECRETS_AWS_KMS_KEY_ID;

  // Database
  if (env.DATABASE_URL) out.databaseUrl = env.DATABASE_URL;
  if (env.REDIS_URL) out.redisUrl = env.REDIS_URL;

  return out;
}
