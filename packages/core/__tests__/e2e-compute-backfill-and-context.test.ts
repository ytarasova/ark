/**
 * End-to-end verification for two fixes that had to ship together:
 *
 * 1. Compute-backfill (#472): sessions dispatched with no explicit `compute`
 *    arg used to land with `compute_name = NULL` in the DB. The web compute
 *    panel's UI filter then matched NULL against every compute row, so a
 *    single session appeared under multiple compute panels.
 *
 * 2. Context namespace split (#480): eval-harness knowledge nodes lived in
 *    the same `type='session'` bucket as production sessions. Every
 *    `store.search()` call (including the auto-injected agent-dispatch
 *    context) returned eval rows mixed in, polluting production prompts.
 *
 * Both fixes are backfill-shaped: one defaults `compute_name = "local"` at
 * create time, the other moves eval rows to `type='eval_session'` so the
 * production namespace stays clean by construction. This test file chains
 * them end-to-end: create sessions + knowledge rows the way the real
 * runtime would, then assert the UI-side filter returns exactly one compute
 * bucket per session and that production context reads do not leak eval
 * nodes.
 *
 * These are pure-TS assertions against AppContext + KnowledgeStore -- no
 * tmux, no agent launch. The goal is to pin the joint invariant (create
 * path + read path) against regression; the individual pieces are already
 * covered in session-compute.test.ts, knowledge/store.test.ts, and
 * migrations/013_eval_session_type.test.ts.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext, getApp } from "./test-helpers.js";
import { KnowledgeStore } from "../knowledge/store.js";
import type { Session } from "../../types/index.js";

withTestContext();

// UI-side filter lifted from ComputeDetailPanel.tsx. Duplicated in the
// test to keep the invariant explicit and to fail loudly if the panel
// predicate drifts from what the backfill assumes.
const HIDDEN_STATUSES = new Set(["completed", "archived"]);

function sessionsVisibleOn(sessions: Session[], computeName: string): Session[] {
  return sessions.filter((s) => {
    if (s.compute_name !== computeName) return false;
    if (HIDDEN_STATUSES.has(s.status)) return false;
    return true;
  });
}

describe("e2e: compute backfill + context namespace separation", () => {
  it("a session created without --compute is visible on exactly the 'local' panel", async () => {
    const app = getApp();
    const session = await app.sessionService.start({ summary: "e2e-default-compute" });

    const all = await app.sessions.list();
    const onLocal = sessionsVisibleOn(all, "local");
    const onEc2 = sessionsVisibleOn(all, "ec2-ssm");

    expect(onLocal.some((s) => s.id === session.id)).toBe(true);
    expect(onEc2.some((s) => s.id === session.id)).toBe(false);
  });

  it("a session created with compute_name='ec2-ssm' is visible on exactly the ec2-ssm panel", async () => {
    const app = getApp();
    const session = await app.sessionService.start({
      summary: "e2e-explicit-compute",
      compute_name: "ec2-ssm",
    });

    const all = await app.sessions.list();
    const onLocal = sessionsVisibleOn(all, "local");
    const onEc2 = sessionsVisibleOn(all, "ec2-ssm");

    expect(onEc2.some((s) => s.id === session.id)).toBe(true);
    expect(onLocal.some((s) => s.id === session.id)).toBe(false);
  });

  it("a stopped / failed session still renders on its target compute (triage visibility)", async () => {
    const app = getApp();
    const session = await app.sessionService.start({
      summary: "e2e-stopped-dispatch",
      compute_name: "ec2-ssm",
    });
    await app.sessions.update(session.id, { status: "failed" });

    const visible = sessionsVisibleOn(await app.sessions.list(), "ec2-ssm");
    expect(visible.some((s) => s.id === session.id)).toBe(true);
  });

  it("completed + archived sessions are hidden everywhere", async () => {
    const app = getApp();
    const done = await app.sessionService.start({ summary: "e2e-completed" });
    await app.sessions.update(done.id, { status: "completed" });
    const shelved = await app.sessionService.start({ summary: "e2e-archived" });
    await app.sessions.update(shelved.id, { status: "archived" });

    const visible = sessionsVisibleOn(await app.sessions.list(), "local");
    expect(visible.some((s) => s.id === done.id)).toBe(false);
    expect(visible.some((s) => s.id === shelved.id)).toBe(false);
  });

  it("legacy rows with NULL compute_name appear on NO compute panel", async () => {
    // Simulate a pre-#472 row. The bug was that NULL matched every compute;
    // the post-fix panel uses strict === so NULL matches none.
    const app = getApp();
    const session = await app.sessionService.start({ summary: "e2e-legacy-null" });
    await app.sessions.update(session.id, { compute_name: null as unknown as string });

    const onLocal = sessionsVisibleOn(await app.sessions.list(), "local");
    const onEc2 = sessionsVisibleOn(await app.sessions.list(), "ec2-ssm");
    expect(onLocal.some((s) => s.id === session.id)).toBe(false);
    expect(onEc2.some((s) => s.id === session.id)).toBe(false);
  });

  it("production store.search() does not surface eval_session nodes (auto-injected context stays clean)", async () => {
    // buildContext() -> store.search() is the read path that had the leak.
    // Seeding both shapes of node and confirming search returns only the
    // production row proves the namespace split holds end-to-end.
    const app = getApp();
    const store = new KnowledgeStore(app.db);

    await store.addNode({
      type: "session",
      label: "production auth refactor",
      content: "refactored JWT verification in auth middleware",
      metadata: {},
    });
    await store.addNode({
      type: "eval_session",
      label: "eval auth refactor",
      content: "refactored JWT verification in auth middleware (eval run)",
      metadata: {},
    });

    const hits = await store.search("JWT verification");
    const types = hits.map((h) => h.type);

    expect(hits.length).toBeGreaterThan(0);
    expect(types).toContain("session");
    expect(types).not.toContain("eval_session");
  });

  it("listNodes({type: 'session'}) excludes eval_session nodes", async () => {
    const app = getApp();
    const store = new KnowledgeStore(app.db);

    await store.addNode({ type: "session", label: "prod-1", content: "a", metadata: {} });
    await store.addNode({ type: "eval_session", label: "eval-1", content: "a", metadata: {} });

    const prodNodes = await store.listNodes({ type: "session" });
    const evalNodes = await store.listNodes({ type: "eval_session" });

    expect(prodNodes.every((n) => n.type === "session")).toBe(true);
    expect(evalNodes.every((n) => n.type === "eval_session")).toBe(true);
    expect(prodNodes.some((n) => n.label === "eval-1")).toBe(false);
    expect(evalNodes.some((n) => n.label === "prod-1")).toBe(false);
  });

  it("search with explicit {types: ['eval_session']} DOES return eval rows (deliberate opt-in)", async () => {
    const app = getApp();
    const store = new KnowledgeStore(app.db);

    await store.addNode({
      type: "eval_session",
      label: "eval explicit",
      content: "needle-string evaluating drift",
      metadata: {},
    });

    const hits = await store.search("needle-string", { types: ["eval_session"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.type === "eval_session")).toBe(true);
  });
});
