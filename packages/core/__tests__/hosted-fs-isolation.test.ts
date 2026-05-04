/**
 * Phase-2 audit fixes -- hosted-mode local-fs isolation.
 *
 * Each test in this file maps 1:1 to a finding from the Phase-2 audit:
 *
 *   H1 -- `_initFilesystem` no-ops in hosted mode
 *   H2 -- `setLogArkDir` is never called in hosted mode (=> no JSONL writes)
 *   H3 -- `state/profiles` mutators throw + listProfiles returns []
 *   H4 -- `claude/trust.{trustWorktree,trustDirectory}` no-op in hosted mode
 *   H6 -- `di/storage` rejects local blob backend in hosted mode
 *   H7 -- `di/runtime.snapshotStore` rejects FS backend in hosted mode
 *
 *   M1 -- `claude/sessions.refreshClaudeSessionsCache` returns 0 in hosted
 *   M2 -- `infra/boot-cleanup` skips cwd sweeps in hosted mode
 *   M3 -- `services/dispatch/guards.cloneRemoteRepoIfNeeded` skips in hosted
 *   M5 -- `modes/hosted-app-mode` plumbs config through (file backend opt-in)
 *   M6 -- `di/seed-builtins` throws when nothing seeds + nothing exists
 *   M7 -- `executors/agent-sdk` refuses launch in hosted mode
 *
 * The harness uses `forHostedTestAsync` (test-helpers.ts) which simulates
 * hosted mode against a SQLite test DB by overriding `app.mode` -- no
 * real Postgres needed. Each test is fully self-contained: build the
 * AppContext, exercise the code path, assert on the side effect.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import * as fsModule from "fs";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { forHostedTestAsync } from "./test-helpers.js";
import { buildHostedAppMode } from "../modes/app-mode.js";
import { FileSecretsProvider } from "../secrets/file-provider.js";
import { AwsSecretsProvider } from "../secrets/aws-provider.js";
import { setLogArkDir } from "../observability/structured-log.js";
import { setProfilesArkDir } from "../state/profiles.js";

// Ensure each test runs against a fresh module-level state. The
// structured-log + profiles modules cache an arkDir as a singleton; tests
// that ran earlier in the same worker may have bound a real path. Hosted-
// mode regression tests assert "no arkDir was bound", so we clear before
// every test in this file.
beforeEach(() => {
  setLogArkDir(null);
  setProfilesArkDir(null);
  delete process.env.ARK_MODE;
});

// ── H1 / H2 ─ _initFilesystem + structured-log singletons ──────────────────

describe("H1 -- _initFilesystem is a no-op in hosted mode", () => {
  it("does not mkdir config.dirs.* and does not configure log/profile arkDir", async () => {
    const ctx = await forHostedTestAsync({ stubBlobStore: true, stubSnapshotStore: true });
    // The test profile's arkDir was created by mkdtempSync inside testDefaults().
    // Boot must NOT now mkdir tracks/worktrees/logs subdirs. We check only the
    // child dirs because the parent already exists from profile setup.
    const tracksDir = ctx.config.dirs.tracks;
    const worktreesDir = ctx.config.dirs.worktrees;
    const logsDir = ctx.config.dirs.logs;

    // Stamp the parent so we can prove only the parent existed pre-boot.
    expect(existsSync(ctx.config.dirs.ark)).toBe(true);
    // The child dirs are derived from the parent and may not exist yet.
    const childExistedBefore = existsSync(tracksDir) || existsSync(worktreesDir) || existsSync(logsDir);

    await ctx.boot();

    // After boot in hosted mode, none of the child dirs should have been
    // freshly created (we cannot assert "still missing" if they happened to
    // exist before -- but in the test profile they never do).
    if (!childExistedBefore) {
      expect(existsSync(tracksDir)).toBe(false);
      expect(existsSync(worktreesDir)).toBe(false);
      expect(existsSync(logsDir)).toBe(false);
    }

    // H2: structured-log _arkDir stays null in hosted mode. We cannot read
    // the module's internal _arkDir directly without re-importing, but the
    // observable effect is "no ark.jsonl is ever written". Trigger a log
    // write and confirm the file does not exist.
    const { logInfo } = await import("../observability/structured-log.js");
    logInfo("session", "hosted-mode-test-marker", { tag: "phase2" });
    const jsonlPath = join(ctx.config.dirs.ark, "ark.jsonl");
    expect(existsSync(jsonlPath)).toBe(false);

    // ARK_MODE env stamp confirms the hosted branch ran.
    expect(process.env.ARK_MODE).toBe("hosted");

    await ctx.shutdown();
    // Cleanup the env stamp so other tests in the same worker don't see it.
    delete process.env.ARK_MODE;
  });

  it("local mode still mkdirs and binds the log arkDir", async () => {
    // Sanity counterpart -- if this stops passing, the gating regressed.
    const ctx = await AppContext.forTestAsync();
    await ctx.boot();
    expect(existsSync(ctx.config.dirs.tracks)).toBe(true);
    expect(existsSync(ctx.config.dirs.worktrees)).toBe(true);
    expect(existsSync(ctx.config.dirs.logs)).toBe(true);

    const { logInfo } = await import("../observability/structured-log.js");
    logInfo("session", "local-mode-test-marker", { tag: "phase2" });
    const jsonlPath = join(ctx.config.dirs.ark, "ark.jsonl");
    expect(existsSync(jsonlPath)).toBe(true);
    const body = readFileSync(jsonlPath, "utf-8");
    expect(body).toContain("local-mode-test-marker");

    await ctx.shutdown();
  });
});

// ── H3 ─ profiles store ─────────────────────────────────────────────────────

describe("H3 -- profiles store is unavailable in hosted mode", () => {
  it("listProfiles returns [] and mutators throw", async () => {
    const ctx = await forHostedTestAsync({ stubBlobStore: true, stubSnapshotStore: true });
    await ctx.boot();

    // The hosted-mode boot path skips setProfilesArkDir, so the module-level
    // _arkDir stays null -- profile mutators surface a clear error.
    const profiles = await import("../state/profiles.js");

    expect(profiles.listProfiles()).toEqual([]);
    expect(() => profiles.createProfile("tenant-a")).toThrow(/profiles unavailable in hosted mode/i);
    expect(() => profiles.deleteProfile("anything")).toThrow(/profiles unavailable in hosted mode/i);

    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });
});

// ── H4 ─ claude/trust ───────────────────────────────────────────────────────

describe("H4 -- claude/trust no-ops in hosted mode", () => {
  it("trustDirectory + trustWorktree do not touch ~/.claude.json or ~/.claude/projects", async () => {
    const ctx = await forHostedTestAsync({ stubBlobStore: true, stubSnapshotStore: true });
    await ctx.boot();
    // ARK_MODE is now "hosted" (set by _initFilesystem). Trust functions
    // read this env var and short-circuit without touching the home dir.
    expect(process.env.ARK_MODE).toBe("hosted");

    const writeSpy = spyOn(fsModule, "writeFileSync");
    const symlinkSpy = spyOn(fsModule, "symlinkSync");
    try {
      const { trustDirectory, trustWorktree } = await import("../claude/trust.js");
      trustDirectory("/tmp/some-fake-dir");
      trustWorktree("/tmp/some-fake-repo", "/tmp/some-fake-worktree");

      const writeArgs = writeSpy.mock.calls.map((c) => String(c[0]));
      const symlinkArgs = symlinkSpy.mock.calls.map((c) => String(c[1]));
      expect(writeArgs.filter((p) => p.includes(".claude.json"))).toEqual([]);
      expect(symlinkArgs.filter((p) => p.includes(".claude/projects"))).toEqual([]);
    } finally {
      writeSpy.mockRestore();
      symlinkSpy.mockRestore();
    }

    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });

  it("local-mode counterpart still writes to ~/.claude.json (regression guard)", async () => {
    // Confirm gating: in local mode, trustDirectory still does its job.
    delete process.env.ARK_MODE; // ensure local
    const writeSpy = spyOn(fsModule, "writeFileSync").mockImplementation(((..._args: unknown[]) => {
      // swallow: we don't actually want to write to the user's home in CI
    }) as never);
    try {
      const { trustDirectory } = await import("../claude/trust.js");
      trustDirectory("/tmp/local-fake-dir");
      const writeArgs = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(writeArgs.some((p) => p.includes(".claude.json"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ── H6 ─ di/storage blob backend ────────────────────────────────────────────

describe("H6 -- hosted mode requires storage.blobBackend=s3", () => {
  it("AppContext.boot throws when blob backend is local in hosted mode", async () => {
    // Default test profile has blobBackend=local. Boot must throw.
    const ctx = await forHostedTestAsync();
    let err: unknown = null;
    try {
      await ctx.boot();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/storage.blobBackend must be 's3'/);
    // Boot may have partially completed; tear down whatever was wired.
    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });

  it("hosted mode with valid s3 config boots cleanly", async () => {
    const ctx = await forHostedTestAsync({
      storage: { blobBackend: "s3", s3: { bucket: "test-bucket", region: "us-east-1", prefix: "ark-test" } },
      // H7 snapshotStore needs a stub since no real S3SnapshotStore exists yet.
      stubSnapshotStore: true,
    });
    await ctx.boot();
    expect(ctx.blobStore).toBeTruthy();
    expect(ctx.blobStore.constructor.name).toBe("S3BlobStore");
    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });
});

// ── H7 ─ di/runtime snapshot store ──────────────────────────────────────────

describe("H7 -- hosted mode rejects FsSnapshotStore", () => {
  it("AppContext.boot throws because snapshotStore factory refuses fs in hosted", async () => {
    const ctx = await forHostedTestAsync({
      // s3 blob is configured (and the blobStore stub satisfies H6 too), so
      // H7's snapshotStore guard is the one that fires.
      storage: { blobBackend: "s3", s3: { bucket: "b", region: "us-east-1", prefix: "p" } },
      stubBlobStore: true,
    });
    let err: unknown = null;
    try {
      await ctx.boot();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/snapshotStore.*hosted/i);
    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });

  it("local mode still uses FsSnapshotStore", async () => {
    const ctx = await AppContext.forTestAsync();
    await ctx.boot();
    expect(ctx.snapshotStore.constructor.name).toBe("FsSnapshotStore");
    await ctx.shutdown();
  });
});

// ── M1 ─ refreshClaudeSessionsCache ─────────────────────────────────────────

describe("M1 -- refreshClaudeSessionsCache returns 0 in hosted mode", () => {
  it("does not scan ~/.claude/projects/ in hosted mode", async () => {
    // We don't need a successful boot for this -- the function's hosted guard
    // fires on the AppContext alone. Build a minimal hosted ctx and call.
    const ctx = await forHostedTestAsync({
      storage: { blobBackend: "s3", s3: { bucket: "b", region: "us-east-1", prefix: "p" } },
    });
    // Boot will throw (H7), so rely on the pre-boot mode for the assertion.
    expect(ctx.mode.kind).toBe("hosted");
    const { refreshClaudeSessionsCache } = await import("../claude/sessions.js");
    // Pass a baseDir that DOES exist so the only thing protecting us is the
    // hosted-mode guard. Use a temp dir; the function will only scan when
    // local-mode wins.
    const dummyDir = mkdtempSync(join(tmpdir(), "ark-fake-claude-"));
    const n = await refreshClaudeSessionsCache(ctx, { baseDir: dummyDir });
    expect(n).toBe(0);

    await ctx.shutdown().catch(() => undefined);
    delete process.env.ARK_MODE;
  });
});

// ── M2 ─ boot-cleanup cwd sweeps ────────────────────────────────────────────

describe("M2 -- BootCleanup skips cwd sweeps in hosted mode", () => {
  it("does not probe process.cwd()/.claude or process.cwd()/.mcp.json in hosted mode", async () => {
    // Boot a fully-hosted ctx so the sessions repo + DB are wired (the
    // sessions sweep below uses them).
    const ctx = await forHostedTestAsync({ stubBlobStore: true, stubSnapshotStore: true });
    await ctx.boot();

    const existsSpy = spyOn(fsModule, "existsSync");
    try {
      const { BootCleanup } = await import("../infra/boot-cleanup.js");
      const det = new BootCleanup(ctx);
      await det.start();
      const probedCwdFiles = existsSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.includes(".claude/settings.local.json") || p.endsWith(".mcp.json"));
      expect(probedCwdFiles).toEqual([]);
    } finally {
      existsSpy.mockRestore();
    }

    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });
});

// ── M3 ─ cloneRemoteRepoIfNeeded ────────────────────────────────────────────

describe("M3 -- cloneRemoteRepoIfNeeded skips conductor-side clone in hosted", () => {
  it("returns ok without calling git clone in hosted mode", async () => {
    const ctx = await forHostedTestAsync();
    const { cloneRemoteRepoIfNeeded } = await import("../services/dispatch/guards.js");

    // Minimal deps shape; getApp returns the hosted ctx.
    const deps = {
      sessions: { update: async () => undefined, get: async () => null } as any,
      events: { log: async () => undefined } as any,
      config: ctx.config,
      getApp: () => ctx,
    };
    const session: any = {
      id: "s-test",
      workdir: null,
      config: { remoteRepo: "https://example.invalid/repo.git" },
    };
    const logs: string[] = [];
    const result = await cloneRemoteRepoIfNeeded(deps, session, (m) => logs.push(m));
    expect(result.ok).toBe(true);
    // Crucially: no clone happened (workdir stayed null).
    expect(session.workdir).toBeNull();
    expect(logs.some((l) => /skipping conductor-side remote-repo clone/i.test(l))).toBe(true);

    await ctx.shutdown().catch(() => undefined);
    delete process.env.ARK_MODE;
  });
});

// ── M5 ─ secrets backend opt-in ─────────────────────────────────────────────

describe("M5 -- hosted secrets backend defaults to AWS, file is opt-in", () => {
  it("buildHostedAppMode with no config uses AwsSecretsProvider", () => {
    const mode = buildHostedAppMode({ dialect: "postgres", url: "postgres://x" });
    expect(mode.secrets).toBeInstanceOf(AwsSecretsProvider);
  });

  it("buildHostedAppMode with config.secrets.backend='file' uses FileSecretsProvider", () => {
    const config: any = {
      secrets: { backend: "file" },
      dirs: { ark: "/tmp/ark-test-hosted-file-secrets" },
    };
    const mode = buildHostedAppMode({ dialect: "postgres", url: "postgres://x" }, config);
    expect(mode.secrets).toBeInstanceOf(FileSecretsProvider);
  });

  it("buildAppMode plumbs config through to buildHostedAppMode", async () => {
    const { buildAppMode } = await import("../modes/app-mode.js");
    const config: any = {
      database: { url: "postgres://test" },
      secrets: { backend: "file" },
      dirs: { ark: "/tmp/ark-test-buildAppMode-file-secrets" },
    };
    const mode = buildAppMode(config);
    expect(mode.kind).toBe("hosted");
    // With config plumbed, the file backend opt-in actually takes effect.
    expect(mode.secrets).toBeInstanceOf(FileSecretsProvider);
  });
});

// ── M6 ─ seed-builtins strict mode ──────────────────────────────────────────

describe("M6 -- seedBuiltinResources is strict in hosted mode", () => {
  it("throws when no builtin dirs found AND no existing rows", async () => {
    const fakeBase = join(tmpdir(), `ark-fake-base-${Date.now()}-${Math.random()}`);
    // Boot in hosted mode so the persistence layer wires DbResourceStore.
    const ctx = await forHostedTestAsync({ stubBlobStore: true, stubSnapshotStore: true });
    await ctx.boot();
    // The boot-time seeder already populated resource_definitions from the
    // real bundled YAMLs. Wipe it + invalidate the per-store sync caches so
    // this test exercises the "fresh deploy with broken image" path (no
    // dirs found AND no existing rows).
    const stmt = ctx.db.prepare("DELETE FROM resource_definitions");
    await stmt.run();
    for (const s of [ctx.flows, ctx.skills, ctx.agents, ctx.recipes, ctx.runtimes]) {
      const backing = (s as { backing?: unknown }).backing ?? s;
      const cache = (backing as { syncCache?: Map<string, unknown> }).syncCache;
      if (cache instanceof Map) cache.clear();
    }

    const { seedBuiltinResources } = await import("../di/seed-builtins.js");
    let err: unknown = null;
    try {
      await seedBuiltinResources(ctx, { baseDir: fakeBase });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/found no builtin resource dirs/);
    await ctx.shutdown();
    delete process.env.ARK_MODE;
  });

  it("does NOT throw in local mode even when builtin dir is missing", async () => {
    const fakeBase = join(tmpdir(), `ark-fake-base-${Date.now()}-${Math.random()}`);
    const local = await AppContext.forTestAsync();
    await local.boot();
    const { seedBuiltinResources } = await import("../di/seed-builtins.js");
    // Should NOT throw -- local mode is tolerant of missing builtin dirs.
    await seedBuiltinResources(local, { baseDir: fakeBase });
    await local.shutdown();
  });
});

// ── M7 ─ claude-agent executor refusal ─────────────────────────────────────

describe("M7 -- claude-agent executor refuses launch in hosted mode", () => {
  it("returns ok: false with a clear message in hosted mode", async () => {
    const ctx = await forHostedTestAsync();
    // We don't need a fully booted hosted stack -- the executor only needs
    // app.mode + app.sessions. Build a minimal session row through the
    // SQLite DB by booting in local mode first then flipping mode.
    await ctx.shutdown().catch(() => undefined);
    delete process.env.ARK_MODE;

    const local = await AppContext.forTestAsync();
    await local.boot();
    const session = await local.sessions.create({ summary: "hosted-test" });
    const hostedMode = buildHostedAppMode({ dialect: "postgres", url: "postgres://x" }, local.config as any);
    (local as any)._container.register({ mode: asValue(hostedMode) });

    const { claudeAgentExecutor } = await import("../executors/claude-agent.js");
    const result = await claudeAgentExecutor.launch({
      app: local,
      sessionId: session.id,
      task: "test",
      initialPrompt: "test",
      agent: { name: "test", model: "claude-3" } as any,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/claude-agent executor is local-mode only/);

    await local.shutdown();
  });
});
