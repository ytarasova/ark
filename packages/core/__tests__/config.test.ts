import { describe, it, expect, afterEach } from "bun:test";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    for (const key of ["ARK_TEST_DIR", "ARK_CONDUCTOR_PORT", "ARK_CONDUCTOR_URL", "NODE_ENV"]) {
      if (origEnv[key] !== undefined) process.env[key] = origEnv[key];
      else delete process.env[key];
    }
  });

  it("uses ~/.ark defaults when no env vars set", () => {
    delete process.env.ARK_TEST_DIR;
    delete process.env.ARK_CONDUCTOR_PORT;
    const cfg = loadConfig();
    expect(cfg.dirs.ark).toContain(".ark");
    expect(cfg.dbPath).toContain("ark.db");
    expect(cfg.ports.conductor).toBe(19400);
    expect(cfg.env).toBe("production");
  });

  it("respects ARK_TEST_DIR", () => {
    process.env.ARK_TEST_DIR = "/tmp/ark-test-xyz";
    const cfg = loadConfig();
    expect(cfg.dirs.ark).toBe("/tmp/ark-test-xyz");
    expect(cfg.dbPath).toBe("/tmp/ark-test-xyz/ark.db");
    expect(cfg.dirs.tracks).toBe("/tmp/ark-test-xyz/tracks");
  });

  it("respects ARK_CONDUCTOR_PORT", () => {
    process.env.ARK_CONDUCTOR_PORT = "19555";
    const cfg = loadConfig();
    expect(cfg.ports.conductor).toBe(19555);
    expect(cfg.conductorUrl).toContain("19555");
  });

  it("applies overrides over env vars", () => {
    process.env.ARK_TEST_DIR = "/tmp/should-be-overridden";
    const cfg = loadConfig({ dirs: { ark: "/custom/path" } as any });
    expect(cfg.dirs.ark).toBe("/custom/path");
  });

  it("sets env to test when NODE_ENV is test", () => {
    process.env.NODE_ENV = "test";
    const cfg = loadConfig();
    expect(cfg.env).toBe("test");
  });
});
