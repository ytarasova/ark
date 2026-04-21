/**
 * MDX (= mdast + optional JSX) is the canonical rich-text form for the
 * ticket framework. Every provider adapter converts its native markup to MDX
 * before handing payloads to Ark, and converts MDX back to native before
 * writing. Keeping a single intermediate form means we only write N converters
 * instead of N^2.
 *
 * For our purposes MDX is mdast with:
 *
 *   - core markdown nodes (paragraph, heading, list, code, table, ...)
 *   - GFM extensions (tables, task lists, strikethrough, autolinks)
 *   - escape hatches via `html` nodes carrying `data-preserved="<kind>"` for
 *     constructs that have no native MDX equivalent (Jira macros, Linear
 *     issue embeds, ADF panels before we lower them to admonitions, etc.)
 *
 * We intentionally do NOT import the `mdast-util-mdx-*` expression / JSX
 * extensions -- tickets almost never need embedded JSX, and keeping the type
 * pinned to the commonmark + gfm surface makes round-tripping deterministic.
 */

import type { Root, RootContent } from "mdast";

/** Canonical MDX document type -- a mdast root node. */
export type Mdx = Root;

/** Individual top-level MDX nodes. */
export type MdxContent = RootContent;

/** Construct an empty MDX document (a root with no children). */
export function emptyMdx(): Mdx {
  return { type: "root", children: [] };
}

/** True when the MDX doc has no renderable text content. */
export function mdxIsEmpty(doc: Mdx): boolean {
  return mdxToPlainText(doc).trim().length === 0;
}

/**
 * Best-effort plain-text rendering for logging, previews, and search indexing.
 * Strips formatting, preserves line structure between blocks.
 */
export function mdxToPlainText(doc: Mdx): string {
  const chunks: string[] = [];
  walkText(doc as unknown as TextishNode, chunks);
  return chunks
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type TextishNode = {
  type: string;
  value?: string;
  children?: TextishNode[];
};

function walkText(node: TextishNode, out: string[]): void {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    out.push(node.value ?? "");
    return;
  }
  if (node.type === "break" || node.type === "thematicBreak") {
    out.push("\n");
    return;
  }
  if (node.type === "html") {
    if (node.value && !/data-preserved=/.test(node.value)) out.push(node.value);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkText(child, out);
    if (isBlockKind(node.type)) out.push("\n\n");
  }
}

function isBlockKind(type: string): boolean {
  return (
    type === "paragraph" ||
    type === "heading" ||
    type === "blockquote" ||
    type === "list" ||
    type === "listItem" ||
    type === "code" ||
    type === "table" ||
    type === "tableRow" ||
    type === "root"
  );
}

/**
 * Wrap a provider-native payload into a preservation escape-hatch HTML block.
 * The resulting node round-trips untouched through every converter: on the
 * way out the HTML block is serialized verbatim; on the way back in adapters
 * look for `data-preserved="<kind>"` and re-materialize the original node.
 */
export function makePreservedBlock(kind: string, raw: unknown): MdxContent {
  const serialized = JSON.stringify(raw);
  const escaped = serialized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return {
    type: "html",
    value: `<div data-preserved="${kind}" data-raw="${escaped}"></div>`,
  };
}

/** Extract a preserved payload from an HTML block, or null if not one. */
export function readPreservedBlock(node: MdxContent): { kind: string; raw: unknown } | null {
  if (node.type !== "html") return null;
  const m = /data-preserved="([^"]+)"\s+data-raw="([^"]*)"/.exec(node.value ?? "");
  if (!m) return null;
  const decoded = m[2]
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  try {
    return { kind: m[1], raw: JSON.parse(decoded) };
  } catch {
    return null;
  }
}
