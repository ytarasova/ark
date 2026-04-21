import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mdxToMarkdown } from "../../../richtext/markdown.js";
import { mdxToPlainText } from "../../../richtext/mdx.js";
import {
  inferType,
  normalizeComment,
  normalizeIssue,
  statusCategory,
  type LinearComment,
  type LinearIssue,
} from "../normalize.js";

const HERE = new URL(".", import.meta.url).pathname;
function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8")) as T;
}

describe("linear normalize", () => {
  it("normalizes an issue with markdown body and labels", () => {
    const issue = loadFixture<LinearIssue>("issue.json");
    const norm = normalizeIssue(issue, "tenant-1");
    expect(norm.provider).toBe("linear");
    expect(norm.id).toBe("ENG-123");
    expect(norm.key).toBe("ENG-123");
    expect(norm.url).toBe("https://linear.app/acme/issue/ENG-123");
    expect(norm.type).toBe("bug");
    expect(norm.labels).toEqual(["bug", "flaky"]);
    expect(norm.priority).toBe("High");
    expect(norm.status.category).toBe("in_progress");
    expect(norm.status.label).toBe("In Progress");
    expect(norm.assignee?.email).toBe("bob@example.com");
    expect(norm.reporter.name).toBe("alice");
    expect(norm.parentId).toBeNull();
    expect(norm.children).toEqual([]);
    const md = mdxToMarkdown(norm.body);
    expect(md).toContain("**login**");
    expect(mdxToPlainText(norm.body)).toContain("flaky since last week");
  });

  it("maps state types to categories", () => {
    expect(statusCategory({ id: "", name: "", type: "backlog" })).toBe("todo");
    expect(statusCategory({ id: "", name: "", type: "unstarted" })).toBe("todo");
    expect(statusCategory({ id: "", name: "", type: "triage" })).toBe("todo");
    expect(statusCategory({ id: "", name: "", type: "started" })).toBe("in_progress");
    expect(statusCategory({ id: "", name: "", type: "completed" })).toBe("done");
    expect(statusCategory({ id: "", name: "", type: "canceled" })).toBe("cancelled");
  });

  it("infers sub_task type when issue has a parent and no explicit label", () => {
    const issue = loadFixture<LinearIssue>("issue.json");
    const sub: LinearIssue = {
      ...issue,
      parent: { id: "p", identifier: "ENG-100" },
      labels: { nodes: [{ id: "x", name: "frontend" }] },
    };
    expect(inferType(sub)).toBe("sub_task");
  });

  it("falls back to other when no label and no parent", () => {
    const issue = loadFixture<LinearIssue>("issue.json");
    expect(inferType({ ...issue, labels: { nodes: [] }, parent: null })).toBe("other");
  });

  it("normalizes a comment", () => {
    const c = loadFixture<LinearComment>("comment.json");
    const norm = normalizeComment(c, "ENG-123");
    expect(norm.id).toBe("comment-uuid-7");
    expect(norm.ticketId).toBe("ENG-123");
    expect(norm.author.email).toBe("bob@example.com");
    expect(norm.parentId).toBeNull();
    expect(mdxToPlainText(norm.body).toLowerCase()).toContain("reproduced");
  });

  it("carries parentId from parent.identifier preferentially over id", () => {
    const issue = loadFixture<LinearIssue>("issue.json");
    const norm = normalizeIssue({ ...issue, parent: { id: "uuid-parent", identifier: "ENG-100" } }, "t");
    expect(norm.parentId).toBe("ENG-100");
  });
});
