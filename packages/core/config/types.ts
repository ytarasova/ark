/**
 * Typed AppConfig shape -- Spring-Boot-style nested sections.
 *
 * This is the future-facing config surface. The legacy flat fields on
 * `ArkConfig` are retained for back-compat and will be derived from
 * these nested sections during the transition.
 *
 * Every field has an `@envvar` TSDoc tag naming the env var that
 * overrides it, so `ARK_*` vars are discoverable from the type itself.
 */

/** Active profile -- selected by explicit arg, `ARK_PROFILE`, or heuristics. */
export type ArkProfile = "local" | "control-plane" | "test";

/** Filesystem locations. */
export interface DirsConfig {
  /**
   * Ark home directory. Contains ark.db, logs, user-defined
   * agents/flows/skills, etc.
   * @envvar ARK_DIR (preferred) / ARK_TEST_DIR (legacy)
   * @default ~/.ark
   */
  ark: string;
  /**
   * Worktrees dir for session branches.
   * @default {dirs.ark}/worktrees
   */
  worktrees: string;
  /**
   * Tracks dir for session transcripts / state.
   * @default {dirs.ark}/tracks
   */
  tracks: string;
  /**
   * Log directory.
   * @default {dirs.ark}/logs
   */
  logs: string;
  /**
   * Scratch / temp dir for short-lived state.
   * @default {dirs.ark}/tmp
   */
  tmp: string;
}

/** Network ports. */
export interface PortsConfig {
  /**
   * Conductor HTTP port.
   * @envvar ARK_CONDUCTOR_PORT
   * @default 19100 (test profile: random)
   */
  conductor: number;
  /**
   * Arkd agent-proxy port.
   * @envvar ARK_ARKD_PORT
   * @default 19300 (test profile: random)
   */
  arkd: number;
  /**
   * Server daemon WS port.
   * @envvar ARK_SERVER_PORT
   * @default 19400 (test profile: random)
   */
  server: number;
  /**
   * Web dashboard port.
   * @envvar ARK_WEB_PORT
   * @default 8420 (test profile: random)
   */
  web: number;
}

/** Database connection. */
export interface DatabaseConfig {
  /**
   * Database URL. Undefined means local SQLite at {dirs.ark}/ark.db.
   * A `postgres://` URL selects the Postgres adapter (control-plane).
   * @envvar DATABASE_URL
   */
  url?: string;
}

/** Channel port allocation for session IPC. */
export interface ChannelsConfig {
  /**
   * Base port for channel hash: port = basePort + (hash(sessionId) % range).
   * @envvar ARK_CHANNEL_BASE_PORT
   * @default 19200 (test profile: randomized by port allocator)
   */
  basePort: number;
  /**
   * Range size for the channel port hash modulus.
   * @envvar ARK_CHANNEL_RANGE
   * @default 10000 (test profile: 1000)
   */
  range: number;
}

/** Observability knobs. */
export interface ObservabilityConfig {
  /**
   * OTLP collector endpoint (OpenTelemetry traces/spans).
   * @envvar ARK_OTLP_ENDPOINT
   */
  otlpEndpoint?: string;
  /**
   * Root log level. Components can override via `setLogComponents`.
   * @envvar ARK_LOG_LEVEL
   * @default "info" (test profile: "error")
   */
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Auth / multi-tenancy. */
export interface AuthSectionConfig {
  /**
   * Require a bearer token on the public API.
   * @envvar ARK_AUTH_REQUIRE_TOKEN
   * @default false (local / test), true (control-plane)
   */
  requireToken: boolean;
  /**
   * Tenant id used when no explicit tenant is provided on an API call.
   * @envvar ARK_DEFAULT_TENANT
   * @default null
   */
  defaultTenant: string | null;
}

/** Blob storage -- uploads, exports, anything that can't live on one replica's disk. */
export interface StorageConfig {
  /**
   * Active backend. `local` writes under `{dirs.ark}/blobs`, `s3` writes to
   * the bucket configured below.
   * @envvar ARK_BLOB_BACKEND
   * @default "local" (local/test profile) / "s3" (control-plane profile)
   */
  blobBackend: "local" | "s3";
  /**
   * S3 backend settings. Required when `blobBackend === "s3"`; ignored otherwise.
   * Credentials use the AWS SDK default provider chain (env / shared config / IMDS).
   */
  s3?: {
    /** @envvar ARK_S3_BUCKET */
    bucket: string;
    /** @envvar ARK_S3_REGION */
    region: string;
    /**
     * Key prefix under the bucket root.
     * @envvar ARK_S3_PREFIX
     * @default "ark"
     */
    prefix?: string;
    /**
     * Override endpoint for LocalStack / MinIO. Unset in production.
     * @envvar ARK_S3_ENDPOINT
     */
    endpoint?: string;
  };
}

/** Feature flags. Grep the codebase for new `config.features.*` usage. */
export interface FeaturesConfig {
  /**
   * Enable auto-rebase on agent completion.
   * @envvar ARK_AUTO_REBASE
   */
  autoRebase: boolean;
  /**
   * Route new hosted sessions through Temporal.
   * @envvar ARK_TEMPORAL_ORCHESTRATION
   * @default false
   */
  temporalOrchestration: boolean;
  /**
   * Run shadow Temporal projector alongside bespoke engine.
   * @envvar ARK_TEMPORAL_SHADOW
   * @default false
   */
  temporalOrchestrationShadow: boolean;
}

/** Temporal workflow engine configuration. */
export interface TemporalConfig {
  /**
   * Temporal server address.
   * @envvar ARK_TEMPORAL_SERVER_URL
   * @default "localhost:7233"
   */
  serverUrl: string;
  /**
   * Temporal namespace.
   * @envvar ARK_TEMPORAL_NAMESPACE
   * @default "default"
   */
  namespace: string;
  /**
   * Task queues this worker pulls from.
   * @default []
   */
  taskQueueAssignments: string[];
  /**
   * Whether to start a Temporal worker in this process.
   * @envvar ARK_TEMPORAL_WORKER
   * @default false
   */
  workerEnabled: boolean;
}

/**
 * Profile defaults -- partial shape, merged by the resolver under env / YAML
 * / programmatic overrides. Profiles export one of these.
 */
export interface ProfileDefaults {
  profile: ArkProfile;
  /** Test profile pre-allocates a dir; other profiles leave undefined. */
  arkDir?: string;
  ports: PortsConfig;
  channels: ChannelsConfig;
  auth: AuthSectionConfig;
  features: FeaturesConfig;
  observability: { logLevel: ObservabilityConfig["logLevel"] };
  storage: StorageConfig;
  temporal?: Partial<TemporalConfig>;
}
