import { describe, it, expect } from "bun:test";
import { adfToMdx, mdxToAdf, type AdfDoc, type AdfNode } from "../richtext/adf.js";
import { prosemirrorToMdx, mdxToProsemirror, type PmDoc, type PmNode } from "../richtext/prosemirror.js";
import { makePreservedBlock, readPreservedBlock } from "../richtext/mdx.js";

describe("lossy round-trip via escape hatch", () => {
  it("preserves a Jira macro (unknown ADF node) across ADF -> MDX -> ADF", () => {
    const macro: AdfNode = {
      type: "extension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "toc",
        parameters: { macroParams: { minLevel: { value: "2" } } },
      },
    };
    const src: AdfDoc = { version: 1, type: "doc", content: [macro] };
    const mdx = adfToMdx(src);
    // The preservation block landed.
    const html = mdx.children.find((c) => c.type === "html");
    expect(html).toBeTruthy();
    const preserved = readPreservedBlock(html!);
    expect(preserved?.kind).toBe("adf-node");

    // And it re-materializes back to ADF.
    const out = mdxToAdf(mdx);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("extension");
    expect((out.content[0].attrs as { extensionKey?: string }).extensionKey).toBe("toc");
  });

  it("preserves an unknown ProseMirror node across PM -> MDX -> PM", () => {
    const unknown: PmNode = {
      type: "linearCustomBlock",
      attrs: { payload: { foo: "bar" } },
    };
    const src: PmDoc = { type: "doc", content: [unknown] };
    const mdx = prosemirrorToMdx(src);
    const html = mdx.children.find((c) => c.type === "html");
    expect(html).toBeTruthy();
    expect(readPreservedBlock(html!)?.kind).toBe("pm-node");

    const out = mdxToProsemirror(mdx);
    expect(out.content[0].type).toBe("linearCustomBlock");
    expect((out.content[0].attrs as { payload?: { foo?: string } }).payload?.foo).toBe("bar");
  });

  it("makePreservedBlock / readPreservedBlock round-trip arbitrary JSON payloads", () => {
    const raw = { nested: { value: 1, s: 'quote "and" < > &' } };
    const block = makePreservedBlock("custom-kind", raw);
    const read = readPreservedBlock(block);
    expect(read?.kind).toBe("custom-kind");
    expect(read?.raw).toEqual(raw);
  });

  it("readPreservedBlock returns null for plain html blocks", () => {
    const read = readPreservedBlock({ type: "html", value: "<p>plain</p>" });
    expect(read).toBeNull();
  });
});
