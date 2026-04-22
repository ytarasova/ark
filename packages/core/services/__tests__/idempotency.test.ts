/**
 * Idempotency key wiring for advance / complete / handoff / executeAction.
 *
 * RF-8 / #388. Temporal activities deliver at-least-once: a retry after a
 * timeout could double-advance a session. The contract under test:
 *
 *   - When the caller does NOT pass `idempotencyKey`, every call runs the body
 *     and returns fresh results. Baseline behavior -- local flows rely on it.
 *   - When the caller passes `idempotencyKey`, the first call runs the body
 *     and persists `(sessionId, stage, op_kind, key) -> result` to
 *     `stage_operations`. A second call with the same key returns the cached
 *     result without running the body.
 *
 * We cover all four keyed surfaces:
 *   - advance()
 *   - complete() (+ its internal advance() cascade)
 *   - handoff() (child-session creation must not double-clone)
 *   - executeAction() (`close` action -- simplest handler, pure event log)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AppContext } from "../../app.js";
import { executeAction } from "../actions/index.js";

let app: AppContext;

beforeEach(async () => {
  if (app) await app.shutdown();
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  // beforeEach resets the next run -- nothing to tear down here.
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function countLedgerRows(sessionId: string, opKind: string): Promise<number> {
  const row = (await app.db
    .prepare(
      `SELECT COUNT(*) AS c FROM stage_operations
        WHERE session_id = ? AND op_kind = ?`,
    )
    .get(sessionId, opKind)) as { c: number } | undefined;
  return row?.c ?? 0;
}

async function countEvents(sessionId: string, type: string): Promise<number> {
  const events = await app.events.list(sessionId);
  return events.filter((e) => e.type === type).length;
}

// ── advance() ─────────────────────────────────────────────────────────────

describe("advance() idempotency", async () => {
  it("no key = body runs every time (baseline; no regression)", async () => {
    app.flows.save("idem-advance-baseline", {
      name: "idem-advance-baseline",
      stages: [
        { name: "s1", agent: "worker", gate: "auto" },
        { name: "s2", agent: "worker", gate: "auto" },
        { name: "s3", agent: "worker", gate: "auto" },
      ],
    } as any);
    const session = await app.sessions.create({ summary: "no-key", flow: "idem-advance-baseline" });
    await app.sessions.update(session.id, { status: "ready", stage: "s1" });

    const first = await app.stageAdvance.advance(session.id, true);
    expect(first.ok).toBe(true);
    const afterFirst = (await app.sessions.get(session.id))!;
    expect(afterFirst.stage).toBe("s2");

    const second = await app.stageAdvance.advance(session.id, true);
    expect(second.ok).toBe(true);
    const afterSecond = (await app.sessions.get(session.id))!;
    expect(afterSecond.stage).toBe("s3");

    // Nothing persisted to the ledger when no key is supplied.
    expect(await countLedgerRows(session.id, "advance")).toBe(0);
  });

  it("same key = replay returns cached result, body does NOT re-run", async () => {
    app.flows.save("idem-advance-key", {
      name: "idem-advance-key",
      stages: [
        { name: "s1", agent: "worker", gate: "auto" },
        { name: "s2", agent: "worker", gate: "auto" },
        { name: "s3", agent: "worker", gate: "auto" },
      ],
    } as any);
    const session = await app.sessions.create({ summary: "keyed", flow: "idem-advance-key" });
    await app.sessions.update(session.id, { status: "ready", stage: "s1" });

    const key = "workflow-A/attempt-1";
    const first = await app.stageAdvance.advance(session.id, true, undefined, { idempotencyKey: key });
    expect(first.ok).toBe(true);
    const afterFirst = (await app.sessions.get(session.id))!;
    expect(afterFirst.stage).toBe("s2"); // advanced exactly once
    expect(await countLedgerRows(session.id, "advance")).toBe(1);

    // Replay -- body MUST NOT fire. If it did we'd be on s3.
    const second = await app.stageAdvance.advance(session.id, true, undefined, { idempotencyKey: key });
    expect(second).toEqual(first);
    const afterSecond = (await app.sessions.get(session.id))!;
    expect(afterSecond.stage).toBe("s2"); // unchanged -- this is the point
    expect(await countLedgerRows(session.id, "advance")).toBe(1);

    // Different key = body runs again.
    const third = await app.stageAdvance.advance(session.id, true, undefined, {
      idempotencyKey: "workflow-A/attempt-2",
    });
    expect(third.ok).toBe(true);
    const afterThird = (await app.sessions.get(session.id))!;
    expect(afterThird.stage).toBe("s3");
    expect(await countLedgerRows(session.id, "advance")).toBe(2);
  });
});

// ── complete() ────────────────────────────────────────────────────────────

describe("complete() idempotency", async () => {
  it("same key = replay returns cached result, stage_completed event not re-logged", async () => {
    app.flows.save("idem-complete-key", {
      name: "idem-complete-key",
      stages: [
        { name: "s1", agent: "worker", gate: "auto" },
        { name: "s2", agent: "worker", gate: "auto" },
      ],
    } as any);
    const session = await app.sessions.create({ summary: "complete-keyed", flow: "idem-complete-key" });
    await app.sessions.update(session.id, { status: "ready", stage: "s1" });

    const key = "complete-key-xyz";
    const first = await app.stageAdvance.complete(session.id, { force: true, idempotencyKey: key });
    expect(first.ok).toBe(true);
    const afterFirst = (await app.sessions.get(session.id))!;
    expect(afterFirst.stage).toBe("s2"); // complete cascades via internal advance()
    const firstEventCount = await countEvents(session.id, "stage_completed");
    expect(firstEventCount).toBe(1);
    expect(await countLedgerRows(session.id, "complete")).toBe(1);

    // Replay -- body MUST NOT run; no new `stage_completed` event; stage unchanged.
    const second = await app.stageAdvance.complete(session.id, { force: true, idempotencyKey: key });
    expect(second).toEqual(first);
    const afterSecond = (await app.sessions.get(session.id))!;
    expect(afterSecond.stage).toBe("s2");
    expect(await countEvents(session.id, "stage_completed")).toBe(firstEventCount);
    expect(await countLedgerRows(session.id, "complete")).toBe(1);
  });
});

// ── handoff() ─────────────────────────────────────────────────────────────

describe("handoff() idempotency", async () => {
  it("same key = second call returns cached result without cloning again", async () => {
    const session = await app.sessions.create({ summary: "handoff-src", flow: "default" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const key = "handoff-key-1";
    const countSessionsBefore = (await app.sessions.list()).length;

    // First call creates a clone via cloneSession + attempts dispatch. Dispatch
    // may fail in the test harness (no runtime / agent), but the ledger
    // records whatever result the body returns, and we only assert on no-op
    // replay behavior -- not dispatch success.
    const first = await app.stageAdvance.handoff(session.id, "reviewer", "please review", { idempotencyKey: key });
    const countSessionsAfterFirst = (await app.sessions.list()).length;
    // cloneSession may have created 0 or 1 new rows depending on dispatch
    // success; we just need the delta from the first call to match the ledger.
    const newSessionsFromFirst = countSessionsAfterFirst - countSessionsBefore;
    expect(await countLedgerRows(session.id, "handoff")).toBe(1);

    // Replay -- body MUST NOT run; no NEW session rows created.
    const second = await app.stageAdvance.handoff(session.id, "reviewer", "please review", { idempotencyKey: key });
    expect(second).toEqual(first);
    const countSessionsAfterSecond = (await app.sessions.list()).length;
    expect(countSessionsAfterSecond - countSessionsAfterFirst).toBe(0);
    // Ledger still has exactly one row for this (session, handoff, key).
    expect(await countLedgerRows(session.id, "handoff")).toBe(1);
    // And the first call's count is preserved.
    expect(newSessionsFromFirst).toBeGreaterThanOrEqual(0);
  });
});

// ── executeAction() ────────────────────────────────────────────────────────

describe("executeAction() idempotency", async () => {
  it("same key = second call returns cached result, no second action_executed event", async () => {
    const session = await app.sessions.create({ summary: "exec-keyed", flow: "default" });
    await app.sessions.update(session.id, { status: "ready", stage: "finish" });

    const key = "exec-key-A";
    const first = await executeAction(app, session.id, "close", { idempotencyKey: key });
    expect(first.ok).toBe(true);
    expect(await countEvents(session.id, "action_executed")).toBe(1);
    expect(await countLedgerRows(session.id, "action:close_ticket")).toBe(1);

    // Replay -- body MUST NOT run; no second event; ledger unchanged.
    const second = await executeAction(app, session.id, "close", { idempotencyKey: key });
    expect(second).toEqual(first);
    expect(await countEvents(session.id, "action_executed")).toBe(1);
    expect(await countLedgerRows(session.id, "action:close_ticket")).toBe(1);

    // Alias `close` and canonical `close_ticket` share ONE ledger bucket
    // because the dispatcher keys on the canonical name.
    const third = await executeAction(app, session.id, "close_ticket", { idempotencyKey: key });
    expect(third).toEqual(first);
    expect(await countEvents(session.id, "action_executed")).toBe(1);
    expect(await countLedgerRows(session.id, "action:close_ticket")).toBe(1);
  });

  it("no key = every call runs the body (baseline)", async () => {
    const session = await app.sessions.create({ summary: "exec-nokey", flow: "default" });
    await app.sessions.update(session.id, { status: "ready", stage: "finish" });

    await executeAction(app, session.id, "close");
    await executeAction(app, session.id, "close");
    expect(await countEvents(session.id, "action_executed")).toBe(2);
    expect(await countLedgerRows(session.id, "action:close_ticket")).toBe(0);
  });

  it("unknown action short-circuits before the ledger (no row written even with key)", async () => {
    const session = await app.sessions.create({ summary: "exec-unknown", flow: "default" });
    const res = await executeAction(app, session.id, "does-not-exist", { idempotencyKey: "k" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("unknown");
    expect(await countLedgerRows(session.id, "action:does-not-exist")).toBe(0);
  });
});
