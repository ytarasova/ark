/**
 * Config profiles -- Spring-Boot-style named layers of overrides.
 *
 * Three first-class profiles ship with ark:
 *
 *   - `local` (default): interactive developer install, `~/.ark`, tmux launcher,
 *     SQLite, fixed well-known ports (19100 conductor, 19300 arkd, etc.).
 *   - `control-plane`: hosted / SaaS deployment. Implies a Postgres
 *     `databaseUrl`, disables the tmux launcher (sessions run on remote
 *     workers), and requires auth tokens on the public API.
 *   - `test`: automated tests. Allocates unique ports per-worker, uses a
 *     per-PID temp dir, disables long-running background pollers.
 *
 * Resolution precedence for selecting a profile (highest first):
 *
 *   1. Explicit argument (`loadAppConfig({ profile: "..." })`).
 *   2. `ARK_PROFILE` env var.
 *   3. Heuristics: `NODE_ENV=test` -> test; `DATABASE_URL` set -> control-plane;
 *      otherwise `local`.
 *
 * Each profile module exports a `ProfileDefaults` object that the resolver
 * merges under env/YAML/override layers. Profiles never read env vars
 * themselves -- they are pure data.
 */

import type { ArkProfile, ProfileDefaults } from "./types.js";
import { allocatePort, allocateBasePort } from "./port-allocator.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Detect the active profile from arg / env / heuristics. */
export function detectProfile(explicit?: ArkProfile): ArkProfile {
  if (explicit) return explicit;

  const envProfile = process.env.ARK_PROFILE;
  if (envProfile === "local" || envProfile === "control-plane" || envProfile === "test") {
    return envProfile;
  }

  // Heuristic: bun:test or NODE_ENV=test -> test profile
  if (process.env.NODE_ENV === "test" || isBunTest()) return "test";

  // Heuristic: DATABASE_URL set to postgres -> control-plane
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
    return "control-plane";
  }

  return "local";
}

/** Rough bun-test detection. */
function isBunTest(): boolean {
  // bun sets BUN_TEST_MODE or puts "test" in argv[1] when invoked as `bun test ...`
  if (process.env.BUN_TEST_MODE) return true;
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith("/bun-test") || argv1.endsWith("bun:test")) return true;
  return false;
}

/** Local profile: developer install, fixed ports, ~/.ark. */
export async function localDefaults(): Promise<ProfileDefaults> {
  return {
    profile: "local",
    // ports -- fixed; ARK_* env vars still win.
    ports: {
      conductor: 19100,
      arkd: 19300,
      server: 19400,
      web: 8420,
    },
    channels: { basePort: 19200, range: 10000 },
    auth: { requireToken: false, defaultTenant: null },
    features: { autoRebase: false, codegraph: false },
    observability: { logLevel: "info" },
  };
}

/** Control-plane profile: hosted SaaS, Postgres-backed, auth required. */
export async function controlPlaneDefaults(): Promise<ProfileDefaults> {
  return {
    profile: "control-plane",
    ports: {
      conductor: 19100,
      arkd: 19300,
      server: 19400,
      web: 8420,
    },
    channels: { basePort: 19200, range: 10000 },
    auth: { requireToken: true, defaultTenant: null },
    features: { autoRebase: true, codegraph: false },
    observability: { logLevel: "info" },
  };
}

/**
 * Test profile: allocate unique ports, use a per-PID+nonce temp dir.
 *
 * Every port is bound via `allocatePort()` so concurrent workers don't
 * collide. Dirs live under `os.tmpdir()` namespaced by PID.
 */
export async function testDefaults(): Promise<ProfileDefaults> {
  const [conductor, arkd, server, web] = await Promise.all([
    allocatePort(),
    allocatePort(),
    allocatePort(),
    allocatePort(),
  ]);
  const channelsBase = await allocateBasePort(1000);
  const arkDir = mkdtempSync(join(tmpdir(), `ark-test-${process.pid}-`));

  return {
    profile: "test",
    arkDir,
    ports: { conductor, arkd, server, web },
    channels: { basePort: channelsBase, range: 1000 },
    auth: { requireToken: false, defaultTenant: null },
    features: { autoRebase: false, codegraph: false },
    observability: { logLevel: "error" }, // quiet tests
  };
}

/** Dispatch to the right defaults loader. */
export async function loadProfileDefaults(profile: ArkProfile): Promise<ProfileDefaults> {
  switch (profile) {
    case "local":
      return localDefaults();
    case "control-plane":
      return controlPlaneDefaults();
    case "test":
      return testDefaults();
  }
}
