/**
 * Tests for template.ts — shared variable substitution.
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
});
