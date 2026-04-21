/**
 * Linear ProseMirror doc JSON <-> MDX.
 *
 * Linear stores issue descriptions and comments as ProseMirror documents
 * (`{type: "doc", content: [...]}`). We cover the same node set as ADF plus
 * Linear-specific inlines: `mention` (user mentions) and `issueMention`
 * (inline issue references like `[ENG-123]`).
 *
 * Unknown ProseMirror nodes round-trip through the `html` escape hatch keyed
 * by `data-preserved="pm-node"`.
 */

import type { Mdx } from "./mdx.js";
import { emptyMdx, makePreservedBlock, readPreservedBlock } from "./mdx.js";
import type {
  Blockquote,
  Code,
  Emphasis,
  Heading,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
  ThematicBreak,
} from "mdast";

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: PmMark[];
  text?: string;
  content?: PmNode[];
}

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PmDoc {
  type: "doc";
  content: PmNode[];
}

// ── PM -> MDX ────────────────────────────────────────────────────────────────

export function prosemirrorToMdx(doc: PmDoc): Mdx {
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return emptyMdx();
  const children: RootContent[] = [];
  for (const node of doc.content) {
    const converted = pmBlockToMdx(node);
    if (Array.isArray(converted)) children.push(...converted);
    else if (converted) children.push(converted);
  }
  return { type: "root", children };
}

function pmBlockToMdx(node: PmNode): RootContent | RootContent[] | null {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: pmInlineChildren(node) } satisfies Paragraph;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6;
      return {
        type: "heading",
        depth: level,
        children: pmInlineChildren(node),
      } satisfies Heading;
    }
    case "bullet_list":
    case "bulletList":
    case "ordered_list":
    case "orderedList":
      return {
        type: "list",
        ordered: node.type === "ordered_list" || node.type === "orderedList",
        spread: false,
        children: (node.content ?? []).map(pmListItemToMdx).filter((x): x is ListItem => !!x),
      } satisfies List;

    case "code_block":
    case "codeBlock":
      return {
        type: "code",
        lang: (node.attrs?.language as string | undefined) ?? null,
        meta: null,
        value: (node.content ?? []).map((t) => t.text ?? "").join(""),
      } satisfies Code;

    case "blockquote":
      return {
        type: "blockquote",
        children: (node.content ?? [])
          .map(pmBlockToMdx)
          .flat()
          .filter((x): x is RootContent => !!x) as Blockquote["children"],
      } satisfies Blockquote;

    case "horizontal_rule":
    case "horizontalRule":
    case "rule":
      return { type: "thematicBreak" } satisfies ThematicBreak;

    case "table":
      return pmTableToMdx(node);

    default:
      return makePreservedBlock("pm-node", node);
  }
}

function pmListItemToMdx(node: PmNode): ListItem | null {
  if (node.type !== "list_item" && node.type !== "listItem") return null;
  const children = (node.content ?? [])
    .map(pmBlockToMdx)
    .flat()
    .filter((x): x is RootContent => !!x);
  return {
    type: "listItem",
    spread: false,
    checked: null,
    children: children as ListItem["children"],
  };
}

function pmTableToMdx(node: PmNode): Table {
  const rows: TableRow[] = (node.content ?? [])
    .filter((r) => r.type === "table_row" || r.type === "tableRow")
    .map((row) => ({
      type: "tableRow",
      children: (row.content ?? [])
        .filter(
          (c) =>
            c.type === "table_cell" || c.type === "tableCell" || c.type === "table_header" || c.type === "tableHeader",
        )
        .map<TableCell>((cell) => ({
          type: "tableCell",
          children: pmInlineChildren(cell),
        })),
    }));
  return { type: "table", align: [], children: rows };
}

function pmInlineChildren(node: PmNode): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of node.content ?? []) {
    const converted = pmInlineToMdx(child);
    if (Array.isArray(converted)) out.push(...converted);
    else if (converted) out.push(converted);
  }
  return out;
}

function pmInlineToMdx(node: PmNode): PhrasingContent | PhrasingContent[] | null {
  switch (node.type) {
    case "text": {
      let phrase: PhrasingContent = { type: "text", value: node.text ?? "" } satisfies Text;
      for (const mark of node.marks ?? []) phrase = applyMark(mark, phrase);
      return phrase;
    }
    case "hard_break":
    case "hardBreak":
      return { type: "break" };
    case "mention":
      return {
        type: "text",
        value: `@${String(node.attrs?.label ?? node.attrs?.id ?? "user")}`,
      } satisfies Text;
    case "issueMention":
    case "issue_mention":
      return {
        type: "text",
        value: `[${String(node.attrs?.identifier ?? node.attrs?.id ?? "issue")}]`,
      } satisfies Text;
    case "emoji":
      return {
        type: "text",
        value: String(node.attrs?.shortcode ?? node.attrs?.name ?? ""),
      } satisfies Text;
    default:
      return null;
  }
}

function applyMark(mark: PmMark, phrase: PhrasingContent): PhrasingContent {
  switch (mark.type) {
    case "bold":
    case "strong":
      return { type: "strong", children: [phrase] } satisfies Strong;
    case "italic":
    case "em":
      return { type: "emphasis", children: [phrase] } satisfies Emphasis;
    case "code":
      return {
        type: "inlineCode",
        value: (phrase as Text).value ?? "",
      } satisfies InlineCode;
    case "link":
      return {
        type: "link",
        url: String(mark.attrs?.href ?? "#"),
        title: null,
        children: [phrase],
      } satisfies Link;
    default:
      return phrase;
  }
}

// ── MDX -> PM ────────────────────────────────────────────────────────────────

export function mdxToProsemirror(doc: Mdx): PmDoc {
  const content: PmNode[] = [];
  for (const node of doc.children ?? []) {
    const converted = mdxBlockToPm(node);
    if (converted) content.push(converted);
  }
  return { type: "doc", content };
}

function mdxBlockToPm(node: RootContent): PmNode | null {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", content: mdxInlineChildren(node.children) };
    case "heading":
      return {
        type: "heading",
        attrs: { level: node.depth },
        content: mdxInlineChildren(node.children),
      };
    case "list":
      return {
        type: node.ordered ? "orderedList" : "bulletList",
        content: (node.children as ListItem[]).map((li) => ({
          type: "listItem",
          content: li.children.map((c) => mdxBlockToPm(c as RootContent)).filter((x): x is PmNode => !!x),
        })),
      };
    case "code":
      return {
        type: "codeBlock",
        attrs: node.lang ? { language: node.lang } : undefined,
        content: node.value ? [{ type: "text", text: node.value }] : [],
      };
    case "blockquote":
      return {
        type: "blockquote",
        content: (node.children as RootContent[]).map(mdxBlockToPm).filter((x): x is PmNode => !!x),
      };
    case "thematicBreak":
      return { type: "horizontalRule" };
    case "table":
      return mdxTableToPm(node);
    case "html": {
      const preserved = readPreservedBlock(node);
      if (preserved?.kind === "pm-node") return preserved.raw as PmNode;
      return {
        type: "paragraph",
        content: [{ type: "text", text: node.value ?? "" }],
      };
    }
    default:
      return null;
  }
}

function mdxTableToPm(node: Table): PmNode {
  return {
    type: "table",
    content: (node.children as TableRow[]).map((row, rowIdx) => ({
      type: "tableRow",
      content: (row.children as TableCell[]).map((cell) => ({
        type: rowIdx === 0 ? "tableHeader" : "tableCell",
        content: [
          {
            type: "paragraph",
            content: mdxInlineChildren(cell.children),
          },
        ],
      })),
    })),
  };
}

function mdxInlineChildren(children: PhrasingContent[]): PmNode[] {
  const out: PmNode[] = [];
  for (const child of children) {
    const converted = mdxInlineToPm(child, []);
    if (Array.isArray(converted)) out.push(...converted);
    else if (converted) out.push(converted);
  }
  return out;
}

function mdxInlineToPm(node: PhrasingContent, marks: PmMark[]): PmNode | PmNode[] | null {
  switch (node.type) {
    case "text":
      return {
        type: "text",
        text: node.value,
        ...(marks.length ? { marks: [...marks] } : {}),
      };
    case "strong":
      return node.children.flatMap((c) => mdxInlineToPm(c, [...marks, { type: "bold" }]) ?? []) as PmNode[];
    case "emphasis":
      return node.children.flatMap((c) => mdxInlineToPm(c, [...marks, { type: "italic" }]) ?? []) as PmNode[];
    case "inlineCode":
      return {
        type: "text",
        text: node.value,
        marks: [...marks, { type: "code" }],
      };
    case "link":
      return node.children.flatMap(
        (c) => mdxInlineToPm(c, [...marks, { type: "link", attrs: { href: node.url } }]) ?? [],
      ) as PmNode[];
    case "break":
      return { type: "hardBreak" };
    default:
      return null;
  }
}
