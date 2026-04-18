/**
 * Smoke tests for the hex adapter binding modules.
 *
 * These verify that `buildLocalBindings`, `buildControlPlaneBindings`, and
 * `buildTestBindings` return objects with the expected port keys. The
 * adapters themselves throw `"not migrated yet"` on method call -- Slice 1+
 * supplies real implementations.
 */

import { describe, it, expect } from "bun:test";

import { buildLocalBindings } from "../adapters/local/index.js";
import { buildControlPlaneBindings } from "../adapters/control-plane/index.js";
import { buildTestBindings } from "../adapters/test/index.js";

const REQUIRED_KEYS = [
  "sessionStore",
  "computeStore",
  "eventBus",
  "eventStore",
  "workspace",
  "processRunner",
  "clock",
  "logger",
  "tracer",
  "secretStore",
];

describe("adapter binding modules", () => {
  it("buildLocalBindings returns every port", () => {
    const bindings = buildLocalBindings({});
    for (const key of REQUIRED_KEYS) {
      expect(bindings).toHaveProperty(key);
      expect((bindings as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  it("buildControlPlaneBindings returns every port", () => {
    const bindings = buildControlPlaneBindings({});
    for (const key of REQUIRED_KEYS) {
      expect(bindings).toHaveProperty(key);
      expect((bindings as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  it("buildTestBindings returns every port", () => {
    const bindings = buildTestBindings({});
    for (const key of REQUIRED_KEYS) {
      expect(bindings).toHaveProperty(key);
      expect((bindings as Record<string, unknown>)[key]).toBeDefined();
    }
  });

  it("stub adapters throw on method call (migration signal)", () => {
    const local = buildLocalBindings({});
    expect(() => local.sessionStore.get("x")).toThrow(/not migrated yet/);
    expect(() => local.processRunner.runSync("echo", ["hi"])).toThrow(/not migrated yet/);

    const cp = buildControlPlaneBindings({});
    expect(() => cp.eventBus.clear()).toThrow(/not migrated yet/);

    const test = buildTestBindings({});
    expect(() => test.clock.now()).toThrow(/not migrated yet/);
  });
});
