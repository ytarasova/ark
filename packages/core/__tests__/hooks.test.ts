/**
 * Tests for hooks.ts -- EventBus with replay buffer and cancellable before handlers.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eventBus } from "../hooks.js";

beforeEach(() => {
  eventBus.clear();
});

describe("EventBus.on", () => {
  it("calls handler when matching event is emitted", () => {
    const received: string[] = [];
    eventBus.on("session:start", (e) => { received.push(e.sessionId); });

    eventBus.emit("session:start", "s-abc123");

    expect(received).toEqual(["s-abc123"]);
  });

  it("does not call handler for non-matching events", () => {
    let called = false;
    eventBus.on("session:stop", () => { called = true; });

    eventBus.emit("session:start", "s-abc123");

    expect(called).toBe(false);
  });

  it("returns unsubscribe function", () => {
    const received: string[] = [];
    const unsub = eventBus.on("test", (e) => { received.push(e.sessionId); });

    eventBus.emit("test", "s-1");
    unsub();
    eventBus.emit("test", "s-2");

    expect(received).toEqual(["s-1"]);
  });

  it("supports multiple handlers for the same event", () => {
    let count = 0;
    eventBus.on("multi", () => { count++; });
    eventBus.on("multi", () => { count++; });

    eventBus.emit("multi", "s-1");

    expect(count).toBe(2);
  });
});

describe("EventBus.onAll", () => {
  it("receives all event types via wildcard", () => {
    const types: string[] = [];
    eventBus.onAll((e) => { types.push(e.type); });

    eventBus.emit("a", "s-1");
    eventBus.emit("b", "s-2");

    expect(types).toEqual(["a", "b"]);
  });
});

describe("EventBus.before", () => {
  it("can cancel an event", () => {
    eventBus.before("cancelable", () => ({ cancelled: true, reason: "blocked" }));

    let received = false;
    eventBus.on("cancelable", () => { received = true; });

    const result = eventBus.emit("cancelable", "s-1");

    expect(result).toBe(false);
    expect(received).toBe(false);
  });

  it("allows event when before handler does not cancel", () => {
    eventBus.before("allowed", () => ({ cancelled: false }));

    let received = false;
    eventBus.on("allowed", () => { received = true; });

    const result = eventBus.emit("allowed", "s-1");

    expect(result).toBe(true);
    expect(received).toBe(true);
  });

  it("allows event when before handler returns void", () => {
    eventBus.before("void", () => {});

    let received = false;
    eventBus.on("void", () => { received = true; });

    const result = eventBus.emit("void", "s-1");

    expect(result).toBe(true);
    expect(received).toBe(true);
  });

  it("returns unsubscribe function", () => {
    const unsub = eventBus.before("test", () => ({ cancelled: true }));

    expect(eventBus.emit("test", "s-1")).toBe(false);
    unsub();
    expect(eventBus.emit("test", "s-1")).toBe(true);
  });
});

describe("EventBus.emit", () => {
  it("assigns sequential IDs to events", () => {
    const ids: number[] = [];
    eventBus.on("seq", (e) => { ids.push(e.id); });

    eventBus.emit("seq", "s-1");
    eventBus.emit("seq", "s-2");
    eventBus.emit("seq", "s-3");

    expect(ids[1]).toBe(ids[0] + 1);
    expect(ids[2]).toBe(ids[1] + 1);
  });

  it("includes stage and data in events", () => {
    let captured: any = null;
    eventBus.on("detailed", (e) => { captured = e; });

    eventBus.emit("detailed", "s-1", { stage: "plan", data: { key: "value" } });

    expect(captured.stage).toBe("plan");
    expect(captured.data).toEqual({ key: "value" });
  });

  it("includes ISO timestamp", () => {
    let captured: any = null;
    eventBus.on("timed", (e) => { captured = e; });

    eventBus.emit("timed", "s-1");

    expect(captured.timestamp).toBeDefined();
    expect(new Date(captured.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("handles handler errors without stopping other handlers", () => {
    const received: string[] = [];
    eventBus.on("error-test", () => { throw new Error("handler crash"); });
    eventBus.on("error-test", (e) => { received.push(e.sessionId); });

    eventBus.emit("error-test", "s-1");

    expect(received).toEqual(["s-1"]);
  });
});

describe("EventBus.replay", () => {
  it("returns events after a given sequence ID", () => {
    eventBus.emit("replay-test", "s-1");
    eventBus.emit("replay-test", "s-2");
    eventBus.emit("replay-test", "s-3");

    const all = eventBus.replay(0);
    expect(all.length).toBeGreaterThanOrEqual(3);

    const afterFirst = eventBus.replay(all[0].id);
    expect(afterFirst.length).toBe(all.length - 1);
  });

  it("returns empty for future sequence ID", () => {
    eventBus.emit("x", "s-1");
    const replay = eventBus.replay(999999);
    expect(replay).toEqual([]);
  });
});

describe("EventBus.clear", () => {
  it("removes all handlers", () => {
    let called = false;
    eventBus.on("cleared", () => { called = true; });
    eventBus.clear();

    eventBus.emit("cleared", "s-1");

    expect(called).toBe(false);
  });

  it("removes before handlers", () => {
    eventBus.before("cleared", () => ({ cancelled: true }));
    eventBus.clear();

    const result = eventBus.emit("cleared", "s-1");
    expect(result).toBe(true);
  });
});
