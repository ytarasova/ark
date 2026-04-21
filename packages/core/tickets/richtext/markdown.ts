/**
 * GitHub-flavored Markdown <-> MDX.
 *
 * MDX is an mdast superset, so this module is almost an identity pipe -- we
 * parse with `mdast-util-from-markdown` (plus the GFM micromark extension for
 * tables, task lists, strikethrough, autolinks), return the root as the MDX
 * doc, and serialize back with `mdast-util-to-markdown` and the matching GFM
 * handlers.
 *
 * We never introduce JSX or ESM import nodes when parsing plain markdown, so
 * the converter pair is lossless for any input that is valid GFM.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Mdx } from "./mdx.js";
import { emptyMdx } from "./mdx.js";

/** Parse GFM markdown into an MDX document. */
export function markdownToMdx(src: string): Mdx {
  if (!src) return emptyMdx();
  const tree = fromMarkdown(src, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  // fromMarkdown returns a Root already; cast via unknown to satisfy mdast's
  // more specific phrasing-content typing.
  return tree as unknown as Mdx;
}

/** Serialize an MDX document back to GFM markdown. */
export function mdxToMarkdown(doc: Mdx): string {
  return toMarkdown(doc, {
    extensions: [gfmToMarkdown()],
    bullet: "-",
    fences: true,
    rule: "-",
  });
}
