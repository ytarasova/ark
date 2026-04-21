import { describe, it, expect } from "bun:test";
import { markdownToMdx, mdxToMarkdown } from "../richtext/markdown.js";
import { mdxIsEmpty, mdxToPlainText } from "../richtext/mdx.js";

describe("markdown <-> MDX", () => {
  it("round-trips a paragraph + heading + list", () => {
    const src = ["# Title", "", "A paragraph with **bold** and *italic*.", "", "- one", "- two", "- three", ""].join(
      "\n",
    );
    const mdx = markdownToMdx(src);
    const out = mdxToMarkdown(mdx);
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("*italic*");
    expect(out).toContain("- one");
    expect(out).toContain("- three");
  });

  it("round-trips a fenced code block with language", () => {
    const src = ["```ts", "const x = 1;", "```", ""].join("\n");
    const mdx = markdownToMdx(src);
    const out = mdxToMarkdown(mdx);
    expect(out).toContain("```ts");
    expect(out).toContain("const x = 1;");
  });

  it("round-trips a GFM table", () => {
    const src = ["| a | b |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");
    const mdx = markdownToMdx(src);
    const out = mdxToMarkdown(mdx);
    // Whitespace in rendered tables is normalized; content must survive.
    expect(out).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
    expect(out).toMatch(/\|\s*1\s*\|\s*2\s*\|/);
    expect(out).toMatch(/\|\s*3\s*\|\s*4\s*\|/);
  });

  it("round-trips a blockquote and inline link", () => {
    const src = ["> quoted [link](https://example.com)", ""].join("\n");
    const mdx = markdownToMdx(src);
    const out = mdxToMarkdown(mdx);
    expect(out).toContain("> quoted");
    expect(out).toContain("[link](https://example.com)");
  });

  it("emptyness helpers behave", () => {
    const empty = markdownToMdx("");
    expect(mdxIsEmpty(empty)).toBe(true);
    const nonEmpty = markdownToMdx("hello");
    expect(mdxIsEmpty(nonEmpty)).toBe(false);
    expect(mdxToPlainText(nonEmpty)).toContain("hello");
  });
});
