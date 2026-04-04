import { join } from "path";
import { homedir } from "os";

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
  default_compute: string | null;
}

export function loadConfig(overrides?: Partial<ArkConfig>): ArkConfig {
  const arkDir = overrides?.arkDir ?? process.env.ARK_TEST_DIR ?? join(homedir(), ".ark");
  const conductorPort = overrides?.conductorPort
    ?? parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100", 10);

  const base: ArkConfig = {
    arkDir,
    dbPath: join(arkDir, "ark.db"),
    tracksDir: join(arkDir, "tracks"),
    worktreesDir: join(arkDir, "worktrees"),
    logDir: join(arkDir, "logs"),
    conductorPort,
    conductorUrl: process.env.ARK_CONDUCTOR_URL ?? `http://localhost:${conductorPort}`,
    env: process.env.ARK_TEST_DIR !== undefined ? "test" : "production",
    otlp: { enabled: false },
    rollback: { enabled: false, timeout: 600, on_timeout: "ignore", auto_merge: false, health_url: null },
    telemetry: { enabled: process.env.ARK_TELEMETRY === "1" },
    default_compute: process.env.ARK_DEFAULT_COMPUTE ?? null,
  };

  if (overrides) {
    const { arkDir: _a, ...rest } = overrides;
    Object.assign(base, rest);
  }

  return base;
}
