/**
 * Unit tests for the PluginRegistry primitive.
 *
 * These tests pin the contract so Phase 2 (compute providers, runtimes,
 * transcript parsers moving to the same registry) doesn't silently break
 * the API shape.
 */

import { describe, it, expect } from "bun:test";
import { createPluginRegistry } from "../plugins/registry.js";
import type { Executor } from "../executor.js";

function stubExecutor(name: string): Executor {
  return {
    name,
    launch: async () => ({ ok: true, handle: `h-${name}` }),
    kill: async () => {},
    status: async () => ({ state: "running" }),
    send: async () => {},
    capture: async () => "",
  };
}

describe("createPluginRegistry", () => {
  it("returns a registry with an empty state", () => {
    const r = createPluginRegistry();
    expect(r.listByKind("executor")).toEqual([]);
    expect(r.get("executor", "anything")).toBeUndefined();
  });

  it("registers and retrieves an executor by kind + name", () => {
    const r = createPluginRegistry();
    const ex = stubExecutor("alpha");
    r.register({ kind: "executor", name: "alpha", impl: ex, source: "builtin" });

    expect(r.get("executor", "alpha")).toBe(ex);
    expect(r.executor("alpha")).toBe(ex);
  });

  it("returns the full entry via getEntry including source metadata", () => {
    const r = createPluginRegistry();
    const ex = stubExecutor("alpha");
    r.register({ kind: "executor", name: "alpha", impl: ex, source: "user", version: "1.2.3", path: "/tmp/alpha.js" });

    const entry = r.getEntry("executor", "alpha");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("user");
    expect(entry!.version).toBe("1.2.3");
    expect(entry!.path).toBe("/tmp/alpha.js");
    expect(entry!.impl).toBe(ex);
  });

  it("overwrites when registering the same kind + name twice", () => {
    const r = createPluginRegistry();
    const v1 = stubExecutor("dup");
    const v2 = stubExecutor("dup");
    r.register({ kind: "executor", name: "dup", impl: v1, source: "builtin" });
    r.register({ kind: "executor", name: "dup", impl: v2, source: "user" });

    expect(r.executor("dup")).toBe(v2);
    expect(r.getEntry("executor", "dup")?.source).toBe("user");
  });

  it("lists every entry of a given kind", () => {
    const r = createPluginRegistry();
    r.register({ kind: "executor", name: "alpha", impl: stubExecutor("alpha"), source: "builtin" });
    r.register({ kind: "executor", name: "beta", impl: stubExecutor("beta"), source: "user" });

    const entries = r.listByKind("executor");
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("unregister removes an entry and reports whether something was removed", () => {
    const r = createPluginRegistry();
    r.register({ kind: "executor", name: "alpha", impl: stubExecutor("alpha"), source: "builtin" });

    expect(r.unregister("executor", "alpha")).toBe(true);
    expect(r.executor("alpha")).toBeUndefined();
    // Second remove is a no-op
    expect(r.unregister("executor", "alpha")).toBe(false);
  });

  it("clear(kind) wipes a single kind's entries without touching others", () => {
    const r = createPluginRegistry();
    r.register({ kind: "executor", name: "alpha", impl: stubExecutor("alpha"), source: "builtin" });
    r.register({ kind: "executor", name: "beta", impl: stubExecutor("beta"), source: "builtin" });

    r.clear("executor");
    expect(r.listByKind("executor")).toEqual([]);
  });

  it("clear() with no arg wipes everything", () => {
    const r = createPluginRegistry();
    r.register({ kind: "executor", name: "alpha", impl: stubExecutor("alpha"), source: "builtin" });

    r.clear();
    expect(r.listByKind("executor")).toEqual([]);
  });
});
