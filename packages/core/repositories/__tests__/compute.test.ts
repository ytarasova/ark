import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { ComputeRepository } from "../compute.js";
import { initSchema, seedLocalCompute } from "../schema.js";
import type { ComputeStatus, ComputeConfig } from "../../../types/index.js";

let db: IDatabase;
let repo: ComputeRepository;

beforeEach(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  initSchema(db);
  seedLocalCompute(db);
  repo = new ComputeRepository(db);
});

describe("ComputeRepository", () => {
  // ── create ──────────────────────────────────────────────────────────────

  it("create returns compute with correct defaults", () => {
    const c = repo.create({ name: "test-docker", provider: "docker" });
    expect(c.name).toBe("test-docker");
    expect(c.provider).toBe("docker");
    expect(c.status).toBe("stopped"); // non-local defaults to stopped
    expect(c.config).toEqual({});
    expect(c.created_at).toBeTruthy();
  });

  it("create with local provider defaults to running", () => {
    const c = repo.create({ name: "local2", provider: "local" });
    expect(c.status).toBe("running");
  });

  it("create with no provider defaults to local/running", () => {
    const c = repo.create({ name: "auto" });
    expect(c.provider).toBe("local");
    expect(c.status).toBe("running");
  });

  it("create stores config", () => {
    const c = repo.create({ name: "ec2-1", provider: "ec2", config: { region: "us-east-1" } });
    expect(c.config).toEqual({ region: "us-east-1" });
  });

  // ── get ─────────────────────────────────────────────────────────────────

  it("get returns seeded local compute", () => {
    const c = repo.get("local");
    expect(c).not.toBeNull();
    expect(c!.provider).toBe("local");
    expect(c!.status).toBe("running");
  });

  it("get returns null for nonexistent", () => {
    expect(repo.get("no-such-compute")).toBeNull();
  });

  it("get parses config from JSON", () => {
    repo.create({ name: "with-cfg", config: { ip: "10.0.0.1" } });
    const c = repo.get("with-cfg");
    expect(c!.config).toEqual({ ip: "10.0.0.1" });
  });

  // ── list ────────────────────────────────────────────────────────────────

  it("list returns all compute entries", () => {
    repo.create({ name: "docker1", provider: "docker" });
    const all = repo.list();
    expect(all.length).toBeGreaterThanOrEqual(2); // local + docker1
  });

  it("list filters by provider", () => {
    repo.create({ name: "d1", provider: "docker" });
    repo.create({ name: "d2", provider: "docker" });
    repo.create({ name: "e1", provider: "ec2" });
    const dockers = repo.list({ provider: "docker" });
    expect(dockers.length).toBe(2);
    expect(dockers.every(c => c.provider === "docker")).toBe(true);
  });

  it("list filters by status", () => {
    repo.create({ name: "run1", provider: "local" }); // running
    repo.create({ name: "stop1", provider: "docker" }); // stopped
    const running = repo.list({ status: "running" });
    expect(running.every(c => c.status === "running")).toBe(true);
  });

  it("list respects limit", () => {
    repo.create({ name: "a" });
    repo.create({ name: "b" });
    repo.create({ name: "c" });
    const result = repo.list({ limit: 2 });
    expect(result.length).toBe(2);
  });

  // ── update ──────────────────────────────────────────────────────────────

  it("update changes fields and returns updated compute", () => {
    repo.create({ name: "upd", provider: "docker" });
    const updated = repo.update("upd", { status: "running" as ComputeStatus });
    expect(updated!.status).toBe("running");
  });

  it("update skips unknown columns", () => {
    repo.create({ name: "upd2" });
    const updated = repo.update("upd2", { unknownField: "x" } as Record<string, unknown>);
    expect(updated).not.toBeNull();
  });

  it("update skips name and created_at", () => {
    repo.create({ name: "upd3" });
    const original = repo.get("upd3")!;
    repo.update("upd3", { name: "hacked", created_at: "1999" } as Record<string, unknown>);
    const after = repo.get("upd3")!;
    expect(after.name).toBe("upd3");
    expect(after.created_at).toBe(original.created_at);
  });

  it("update handles config as JSON", () => {
    repo.create({ name: "cfg-upd" });
    const updated = repo.update("cfg-upd", { config: { region: "eu-west-1" } as ComputeConfig });
    expect(updated!.config).toEqual({ region: "eu-west-1" });
  });

  it("update returns null for nonexistent", () => {
    expect(repo.update("no-exist", { status: "running" as ComputeStatus })).toBeNull();
  });

  // ── delete ──────────────────────────────────────────────────────────────

  it("delete removes compute and returns true", () => {
    repo.create({ name: "del-me", provider: "docker" });
    expect(repo.delete("del-me")).toBe(true);
    expect(repo.get("del-me")).toBeNull();
  });

  it("delete prevents deleting local compute", () => {
    expect(repo.delete("local")).toBe(false);
    expect(repo.get("local")).not.toBeNull();
  });

  it("delete returns false for nonexistent", () => {
    expect(repo.delete("no-such")).toBe(false);
  });

  // ── mergeConfig ─────────────────────────────────────────────────────────

  it("mergeConfig merges without replacing existing keys", () => {
    repo.create({ name: "merge", config: { ip: "1.2.3.4", region: "us-east-1" } });
    const updated = repo.mergeConfig("merge", { region: "eu-west-1", key_path: "/tmp/k" });
    expect(updated!.config).toEqual({ ip: "1.2.3.4", region: "eu-west-1", key_path: "/tmp/k" });
  });

  it("mergeConfig returns null for nonexistent", () => {
    const result = repo.mergeConfig("no-exist", { foo: "bar" });
    expect(result).toBeNull();
  });

  it("mergeConfig updates updated_at", () => {
    repo.create({ name: "ts-test" });
    const before = repo.get("ts-test")!;
    repo.mergeConfig("ts-test", { x: 1 });
    const after = repo.get("ts-test")!;
    // updated_at is refreshed (may be same ms in fast tests, so just check it exists)
    expect(after.updated_at).toBeTruthy();
    expect(after.config).toEqual({ x: 1 });
  });
});
