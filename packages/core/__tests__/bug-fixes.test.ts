/**
 * Regression tests for critical bug fixes:
 * - applyReport null dereference with nonexistent sessionId
 * - mergeSessionConfig atomic read-modify-write
 * - safeParseConfig handles corrupted JSON
 */

import { describe, test, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import * as store from "../store.js";
import { applyReport } from "../session.js";
import type { OutboundMessage } from "../channel-types.js";

withTestContext();

// ── Bug 1: applyReport null guard ────────────────────────────────────────────

describe("applyReport", () => {
  test("returns empty result for nonexistent sessionId (no crash)", () => {
    const report = { type: "completed", stage: "plan", summary: "done" } as unknown as OutboundMessage;
    const result = applyReport("s-nonexistent", report);
    expect(result.updates).toEqual({});
    expect(result.logEvents).toEqual([]);
    expect(result.busEvents).toEqual([]);
  });

  test("still works correctly for existing session", () => {
    const session = store.createSession({ summary: "test session" });
    store.updateSession(session.id, { status: "running", stage: "plan" });
    const report = { type: "progress", stage: "plan", message: "working..." } as unknown as OutboundMessage;
    const result = applyReport(session.id, report);
    // Should have log events and bus events
    expect(result.logEvents!.length).toBeGreaterThan(0);
    expect(result.busEvents!.length).toBeGreaterThan(0);
  });
});

// ── Bug 2: mergeSessionConfig atomic ─────────────────────────────────────────

describe("mergeSessionConfig", () => {
  test("merges without clobbering existing keys", () => {
    const session = store.createSession({
      summary: "test",
      config: { existing: "value", count: 1 },
    });

    store.mergeSessionConfig(session.id, { newKey: "added" });
    const updated = store.getSession(session.id)!;
    expect(updated.config.existing).toBe("value");
    expect(updated.config.count).toBe(1);
    expect(updated.config.newKey).toBe("added");
  });

  test("two sequential patches both survive", () => {
    const session = store.createSession({ summary: "test", config: {} });

    store.mergeSessionConfig(session.id, { a: 1 });
    store.mergeSessionConfig(session.id, { b: 2 });

    const updated = store.getSession(session.id)!;
    expect(updated.config.a).toBe(1);
    expect(updated.config.b).toBe(2);
  });

  test("no-ops for nonexistent session", () => {
    // Should not throw
    store.mergeSessionConfig("s-nonexistent", { key: "val" });
  });
});

// ── Bug 3: safeParseConfig ───────────────────────────────────────────────────

describe("safeParseConfig", () => {
  test("parses valid JSON string", () => {
    const result = store.safeParseConfig('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
  });

  test("returns object as-is", () => {
    const obj = { foo: "bar" };
    const result = store.safeParseConfig(obj);
    expect(result).toEqual({ foo: "bar" });
  });

  test("returns empty object for corrupted JSON", () => {
    const result = store.safeParseConfig("{broken json!!!");
    expect(result).toEqual({});
  });

  test("returns empty object for null", () => {
    const result = store.safeParseConfig(null);
    expect(result).toEqual({});
  });

  test("returns empty object for undefined", () => {
    const result = store.safeParseConfig(undefined);
    expect(result).toEqual({});
  });

  test("returns empty object for empty string", () => {
    const result = store.safeParseConfig("");
    expect(result).toEqual({});
  });
});
