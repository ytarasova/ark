import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mdxToMarkdown } from "../../../richtext/markdown.js";
import { mdxToPlainText } from "../../../richtext/mdx.js";
import {
  normalizeComment,
  normalizeIssue,
  parseRef,
  refOf,
  statusCategory,
  type BbComment,
  type BbIssue,
} from "../normalize.js";

const HERE = new URL(".", import.meta.url).pathname;
function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8")) as T;
}

describe("bitbucket normalize", () => {
  it("parseRef handles workspace/repo#N", () => {
    expect(parseRef("acme/widgets#7")).toEqual({ workspace: "acme", repo: "widgets", id: 7 });
    expect(() => parseRef("widgets#7")).toThrow();
  });

  it("refOf uses repository.full_name first", () => {
    const issue = loadFixture<BbIssue>("issue.json");
    const ref = refOf({ ...issue, repository: { full_name: "acme/widgets" } });
    expect(ref).toBe("acme/widgets#7");
  });

  it("refOf falls back to self link when repository missing", () => {
    const issue = loadFixture<BbIssue>("issue.json");
    const ref = refOf(issue);
    expect(ref).toBe("acme/widgets#7");
  });

  it("normalizes a typical issue", () => {
    const issue = { ...loadFixture<BbIssue>("issue.json"), repository: { full_name: "acme/widgets" } };
    const norm = normalizeIssue(issue, "tenant-1");
    expect(norm.provider).toBe("bitbucket");
    expect(norm.id).toBe("acme/widgets#7");
    expect(norm.key).toBe("#7");
    expect(norm.url).toBe("https://bitbucket.org/acme/widgets/issues/7");
    expect(norm.title).toContain("500");
    expect(norm.type).toBe("bug");
    expect(norm.priority).toBe("major");
    expect(norm.status.category).toBe("in_progress"); // open
    expect(norm.labels).toContain("component:api");
    expect(norm.assignee?.name).toBe("Bob Singh");
    expect(norm.reporter.name).toBe("Alice Chen");
    const md = mdxToMarkdown(norm.body);
    expect(md).toContain("**500 Internal Server Error**");
    expect(mdxToPlainText(norm.body)).toContain("curl -X POST");
  });

  it("maps BB states to categories", () => {
    expect(statusCategory("new")).toBe("todo");
    expect(statusCategory("on hold")).toBe("todo");
    expect(statusCategory("open")).toBe("in_progress");
    expect(statusCategory("resolved")).toBe("done");
    expect(statusCategory("closed")).toBe("done");
    expect(statusCategory("wontfix")).toBe("cancelled");
    expect(statusCategory("invalid")).toBe("cancelled");
    expect(statusCategory("duplicate")).toBe("cancelled");
  });

  it("kind enum maps to TicketType", () => {
    const base = { ...loadFixture<BbIssue>("issue.json"), repository: { full_name: "acme/widgets" } };
    expect(normalizeIssue({ ...base, kind: "enhancement" }, "t").type).toBe("story");
    expect(normalizeIssue({ ...base, kind: "task" }, "t").type).toBe("task");
    expect(normalizeIssue({ ...base, kind: "proposal" }, "t").type).toBe("story");
    expect(normalizeIssue({ ...base, kind: undefined as unknown as undefined }, "t").type).toBe("other");
  });

  it("normalizes a comment", () => {
    const c = loadFixture<BbComment>("comment.json");
    const norm = normalizeComment(c, "acme/widgets#7");
    expect(norm.id).toBe("5001");
    expect(norm.ticketId).toBe("acme/widgets#7");
    expect(norm.author.name).toBe("Bob Singh");
    expect(norm.parentId).toBeNull();
    expect(mdxToPlainText(norm.body)).toContain("Confirmed");
  });

  it("preserves parentId for threaded reply", () => {
    const c = loadFixture<BbComment>("comment.json");
    const child = { ...c, parent: { id: 5000 } };
    expect(normalizeComment(child, "r#1").parentId).toBe("5000");
  });
});
