import { describe, expect, it } from "bun:test";
import { buildSearchQuery } from "../query.js";

describe("github query", () => {
  it("always includes type:issue", () => {
    expect(buildSearchQuery({})).toContain("type:issue");
  });

  it("scopes to a repo when provided", () => {
    const q = buildSearchQuery({}, { owner: "acme", repo: "widgets" });
    expect(q).toContain("repo:acme/widgets");
  });

  it("passes free-text verbatim", () => {
    const q = buildSearchQuery({ text: "crash import" });
    expect(q).toContain("crash import");
  });

  it("maps todo -> state:open", () => {
    const q = buildSearchQuery({ statusCategories: ["todo"] });
    expect(q).toContain("state:open");
  });

  it("maps done -> state:closed + reason:completed", () => {
    const q = buildSearchQuery({ statusCategories: ["done"] });
    expect(q).toContain("state:closed");
    expect(q).toContain("reason:completed");
  });

  it("maps cancelled -> state:closed + reason:not_planned", () => {
    const q = buildSearchQuery({ statusCategories: ["cancelled"] });
    expect(q).toContain("state:closed");
    expect(q).toContain("reason:not_planned");
  });

  it("drops state: when both open and closed are asked for", () => {
    const q = buildSearchQuery({ statusCategories: ["todo", "done"] });
    expect(q).not.toContain("state:open");
    expect(q).not.toContain("state:closed");
  });

  it("translates assignee, author (reporter), and labels", () => {
    const q = buildSearchQuery({
      assigneeIds: ["alice"],
      reporterIds: ["bob"],
      labels: ["bug", "high priority"],
    });
    expect(q).toContain("assignee:alice");
    expect(q).toContain("author:bob");
    expect(q).toContain("label:bug");
    expect(q).toContain('label:"high priority"');
  });

  it("translates updatedSince to updated:>= YYYY-MM-DD", () => {
    const q = buildSearchQuery({ updatedSince: "2024-07-04T10:30:00Z" });
    expect(q).toContain("updated:>=2024-07-04");
  });
});
