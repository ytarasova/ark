import { describe, expect, it } from "bun:test";
import { buildBbql } from "../query.js";

describe("bitbucket query", () => {
  it("returns empty for empty query", () => {
    expect(buildBbql({})).toBe("");
  });

  it("maps done -> state IN (resolved, closed)", () => {
    const q = buildBbql({ statusCategories: ["done"] });
    expect(q).toContain('state IN ("resolved", "closed")');
  });

  it("maps cancelled -> invalid/wontfix/duplicate", () => {
    const q = buildBbql({ statusCategories: ["cancelled"] });
    expect(q).toContain("state IN");
    expect(q).toContain('"wontfix"');
    expect(q).toContain('"invalid"');
    expect(q).toContain('"duplicate"');
  });

  it("maps in_progress -> open", () => {
    const q = buildBbql({ statusCategories: ["in_progress"] });
    expect(q).toContain('state IN ("open")');
  });

  it("joins multiple clauses with AND", () => {
    const q = buildBbql({
      statusCategories: ["in_progress"],
      assigneeIds: ["{uuid-a}"],
      reporterIds: ["{uuid-b}"],
    });
    expect(q.split(" AND ")).toHaveLength(3);
    expect(q).toContain('assignee.uuid="{uuid-a}"');
    expect(q).toContain('reporter.uuid="{uuid-b}"');
  });

  it("maps scoped labels to component/milestone/version", () => {
    const q = buildBbql({ labels: ["component:api", "milestone:v1", "version:2.0"] });
    expect(q).toContain('component.name="api"');
    expect(q).toContain('milestone.name="v1"');
    expect(q).toContain('version.name="2.0"');
  });

  it("silently drops unscoped labels (unsupported on BB Issues)", () => {
    const q = buildBbql({ labels: ["bug"] });
    expect(q).toBe("");
  });

  it("maps updatedSince + free text", () => {
    const q = buildBbql({ updatedSince: "2024-01-01T00:00:00Z", text: "crash" });
    expect(q).toContain('updated_on >= "2024-01-01T00:00:00Z"');
    expect(q).toContain('title ~ "crash"');
  });

  it("escapes quote characters in user input", () => {
    const q = buildBbql({ text: 'has "quotes"' });
    expect(q).toContain('title ~ "has \\"quotes\\""');
  });
});
