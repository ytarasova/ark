import { describe, it, expect } from "bun:test";
import { adfToMdx, mdxToAdf, type AdfDoc, type AdfNode } from "../richtext/adf.js";

function doc(...nodes: AdfNode[]): AdfDoc {
  return { version: 1, type: "doc", content: nodes };
}

function findAll(node: AdfNode | AdfDoc, type: string, out: AdfNode[] = []): AdfNode[] {
  if ((node as AdfNode).type === type) out.push(node as AdfNode);
  for (const c of (node as { content?: AdfNode[] }).content ?? []) findAll(c, type, out);
  return out;
}

describe("ADF <-> MDX", () => {
  it("round-trips a paragraph", () => {
    const src = doc({ type: "paragraph", content: [{ type: "text", text: "hello" }] });
    const mdx = adfToMdx(src);
    const out = mdxToAdf(mdx);
    expect(findAll(out, "paragraph")).toHaveLength(1);
    expect(findAll(out, "text")[0].text).toBe("hello");
  });

  it("round-trips headings at multiple levels", () => {
    const src = doc(
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "A" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "C" }] },
    );
    const out = mdxToAdf(adfToMdx(src));
    const heads = findAll(out, "heading");
    expect(heads).toHaveLength(2);
    expect(heads[0].attrs?.level).toBe(1);
    expect(heads[1].attrs?.level).toBe(3);
  });

  it("round-trips bulletList, orderedList, and listItem", () => {
    const item = (txt: string): AdfNode => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: txt }] }],
    });
    const src = doc(
      { type: "bulletList", content: [item("one"), item("two")] },
      { type: "orderedList", content: [item("a"), item("b")] },
    );
    const out = mdxToAdf(adfToMdx(src));
    expect(findAll(out, "bulletList")).toHaveLength(1);
    expect(findAll(out, "orderedList")).toHaveLength(1);
    expect(findAll(out, "listItem")).toHaveLength(4);
  });

  it("round-trips codeBlock with language", () => {
    const src = doc({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
    const out = mdxToAdf(adfToMdx(src));
    const cb = findAll(out, "codeBlock")[0];
    expect(cb.attrs?.language).toBe("ts");
    expect(cb.content?.[0].text).toBe("const x = 1;");
  });

  it("round-trips a table with header and body cells", () => {
    const p = (txt: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text: txt }] });
    const src = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [p("h1")] },
            { type: "tableHeader", content: [p("h2")] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [p("c1")] },
            { type: "tableCell", content: [p("c2")] },
          ],
        },
      ],
    });
    const out = mdxToAdf(adfToMdx(src));
    expect(findAll(out, "tableRow")).toHaveLength(2);
    expect(findAll(out, "tableHeader")).toHaveLength(2);
    expect(findAll(out, "tableCell")).toHaveLength(2);
  });

  it("preserves link marks on text nodes", () => {
    const src = doc({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "click",
          marks: [{ type: "link", attrs: { href: "https://ex.com" } }],
        },
      ],
    });
    const out = mdxToAdf(adfToMdx(src));
    const texts = findAll(out, "text");
    const linkMark = texts[0].marks?.find((m) => m.type === "link");
    expect(linkMark).toBeTruthy();
    expect(linkMark?.attrs?.href).toBe("https://ex.com");
  });

  it("lowers panel (info) to MDX admonition and back to panel", () => {
    const src = doc({
      type: "panel",
      attrs: { panelType: "info" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "heads up" }] }],
    });
    const mdx = adfToMdx(src);
    // The MDX form is a fenced admonition built from html nodes.
    const htmlFence = mdx.children.find((c) => c.type === "html");
    expect(htmlFence).toBeTruthy();
    const out = mdxToAdf(mdx);
    const panel = findAll(out, "panel")[0];
    expect(panel).toBeTruthy();
    expect(panel.attrs?.panelType).toBe("info");
    expect(findAll(panel, "text")[0].text).toBe("heads up");
  });

  it("flattens mention, status, emoji, and hardBreak to text", () => {
    const src = doc({
      type: "paragraph",
      content: [
        { type: "mention", attrs: { text: "yana" } },
        { type: "hardBreak" },
        { type: "status", attrs: { text: "In Progress" } },
        { type: "emoji", attrs: { shortName: ":tada:" } },
      ],
    });
    const mdx = adfToMdx(src);
    const text = JSON.stringify(mdx);
    expect(text).toContain("@yana");
    expect(text).toContain("[In Progress]");
    expect(text).toContain(":tada:");
  });

  it("round-trips a rule (thematic break)", () => {
    const src = doc({ type: "rule" });
    const out = mdxToAdf(adfToMdx(src));
    expect(findAll(out, "rule")).toHaveLength(1);
  });
});
