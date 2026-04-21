import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { normalizeChangelog, normalizeComment, normalizeIssue, type JiraIssue } from "../normalize.js";
import type { JiraComment } from "../normalize.js";
import { mdxToPlainText } from "../../../richtext/mdx.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

describe("normalizeIssue", () => {
  it("maps an Epic with children", () => {
    const issue = load<JiraIssue>("epic.json");
    const n = normalizeIssue(issue, { tenantId: "t1", webBaseUrl: "https://acme.atlassian.net" });
    expect(n.provider).toBe("jira");
    expect(n.id).toBe("10001");
    expect(n.key).toBe("PROJ-1");
    expect(n.url).toBe("https://acme.atlassian.net/browse/PROJ-1");
    expect(n.type).toBe("epic");
    expect(n.status.category).toBe("todo");
    expect(n.priority).toBe("High");
    expect(n.labels).toEqual(["platform", "roadmap"]);
    expect(n.assignee).toBeNull();
    expect(n.reporter.email).toBe("yana@acme.io");
    expect(n.children).toEqual(["10011", "10012"]);
    expect(n.parentId).toBeNull();
    expect(n.tenantId).toBe("t1");
  });

  it("maps a Story with strong/emphasis marks and epic-link parent", () => {
    const issue = load<JiraIssue>("story.json");
    const n = normalizeIssue(issue, { tenantId: "t1" });
    expect(n.type).toBe("story");
    expect(n.status.category).toBe("in_progress");
    expect(n.parentId).toBe("10001");
    expect(n.assignee?.email).toBeNull(); // privacy-hidden
    expect(n.assignee?.name).toBe("Aisha Rao");
    const text = mdxToPlainText(n.body);
    expect(text).toContain("generic ticket API");
    expect(text).toContain("Blocked by");
  });

  it("maps a Task whose description is a table", () => {
    const issue = load<JiraIssue>("task-table.json");
    const n = normalizeIssue(issue, { tenantId: "t1" });
    expect(n.type).toBe("task");
    expect(n.status.category).toBe("done");
    // The table survives the ADF->MDX conversion with the expected row count.
    const table = n.body.children.find((c) => c.type === "table") as { children: unknown[] } | undefined;
    expect(table).toBeTruthy();
    expect(table!.children).toHaveLength(3); // 1 header row + 2 body rows
  });

  it("maps a Bug with a codeBlock and preserves language round-trip", () => {
    const issue = load<JiraIssue>("bug-codeblock.json");
    const n = normalizeIssue(issue, { tenantId: "t1" });
    expect(n.type).toBe("bug");
    expect(n.priority).toBe("Highest");
    const text = mdxToPlainText(n.body);
    expect(text).toContain("await dispatch");
  });

  it("falls back to 'todo' category for unknown statusCategory keys", () => {
    const issue = load<JiraIssue>("story.json");
    const mutated: JiraIssue = JSON.parse(JSON.stringify(issue));
    mutated.fields.status = { id: "99", name: "Weird", statusCategory: { key: "mystery" } };
    const n = normalizeIssue(mutated, { tenantId: "t1" });
    expect(n.status.category).toBe("todo");
  });

  it("falls back to 'other' type when issuetype is unrecognised", () => {
    const issue = load<JiraIssue>("story.json");
    const mutated: JiraIssue = JSON.parse(JSON.stringify(issue));
    mutated.fields.issuetype = { name: "Milestone" };
    const n = normalizeIssue(mutated, { tenantId: "t1" });
    expect(n.type).toBe("other");
  });
});

describe("normalizeComment", () => {
  it("converts an ADF comment body to MDX", () => {
    const comment = load<JiraComment>("comment.json");
    const n = normalizeComment(comment, "10040");
    expect(n.id).toBe("70001");
    expect(n.ticketId).toBe("10040");
    expect(n.author.name).toBe("Aisha Rao");
    expect(mdxToPlainText(n.body)).toContain("Looks good");
  });

  it("handles a plain-string body from DC without crashing", () => {
    const n = normalizeComment(
      {
        id: "1",
        author: { accountId: "acc", displayName: "Bob" },
        body: "plain wiki text",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
      "t",
    );
    expect(mdxToPlainText(n.body)).toContain("plain wiki text");
  });
});

describe("normalizeChangelog", () => {
  it("derives 'transitioned' from a status change", () => {
    const issue = load<JiraIssue>("bug-codeblock.json");
    const histories = issue.changelog!.histories!;
    const a = normalizeChangelog(histories[0], issue.id);
    expect(a.kind).toBe("transitioned");
    expect(a.changes.status).toEqual({ old: "To Do", new: "In Progress" });
  });

  it("derives 'labeled' from a labels change", () => {
    const issue = load<JiraIssue>("bug-codeblock.json");
    const histories = issue.changelog!.histories!;
    const a = normalizeChangelog(histories[1], issue.id);
    expect(a.kind).toBe("labeled");
  });
});
