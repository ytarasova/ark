/**
 * ComputeService tests.
 *
 * Uses the DI container (awilix) to wire the service. Demonstrates how to
 * swap a repository with a fake via `container.register({ <key>: asValue(fake) })`
 * -- see the "container overrides" block at the bottom.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../../app.js";
import { ComputeService } from "../compute.js";
import { ComputeRepository } from "../../repositories/compute.js";
import type { Compute, ComputeStatus } from "../../../types/index.js";
import { providerOf } from "../../compute/adapters/provider-map.js";

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
  // ── create: rule-aware (singleton, initialStatus) ──────────────────────

  it("create returns compute with correct defaults (docker -> stopped)", async () => {
    const c = await svc.create({ name: "test-docker", provider: "docker" });
    expect(c.name).toBe("test-docker");
    expect(providerOf(c)).toBe("docker");
    expect(c.status).toBe("stopped");
  });

  it("create pulls initialStatus from the provider (local -> running)", async () => {
    // Fresh tenant has no local row seeded (seedLocalCompute runs at boot,
    // but it lives under the default tenant). An isolated tenant scope gives
    // us a ComputeService that writes against an empty `compute` view so
    // we can exercise the provider-driven initialStatus path without
    // tripping the singleton rule against the seeded default-tenant row.
    const isolated = app.forTenant("isolated-tenant");
    const c = await isolated.computeService.create({ name: "iso-local", provider: "local" });
    expect(c.status).toBe("running");
  });

  it("create rejects second local provider (singleton)", async () => {
    // "local" is seeded at boot -- creating another must throw.
    expect(svc.create({ name: "local2", provider: "local" })).rejects.toThrow(/singleton/);
  });

  it("create with no provider defaults to local and rejects (singleton)", async () => {
    expect(svc.create({ name: "auto" })).rejects.toThrow(/singleton/);
  });

  it("create allows a second local row when is_template=true (template exempt)", async () => {
    const c = await svc.create({ name: "local-tmpl", provider: "local", is_template: true });
    expect(c.is_template).toBe(true);
    expect(c.name).toBe("local-tmpl");
  });

  it("create allows a local-provider row when cloned_from is set (clone exempt)", async () => {
    // Seed a local template first.
    await svc.create({ name: "local-parent", provider: "local", is_template: true });
    // Clone of the template is concrete but exempt from the singleton check
    // because it carries cloned_from.
    const c = await svc.create({ name: "local-child", provider: "local", cloned_from: "local-parent" });
    expect(c.cloned_from).toBe("local-parent");
  });

  it("create throws for an unknown provider", async () => {
    expect(svc.create({ name: "mystery", provider: "not-a-real-provider" as any })).rejects.toThrow(/Unknown provider/);
  });

  // ── get ────────────────────────────────────────────────────────────────

  it("get returns seeded local compute", async () => {
    const c = await svc.get("local");
    expect(c).not.toBeNull();
    expect(providerOf(c!)).toBe("local");
  });

  it("get returns null for nonexistent", async () => {
    expect(await svc.get("no-such")).toBeNull();
  });

  // ── list ───────────────────────────────────────────────────────────────

  it("list returns all compute entries", async () => {
    await svc.create({ name: "d1", provider: "docker" });
    const all = await svc.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("list filters by provider", async () => {
    await svc.create({ name: "d1", provider: "docker" });
    await svc.create({ name: "e1", provider: "ec2" });
    const dockers = await svc.list({ provider: "docker" });
    expect(dockers.every((c) => providerOf(c) === "docker")).toBe(true);
  });

  // ── update ─────────────────────────────────────────────────────────────

  it("update changes fields", async () => {
    await svc.create({ name: "upd", provider: "docker" });
    const updated = await svc.update("upd", { session_id: `ark-s-${"upd"}`, status: "running" as ComputeStatus });
    expect(updated!.status).toBe("running");
  });

  // ── delete: rule-aware (canDelete) ─────────────────────────────────────

  it("delete removes compute", async () => {
    await svc.create({ name: "del-me", provider: "docker" });
    expect(await svc.delete("del-me")).toBe(true);
    expect(await svc.get("del-me")).toBeNull();
  });

  it("delete throws when provider.canDelete is false (local)", async () => {
    // "local" provider sets canDelete=false. Attempting to delete must throw
    // rather than silently no-op, so the caller sees a clear error.
    expect(svc.delete("local")).rejects.toThrow(/does not support deletion/);
    expect(await svc.get("local")).not.toBeNull();
  });

  it("delete returns false for nonexistent", async () => {
    expect(await svc.delete("no-such")).toBe(false);
  });

  // ── mergeConfig ────────────────────────────────────────────────────────

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
    it("swapping computes repo with a fake intercepts insert()", async () => {
      const stored: Compute[] = [];
      const fakeRepo = {
        insert: mock(
          async (row: { name: string; compute_kind: string; isolation_kind: string; status: ComputeStatus }) => {
            const c = {
              name: row.name,
              status: row.status,
              compute_kind: row.compute_kind,
              isolation_kind: row.isolation_kind,
              config: {},
              is_template: false,
              cloned_from: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } as unknown as Compute;
            stored.push(c);
            return c;
          },
        ),
        findByProvider: mock(async () => null),
        get: mock(async (name: string) => stored.find((c) => c.name === name) ?? null),
        list: mock(async () => stored),
        update: mock(async () => null),
        delete: mock(async () => true),
        mergeConfig: mock(async () => null),
      };

      app.container.register({
        computes: asValue(fakeRepo as unknown as ComputeRepository),
        computeService: asValue(new ComputeService(fakeRepo as unknown as ComputeRepository, app)),
      });

      const freshSvc = app.container.resolve("computeService");
      const c = await freshSvc.create({ name: "fake-ec2", provider: "ec2" });

      expect(c.name).toBe("fake-ec2");
      expect(fakeRepo.insert).toHaveBeenCalledTimes(1);
      expect(stored.length).toBe(1);

      // Real repo is untouched (override only affects the container copy).
      expect(await repo.get("fake-ec2")).toBeNull();
    });
  });
});
