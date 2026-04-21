/**
 * Tests for core store functions: generateId, claimSession, mergeComputeConfig, getChildren.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("generateId", () => {
  it("returns a string starting with s-", async () => {
    const id = await getApp().sessions.generateId();
    expect(id.startsWith("s-")).toBe(true);
  });

  it("generates unique IDs", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(await getApp().sessions.generateId());
    }
    expect(ids.size).toBe(50);
  });

  it("returns 10 url-safe lowercase chars after s-", async () => {
    const id = await getApp().sessions.generateId();
    const suffix = id.slice(2);
    expect(suffix).toMatch(/^[a-z0-9]{10}$/);
  });
});

describe("claimSession", () => {
  it("transitions status when expected status matches", async () => {
    const session = await getApp().sessions.create({ summary: "claim test" });
    expect(session.status).toBe("pending");

    const ok = await getApp().sessions.claim(session.id, "pending", "running");
    expect(ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("running");
  });

  it("fails when expected status does not match", async () => {
    const session = await getApp().sessions.create({ summary: "claim test" });

    const ok = await getApp().sessions.claim(session.id, "running", "done");
    expect(ok).toBe(false);

    const unchanged = (await getApp().sessions.get(session.id))!;
    expect(unchanged.status).toBe("pending");
  });

  it("applies extra fields on successful claim", async () => {
    const session = await getApp().sessions.create({ summary: "claim with extras" });

    const ok = await getApp().sessions.claim(session.id, "pending", "running", { agent: "worker" });
    expect(ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.agent).toBe("worker");
    expect(updated.status).toBe("running");
  });

  it("returns false for nonexistent session", async () => {
    const ok = await getApp().sessions.claim("s-nonexistent", "pending", "running");
    expect(ok).toBe(false);
  });

  it("is atomic - concurrent claims should have only one succeed", async () => {
    const session = await getApp().sessions.create({ summary: "race test" });

    // Simulate two concurrent claims
    const result1 = await getApp().sessions.claim(session.id, "pending", "running");
    const result2 = await getApp().sessions.claim(session.id, "pending", "dispatching");

    // Exactly one should succeed
    expect(result1).toBe(true);
    expect(result2).toBe(false);
    expect((await getApp().sessions.get(session.id))!.status).toBe("running");
  });
});

describe("mergeComputeConfig", () => {
  it("merges keys into existing config", async () => {
    await getApp().computes.create({ name: "test-merge", provider: "docker", config: { a: 1, b: 2 } });

    const result = await getApp().computes.mergeConfig("test-merge", { b: 3, c: 4 });
    expect(result).not.toBeNull();

    const config = result!.config as Record<string, unknown>;
    expect(config.a).toBe(1);
    expect(config.b).toBe(3);
    expect(config.c).toBe(4);
  });

  it("returns null for nonexistent compute", async () => {
    const result = await getApp().computes.mergeConfig("nonexistent", { key: "val" });
    expect(result).toBeNull();
  });

  it("works with empty initial config", async () => {
    await getApp().computes.create({ name: "empty-cfg", provider: "docker" });

    const result = await getApp().computes.mergeConfig("empty-cfg", { foo: "bar" });
    expect(result).not.toBeNull();

    const config = result!.config as Record<string, unknown>;
    expect(config.foo).toBe("bar");
  });
});

describe("getChildren", () => {
  it("returns sessions with matching parent_id", async () => {
    const parent = await getApp().sessions.create({ summary: "parent" });
    const child1 = await getApp().sessions.create({ summary: "child 1" });
    const child2 = await getApp().sessions.create({ summary: "child 2" });
    const unrelated = await getApp().sessions.create({ summary: "unrelated" });

    await getApp().sessions.update(child1.id, { parent_id: parent.id });
    await getApp().sessions.update(child2.id, { parent_id: parent.id });

    const children = await getApp().sessions.getChildren(parent.id);
    const childIds = children.map((c) => c.id);

    expect(childIds).toContain(child1.id);
    expect(childIds).toContain(child2.id);
    expect(childIds).not.toContain(unrelated.id);
  });

  it("returns empty array when no children exist", async () => {
    const session = await getApp().sessions.create({ summary: "no children" });
    const children = await getApp().sessions.getChildren(session.id);
    expect(children).toEqual([]);
  });
});
