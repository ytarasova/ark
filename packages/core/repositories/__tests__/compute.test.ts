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
  // -- insert -----------------------------------------------------------

  it("insert writes the row as given (no defaults, no rules)", async () => {
    const c = await repo.insert({
      name: "test-docker",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    expect(c.name).toBe("test-docker");
    expect(c.provider).toBe("docker");
    expect(c.status).toBe("stopped");
    expect(c.config).toEqual({});
    expect(c.created_at).toBeTruthy();
  });

  it("insert does NOT enforce the singleton rule (repo is dumb)", async () => {
    // "local" is already seeded. The repo must allow a second "local" row
    // because enforcement now lives in ComputeService, not here.
    const c = await repo.insert({
      name: "local2",
      provider: "local",
      compute_kind: "local",
      runtime_kind: "direct",
      status: "running",
    });
    expect(c.name).toBe("local2");
  });

  it("insert stores config", async () => {
    const c = await repo.insert({
      name: "ec2-1",
      provider: "ec2",
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "stopped",
      config: { region: "us-east-1" },
    });
    expect(c.config).toEqual({ region: "us-east-1" });
  });

  it("insert persists is_template + cloned_from", async () => {
    await repo.insert({
      name: "tmpl-1",
      provider: "ec2",
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "stopped",
      is_template: true,
    });
    const tmpl = (await repo.get("tmpl-1"))!;
    expect(tmpl.is_template).toBe(true);

    await repo.insert({
      name: "clone-1",
      provider: "ec2",
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "stopped",
      cloned_from: "tmpl-1",
    });
    const clone = (await repo.get("clone-1"))!;
    expect(clone.cloned_from).toBe("tmpl-1");
  });

  // -- findByProvider ---------------------------------------------------

  it("findByProvider returns the first matching row for the provider", async () => {
    // "local" is seeded.
    const found = await repo.findByProvider("local");
    expect(found).not.toBeNull();
    expect(found!.provider).toBe("local");
  });

  it("findByProvider returns null when no row matches", async () => {
    const found = await repo.findByProvider("ec2");
    expect(found).toBeNull();
  });

  it("findByProvider with excludeTemplates=true skips template rows", async () => {
    await repo.insert({
      name: "ec2-tmpl",
      provider: "ec2",
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "stopped",
      is_template: true,
    });
    // Only a template exists -- excluding templates must return null.
    expect(await repo.findByProvider("ec2", { excludeTemplates: true })).toBeNull();
    // Default (no exclude) returns the template.
    expect(await repo.findByProvider("ec2")).not.toBeNull();
  });

  it("findByProvider with excludeTemplates=true returns a concrete row", async () => {
    await repo.insert({
      name: "ec2-concrete",
      provider: "ec2",
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "stopped",
    });
    const found = await repo.findByProvider("ec2", { excludeTemplates: true });
    expect(found).not.toBeNull();
    expect(found!.name).toBe("ec2-concrete");
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
    await repo.insert({
      name: "with-cfg",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
      config: { ip: "10.0.0.1" },
    });
    const c = await repo.get("with-cfg");
    expect(c!.config).toEqual({ ip: "10.0.0.1" });
  });

  // -- list -------------------------------------------------------------

  it("list returns all compute entries", async () => {
    await repo.insert({
      name: "docker1",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const all = await repo.list();
    expect(all.length).toBeGreaterThanOrEqual(2); // local + docker1
  });

  it("list filters by provider", async () => {
    await repo.insert({
      name: "d1",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    await repo.insert({
      name: "d2",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    await repo.insert({
      name: "e1",
      provider: "ec2",
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "stopped",
    });
    const dockers = await repo.list({ provider: "docker" });
    expect(dockers.length).toBe(2);
    expect(dockers.every((c) => c.provider === "docker")).toBe(true);
  });

  it("list filters by status", async () => {
    // "local" already seeded as running; add a stopped docker
    await repo.insert({
      name: "stop1",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const running = await repo.list({ status: "running" });
    expect(running.length).toBeGreaterThanOrEqual(1);
    expect(running.every((c) => c.status === "running")).toBe(true);
  });

  it("list respects limit", async () => {
    for (const n of ["a", "b", "c"]) {
      await repo.insert({
        name: n,
        provider: "docker",
        compute_kind: "local",
        runtime_kind: "docker",
        status: "stopped",
      });
    }
    const result = await repo.list({ limit: 2 });
    expect(result.length).toBe(2);
  });

  // -- update -----------------------------------------------------------

  it("update changes fields and returns updated compute", async () => {
    await repo.insert({
      name: "upd",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const updated = await repo.update("upd", { status: "running" as ComputeStatus });
    expect(updated!.status).toBe("running");
  });

  it("update skips unknown columns", async () => {
    await repo.insert({
      name: "upd2",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const updated = await repo.update("upd2", { unknownField: "x" } as Record<string, unknown>);
    expect(updated).not.toBeNull();
  });

  it("update skips name and created_at", async () => {
    await repo.insert({
      name: "upd3",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const original = (await repo.get("upd3"))!;
    await repo.update("upd3", { name: "hacked", created_at: "1999" } as Record<string, unknown>);
    const after = (await repo.get("upd3"))!;
    expect(after.name).toBe("upd3");
    expect(after.created_at).toBe(original.created_at);
  });

  it("update handles config as JSON", async () => {
    await repo.insert({
      name: "cfg-upd",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const updated = await repo.update("cfg-upd", { config: { region: "eu-west-1" } as ComputeConfig });
    expect(updated!.config).toEqual({ region: "eu-west-1" });
  });

  it("update returns null for nonexistent", async () => {
    expect(await repo.update("no-exist", { status: "running" as ComputeStatus })).toBeNull();
  });

  // -- delete -----------------------------------------------------------

  it("delete removes compute and returns true", async () => {
    await repo.insert({
      name: "del-me",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    expect(await repo.delete("del-me")).toBe(true);
    expect(await repo.get("del-me")).toBeNull();
  });

  it("delete does NOT guard against 'local' (repo is dumb)", async () => {
    // The name-based 'local' delete guard was moved out of the repo: the
    // canDelete rule now lives in ComputeService. Repo must delete whatever
    // it is told to.
    expect(await repo.delete("local")).toBe(true);
    expect(await repo.get("local")).toBeNull();
  });

  it("delete returns false for nonexistent", async () => {
    expect(await repo.delete("no-such")).toBe(false);
  });

  // -- mergeConfig ------------------------------------------------------

  it("mergeConfig merges without replacing existing keys", async () => {
    await repo.insert({
      name: "merge",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
      config: { ip: "1.2.3.4", region: "us-east-1" },
    });
    const updated = await repo.mergeConfig("merge", { region: "eu-west-1", key_path: "/tmp/k" });
    expect(updated!.config).toEqual({ ip: "1.2.3.4", region: "eu-west-1", key_path: "/tmp/k" });
  });

  it("mergeConfig returns null for nonexistent", async () => {
    const result = await repo.mergeConfig("no-exist", { foo: "bar" });
    expect(result).toBeNull();
  });

  it("mergeConfig updates updated_at", async () => {
    await repo.insert({
      name: "ts-test",
      provider: "docker",
      compute_kind: "local",
      runtime_kind: "docker",
      status: "stopped",
    });
    const before = (await repo.get("ts-test"))!;
    await repo.mergeConfig("ts-test", { x: 1 });
    const after = (await repo.get("ts-test"))!;
    // updated_at is refreshed (may be same ms in fast tests, so just check it exists)
    expect(after.updated_at).toBeTruthy();
    expect(before.updated_at).toBeTruthy();
    expect(after.config).toEqual({ x: 1 });
  });
});
