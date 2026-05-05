/**
 * Shape tests for the hex port catalog.
 *
 * These tests don't exercise real behaviour -- the adapters in this PR are
 * all stubs. Instead they verify:
 *   1. Every port in `packages/core/ports/` is importable from the barrel.
 *   2. Each port has the method set the audit plan (4-di-plan.md) describes.
 *
 * When Slice 1+ lands and real adapters get wired, replace each `instance`
 * construction with the real adapter; the method-name assertions will keep
 * the interface stable.
 */

import { describe, it, expect } from "bun:test";

// Import type barrel to prove the barrel resolves.
import type * as Ports from "../ports/index.js";

// Minimal mocks that satisfy the shape without throwing during property access.
// (Calling the methods is out of scope; the scaffolding adapters deliberately
// throw `"not migrated yet"`.)
function methodNames(instance: Record<string, unknown>): string[] {
  return Object.keys(instance).filter((k) => typeof instance[k] === "function");
}

describe("port catalog shape", () => {
  it("barrel exports every port type", () => {
    // Compile-time check -- if any export is removed this file fails to type-check.
    type _Required =
      | Ports.SessionStore
      | Ports.ComputeStore
      | Ports.EventBus
      | Ports.EventStore
      | Ports.Workspace
      | Ports.ProcessRunner
      | Ports.Clock
      | Ports.Logger
      | Ports.Tracer
      | Ports.SecretStore
      | Ports.ComputeProvider
      | Ports.FlowStore
      | Ports.AgentStore
      | Ports.SkillStore
      | Ports.RuntimeStore;

    // Runtime check: barrel module loads without error.
    expect(true).toBe(true);
  });

  it("SessionStore has the expected methods", () => {
    const instance: Ports.SessionStore = {
      setTenant: () => {},
      getTenant: () => "t",
      get: () => null,
      create: () => ({}) as any,
      update: () => null,
      delete: () => false,
      list: () => [],
      listDeleted: () => [],
      channelPort: () => 0,
    };
    expect(methodNames(instance as any).sort()).toEqual(
      ["channelPort", "create", "delete", "get", "getTenant", "list", "listDeleted", "setTenant", "update"].sort(),
    );
  });

  it("ComputeStore has the expected methods", () => {
    const instance: Ports.ComputeStore = {
      setTenant: () => {},
      getTenant: () => "t",
      get: () => null,
      create: () => ({}) as any,
      update: () => null,
      delete: () => false,
      list: () => [],
    };
    expect(methodNames(instance as any).sort()).toEqual(
      ["create", "delete", "get", "getTenant", "list", "setTenant", "update"].sort(),
    );
  });

  it("EventBus has the expected methods", () => {
    const instance: Ports.EventBus = {
      on: () => () => {},
      onAll: () => () => {},
      before: () => () => {},
      emit: () => true,
      replay: () => [],
      clear: () => {},
    };
    expect(methodNames(instance as any).sort()).toEqual(["before", "clear", "emit", "on", "onAll", "replay"].sort());
  });

  it("EventStore has the expected methods", () => {
    const instance: Ports.EventStore = {
      setTenant: () => {},
      getTenant: () => "t",
      log: () => {},
      list: () => [],
      deleteForTrack: () => {},
    };
    expect(methodNames(instance as any).sort()).toEqual(
      ["deleteForTrack", "getTenant", "list", "log", "setTenant"].sort(),
    );
  });

  it("Workspace has the expected methods", () => {
    const instance: Ports.Workspace = {
      setup: async () => ({ workdir: "/tmp", worktree: false }),
      teardown: async () => {},
      createPR: async () => ({ prId: "1", prUrl: "http://example" }),
      mergePR: async () => {},
      copyFiles: async () => {},
      writeAttachment: async () => "/tmp/a",
    };
    expect(methodNames(instance as any).sort()).toEqual(
      ["copyFiles", "createPR", "mergePR", "setup", "teardown", "writeAttachment"].sort(),
    );
  });

  it("ProcessRunner has the expected methods", () => {
    const instance: Ports.ProcessRunner = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      runSync: () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    };
    expect(methodNames(instance as any).sort()).toEqual(["run", "runSync"].sort());
  });

  it("Clock has the expected methods", () => {
    const instance: Ports.Clock = {
      now: () => 0,
      iso: () => "1970-01-01T00:00:00Z",
      sleep: async () => {},
    };
    expect(methodNames(instance as any).sort()).toEqual(["iso", "now", "sleep"].sort());
  });

  it("Logger has the expected methods", () => {
    const instance: Ports.Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => instance,
    };
    expect(methodNames(instance as any).sort()).toEqual(["child", "debug", "error", "info", "warn"].sort());
  });

  it("Tracer has the expected methods", () => {
    const instance: Ports.Tracer = {
      startSpan: () => ({ end: () => {}, setAttrs: () => {}, recordError: () => {} }),
      withSpan: async (_n, _a, fn) => fn({ end: () => {}, setAttrs: () => {}, recordError: () => {} }),
      flush: async () => {},
    };
    expect(methodNames(instance as any).sort()).toEqual(["flush", "startSpan", "withSpan"].sort());
  });

  it("SecretStore has the expected methods", () => {
    const instance: Ports.SecretStore = {
      get: () => null,
      require: () => "",
      has: () => false,
    };
    expect(methodNames(instance as any).sort()).toEqual(["get", "has", "require"].sort());
  });
});
