import { describe, it, expect } from "bun:test";
import { prosemirrorToMdx, mdxToProsemirror, type PmDoc, type PmNode } from "../richtext/prosemirror.js";

function doc(...nodes: PmNode[]): PmDoc {
  return { type: "doc", content: nodes };
}

function findAll(node: PmNode | PmDoc, type: string, out: PmNode[] = []): PmNode[] {
  if ((node as PmNode).type === type) out.push(node as PmNode);
  for (const c of (node as { content?: PmNode[] }).content ?? []) findAll(c, type, out);
  return out;
}

describe("ProseMirror <-> MDX", () => {
  it("round-trips a paragraph with bold and italic marks", () => {
    const src = doc({
      type: "paragraph",
      content: [
        { type: "text", text: "a ", marks: [{ type: "bold" }] },
        { type: "text", text: "b", marks: [{ type: "italic" }] },
      ],
    });
    const out = mdxToProsemirror(prosemirrorToMdx(src));
    const texts = findAll(out, "text");
    expect(texts.some((t) => t.marks?.some((m) => m.type === "bold"))).toBe(true);
    expect(texts.some((t) => t.marks?.some((m) => m.type === "italic"))).toBe(true);
  });

  it("round-trips headings and lists", () => {
    const src = doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "y" }] }],
          },
        ],
      },
    );
    const out = mdxToProsemirror(prosemirrorToMdx(src));
    const h = findAll(out, "heading")[0];
    expect(h.attrs?.level).toBe(2);
    expect(findAll(out, "listItem")).toHaveLength(2);
  });

  it("round-trips code block and blockquote", () => {
    const src = doc(
      {
        type: "codeBlock",
        attrs: { language: "py" },
        content: [{ type: "text", text: "print(1)" }],
      },
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }],
      },
    );
    const out = mdxToProsemirror(prosemirrorToMdx(src));
    const cb = findAll(out, "codeBlock")[0];
    expect(cb.attrs?.language).toBe("py");
    expect(findAll(out, "blockquote")).toHaveLength(1);
  });

  it("round-trips horizontal rule", () => {
    const src = doc({ type: "horizontalRule" });
    const out = mdxToProsemirror(prosemirrorToMdx(src));
    expect(findAll(out, "horizontalRule")).toHaveLength(1);
  });

  it("flattens mention and issueMention to plain text", () => {
    const src = doc({
      type: "paragraph",
      content: [
        { type: "mention", attrs: { label: "yana" } },
        { type: "text", text: " see " },
        { type: "issueMention", attrs: { identifier: "ENG-123" } },
      ],
    });
    const mdx = prosemirrorToMdx(src);
    const joined = JSON.stringify(mdx);
    expect(joined).toContain("@yana");
    expect(joined).toContain("[ENG-123]");
  });

  it("round-trips a link mark", () => {
    const src = doc({
      type: "paragraph",
      content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "https://ex.com" } }] }],
    });
    const out = mdxToProsemirror(prosemirrorToMdx(src));
    const link = findAll(out, "text")[0].marks?.find((m) => m.type === "link");
    expect(link?.attrs?.href).toBe("https://ex.com");
  });
});
