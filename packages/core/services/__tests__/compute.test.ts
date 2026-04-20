/**
 * ComputeService tests.
 *
 * Uses the DI container (awilix) to wire the service. Demonstrates how to
 * swap a repository with a fake via `container.register({ <key>: asValue(fake) })`
 * -- see the "container overrides" block at the bottom.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { asValue } from "awilix";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { AppContext, setApp, clearApp } from "../../app.js";
import { ComputeService } from "../compute.js";
import { ComputeRepository } from "../../repositories/compute.js";
import { initSchema, seedLocalCompute } from "../../repositories/schema.js";
import type { Compute, ComputeStatus } from "../../../types/index.js";

let app: AppContext;
let repo: ComputeRepository;
let svc: ComputeService;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
  repo = app.computes;
  svc = app.computeService;
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("ComputeService", () => {
  // ── create ─────────────────────────────────────────────────────────────────

  it("create delegates to repository", () => {
    const c = svc.create({ name: "test-docker", provider: "docker" });
    expect(c.name).toBe("test-docker");
    expect(c.provider).toBe("docker");
    expect(c.status).toBe("stopped");
  });

  it("create rejects second local provider (singleton)", () => {
    // "local" already seeded -- creating another must throw
    expect(() => svc.create({ name: "local2", provider: "local" })).toThrow(/singleton/);
  });

  // ── get ────────────────────────────────────────────────────────────────────

  it("get returns seeded local compute", () => {
    const c = svc.get("local");
    expect(c).not.toBeNull();
    expect(c!.provider).toBe("local");
  });

  it("get returns null for nonexistent", () => {
    expect(svc.get("no-such")).toBeNull();
  });

  // ── list ───────────────────────────────────────────────────────────────────

  it("list returns all compute entries", () => {
    svc.create({ name: "d1", provider: "docker" });
    const all = svc.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("list filters by provider", () => {
    svc.create({ name: "d1", provider: "docker" });
    svc.create({ name: "e1", provider: "ec2" });
    const dockers = svc.list({ provider: "docker" });
    expect(dockers.every((c) => c.provider === "docker")).toBe(true);
  });

  // ── update ─────────────────────────────────────────────────────────────────

  it("update changes fields", () => {
    svc.create({ name: "upd", provider: "docker" });
    const updated = svc.update("upd", { status: "running" as ComputeStatus });
    expect(updated!.status).toBe("running");
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  it("delete removes compute", () => {
    svc.create({ name: "del-me", provider: "docker" });
    expect(svc.delete("del-me")).toBe(true);
    expect(svc.get("del-me")).toBeNull();
  });

  it("delete prevents deleting 'local'", () => {
    expect(svc.delete("local")).toBe(false);
    expect(svc.get("local")).not.toBeNull();
  });

  it("delete returns false for nonexistent", () => {
    expect(svc.delete("no-such")).toBe(false);
  });

  // ── mergeConfig ────────────────────────────────────────────────────────────

  it("mergeConfig delegates to repository", () => {
    svc.create({ name: "merge", provider: "docker", config: { ip: "1.2.3.4" } });
    const updated = svc.mergeConfig("merge", { region: "us-east-1" });
    expect(updated!.config).toEqual({ ip: "1.2.3.4", region: "us-east-1" });
  });

  // ── DI container overrides ────────────────────────────────────────────
  //
  // Demonstrates replacing the compute repository with a fake so
  // ComputeService.create() can be exercised without touching SQLite.

  describe("container overrides", () => {
    it("swapping computes repo with a fake intercepts create()", () => {
      const stored: Compute[] = [];
      const fakeRepo = {
        create: mock((opts: { name: string; provider: string }) => {
          const c = {
            name: opts.name,
            provider: opts.provider,
            status: "stopped" as ComputeStatus,
            config: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as unknown as Compute;
          stored.push(c);
          return c;
        }),
        get: mock((name: string) => stored.find((c) => c.name === name) ?? null),
        list: mock(() => stored),
        update: mock(() => null),
        delete: mock(() => true),
        mergeConfig: mock(() => null),
      };

      app.container.register({
        computes: asValue(fakeRepo as unknown as ComputeRepository),
        computeService: asValue(new ComputeService(fakeRepo as unknown as ComputeRepository)),
      });

      const freshSvc = app.container.resolve("computeService");
      const c = freshSvc.create({ name: "fake-ec2", provider: "ec2" });

      expect(c.name).toBe("fake-ec2");
      expect(fakeRepo.create).toHaveBeenCalledTimes(1);
      expect(stored.length).toBe(1);

      // Real repo is untouched (override only affects the container copy).
      expect(repo.get("fake-ec2")).toBeNull();
    });
  });

  // ── Pure-unit construction (legacy, still supported) ──────────────────

  describe("pure unit construction (no container)", () => {
    let pureDb: IDatabase;
    let pureSvc: ComputeService;

    beforeEach(() => {
      pureDb = new BunSqliteAdapter(new Database(":memory:"));
      initSchema(pureDb);
      seedLocalCompute(pureDb);
      pureSvc = new ComputeService(new ComputeRepository(pureDb));
    });

    it("create() works without an AppContext", () => {
      const c = pureSvc.create({ name: "pure-docker", provider: "docker" });
      expect(c.name).toBe("pure-docker");
    });
  });
});
