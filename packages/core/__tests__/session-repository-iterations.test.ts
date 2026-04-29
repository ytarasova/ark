/**
 * Per-iteration child projection (`child_iterations`) attached to parent
 * rows by `listRoots` and `listChildren`. The UI's `buildFlowProgress`
 * consumes these directly to paint per-iteration progress segments on
 * fan-out parent rows -- without a second round-trip per parent.
 *
 * Two scenarios:
 *  - **Single-level fan-out:** root has N for_each children, each with a
 *    `for_each_index` in config. listRoots returns the root with
 *    child_iterations sorted by that index, regardless of insertion order.
 *  - **Nested fan-out:** a for_each child can itself be a for_each parent
 *    (parent of parents). Each level uses its own list call --
 *    listRoots for level 0, listChildren for level 1+ -- and each
 *    attaches its own child_iterations. Arbitrary depth is supported
 *    because each level is one independent query, never N+1.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../database/sqlite.js";
import type { DatabaseAdapter } from "../database/index.js";
import { SessionRepository } from "../repositories/session.js";
import { initSchema } from "../repositories/schema.js";

let db: DatabaseAdapter;
let repo: SessionRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  repo = new SessionRepository(db);
});

describe("SessionRepository.listRoots / listChildren -- child_iterations", () => {
  it("attaches per-iteration projection sorted by config.for_each_index", async () => {
    const root = await repo.create({ summary: "fan-out parent" });
    // Insert children OUT of for_each_index order to prove the sort works.
    const c2 = await repo.create({ summary: "c2", config: { for_each_index: 2 } });
    const c0 = await repo.create({ summary: "c0", config: { for_each_index: 0 } });
    const c1 = await repo.create({ summary: "c1", config: { for_each_index: 1 } });
    await repo.update(c0.id, { parent_id: root.id, status: "completed" });
    await repo.update(c1.id, { parent_id: root.id, status: "running" });
    await repo.update(c2.id, { parent_id: root.id, status: "failed" });

    const roots = await repo.listRoots();
    const r = roots.find((x) => x.id === root.id);
    expect(r?.child_iterations).toEqual([
      { id: c0.id, status: "completed", for_each_index: 0, created_at: expect.any(String) },
      { id: c1.id, status: "running", for_each_index: 1, created_at: expect.any(String) },
      { id: c2.id, status: "failed", for_each_index: 2, created_at: expect.any(String) },
    ]);
  });

  it("falls back to created_at when for_each_index is missing", async () => {
    const root = await repo.create({ summary: "legacy parent" });
    const a = await repo.create({ summary: "a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create({ summary: "b" });
    await repo.update(a.id, { parent_id: root.id, status: "completed" });
    await repo.update(b.id, { parent_id: root.id, status: "completed" });

    const [r] = await repo.listRoots();
    expect(r.child_iterations?.map((it) => it.id)).toEqual([a.id, b.id]);
  });

  it("supports nested fan-out -- a for_each child carries its own child_iterations", async () => {
    // Level 0: root
    // Level 1: c0 (for_each parent of grand-children)
    // Level 2: g0, g1 (grand-children of c0)
    const root = await repo.create({ summary: "root" });
    const c0 = await repo.create({ summary: "c0", config: { for_each_index: 0 } });
    await repo.update(c0.id, { parent_id: root.id, status: "running" });

    const g0 = await repo.create({ summary: "g0", config: { for_each_index: 0 } });
    const g1 = await repo.create({ summary: "g1", config: { for_each_index: 1 } });
    await repo.update(g0.id, { parent_id: c0.id, status: "completed" });
    await repo.update(g1.id, { parent_id: c0.id, status: "running" });

    // Root row sees its level-1 child but NOT the level-2 grandchildren.
    const [r] = await repo.listRoots();
    expect(r.child_iterations?.map((it) => it.id)).toEqual([c0.id]);

    // Expanding c0 calls listChildren(c0.id) -- which attaches c0's OWN
    // child_iterations (the grandchildren). Each level is independent.
    const level1 = await repo.listChildren(root.id);
    const c0Row = level1.find((x) => x.id === c0.id);
    expect(c0Row?.child_iterations?.map((it) => it.id)).toEqual([g0.id, g1.id]);
    expect(c0Row?.child_iterations?.map((it) => it.status)).toEqual(["completed", "running"]);
  });

  it("returns child_iterations: undefined when the session has no children", async () => {
    const leaf = await repo.create({ summary: "lonely leaf" });
    const [r] = await repo.listRoots();
    expect(r.id).toBe(leaf.id);
    expect(r.child_iterations).toBeUndefined();
  });
});
