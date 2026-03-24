import { join } from "path";
import { homedir } from "os";

export interface ArkConfig {
  arkDir: string;
  dbPath: string;
  tracksDir: string;
  worktreesDir: string;
  logDir: string;
  conductorPort: number;
  conductorUrl: string;
  env: "production" | "test";
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
  };

  if (overrides) {
    const { arkDir: _a, ...rest } = overrides;
    Object.assign(base, rest);
  }

  return base;
}
