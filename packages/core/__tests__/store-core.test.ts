/**
 * Tests for core store functions: generateId, claimSession, mergeComputeConfig, getChildren.
 */

import { describe, it, expect } from "bun:test";
import {
  generateId,
  createSession,
  getSession,
  updateSession,
  claimSession,
  createCompute,
  getCompute,
  mergeComputeConfig,
  getChildren,
} from "../store.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("generateId", () => {
  it("returns a string starting with s-", () => {
    const id = generateId();
    expect(id.startsWith("s-")).toBe(true);
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(50);
  });

  it("returns 6 hex chars after s-", () => {
    const id = generateId();
    const hex = id.slice(2);
    expect(hex).toMatch(/^[a-f0-9]{6}$/);
  });
});

describe("claimSession", () => {
  it("transitions status when expected status matches", () => {
    const session = createSession({ summary: "claim test" });
    expect(session.status).toBe("pending");

    const ok = claimSession(session.id, "pending", "running");
    expect(ok).toBe(true);

    const updated = getSession(session.id)!;
    expect(updated.status).toBe("running");
  });

  it("fails when expected status does not match", () => {
    const session = createSession({ summary: "claim test" });

    const ok = claimSession(session.id, "running", "done");
    expect(ok).toBe(false);

    const unchanged = getSession(session.id)!;
    expect(unchanged.status).toBe("pending");
  });

  it("applies extra fields on successful claim", () => {
    const session = createSession({ summary: "claim with extras" });

    const ok = claimSession(session.id, "pending", "running", { agent: "worker" });
    expect(ok).toBe(true);

    const updated = getSession(session.id)!;
    expect(updated.agent).toBe("worker");
    expect(updated.status).toBe("running");
  });

  it("returns false for nonexistent session", () => {
    const ok = claimSession("s-nonexistent", "pending", "running");
    expect(ok).toBe(false);
  });

  it("is atomic - concurrent claims should have only one succeed", () => {
    const session = createSession({ summary: "race test" });

    // Simulate two concurrent claims
    const result1 = claimSession(session.id, "pending", "running");
    const result2 = claimSession(session.id, "pending", "dispatching");

    // Exactly one should succeed
    expect(result1).toBe(true);
    expect(result2).toBe(false);
    expect(getSession(session.id)!.status).toBe("running");
  });
});

describe("mergeComputeConfig", () => {
  it("merges keys into existing config", () => {
    createCompute({ name: "test-merge", config: { a: 1, b: 2 } });

    const result = mergeComputeConfig("test-merge", { b: 3, c: 4 });
    expect(result).not.toBeNull();

    const config = result!.config as Record<string, unknown>;
    expect(config.a).toBe(1);
    expect(config.b).toBe(3);
    expect(config.c).toBe(4);
  });

  it("returns null for nonexistent compute", () => {
    const result = mergeComputeConfig("nonexistent", { key: "val" });
    expect(result).toBeNull();
  });

  it("works with empty initial config", () => {
    createCompute({ name: "empty-cfg" });

    const result = mergeComputeConfig("empty-cfg", { foo: "bar" });
    expect(result).not.toBeNull();

    const config = result!.config as Record<string, unknown>;
    expect(config.foo).toBe("bar");
  });
});

describe("getChildren", () => {
  it("returns sessions with matching parent_id", () => {
    const parent = createSession({ summary: "parent" });
    const child1 = createSession({ summary: "child 1" });
    const child2 = createSession({ summary: "child 2" });
    const unrelated = createSession({ summary: "unrelated" });

    updateSession(child1.id, { parent_id: parent.id });
    updateSession(child2.id, { parent_id: parent.id });

    const children = getChildren(parent.id);
    const childIds = children.map(c => c.id);

    expect(childIds).toContain(child1.id);
    expect(childIds).toContain(child2.id);
    expect(childIds).not.toContain(unrelated.id);
  });

  it("returns empty array when no children exist", () => {
    const session = createSession({ summary: "no children" });
    const children = getChildren(session.id);
    expect(children).toEqual([]);
  });
});
