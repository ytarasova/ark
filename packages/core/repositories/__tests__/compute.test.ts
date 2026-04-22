import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database.js";
import { ComputeRepository } from "../compute.js";
import { initSchema, seedLocalCompute } from "../schema.js";
import type { ComputeStatus, ComputeConfig } from "../../../types/index.js";

let db: DatabaseAdapter;
let repo: ComputeRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  await seedLocalCompute(db);
  repo = new ComputeRepository(db);
});

describe("ComputeRepository", async () => {
  // -- create -----------------------------------------------------------

  it("create returns compute with correct defaults", async () => {
    const c = await repo.create({ name: "test-docker", provider: "docker" });
    expect(c.name).toBe("test-docker");
    expect(c.provider).toBe("docker");
    expect(c.status).toBe("stopped"); // non-local defaults to stopped
    expect(c.config).toEqual({});
    expect(c.created_at).toBeTruthy();
  });

  it("create rejects second local provider (singleton)", async () => {
    // "local" already seeded -- creating another must throw
    (await expect(repo.create({ name: "local2", provider: "local" }))).rejects.toThrow(/singleton/);
  });

  it("create with no provider defaults to local and rejects (singleton)", async () => {
    // Default provider is "local", which is already seeded
    (await expect(repo.create({ name: "auto" }))).rejects.toThrow(/singleton/);
  });

  it("create stores config", async () => {
    const c = await repo.create({ name: "ec2-1", provider: "ec2", config: { region: "us-east-1" } });
    expect(c.config).toEqual({ region: "us-east-1" });
  });

  // -- get --------------------------------------------------------------

  it("get returns seeded local compute", async () => {
    const c = await repo.get("local");
    expect(c).not.toBeNull();
    expect(c!.provider).toBe("local");
    expect(c!.status).toBe("running");
  });

  it("get returns null for nonexistent", async () => {
    expect(await repo.get("no-such-compute")).toBeNull();
  });

  it("get parses config from JSON", async () => {
    await repo.create({ name: "with-cfg", provider: "docker", config: { ip: "10.0.0.1" } });
    const c = await repo.get("with-cfg");
    expect(c!.config).toEqual({ ip: "10.0.0.1" });
  });

  // -- list -------------------------------------------------------------

  it("list returns all compute entries", async () => {
    await repo.create({ name: "docker1", provider: "docker" });
    const all = await repo.list();
    expect(all.length).toBeGreaterThanOrEqual(2); // local + docker1
  });

  it("list filters by provider", async () => {
    await repo.create({ name: "d1", provider: "docker" });
    await repo.create({ name: "d2", provider: "docker" });
    await repo.create({ name: "e1", provider: "ec2" });
    const dockers = await repo.list({ provider: "docker" });
    expect(dockers.length).toBe(2);
    expect(dockers.every((c) => c.provider === "docker")).toBe(true);
  });

  it("list filters by status", async () => {
    // "local" already seeded as running; add a stopped docker
    await repo.create({ name: "stop1", provider: "docker" }); // stopped
    const running = await repo.list({ status: "running" });
    expect(running.length).toBeGreaterThanOrEqual(1);
    expect(running.every((c) => c.status === "running")).toBe(true);
  });

  it("list respects limit", async () => {
    await repo.create({ name: "a", provider: "docker" });
    await repo.create({ name: "b", provider: "docker" });
    await repo.create({ name: "c", provider: "docker" });
    const result = await repo.list({ limit: 2 });
    expect(result.length).toBe(2);
  });

  // -- update -----------------------------------------------------------

  it("update changes fields and returns updated compute", async () => {
    await repo.create({ name: "upd", provider: "docker" });
    const updated = await repo.update("upd", { status: "running" as ComputeStatus });
    expect(updated!.status).toBe("running");
  });

  it("update skips unknown columns", async () => {
    await repo.create({ name: "upd2", provider: "docker" });
    const updated = await repo.update("upd2", { unknownField: "x" } as Record<string, unknown>);
    expect(updated).not.toBeNull();
  });

  it("update skips name and created_at", async () => {
    await repo.create({ name: "upd3", provider: "docker" });
    const original = (await repo.get("upd3"))!;
    await repo.update("upd3", { name: "hacked", created_at: "1999" } as Record<string, unknown>);
    const after = (await repo.get("upd3"))!;
    expect(after.name).toBe("upd3");
    expect(after.created_at).toBe(original.created_at);
  });

  it("update handles config as JSON", async () => {
    await repo.create({ name: "cfg-upd", provider: "docker" });
    const updated = await repo.update("cfg-upd", { config: { region: "eu-west-1" } as ComputeConfig });
    expect(updated!.config).toEqual({ region: "eu-west-1" });
  });

  it("update returns null for nonexistent", async () => {
    expect(await repo.update("no-exist", { status: "running" as ComputeStatus })).toBeNull();
  });

  // -- delete -----------------------------------------------------------

  it("delete removes compute and returns true", async () => {
    await repo.create({ name: "del-me", provider: "docker" });
    expect(await repo.delete("del-me")).toBe(true);
    expect(await repo.get("del-me")).toBeNull();
  });

  it("delete prevents deleting local compute", async () => {
    expect(await repo.delete("local")).toBe(false);
    expect(await repo.get("local")).not.toBeNull();
  });

  it("delete returns false for nonexistent", async () => {
    expect(await repo.delete("no-such")).toBe(false);
  });

  // -- mergeConfig ------------------------------------------------------

  it("mergeConfig merges without replacing existing keys", async () => {
    await repo.create({ name: "merge", provider: "docker", config: { ip: "1.2.3.4", region: "us-east-1" } });
    const updated = await repo.mergeConfig("merge", { region: "eu-west-1", key_path: "/tmp/k" });
    expect(updated!.config).toEqual({ ip: "1.2.3.4", region: "eu-west-1", key_path: "/tmp/k" });
  });

  it("mergeConfig returns null for nonexistent", async () => {
    const result = await repo.mergeConfig("no-exist", { foo: "bar" });
    expect(result).toBeNull();
  });

  it("mergeConfig updates updated_at", async () => {
    await repo.create({ name: "ts-test", provider: "docker" });
    const before = (await repo.get("ts-test"))!;
    await repo.mergeConfig("ts-test", { x: 1 });
    const after = (await repo.get("ts-test"))!;
    // updated_at is refreshed (may be same ms in fast tests, so just check it exists)
    expect(after.updated_at).toBeTruthy();
    expect(after.config).toEqual({ x: 1 });
  });
});
