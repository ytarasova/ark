import { describe, it, expect } from "bun:test";
import { buildRouterEnv } from "../router-env.js";
import type { ArkConfig } from "../../config.js";

function makeConfig(routerEnabled: boolean, url = "http://localhost:8430"): ArkConfig {
  return {
    arkDir: "/tmp/ark",
    dbPath: "/tmp/ark/ark.db",
    tracksDir: "/tmp/ark/tracks",
    worktreesDir: "/tmp/ark/worktrees",
    logDir: "/tmp/ark/logs",
    conductorPort: 19100,
    conductorUrl: "http://localhost:19100",
    env: "test",
    otlp: { enabled: false },
    rollback: { enabled: false, timeout: 600, on_timeout: "ignore", auto_merge: false, health_url: null },
    telemetry: { enabled: false },
    router: { enabled: routerEnabled, url, policy: "balanced", autoStart: false },
    default_compute: null,
  };
}

describe("buildRouterEnv", () => {
  it("returns empty object when router is disabled", () => {
    const config = makeConfig(false);
    expect(buildRouterEnv(config, { mode: "claude" })).toEqual({});
    expect(buildRouterEnv(config, { mode: "openai" })).toEqual({});
  });

  it("claude mode sets ANTHROPIC_BASE_URL only", () => {
    const config = makeConfig(true, "http://localhost:8430");
    const env = buildRouterEnv(config, { mode: "claude" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:8430");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("openai mode sets both OPENAI_BASE_URL and ANTHROPIC_BASE_URL", () => {
    const config = makeConfig(true, "http://localhost:8430");
    const env = buildRouterEnv(config, { mode: "openai" });
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:8430/v1");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:8430");
  });

  it("uses custom router URL", () => {
    const config = makeConfig(true, "https://router.example.com:9000");
    const env = buildRouterEnv(config, { mode: "claude" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://router.example.com:9000");
  });

  it("returns empty when config.router is undefined", () => {
    const config = makeConfig(false);
    delete (config as any).router;
    expect(buildRouterEnv(config, { mode: "claude" })).toEqual({});
  });
});
