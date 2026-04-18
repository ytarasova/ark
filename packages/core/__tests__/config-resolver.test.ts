/**
 * Tests for the Spring-Boot-style config resolver.
 *
 * Precedence (highest first):
 *   1. Programmatic overrides passed to loadAppConfig({...})
 *   2. ARK_* env vars
 *   3. {arkDir}/config.yaml (profile-aware)
 *   4. Profile defaults
 *
 * The test profile is also asserted end-to-end: unique ports per call,
 * unique temp dirs, no collision with sibling calls.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAppConfig, loadConfig } from "../config.js";
import { detectProfile } from "../config/profiles.js";
import { readEnv } from "../config/env-source.js";
import { allocatePort } from "../config/port-allocator.js";

// Keep a copy of env and restore after each test so we don't leak state
// into sibling tests (this whole suite mutates process.env heavily).
const ENV_KEYS_WE_TOUCH = [
  "ARK_DIR",
  "ARK_TEST_DIR",
  "ARK_PROFILE",
  "ARK_CONDUCTOR_PORT",
  "ARK_ARKD_PORT",
  "ARK_SERVER_PORT",
  "ARK_WEB_PORT",
  "ARK_CHANNEL_BASE_PORT",
  "ARK_CHANNEL_RANGE",
  "ARK_LOG_LEVEL",
  "ARK_OTLP_ENDPOINT",
  "ARK_AUTO_REBASE",
  "ARK_CODEGRAPH",
  "ARK_AUTH_REQUIRE_TOKEN",
  "ARK_DEFAULT_TENANT",
  "DATABASE_URL",
  "REDIS_URL",
  "NODE_ENV",
];

const savedEnv: Record<string, string | undefined> = {};
const tempDirsToCleanup: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS_WE_TOUCH) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS_WE_TOUCH) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => {
  for (const d of tempDirsToCleanup) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function scratchDir(prefix = "cfg-test"): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirsToCleanup.push(d);
  return d;
}

// ── Profile detection ────────────────────────────────────────────────────

describe("detectProfile", () => {
  it("defaults to local when no env hints present", () => {
    delete process.env.ARK_PROFILE;
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.BUN_TEST_MODE;
    expect(detectProfile()).toBe("local");
  });

  it("picks test when NODE_ENV=test", () => {
    delete process.env.ARK_PROFILE;
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    expect(detectProfile()).toBe("test");
  });

  it("picks control-plane when DATABASE_URL is postgres", () => {
    delete process.env.ARK_PROFILE;
    delete process.env.NODE_ENV;
    delete process.env.BUN_TEST_MODE;
    process.env.DATABASE_URL = "postgres://localhost/ark";
    expect(detectProfile()).toBe("control-plane");
  });

  it("ARK_PROFILE env var beats heuristics", () => {
    process.env.NODE_ENV = "test";
    process.env.ARK_PROFILE = "local";
    expect(detectProfile()).toBe("local");
  });

  it("explicit arg beats env and heuristics", () => {
    process.env.NODE_ENV = "test";
    process.env.ARK_PROFILE = "local";
    expect(detectProfile("control-plane")).toBe("control-plane");
  });

  it("rejects unknown ARK_PROFILE values (falls back to heuristics)", () => {
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.BUN_TEST_MODE;
    process.env.ARK_PROFILE = "prod";
    expect(detectProfile()).toBe("local");
  });
});

// ── Env-source parsing ─────────────────────────────────────────────────────

describe("readEnv", () => {
  it("drops malformed integers with a warning rather than NaN", () => {
    process.env.ARK_CONDUCTOR_PORT = "not-a-number";
    const out = readEnv();
    expect(out.ports.conductor).toBeUndefined();
  });

  it("parses valid integer ports", () => {
    process.env.ARK_CONDUCTOR_PORT = "19555";
    process.env.ARK_ARKD_PORT = "19777";
    const out = readEnv();
    expect(out.ports.conductor).toBe(19555);
    expect(out.ports.arkd).toBe(19777);
  });

  it("parses truthy/falsy booleans for feature flags", () => {
    process.env.ARK_AUTO_REBASE = "true";
    process.env.ARK_CODEGRAPH = "0";
    const out = readEnv();
    expect(out.features.autoRebase).toBe(true);
    expect(out.features.codegraph).toBe(false);
  });

  it("accepts ARK_DIR and falls back to ARK_TEST_DIR", () => {
    delete process.env.ARK_DIR;
    process.env.ARK_TEST_DIR = "/tmp/legacy";
    const a = readEnv();
    expect(a.arkDir).toBe("/tmp/legacy");

    process.env.ARK_DIR = "/tmp/new";
    const b = readEnv();
    expect(b.arkDir).toBe("/tmp/new");
  });
});

// ── Precedence: override > env > file > default ───────────────────────────

describe("loadConfig precedence", () => {
  it("profile defaults apply when nothing else is set", () => {
    delete process.env.ARK_CONDUCTOR_PORT;
    delete process.env.ARK_PROFILE;
    delete process.env.NODE_ENV;
    process.env.ARK_DIR = scratchDir(); // stable dir with no config.yaml
    const cfg = loadConfig({ profile: "local" });
    expect(cfg.ports.conductor).toBe(19100);
    expect(cfg.profile).toBe("local");
  });

  it("env var wins over profile default", () => {
    process.env.ARK_DIR = scratchDir();
    process.env.ARK_CONDUCTOR_PORT = "29100";
    const cfg = loadConfig({ profile: "local" });
    expect(cfg.ports.conductor).toBe(29100);
    expect(cfg.conductorPort).toBe(29100); // legacy mirror also updated
  });

  it("YAML file wins over profile default but loses to env", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "config.yaml"), "ports:\n  conductor: 39100\n  arkd: 39300\n");
    process.env.ARK_DIR = dir;
    delete process.env.ARK_CONDUCTOR_PORT;

    const cfgYaml = loadConfig({ profile: "local" });
    expect(cfgYaml.ports.conductor).toBe(39100);
    expect(cfgYaml.ports.arkd).toBe(39300);

    process.env.ARK_CONDUCTOR_PORT = "49100";
    const cfgEnv = loadConfig({ profile: "local" });
    expect(cfgEnv.ports.conductor).toBe(49100);
    expect(cfgEnv.ports.arkd).toBe(39300); // yaml still wins vs default for arkd
  });

  it("programmatic override beats everything", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "config.yaml"), "ports:\n  conductor: 39100\n");
    process.env.ARK_DIR = dir;
    process.env.ARK_CONDUCTOR_PORT = "49100";
    const cfg = loadConfig({ profile: "local", conductorPort: 59100 });
    expect(cfg.ports.conductor).toBe(59100);
    expect(cfg.conductorPort).toBe(59100);
  });

  it("YAML profile overlay merges on top of top-level keys", () => {
    const dir = scratchDir();
    writeFileSync(
      join(dir, "config.yaml"),
      [
        "ports:",
        "  conductor: 19100",
        "  arkd: 19300",
        "profiles:",
        "  control-plane:",
        "    ports:",
        "      conductor: 28888",
        "",
      ].join("\n"),
    );
    process.env.ARK_DIR = dir;
    delete process.env.ARK_CONDUCTOR_PORT;

    const cfgLocal = loadConfig({ profile: "local" });
    expect(cfgLocal.ports.conductor).toBe(19100);
    expect(cfgLocal.ports.arkd).toBe(19300);

    const cfgCp = loadConfig({ profile: "control-plane" });
    expect(cfgCp.ports.conductor).toBe(28888); // overlay wins
    expect(cfgCp.ports.arkd).toBe(19300); // falls through top-level
  });

  it("missing YAML file is non-fatal", () => {
    process.env.ARK_DIR = scratchDir(); // empty dir, no config.yaml
    const cfg = loadConfig({ profile: "local" });
    expect(cfg.ports.conductor).toBe(19100);
  });

  it("malformed YAML falls back to defaults without crashing", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "config.yaml"), "ports:\n  conductor: [not, valid\n");
    process.env.ARK_DIR = dir;
    const cfg = loadConfig({ profile: "local" });
    expect(cfg.ports.conductor).toBe(19100);
  });
});

// ── Profile defaults differ meaningfully ─────────────────────────────────

describe("profile defaults", () => {
  it("control-plane requires auth by default; local does not", () => {
    delete process.env.ARK_AUTH_REQUIRE_TOKEN;
    process.env.ARK_DIR = scratchDir();
    const local = loadConfig({ profile: "local" });
    const cp = loadConfig({ profile: "control-plane" });
    expect(local.authSection.requireToken).toBe(false);
    expect(cp.authSection.requireToken).toBe(true);
  });

  it("test profile defaults log level to error (quiet)", () => {
    process.env.ARK_DIR = scratchDir();
    delete process.env.ARK_LOG_LEVEL;
    const cfg = loadConfig({ profile: "test" });
    expect(cfg.observability.logLevel).toBe("error");
  });
});

// ── loadAppConfig async path with dynamic ports in the test profile ─────

describe("loadAppConfig (async)", () => {
  it("test profile allocates unique ports each call", async () => {
    const a = await loadAppConfig({ profile: "test" });
    const b = await loadAppConfig({ profile: "test" });

    // Every port pair should differ between sibling builds in test mode
    expect(a.ports.conductor).not.toBe(b.ports.conductor);
    expect(a.ports.arkd).not.toBe(b.ports.arkd);
    expect(a.ports.server).not.toBe(b.ports.server);
    expect(a.ports.web).not.toBe(b.ports.web);
  });

  it("test profile puts arkDir in a unique temp dir", async () => {
    const a = await loadAppConfig({ profile: "test" });
    const b = await loadAppConfig({ profile: "test" });
    expect(a.dirs.ark).not.toBe(b.dirs.ark);
    expect(a.dirs.ark.includes(String(process.pid))).toBe(true);
    tempDirsToCleanup.push(a.dirs.ark, b.dirs.ark);
  });

  it("test profile randomizes channel base port", async () => {
    const a = await loadAppConfig({ profile: "test" });
    const b = await loadAppConfig({ profile: "test" });
    // Not strictly unique (both are ephemeral-port-derived), but should
    // not be the fixed 19200 default.
    expect(a.channels.basePort).not.toBe(19200);
    expect(b.channels.basePort).not.toBe(19200);
    tempDirsToCleanup.push(a.dirs.ark, b.dirs.ark);
  });

  it("programmatic overrides still beat auto-allocated test ports", async () => {
    const cfg = await loadAppConfig({ profile: "test", conductorPort: 12345 });
    expect(cfg.ports.conductor).toBe(12345);
    tempDirsToCleanup.push(cfg.dirs.ark);
  });
});

// ── Port allocator sanity ────────────────────────────────────────────────

describe("allocatePort", () => {
  it("returns distinct ports on repeated calls", async () => {
    const ports = await Promise.all([allocatePort(), allocatePort(), allocatePort(), allocatePort()]);
    const unique = new Set(ports);
    // Not a strict guarantee, but 4 ephemeral ports in rapid succession
    // should be distinct >99.99% of the time.
    expect(unique.size).toBeGreaterThan(1);
    for (const p of ports) {
      expect(p).toBeGreaterThan(1024);
      expect(p).toBeLessThan(65536);
    }
  });
});

// ── Nested accessor parity ───────────────────────────────────────────────

describe("legacy flat <-> nested parity", () => {
  it("ports.conductor === conductorPort; dirs.ark === arkDir", () => {
    process.env.ARK_DIR = scratchDir();
    process.env.ARK_CONDUCTOR_PORT = "19100";
    const cfg = loadConfig({ profile: "local" });
    expect(cfg.ports.conductor).toBe(cfg.conductorPort);
    expect(cfg.dirs.ark).toBe(cfg.arkDir);
    expect(cfg.ports.arkd).toBe(cfg.arkdPort);
    expect(cfg.dirs.tracks).toBe(cfg.tracksDir);
    expect(cfg.dirs.worktrees).toBe(cfg.worktreesDir);
    expect(cfg.dirs.logs).toBe(cfg.logDir);
  });
});
