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
import type { DatabaseAdapter } from "../../database.js";
import { AppContext } from "../../app.js";
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
  repo = app.computes;
  svc = app.computeService;
});

afterEach(async () => {
  await app?.shutdown();
});

describe("ComputeService", async () => {
  // ── create ─────────────────────────────────────────────────────────────────

  it("create delegates to repository", async () => {
    const c = await svc.create({ name: "test-docker", provider: "docker" });
    expect(c.name).toBe("test-docker");
    expect(c.provider).toBe("docker");
    expect(c.status).toBe("stopped");
  });

  it("create rejects second local provider (singleton)", async () => {
    // "local" already seeded -- creating another must throw
    expect(svc.create({ name: "local2", provider: "local" })).rejects.toThrow(/singleton/);
  });

  // ── get ────────────────────────────────────────────────────────────────────

  it("get returns seeded local compute", async () => {
    const c = await svc.get("local");
    expect(c).not.toBeNull();
    expect(c!.provider).toBe("local");
  });

  it("get returns null for nonexistent", async () => {
    expect(await svc.get("no-such")).toBeNull();
  });

  // ── list ───────────────────────────────────────────────────────────────────

  it("list returns all compute entries", async () => {
    await svc.create({ name: "d1", provider: "docker" });
    const all = await svc.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("list filters by provider", async () => {
    await svc.create({ name: "d1", provider: "docker" });
    await svc.create({ name: "e1", provider: "ec2" });
    const dockers = await svc.list({ provider: "docker" });
    expect(dockers.every((c) => c.provider === "docker")).toBe(true);
  });

  // ── update ─────────────────────────────────────────────────────────────────

  it("update changes fields", async () => {
    await svc.create({ name: "upd", provider: "docker" });
    const updated = await svc.update("upd", { status: "running" as ComputeStatus });
    expect(updated!.status).toBe("running");
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  it("delete removes compute", async () => {
    await svc.create({ name: "del-me", provider: "docker" });
    expect(await svc.delete("del-me")).toBe(true);
    expect(await svc.get("del-me")).toBeNull();
  });

  it("delete prevents deleting 'local'", async () => {
    expect(await svc.delete("local")).toBe(false);
    expect(await svc.get("local")).not.toBeNull();
  });

  it("delete returns false for nonexistent", async () => {
    expect(await svc.delete("no-such")).toBe(false);
  });

  // ── mergeConfig ────────────────────────────────────────────────────────────

  it("mergeConfig delegates to repository", async () => {
    await svc.create({ name: "merge", provider: "docker", config: { ip: "1.2.3.4" } });
    const updated = await svc.mergeConfig("merge", { region: "us-east-1" });
    expect(updated!.config).toEqual({ ip: "1.2.3.4", region: "us-east-1" });
  });

  // ── DI container overrides ────────────────────────────────────────────
  //
  // Demonstrates replacing the compute repository with a fake so
  // ComputeService.create() can be exercised without touching SQLite.

  describe("container overrides", () => {
    it("swapping computes repo with a fake intercepts create()", async () => {
      const stored: Compute[] = [];
      const fakeRepo = {
        create: mock(async (opts: { name: string; provider: string }) => {
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
        get: mock(async (name: string) => stored.find((c) => c.name === name) ?? null),
        list: mock(async () => stored),
        update: mock(async () => null),
        delete: mock(async () => true),
        mergeConfig: mock(async () => null),
      };

      app.container.register({
        computes: asValue(fakeRepo as unknown as ComputeRepository),
        computeService: asValue(new ComputeService(fakeRepo as unknown as ComputeRepository)),
      });

      const freshSvc = app.container.resolve("computeService");
      const c = await freshSvc.create({ name: "fake-ec2", provider: "ec2" });

      expect(c.name).toBe("fake-ec2");
      expect(fakeRepo.create).toHaveBeenCalledTimes(1);
      expect(stored.length).toBe(1);

      // Real repo is untouched (override only affects the container copy).
      expect(await repo.get("fake-ec2")).toBeNull();
    });
  });

  // ── Pure-unit construction (legacy, still supported) ──────────────────

  describe("pure unit construction (no container)", () => {
    let pureDb: DatabaseAdapter;
    let pureSvc: ComputeService;

    beforeEach(async () => {
      pureDb = new BunSqliteAdapter(new Database(":memory:"));
      await initSchema(pureDb);
      await seedLocalCompute(pureDb);
      pureSvc = new ComputeService(new ComputeRepository(pureDb));
    });

    it("create() works without an AppContext", async () => {
      const c = await pureSvc.create({ name: "pure-docker", provider: "docker" });
      expect(c.name).toBe("pure-docker");
    });
  });
});
