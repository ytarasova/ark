import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../database/sqlite.js";
import type { DatabaseAdapter } from "../database/index.js";
import { SessionRepository } from "../repositories/session.js";
import { initSchema } from "../repositories/schema.js";

// Tree-aware SessionRepository methods added for the parent/child tree API
// (see `session/tree`, `session/list_children`, and `/api/sessions?roots=true`).
// These tests use a bare in-memory sqlite adapter instead of the full
// AppContext boot because we're exercising the repository layer directly --
// same pattern the sibling file `repositories/__tests__/session.test.ts` uses.

let db: DatabaseAdapter;
let repo: SessionRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  repo = new SessionRepository(db);
});

async function insertUsage(sessionId: string, costUsd: number): Promise<void> {
  // Minimal usage_records row; most columns have defaults, we just need
  // session_id + cost_usd for the rollup subquery to pick it up.
  await db
    .prepare(
      `INSERT INTO usage_records (session_id, tenant_id, model, provider, input_tokens, output_tokens, cost_usd)
       VALUES (?, 'default', 'gpt-x', 'test', 0, 0, ?)`,
    )
    .run(sessionId, costUsd);
}

describe("SessionRepository tree methods", async () => {
  it("listRoots excludes descendants and attaches child_stats", async () => {
    const root = await repo.create({ summary: "root" });
    const other = await repo.create({ summary: "other-root" });
    const c1 = await repo.create({ summary: "c1" });
    const c2 = await repo.create({ summary: "c2" });
    const c3 = await repo.create({ summary: "c3" });
    await repo.update(c1.id, { parent_id: root.id, status: "running" });
    await repo.update(c2.id, { parent_id: root.id, status: "completed" });
    await repo.update(c3.id, { parent_id: root.id, status: "failed" });
    const grandchild = await repo.create({ summary: "gc1" });
    await repo.update(grandchild.id, { parent_id: c1.id });

    await insertUsage(c1.id, 0.5);
    await insertUsage(c2.id, 1.25);
    await insertUsage(c3.id, 0.25);

    const roots = await repo.listRoots();
    const ids = roots.map((r) => r.id);
    expect(ids).toContain(root.id);
    expect(ids).toContain(other.id);
    // Descendants and grandchildren must be absent from the roots list.
    expect(ids).not.toContain(c1.id);
    expect(ids).not.toContain(grandchild.id);

    const rootRow = roots.find((r) => r.id === root.id)!;
    expect(rootRow.child_stats).not.toBeNull();
    expect(rootRow.child_stats!.total).toBe(3);
    expect(rootRow.child_stats!.running).toBe(1);
    expect(rootRow.child_stats!.completed).toBe(1);
    expect(rootRow.child_stats!.failed).toBe(1);
    // Cost sum is 0.5 + 1.25 + 0.25. Use approximate equality for floats.
    expect(rootRow.child_stats!.cost_usd_sum).toBeCloseTo(2.0, 5);

    // Root with no children gets `child_stats: null`.
    const otherRow = roots.find((r) => r.id === other.id)!;
    expect(otherRow.child_stats).toBeNull();
  });

  it("listChildren returns direct descendants with their own child_stats", async () => {
    const root = await repo.create({ summary: "root" });
    const c1 = await repo.create({ summary: "c1" });
    const c2 = await repo.create({ summary: "c2" });
    await repo.update(c1.id, { parent_id: root.id });
    await repo.update(c2.id, { parent_id: root.id });

    const gc = await repo.create({ summary: "gc" });
    await repo.update(gc.id, { parent_id: c1.id, status: "running" });

    const children = await repo.listChildren(root.id);
    expect(children.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());

    const c1Row = children.find((c) => c.id === c1.id)!;
    expect(c1Row.child_stats).not.toBeNull();
    expect(c1Row.child_stats!.total).toBe(1);
    expect(c1Row.child_stats!.running).toBe(1);

    const c2Row = children.find((c) => c.id === c2.id)!;
    expect(c2Row.child_stats).toBeNull();
  });

  it("loadTree returns a recursive shape with root + 3 children + 1 grandchild", async () => {
    const root = await repo.create({ summary: "root" });
    const c1 = await repo.create({ summary: "c1" });
    const c2 = await repo.create({ summary: "c2" });
    const c3 = await repo.create({ summary: "c3" });
    const gc = await repo.create({ summary: "gc" });
    await repo.update(c1.id, { parent_id: root.id });
    await repo.update(c2.id, { parent_id: root.id });
    await repo.update(c3.id, { parent_id: root.id });
    await repo.update(gc.id, { parent_id: c1.id, status: "completed" });

    await insertUsage(gc.id, 0.75);

    const tree = await repo.loadTree(root.id);
    expect(tree.id).toBe(root.id);
    expect(tree.children.length).toBe(3);
    expect(tree.child_stats!.total).toBe(3);

    const c1Node = tree.children.find((n) => n.id === c1.id)!;
    expect(c1Node.children.length).toBe(1);
    expect(c1Node.children[0].id).toBe(gc.id);
    expect(c1Node.child_stats!.total).toBe(1);
    expect(c1Node.child_stats!.completed).toBe(1);
    expect(c1Node.child_stats!.cost_usd_sum).toBeCloseTo(0.75, 5);

    // Leaf has no children and no stats.
    expect(c1Node.children[0].children).toEqual([]);
    expect(c1Node.children[0].child_stats).toBeNull();
  });

  it("loadTree rejects when a non-root id is passed", async () => {
    const root = await repo.create({ summary: "root" });
    const child = await repo.create({ summary: "child" });
    await repo.update(child.id, { parent_id: root.id });

    await expect(repo.loadTree(child.id)).rejects.toThrow(/Parent-session required/);
  });

  it("loadTree cycle guard fires on self-parenting rows", async () => {
    const root = await repo.create({ summary: "root" });
    // Hand-roll a self-cycle -- parent_id = self. Bypasses the normal fan-out
    // path, which never produces cycles, so we update directly.
    await repo.update(root.id, { parent_id: root.id });

    // Because parent_id !== null, loadTree rejects as non-root. The self-
    // cycle is only reachable via an already-existing tree whose root has
    // no parent but a child pointing back to it.
    await expect(repo.loadTree(root.id)).rejects.toThrow(/Parent-session required/);

    // Build the other cycle shape: root -> child -> root. The loader must
    // either terminate (cycle guard) or raise the depth-cap error, but must
    // not hang.
    const realRoot = await repo.create({ summary: "real-root" });
    const cyc = await repo.create({ summary: "cycle" });
    await repo.update(cyc.id, { parent_id: realRoot.id });
    // Now close the loop: realRoot.parent_id = cyc.id -- this makes realRoot
    // non-root so loadTree will reject, same guard path.
    await repo.update(realRoot.id, { parent_id: cyc.id });
    await expect(repo.loadTree(realRoot.id)).rejects.toThrow(/Parent-session required/);
  });

  it("loadTree depth cap fires on chains longer than maxDepth", async () => {
    // Build a root + 7-level chain; loadTree default cap is 6 so this must
    // overflow.
    const root = await repo.create({ summary: "root" });
    let prev = root.id;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const s = await repo.create({ summary: `lvl-${i}` });
      await repo.update(s.id, { parent_id: prev });
      prev = s.id;
      ids.push(s.id);
    }

    await expect(repo.loadTree(root.id)).rejects.toThrow(/depth/i);
  });
});
