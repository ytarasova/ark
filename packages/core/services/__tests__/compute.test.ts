import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { ComputeService } from "../compute.js";
import { ComputeRepository } from "../../repositories/compute.js";
import { initSchema, seedLocalCompute } from "../../repositories/schema.js";
import type { ComputeStatus } from "../../../types/index.js";

let db: IDatabase;
let repo: ComputeRepository;
let svc: ComputeService;

beforeEach(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  initSchema(db);
  seedLocalCompute(db);
  repo = new ComputeRepository(db);
  svc = new ComputeService(repo);
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
});
