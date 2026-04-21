import { describe, expect, it } from "bun:test";
import { buildIssueFilter } from "../query.js";

describe("linear query", () => {
  it("returns empty filter for empty query", () => {
    const { filter, first } = buildIssueFilter({});
    expect(filter).toEqual({});
    expect(first).toBe(50);
  });

  it("maps todo -> state.type.in [triage, backlog, unstarted]", () => {
    const { filter } = buildIssueFilter({ statusCategories: ["todo"] });
    expect(filter).toEqual({ state: { type: { in: ["triage", "backlog", "unstarted"] } } });
  });

  it("maps in_progress + done -> combined state types", () => {
    const { filter } = buildIssueFilter({ statusCategories: ["in_progress", "done"] });
    const state = filter.state as { type: { in: string[] } };
    expect(state.type.in.sort()).toEqual(["completed", "started"].sort());
  });

  it("maps assignees + reporters + labels", () => {
    const { filter } = buildIssueFilter({
      assigneeIds: ["user-a", "user-b"],
      reporterIds: ["user-c"],
      labels: ["bug", "urgent"],
    });
    expect(filter.assignee).toEqual({ id: { in: ["user-a", "user-b"] } });
    expect(filter.creator).toEqual({ id: { in: ["user-c"] } });
    expect(filter.labels).toEqual({ some: { name: { in: ["bug", "urgent"] } } });
  });

  it("maps updatedSince + text search", () => {
    const { filter } = buildIssueFilter({ updatedSince: "2024-01-01T00:00:00Z", text: "flaky" });
    expect(filter.updatedAt).toEqual({ gte: "2024-01-01T00:00:00Z" });
    expect(filter.searchableContent).toEqual({ contains: "flaky" });
  });

  it("caps page size at 250", () => {
    const { first } = buildIssueFilter({ limit: 1000 });
    expect(first).toBe(250);
  });

  it("maps parentId to parent.id.eq", () => {
    const { filter } = buildIssueFilter({ parentId: "ENG-10" });
    expect(filter.parent).toEqual({ id: { eq: "ENG-10" } });
  });
});
