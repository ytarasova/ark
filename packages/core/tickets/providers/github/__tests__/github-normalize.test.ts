import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mdxToMarkdown } from "../../../richtext/markdown.js";
import { mdxToPlainText } from "../../../richtext/mdx.js";
import {
  inferType,
  normalizeComment,
  normalizeIssue,
  normalizeStatus,
  parseRef,
  refOf,
  type GhComment,
  type GhIssue,
} from "../normalize.js";

const HERE = new URL(".", import.meta.url).pathname;
function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8")) as T;
}

describe("github normalize", () => {
  it("parses owner/repo#N refs", () => {
    expect(parseRef("acme/widgets#42")).toEqual({ owner: "acme", repo: "widgets", number: 42 });
    expect(() => parseRef("#42")).toThrow();
    expect(() => parseRef("bad")).toThrow();
  });

  it("computes ref from repository_url", () => {
    const issue = loadFixture<GhIssue>("issue.json");
    expect(refOf(issue)).toBe("acme/widgets#42");
  });

  it("normalizes a typical issue end-to-end", () => {
    const issue = loadFixture<GhIssue>("issue.json");
    const norm = normalizeIssue(issue, "tenant-1");
    expect(norm.provider).toBe("github");
    expect(norm.id).toBe("acme/widgets#42");
    expect(norm.key).toBe("#42");
    expect(norm.url).toBe("https://github.com/acme/widgets/issues/42");
    expect(norm.title).toContain("CSV");
    expect(norm.type).toBe("bug");
    expect(norm.labels).toContain("bug");
    expect(norm.labels).toContain("frontend");
    expect(norm.assignee?.name).toBe("Bob Singh");
    expect(norm.reporter.name).toBe("Alice Chen");
    expect(norm.priority).toBeNull();
    expect(norm.status.category).toBe("todo");
    expect(norm.tenantId).toBe("tenant-1");
    // Body round-trips through MDX and preserves key content.
    const text = mdxToPlainText(norm.body);
    expect(text).toContain("OutOfMemory");
    const md = mdxToMarkdown(norm.body);
    expect(md).toContain("**1M rows**");
    expect(md).toMatch(/\|\s*Chrome\s*\|/);
  });

  it("maps closed+completed -> done", () => {
    const base = loadFixture<GhIssue>("issue.json");
    const closed: GhIssue = { ...base, state: "closed", state_reason: "completed" };
    expect(normalizeStatus(closed).category).toBe("done");
    const cancelled: GhIssue = { ...base, state: "closed", state_reason: "not_planned" };
    expect(normalizeStatus(cancelled).category).toBe("cancelled");
    const reopened: GhIssue = { ...base, state: "open", state_reason: "reopened" };
    expect(normalizeStatus(reopened).category).toBe("in_progress");
  });

  it("infers type from labels", () => {
    expect(inferType([{ name: "bug" }])).toBe("bug");
    expect(inferType([{ name: "Epic" }])).toBe("epic");
    expect(inferType([{ name: "enhancement" }])).toBe("other");
    expect(inferType(["sub-task"])).toBe("sub_task");
  });

  it("normalizes a comment", () => {
    const comment = loadFixture<GhComment>("comment.json");
    const norm = normalizeComment(comment, "acme/widgets#42");
    expect(norm.id).toBe("9001");
    expect(norm.ticketId).toBe("acme/widgets#42");
    expect(norm.author.name).toBe("Bob Singh");
    expect(norm.parentId).toBeNull();
    expect(mdxToPlainText(norm.body)).toContain("Confirmed");
  });

  it("handles null assignee + empty body", () => {
    const base = loadFixture<GhIssue>("issue.json");
    const issue: GhIssue = { ...base, assignee: null, body: null };
    const norm = normalizeIssue(issue, "t");
    expect(norm.assignee).toBeNull();
    expect(norm.body.children).toEqual([]);
  });
});
