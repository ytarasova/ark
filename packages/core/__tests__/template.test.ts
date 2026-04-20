/**
 * Tests for template.ts -- Nunjucks-backed variable substitution.
 */

import { describe, it, expect } from "bun:test";
import { substituteVars, buildSessionVars, unresolvedVars } from "../template.js";

// ── substituteVars: basic ───────────────────────────────────────────────────

describe("substituteVars", () => {
  it("resolves {{var}} when set", () => {
    const result = substituteVars("Hello {{name}}, welcome to {{place}}.", {
      name: "Alice",
      place: "Ark",
    });
    expect(result).toBe("Hello Alice, welcome to Ark.");
  });

  it("preserves unknown {{var}} verbatim (double braces)", () => {
    const result = substituteVars("Known: {{a}}, Unknown: {{b}}", { a: "yes" });
    expect(result).toBe("Known: yes, Unknown: {{b}}");
  });

  it("preserves unresolved dotted path verbatim", () => {
    const result = substituteVars("{{inputs.files.missing}}", {});
    expect(result).toBe("{{inputs.files.missing}}");
  });

  it("renders empty string value", () => {
    const result = substituteVars("Value={{key}}", { key: "" });
    expect(result).toBe("Value=");
  });

  it("passes through templates with no variables", () => {
    const result = substituteVars("No variables here.", { key: "unused" });
    expect(result).toBe("No variables here.");
  });

  it("handles multiple occurrences of same variable", () => {
    const result = substituteVars("{{x}} and {{x}} again", { x: "val" });
    expect(result).toBe("val and val again");
  });

  it("resolves dotted keys via flat map", () => {
    const result = substituteVars("recipe={{inputs.files.recipe}} key={{inputs.params.jira_key}}", {
      "inputs.files.recipe": "/tmp/r.yaml",
      "inputs.params.jira_key": "IN-1234",
    });
    expect(result).toBe("recipe=/tmp/r.yaml key=IN-1234");
  });

  it("tolerates whitespace inside braces", () => {
    const result = substituteVars("{{ name }} and {{  name  }}", { name: "A" });
    expect(result).toBe("A and A");
  });
});

// ── substituteVars: short-namespace alias ───────────────────────────────────

describe("substituteVars short-namespace alias", () => {
  it("{{files.X}} resolves to inputs.files.X when top-level is unset", () => {
    const result = substituteVars("{{files.recipe}}", {
      "inputs.files.recipe": "/tmp/r.yaml",
    });
    expect(result).toBe("/tmp/r.yaml");
  });

  it("{{params.X}} resolves to inputs.params.X when top-level is unset", () => {
    const result = substituteVars("{{params.jira_key}}", {
      "inputs.params.jira_key": "IN-99",
    });
    expect(result).toBe("IN-99");
  });

  it("top-level {{files.X}} wins over alias", () => {
    const result = substituteVars("{{files.recipe}}", {
      "files.recipe": "/top.yaml",
      "inputs.files.recipe": "/tmp/r.yaml",
    });
    expect(result).toBe("/top.yaml");
  });

  it("alias does not apply to already-namespaced paths", () => {
    const result = substituteVars("{{inputs.files.foo}}", {});
    expect(result).toBe("{{inputs.files.foo}}");
  });
});

// ── substituteVars: Jinja features ──────────────────────────────────────────

describe("substituteVars Jinja features", () => {
  it("conditional renders body when condition is truthy", () => {
    const result = substituteVars("{% if ticket %}JIRA: {{ ticket }}{% endif %}", { ticket: "X" });
    expect(result).toBe("JIRA: X");
  });

  it("conditional skips body when condition is unset/empty", () => {
    const setButEmpty = substituteVars("{% if ticket %}JIRA: {{ ticket }}{% endif %}", { ticket: "" });
    expect(setButEmpty).toBe("");
    const unset = substituteVars("{% if ticket %}JIRA: {{ ticket }}{% endif %}", {});
    expect(unset).toBe("");
  });

  it("for loop iterates over a nested bag", () => {
    const result = substituteVars("{% for k, v in inputs.params %}{{k}}={{v}}, {% endfor %}", {
      "inputs.params.a": "1",
      "inputs.params.b": "2",
    });
    expect(result).toBe("a=1, b=2, ");
  });

  it("filter: default applies when value is unset", () => {
    const result = substituteVars('{{ branch | default("main") }}', {});
    expect(result).toBe("main");
  });

  it("raw block escapes Jinja syntax", () => {
    const result = substituteVars("{% raw %}{{literal}}{% endraw %}", { literal: "SHOULD_NOT_APPEAR" });
    expect(result).toBe("{{literal}}");
  });

  it("for loop variable shadows outer scope", () => {
    const result = substituteVars("{% for item in items %}{{item}}{% endfor %}", {
      // Loop var 'item' has no top-level entry; comes from iteration.
      "items.0": "a",
      "items.1": "b",
    });
    // We don't build array-aware unflatten, so this case is not expected to
    // iterate a proper array. Just verify the loop variable isn't prematurely
    // substituted to a '{{item}}' preserved literal.
    expect(result).not.toContain("{{item}}");
  });
});

// ── unresolvedVars ──────────────────────────────────────────────────────────

describe("unresolvedVars", () => {
  it("returns paths that don't resolve", () => {
    const missing = unresolvedVars("{{files.bar}} {{ticket}}", { ticket: "X" });
    expect(missing).toEqual(["files.bar"]);
  });

  it("respects the short-namespace alias", () => {
    const missing = unresolvedVars("{{files.foo}} {{files.bar}}", {
      "inputs.files.foo": "/a",
    });
    expect(missing).toEqual(["files.bar"]);
  });

  it("is empty when all vars resolve", () => {
    expect(unresolvedVars("{{a}} {{b}}", { a: "1", b: "2" })).toEqual([]);
  });

  it("deduplicates repeated references", () => {
    expect(unresolvedVars("{{x}} {{x}} {{x}}", {})).toEqual(["x"]);
  });

  it("excludes locals bound by for loops", () => {
    // Loop var 'item' is local to the body and must never appear in the
    // unresolved list -- even when the outer iteree is missing from vars.
    const missing = unresolvedVars("{% for item in items %}{{item.name}}{% endfor %}", {});
    expect(missing).not.toContain("item");
    expect(missing).not.toContain("item.name");
    // 'items' (the iteree) is still referenced and missing.
    expect(missing).toEqual(["items"]);
  });

  // ── Double-brace + short-namespace (Web UI chip bar) ──────────────────────

  it("resolves {{var}} when the key is present", () => {
    const result = substituteVars("Hello {{name}}", { name: "Alice" });
    expect(result).toBe("Hello Alice");
  });

  it("preserves {{unknown}} verbatim when the key is missing", () => {
    const result = substituteVars("before {{unknown}} after", {});
    expect(result).toBe("before {{unknown}} after");
  });

  it("resolves {{files.X}} via the short-namespace alias", () => {
    const result = substituteVars("env={{files.env}}", {
      "inputs.files.env": "/tmp/.env",
    });
    expect(result).toBe("env=/tmp/.env");
  });

  it("resolves {{params.X}} via the short-namespace alias", () => {
    const result = substituteVars("ticket={{params.jira}}", {
      "inputs.params.jira": "IN-42",
    });
    expect(result).toBe("ticket=IN-42");
  });

  it("tolerates whitespace inside double braces", () => {
    const result = substituteVars("path={{ files.foo }}", {
      "inputs.files.foo": "/tmp/foo",
    });
    expect(result).toBe("path=/tmp/foo");
  });

  it("preserves single-brace literals verbatim (single-brace is not a template syntax in Nunjucks)", () => {
    // Single-brace `{var}` is not a Nunjucks delimiter. YAML was migrated to
    // `{{var}}` in this PR; any surviving `{...}` is intended as literal text.
    const result = substituteVars("{greeting}, {{who}}!", {
      greeting: "Hi",
      who: "world",
    });
    expect(result).toBe("{greeting}, world!");
  });

  it("does not treat {{ / }} as a literal match when resolvable key is absent (preserves both braces)", () => {
    const result = substituteVars("{{files.bar}}", {});
    expect(result).toBe("{{files.bar}}");
  });
});

// ── unresolvedVars ──────────────────────────────────────────────────────────

describe("unresolvedVars", () => {
  it("returns the short-namespace key for an unset {{files.X}}", () => {
    expect(unresolvedVars("{{files.bar}} text", {})).toEqual(["files.bar"]);
  });

  it("ignores single-brace `{x}` literals (Nunjucks uses double-brace only)", () => {
    expect(unresolvedVars("{unknown}", {})).toEqual([]);
  });

  it("returns an empty array when everything resolves (direct + aliased)", () => {
    expect(
      unresolvedVars("{{files.env}} {{ticket}}", {
        "inputs.files.env": "/tmp/.env",
        ticket: "PROJ-1",
      }),
    ).toEqual([]);
  });

  it("de-duplicates repeated keys", () => {
    expect(unresolvedVars("{{x}} {{x}} {{y}}", {})).toEqual(["x", "y"]);
  });
});

// ── buildSessionVars ────────────────────────────────────────────────────────

describe("buildSessionVars", () => {
  it("builds correct map from session", () => {
    const vars = buildSessionVars({
      ticket: "PROJ-1",
      summary: "Fix bug",
      repo: "/code/repo",
      branch: "feat/fix",
      workdir: "/tmp/work",
      id: "s-abc",
      stage: "implement",
      flow: "default",
      agent: "worker",
      compute_name: "remote-1",
    });

    expect(vars.ticket).toBe("PROJ-1");
    expect(vars.summary).toBe("Fix bug");
    expect(vars.jira_key).toBe("PROJ-1");
    expect(vars.jira_summary).toBe("Fix bug");
    expect(vars.repo).toBe("/code/repo");
    expect(vars.branch).toBe("feat/fix");
    expect(vars.workdir).toBe("/tmp/work");
    expect(vars.track_id).toBe("s-abc");
    expect(vars.session_id).toBe("s-abc");
    expect(vars.stage).toBe("implement");
    expect(vars.flow).toBe("default");
    expect(vars.agent).toBe("worker");
    expect(vars.compute).toBe("remote-1");
  });

  it("handles missing fields gracefully", () => {
    const vars = buildSessionVars({});

    expect(vars.ticket).toBe("");
    expect(vars.summary).toBe("");
    expect(vars.jira_key).toBe("");
    expect(vars.jira_summary).toBe("");
    expect(vars.repo).toBe("");
    expect(vars.branch).toBe("");
    expect(vars.workdir).toBe(".");
    expect(vars.track_id).toBe("");
    expect(vars.session_id).toBe("");
    expect(vars.stage).toBe("");
    expect(vars.flow).toBe("");
    expect(vars.agent).toBe("");
    expect(vars.compute).toBe("local");
  });

  it("flattens session.config.inputs into dotted keys", () => {
    const vars = buildSessionVars({
      id: "s-1",
      config: {
        inputs: {
          files: { recipe: "/tmp/r.yaml", prd: "/tmp/prd.md" },
          params: { jira_key: "IN-1", auto: "false" },
        },
      },
    });

    expect(vars["inputs.files.recipe"]).toBe("/tmp/r.yaml");
    expect(vars["inputs.files.prd"]).toBe("/tmp/prd.md");
    expect(vars["inputs.params.jira_key"]).toBe("IN-1");
    expect(vars["inputs.params.auto"]).toBe("false");
  });

  it("tolerates inputs absent or empty", () => {
    const vars = buildSessionVars({ config: {} });
    expect(vars["inputs.files.recipe"]).toBeUndefined();
  });

  it("round-trips with substituteVars", () => {
    const vars = buildSessionVars({
      id: "s-1",
      ticket: "T-1",
      summary: "Do X",
      config: {
        inputs: {
          files: { recipe: "/tmp/r.yaml" },
          params: { jira_key: "J-1" },
        },
      },
    });
    const rendered = substituteVars(
      "session={{session_id}} ticket={{ticket}} summary={{summary}} recipe={{inputs.files.recipe}} jira={{inputs.params.jira_key}}",
      vars,
    );
    expect(rendered).toBe("session=s-1 ticket=T-1 summary=Do X recipe=/tmp/r.yaml jira=J-1");
  });
});
