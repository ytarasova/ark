/**
 * Regression tests for critical bug fixes:
 * - applyReport null dereference with nonexistent sessionId
 * - mergeSessionConfig atomic read-modify-write
 * - safeParseConfig handles corrupted JSON
 */

import { describe, test, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { safeParseConfig } from "../util.js";
import type { OutboundMessage } from "../conductor/channel-types.js";
import { getApp } from "./test-helpers.js";

withTestContext();

// ── Bug 1: applyReport null guard ────────────────────────────────────────────

describe("applyReport", () => {
  test("returns empty result for nonexistent sessionId (no crash)", async () => {
    const report = { type: "completed", stage: "plan", summary: "done" } as unknown as OutboundMessage;
    const result = await getApp().sessionHooks.applyReport("s-nonexistent", report);
    expect(result.updates).toEqual({});
    expect(result.logEvents).toEqual([]);
    expect(result.busEvents).toEqual([]);
  });

  test("still works correctly for existing session", async () => {
    const session = await getApp().sessions.create({ summary: "test session" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "plan" });
    const report = { type: "progress", stage: "plan", message: "working..." } as unknown as OutboundMessage;
    const result = await getApp().sessionHooks.applyReport(session.id, report);
    // Should have log events and bus events
    expect(result.logEvents!.length).toBeGreaterThan(0);
    expect(result.busEvents!.length).toBeGreaterThan(0);
  });
});

// ── Bug 2: mergeSessionConfig atomic ─────────────────────────────────────────

describe("mergeSessionConfig", () => {
  test("merges without clobbering existing keys", async () => {
    const session = await getApp().sessions.create({
      summary: "test",
      config: { existing: "value", count: 1 },
    });

    await getApp().sessions.mergeConfig(session.id, { newKey: "added" });
    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.config.existing).toBe("value");
    expect(updated.config.count).toBe(1);
    expect(updated.config.newKey).toBe("added");
  });

  test("two sequential patches both survive", async () => {
    const session = await getApp().sessions.create({ summary: "test", config: {} });

    await getApp().sessions.mergeConfig(session.id, { a: 1 });
    await getApp().sessions.mergeConfig(session.id, { b: 2 });

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.config.a).toBe(1);
    expect(updated.config.b).toBe(2);
  });

  test("no-ops for nonexistent session", async () => {
    // Should not throw
    await getApp().sessions.mergeConfig("s-nonexistent", { key: "val" });
  });
});

// ── Bug 3: safeParseConfig ───────────────────────────────────────────────────

describe("safeParseConfig", () => {
  test("parses valid JSON string", () => {
    const result = safeParseConfig('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
  });

  test("returns object as-is", () => {
    const obj = { foo: "bar" };
    const result = safeParseConfig(obj);
    expect(result).toEqual({ foo: "bar" });
  });

  test("returns empty object for corrupted JSON", () => {
    const result = safeParseConfig("{broken json!!!");
    expect(result).toEqual({});
  });

  test("returns empty object for null", () => {
    const result = safeParseConfig(null);
    expect(result).toEqual({});
  });

  test("returns empty object for undefined", () => {
    const result = safeParseConfig(undefined);
    expect(result).toEqual({});
  });

  test("returns empty object for empty string", () => {
    const result = safeParseConfig("");
    expect(result).toEqual({});
  });
});
