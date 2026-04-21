import { describe, it, expect } from "bun:test";
import { queryToJql } from "../jql.js";

describe("queryToJql", () => {
  it("returns empty string for empty query", () => {
    expect(queryToJql({})).toBe("");
  });

  it("translates free text as a bare predicate group", () => {
    expect(queryToJql({ text: "project = ARK AND type = Bug" })).toBe("(project = ARK AND type = Bug)");
  });

  it("maps status categories onto statusCategory keys", () => {
    const jql = queryToJql({ statusCategories: ["todo", "in_progress"] });
    expect(jql).toBe('statusCategory in ("new", "indeterminate")');
  });

  it("joins multiple clauses with AND", () => {
    const jql = queryToJql({
      text: "project = ARK",
      statusCategories: ["done"],
      labels: ["backend", "urgent"],
    });
    expect(jql).toBe('(project = ARK) AND statusCategory in ("done") AND labels in ("backend", "urgent")');
  });

  it("quotes string values and escapes embedded quotes", () => {
    const jql = queryToJql({ assigneeIds: ['he said "hi"'] });
    expect(jql).toBe('assignee in ("he said \\"hi\\"")');
  });

  it("maps ticket types onto issuetype names, skipping 'other'", () => {
    const jql = queryToJql({ types: ["epic", "story", "other"] });
    expect(jql).toBe('issuetype in ("Epic", "Story")');
  });

  it("emits parent and updatedSince predicates", () => {
    const jql = queryToJql({ parentId: "PROJ-1", updatedSince: "2026-04-01T00:00:00Z" });
    expect(jql).toBe('parent = "PROJ-1" AND updated >= "2026-04-01T00:00:00Z"');
  });

  it("includes reporter filter", () => {
    const jql = queryToJql({ reporterIds: ["712020:abc"] });
    expect(jql).toBe('reporter in ("712020:abc")');
  });
});
