/**
 * Regression tests for the for_each template-resolution chain.
 *
 * Covers the three bugs fixed in the same-named commit:
 *   1. buildSessionVars must preserve array-of-object values (not stringify
 *      them). Without this, inputs.params.repos collapses to
 *      "[object Object],[object Object]" and for_each iterates bogus items.
 *   2. resolveForEachList on a bare `{{path}}` expression must return the
 *      native value, not round-trip through Nunjucks (which coerces to
 *      string).
 *   3. buildIterationVars must NOT write `extra[iterVar] = String(item)`
 *      when item is an object -- that clobbers the nested flat keys
 *      produced by flattenItem during the unflatten step in template.ts.
 */

import { describe, it, expect } from "bun:test";
import { buildSessionVars, substituteVars } from "../template.js";
import { buildIterationVars, flattenItem, resolveForEachList } from "../services/dispatch/dispatch-foreach.js";

describe("for_each template resolution", () => {
  describe("buildSessionVars preserves native types", () => {
    it("keeps inputs.params.repos as an array of objects", () => {
      const vars = buildSessionVars({
        id: "s-1",
        config: {
          inputs: {
            params: {
              repos: [{ repo_path: "/tmp/a" }, { repo_path: "/tmp/b" }],
            },
          },
        },
      });
      expect(Array.isArray(vars["inputs.params.repos"])).toBe(true);
      const repos = vars["inputs.params.repos"] as Array<{ repo_path: string }>;
      expect(repos).toHaveLength(2);
      expect(repos[0].repo_path).toBe("/tmp/a");
    });

    it("keeps primitive array values as array", () => {
      const vars = buildSessionVars({
        id: "s-1",
        config: { inputs: { params: { files: ["README.md", "package.json"] } } },
      });
      expect(vars["inputs.params.files"]).toEqual(["README.md", "package.json"]);
    });

    it("exposes the intermediate object at each dotted prefix", () => {
      const vars = buildSessionVars({
        id: "s-1",
        config: { inputs: { params: { k: "v" } } },
      });
      expect(vars["inputs"]).toEqual({ params: { k: "v" } } as unknown);
      expect(vars["inputs.params"]).toEqual({ k: "v" } as unknown);
      expect(vars["inputs.params.k"]).toBe("v");
    });
  });

  describe("resolveForEachList bare-path fast path", () => {
    it("returns native array for `{{inputs.params.repos}}`", () => {
      const sessionVars = buildSessionVars({
        id: "s-1",
        config: {
          inputs: {
            params: {
              repos: [{ repo_path: "/tmp/a" }, { repo_path: "/tmp/b" }],
            },
          },
        },
      });
      const items = resolveForEachList("{{inputs.params.repos}}", sessionVars, {
        config: (sessionVars as { config?: unknown }).config,
      });
      expect(items).toHaveLength(2);
      expect((items[0] as { repo_path: string }).repo_path).toBe("/tmp/a");
    });

    it("handles whitespace inside the template braces", () => {
      const sessionVars = buildSessionVars({
        id: "s-1",
        config: { inputs: { params: { xs: [1, 2, 3] } } },
      });
      expect(resolveForEachList("{{ inputs.params.xs }}", sessionVars, { config: null })).toEqual([1, 2, 3]);
    });

    it("resolves a non-template identifier from session.config", () => {
      const items = resolveForEachList(
        "inputs.params.repos",
        {},
        { config: { inputs: { params: { repos: [{ repo_path: "/tmp/a" }] } } } },
      );
      expect((items[0] as { repo_path: string }).repo_path).toBe("/tmp/a");
    });

    it("throws a clean error when the path is missing", () => {
      expect(() => resolveForEachList("{{inputs.params.missing}}", {}, { config: null })).toThrow(
        /no value for 'inputs\.params\.missing'/,
      );
    });

    it("falls back to Nunjucks rendering for non-bare expressions", () => {
      const sessionVars = { prefix: "xx" };
      const items = resolveForEachList("{{ prefix }}_ok", sessionVars, { config: null });
      expect(items).toEqual(["xx_ok"]);
    });
  });

  describe("buildIterationVars keeps nested iter-var intact for objects", () => {
    it("does not clobber `repo.repo_path` with `[object Object]`", () => {
      const baseVars = {};
      const iterVars = buildIterationVars(baseVars, "repo", { repo_path: "/tmp/a" });

      // Nested flat key is set to the native string.
      expect(iterVars["repo.repo_path"]).toBe("/tmp/a");
      // The literal iterVar key is NOT overwritten with "[object Object]".
      expect(iterVars.repo).toBeUndefined();
    });

    it("still sets the iterVar key for primitive items (supports `{{item}}`)", () => {
      const iterVars = buildIterationVars({}, "item", "hello");
      expect(iterVars.item).toBe("hello");
    });

    it("substituteVars resolves `{{repo.repo_path}}` against object iter vars", () => {
      const iterVars = buildIterationVars({}, "repo", { repo_path: "/tmp/a" });
      expect(substituteVars("{{repo.repo_path}}", iterVars)).toBe("/tmp/a");
    });
  });

  describe("end-to-end: sessionVars -> resolveForEachList -> iterVars -> substituteVars", () => {
    it("expands per-iteration templates to native values", () => {
      const sessionVars = buildSessionVars({
        id: "s-root",
        config: {
          inputs: {
            params: { repos: [{ repo_path: "/tmp/a" }, { repo_path: "/tmp/b" }] },
          },
        },
      });
      const items = resolveForEachList("{{inputs.params.repos}}", sessionVars, {
        config: (sessionVars as { config?: unknown }).config,
      });
      expect(items).toHaveLength(2);

      const resolvedPaths = items.map((item) => {
        const iterVars = buildIterationVars(sessionVars, "repo", item);
        return substituteVars("{{repo.repo_path}}", iterVars);
      });
      expect(resolvedPaths).toEqual(["/tmp/a", "/tmp/b"]);
    });
  });

  describe("flattenItem honours nested structure", () => {
    it("produces dotted keys for object leaves", () => {
      const out: Record<string, unknown> = {};
      flattenItem("repo", { repo_path: "/a", branch: "main" }, out);
      expect(out["repo.repo_path"]).toBe("/a");
      expect(out["repo.branch"]).toBe("main");
    });

    it("stringifies arrays at the leaf position", () => {
      const out: Record<string, unknown> = {};
      flattenItem("xs", [1, 2, 3], out);
      expect(out.xs).toBe("[1,2,3]");
    });
  });
});
