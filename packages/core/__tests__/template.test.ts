/**
 * Tests for template.ts -- shared variable substitution.
 */

import { describe, it, expect } from "bun:test";
import { substituteVars, buildSessionVars } from "../template.js";

// ── substituteVars ──────────────────────────────────────────────────────────

describe("substituteVars", () => {
  it("replaces known variables", () => {
    const result = substituteVars("Hello {name}, welcome to {place}.", {
      name: "Alice",
      place: "Ark",
    });
    expect(result).toBe("Hello Alice, welcome to Ark.");
  });

  it("preserves unknown variables as {name}", () => {
    const result = substituteVars("Known: {a}, Unknown: {b}", { a: "yes" });
    expect(result).toBe("Known: yes, Unknown: {b}");
  });

  it("handles empty string values", () => {
    const result = substituteVars("Value={key}", { key: "" });
    expect(result).toBe("Value=");
  });

  it("handles template with no variables (passthrough)", () => {
    const result = substituteVars("No variables here.", { key: "unused" });
    expect(result).toBe("No variables here.");
  });

  it("handles multiple occurrences of same variable", () => {
    const result = substituteVars("{x} and {x} again", { x: "val" });
    expect(result).toBe("val and val again");
  });

  it("resolves dotted keys", () => {
    const result = substituteVars("recipe={inputs.files.recipe} key={inputs.params.jira_key}", {
      "inputs.files.recipe": "/tmp/r.yaml",
      "inputs.params.jira_key": "IN-1234",
    });
    expect(result).toBe("recipe=/tmp/r.yaml key=IN-1234");
  });

  it("preserves unresolved dotted keys", () => {
    const result = substituteVars("{inputs.files.missing}", {});
    expect(result).toBe("{inputs.files.missing}");
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
});
