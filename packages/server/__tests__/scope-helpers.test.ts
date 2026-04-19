/**
 * Unit tests for `handlers/scope-helpers.ts`. Pure functions -- no fixtures.
 */

import { describe, expect, it } from "bun:test";
import { guardBuiltin, projectArg, resolveScope } from "../handlers/scope-helpers.js";

describe("resolveScope", () => {
  it("honours explicit project when projectRoot is available", () => {
    expect(resolveScope("project", null, "/repo")).toBe("project");
  });

  it("falls back to global when caller asks for project but no projectRoot", () => {
    expect(resolveScope("project", null, undefined)).toBe("global");
  });

  it("honours explicit global", () => {
    expect(resolveScope("global", { _source: "project" }, "/repo")).toBe("global");
  });

  it("infers project from existing._source when no explicit scope", () => {
    expect(resolveScope(undefined, { _source: "project" }, "/repo")).toBe("project");
  });

  it("defaults to global when existing is null", () => {
    expect(resolveScope(undefined, null, "/repo")).toBe("global");
  });

  it("defaults to global for builtin existing", () => {
    expect(resolveScope(undefined, { _source: "builtin" }, "/repo")).toBe("global");
  });
});

describe("guardBuiltin", () => {
  it("throws on builtin edit", () => {
    expect(() => guardBuiltin({ _source: "builtin" }, "Agent", "reviewer", "edit")).toThrow(/builtin -- copy it/);
  });

  it("throws on builtin delete", () => {
    expect(() => guardBuiltin({ _source: "builtin" }, "Skill", "some-skill", "delete")).toThrow(
      /Cannot delete builtin skill/,
    );
  });

  it("no-ops on project source", () => {
    expect(() => guardBuiltin({ _source: "project" }, "Agent", "reviewer", "edit")).not.toThrow();
  });

  it("no-ops on null existing", () => {
    expect(() => guardBuiltin(null, "Agent", "whatever", "delete")).not.toThrow();
  });
});

describe("projectArg", () => {
  it("returns projectRoot when scope is project", () => {
    expect(projectArg("project", "/repo")).toBe("/repo");
  });

  it("returns undefined when scope is global", () => {
    expect(projectArg("global", "/repo")).toBeUndefined();
  });

  it("returns undefined when scope is project but root missing", () => {
    expect(projectArg("project", undefined)).toBeUndefined();
  });
});
