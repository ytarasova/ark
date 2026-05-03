/**
 * Unit tests for the SDK Stop-hook gate (v0.21.39 "explicit completion +
 * steerable" contract).
 *
 * The gate has three defining behaviors:
 *   - complete_stage fired + queue empty         -> SDK may stop (`{}`).
 *   - complete_stage NOT fired                   -> block with "end_turn ... complete_stage".
 *   - complete_stage fired + queue has pending   -> block with "user message arrived".
 *
 * These tests pin all three so a regression can't silently close sessions
 * early (the original bug) or ignore a mid-run steer.
 */

import { test, expect } from "bun:test";
import { decideStopHook, PromptQueue } from "../launch.js";

test("allows SDK stop when complete_stage fired and queue is empty", () => {
  const decision = decideStopHook({ stageCompleteRequested: true, queuePendingCount: 0 });
  expect(decision).toEqual({});
});

test("blocks SDK stop when complete_stage has NOT been called", () => {
  const decision = decideStopHook({ stageCompleteRequested: false, queuePendingCount: 0 });
  expect("decision" in decision && decision.decision).toBe("block");
  const reason = "decision" in decision ? decision.reason : "";
  expect(reason).toContain("complete_stage");
  expect(reason).toContain("end_turn");
});

test("blocks SDK stop with a distinct reason when a user message arrives AFTER completion", () => {
  const decision = decideStopHook({ stageCompleteRequested: true, queuePendingCount: 1 });
  expect("decision" in decision && decision.decision).toBe("block");
  const reason = "decision" in decision ? decision.reason : "";
  expect(reason).toContain("user message arrived");
  expect(reason).not.toContain("complete_stage");
});

test("pre-completion state still blocks when the queue has pending user messages", () => {
  // Belt-and-braces: a mid-run steer arriving before complete_stage still
  // blocks on the missing-completion branch -- the agent is told to finish
  // first, then call complete_stage. The queue itself naturally feeds the
  // steer as the next user turn.
  const decision = decideStopHook({ stageCompleteRequested: false, queuePendingCount: 3 });
  expect("decision" in decision && decision.decision).toBe("block");
  const reason = "decision" in decision ? decision.reason : "";
  expect(reason).toContain("complete_stage");
});

test("PromptQueue.pendingCount tracks pushed-but-undrained messages", async () => {
  const q = new PromptQueue();
  expect(q.pendingCount()).toBe(0);

  q.push("first");
  q.push("second");
  expect(q.pendingCount()).toBe(2);

  // Drain one via the async iterator; count should drop.
  const it = q[Symbol.asyncIterator]();
  const m1 = await it.next();
  expect(m1.done).toBe(false);
  expect(q.pendingCount()).toBe(1);

  const m2 = await it.next();
  expect(m2.done).toBe(false);
  expect(q.pendingCount()).toBe(0);
});

test("PromptQueue delivers a message pushed AFTER a consumer is waiting (steerable)", async () => {
  // The central "steerable" property: the SDK iterator sits on next() waiting
  // for user input between assistant turns; a push() from the conductor's
  // user-input channel must wake it up. Without this, mid-run steers are
  // silently swallowed.
  const q = new PromptQueue();
  const it = q[Symbol.asyncIterator]();

  const pending = it.next();
  queueMicrotask(() => q.push("steer me"));

  const result = await pending;
  expect(result.done).toBe(false);
  expect(result.value.type).toBe("user");
  const content = result.value.message.content;
  expect(typeof content === "string" ? content : "").toBe("steer me");
});

test("PromptQueue.close resolves any waiting consumers with done:true", async () => {
  const q = new PromptQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.close();
  const result = await pending;
  expect(result.done).toBe(true);
});
