/**
 * `getSessionCost(parentId)` must aggregate every descendant's cost, not
 * just the parent's own ledger rows. Fan-out parents never run an agent
 * themselves -- the cost lives on the children. Pre-fix the parent's
 * Cost tab read \$0.00 even when the children combined had spent dollars.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
}, 30_000);

describe("getSessionCost rollup", () => {
  test("parent surfaces sum of children's costs by default", async () => {
    const parent = await app.sessions.create({ summary: "fan-out parent" });
    const childA = await app.sessions.create({ summary: "child A" });
    const childB = await app.sessions.create({ summary: "child B" });
    await app.sessions.update(childA.id, { parent_id: parent.id });
    await app.sessions.update(childB.id, { parent_id: parent.id });

    // Record usage on the children only (real fan-out shape).
    app.usageRecorder.record({
      sessionId: childA.id,
      tenantId: "default",
      userId: "system",
      model: "sonnet",
      provider: "anthropic",
      runtime: "claude-agent",
      usage: { input_tokens: 100, output_tokens: 200 },
      source: "test",
      costMode: "api",
    });
    app.usageRecorder.record({
      sessionId: childB.id,
      tenantId: "default",
      userId: "system",
      model: "sonnet",
      provider: "anthropic",
      runtime: "claude-agent",
      usage: { input_tokens: 50, output_tokens: 75 },
      source: "test",
      costMode: "api",
    });

    const total = await app.usageRecorder.getSessionCost(parent.id);
    // 150 input + 275 output = 425 total tokens summed
    expect(total.input_tokens).toBe(150);
    expect(total.output_tokens).toBe(275);
    expect(total.total_tokens).toBe(425);
    expect(total.records.length).toBe(2);
  });

  test("includeDescendants:false returns only the row's own ledger entries", async () => {
    const parent = await app.sessions.create({ summary: "strict parent" });
    const child = await app.sessions.create({ summary: "strict child" });
    await app.sessions.update(child.id, { parent_id: parent.id });
    app.usageRecorder.record({
      sessionId: child.id,
      tenantId: "default",
      userId: "system",
      model: "sonnet",
      provider: "anthropic",
      runtime: "claude-agent",
      usage: { input_tokens: 999, output_tokens: 999 },
      source: "test",
      costMode: "api",
    });

    const strict = await app.usageRecorder.getSessionCost(parent.id, { includeDescendants: false });
    expect(strict.records.length).toBe(0);
    expect(strict.input_tokens).toBe(0);
    expect(strict.output_tokens).toBe(0);
  });

  test("walks multiple levels of descendants (fanout-of-fanouts)", async () => {
    const root = await app.sessions.create({ summary: "root" });
    const mid = await app.sessions.create({ summary: "mid" });
    const leaf = await app.sessions.create({ summary: "leaf" });
    await app.sessions.update(mid.id, { parent_id: root.id });
    await app.sessions.update(leaf.id, { parent_id: mid.id });
    app.usageRecorder.record({
      sessionId: leaf.id,
      tenantId: "default",
      userId: "system",
      model: "sonnet",
      provider: "anthropic",
      runtime: "claude-agent",
      usage: { input_tokens: 10, output_tokens: 20 },
      source: "test",
      costMode: "api",
    });

    const total = await app.usageRecorder.getSessionCost(root.id);
    expect(total.input_tokens).toBe(10);
    expect(total.output_tokens).toBe(20);
  });
});
