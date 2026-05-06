/**
 * Unified-model repository tests.
 *
 * Templates and concrete compute targets now live in the same `compute`
 * table, distinguished by the `is_template` flag. This file verifies
 * the filter views (`listTemplates` / `listConcrete`) and the round-trip
 * of the new columns (`is_template`, `cloned_from`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database.js";
import { ComputeRepository } from "../compute.js";
import { initSchema, seedLocalCompute } from "../schema.js";

let db: DatabaseAdapter;
let repo: ComputeRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  await seedLocalCompute(db);
  repo = new ComputeRepository(db);
});

describe("ComputeRepository unified is_template model", () => {
  it("defaults is_template to false when not specified", async () => {
    const c = await repo.insert({
      name: "plain-ec2",
      compute: "ec2",
      isolation: "direct",
      compute_kind: "ec2",
      isolation_kind: "direct",
      status: "stopped",
    });
    expect(c.is_template).toBe(false);
    expect(c.cloned_from).toBeNull();
  });

  it("persists is_template: true when specified", async () => {
    const c = await repo.insert({
      name: "tmpl-k8s",
      compute: "k8s",
      isolation: "direct",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "stopped",
      is_template: true,
    });
    expect(c.is_template).toBe(true);

    const reread = await repo.get("tmpl-k8s");
    expect(reread?.is_template).toBe(true);
  });

  it("persists cloned_from through insert + read", async () => {
    await repo.insert({
      name: "tmpl",
      compute: "k8s",
      isolation: "direct",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "stopped",
      is_template: true,
    });
    const clone = await repo.insert({
      name: "tmpl-session1",
      compute: "k8s",
      isolation: "direct",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "stopped",
      cloned_from: "tmpl",
    });
    expect(clone.cloned_from).toBe("tmpl");
    expect(clone.is_template).toBe(false);

    const reread = await repo.get("tmpl-session1");
    expect(reread?.cloned_from).toBe("tmpl");
  });

  it("listTemplates returns only template rows", async () => {
    await repo.insert({
      name: "concrete-a",
      compute: "ec2",
      isolation: "direct",
      compute_kind: "ec2",
      isolation_kind: "direct",
      status: "stopped",
    });
    await repo.insert({
      name: "tmpl-a",
      compute: "local",
      isolation: "docker",
      compute_kind: "local",
      isolation_kind: "docker",
      status: "stopped",
      is_template: true,
    });
    await repo.insert({
      name: "tmpl-b",
      compute: "k8s",
      isolation: "direct",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "stopped",
      is_template: true,
    });

    const templates = await repo.listTemplates();
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(["tmpl-a", "tmpl-b"]);
    expect(templates.every((t) => t.is_template === true)).toBe(true);
  });

  it("listConcrete returns only non-template rows", async () => {
    await repo.insert({
      name: "concrete-a",
      compute: "ec2",
      isolation: "direct",
      compute_kind: "ec2",
      isolation_kind: "direct",
      status: "stopped",
    });
    await repo.insert({
      name: "tmpl-a",
      compute: "local",
      isolation: "docker",
      compute_kind: "local",
      isolation_kind: "docker",
      status: "stopped",
      is_template: true,
    });

    const concrete = await repo.listConcrete();
    // "local" is seeded and not a template. "concrete-a" is ours.
    expect(concrete.some((c) => c.name === "local")).toBe(true);
    expect(concrete.some((c) => c.name === "concrete-a")).toBe(true);
    expect(concrete.some((c) => c.name === "tmpl-a")).toBe(false);
    expect(concrete.every((c) => !c.is_template)).toBe(true);
  });

  it("list() (no filter) returns both templates and concrete rows", async () => {
    await repo.insert({
      name: "concrete-a",
      compute: "ec2",
      isolation: "direct",
      compute_kind: "ec2",
      isolation_kind: "direct",
      status: "stopped",
    });
    await repo.insert({
      name: "tmpl-a",
      compute: "local",
      isolation: "docker",
      compute_kind: "local",
      isolation_kind: "docker",
      status: "stopped",
      is_template: true,
    });

    const all = await repo.list();
    const names = all.map((c) => c.name);
    expect(names).toContain("concrete-a");
    expect(names).toContain("tmpl-a");
  });
});
