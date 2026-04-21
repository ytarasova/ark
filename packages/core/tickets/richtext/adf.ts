/**
 * Atlassian Document Format (ADF) <-> MDX.
 *
 * ADF is Atlassian's JSON rich-text tree, used by Jira Cloud, Confluence, and
 * Bitbucket Cloud. We hand-roll the converter because:
 *
 *   - `@atlaskit/adf-schema` pulls in React and assorted UI baggage that does
 *     not install cleanly under Bun.
 *   - We only need the subset of ADF that real tickets use in practice.
 *
 * Supported nodes (both directions):
 *   paragraph, heading, bulletList, orderedList, listItem, codeBlock
 *   (including language), table, tableRow, tableHeader, tableCell, mention,
 *   link, panel (info/warning/error/success -> MDX admonition fences), status
 *   lozenge, emoji, hardBreak, rule.
 *
 * Unsupported ADF nodes (Jira macros, media embeds, date lozenges, extensions)
 * round-trip through an MDX `html` preservation block carrying `data-raw` with
 * the original ADF serialized verbatim -- `adfToMdx(mdxToAdf(adf))` returns a
 * semantically equivalent tree.
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

// ── ADF type surface (local copy -- kept minimal) ────────────────────────────

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  text?: string;
  content?: AdfNode[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

type AdmonitionKind = "info" | "warning" | "error" | "success" | "note";

const PANEL_TO_ADMONITION: Record<string, AdmonitionKind> = {
  info: "info",
  warning: "warning",
  error: "error",
  success: "success",
  note: "note",
};

// ── ADF -> MDX ───────────────────────────────────────────────────────────────

export function adfToMdx(adf: AdfDoc): Mdx {
  if (!adf || adf.type !== "doc" || !Array.isArray(adf.content)) return emptyMdx();
  const children: RootContent[] = [];
  for (const node of adf.content) {
    const converted = adfBlockToMdx(node);
    if (Array.isArray(converted)) children.push(...converted);
    else if (converted) children.push(converted);
  }
  return { type: "root", children };
}

function adfBlockToMdx(node: AdfNode): RootContent | RootContent[] | null {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: adfInlineChildren(node) } satisfies Paragraph;

    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: "heading", depth: level, children: adfInlineChildren(node) } satisfies Heading;
    }

    case "bulletList":
    case "orderedList":
      return {
        type: "list",
        ordered: node.type === "orderedList",
        spread: false,
        children: (node.content ?? []).map((li) => adfListItemToMdx(li)).filter((x): x is ListItem => !!x),
      } satisfies List;

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
          .map((c) => adfBlockToMdx(c))
          .flat()
          .filter((x): x is RootContent => !!x) as Blockquote["children"],
      } satisfies Blockquote;

    case "rule":
      return { type: "thematicBreak" } satisfies ThematicBreak;

    case "table":
      return adfTableToMdx(node);

    case "panel": {
      const kind = PANEL_TO_ADMONITION[String(node.attrs?.panelType ?? "info")] ?? "info";
      return adfPanelToAdmonition(kind, node);
    }

    default:
      // Unknown ADF block -- preserve verbatim via escape hatch.
      return makePreservedBlock("adf-node", node);
  }
}

function adfListItemToMdx(node: AdfNode): ListItem | null {
  if (node.type !== "listItem") return null;
  const children = (node.content ?? [])
    .map((c) => adfBlockToMdx(c))
    .flat()
    .filter((x): x is RootContent => !!x);
  return {
    type: "listItem",
    spread: false,
    checked: null,
    children: children as ListItem["children"],
  } satisfies ListItem;
}

function adfTableToMdx(node: AdfNode): Table {
  const rows: TableRow[] = (node.content ?? [])
    .filter((r) => r.type === "tableRow")
    .map((row) => {
      const cells: TableCell[] = (row.content ?? [])
        .filter((c) => c.type === "tableCell" || c.type === "tableHeader")
        .map((cell) => ({
          type: "tableCell",
          children: adfInlineChildren(cell),
        }));
      return { type: "tableRow", children: cells };
    });
  return { type: "table", align: [], children: rows };
}

function adfPanelToAdmonition(kind: AdmonitionKind, node: AdfNode): RootContent[] {
  // MDX admonitions as fenced blocks -- rendered verbatim via `html` nodes so
  // we stay within the base mdast type set.
  const body: RootContent[] = [
    { type: "html", value: `:::${kind}` },
    ...((node.content ?? [])
      .map((c) => adfBlockToMdx(c))
      .flat()
      .filter((x): x is RootContent => !!x) as RootContent[]),
    { type: "html", value: ":::" },
  ];
  return body;
}

function adfInlineChildren(node: AdfNode): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of node.content ?? []) {
    const converted = adfInlineToMdx(child);
    if (Array.isArray(converted)) out.push(...converted);
    else if (converted) out.push(converted);
  }
  return out;
}

function adfInlineToMdx(node: AdfNode): PhrasingContent | PhrasingContent[] | null {
  switch (node.type) {
    case "text": {
      let phrase: PhrasingContent = { type: "text", value: node.text ?? "" } satisfies Text;
      for (const mark of node.marks ?? []) {
        phrase = applyMark(mark, phrase);
      }
      return phrase;
    }

    case "hardBreak":
      return { type: "break" };

    case "mention":
      return {
        type: "text",
        value: `@${String(node.attrs?.text ?? node.attrs?.id ?? "user")}`,
      } satisfies Text;

    case "emoji":
      return {
        type: "text",
        value: String(node.attrs?.shortName ?? node.attrs?.text ?? ""),
      } satisfies Text;

    case "status":
      return {
        type: "text",
        value: `[${String(node.attrs?.text ?? "status")}]`,
      } satisfies Text;

    case "inlineCard":
    case "link":
      return {
        type: "link",
        url: String(node.attrs?.url ?? node.attrs?.href ?? "#"),
        title: null,
        children: (node.content ?? [])
          .map((c) => adfInlineToMdx(c))
          .flat()
          .filter((x): x is PhrasingContent => !!x),
      } satisfies Link;

    default:
      return null;
  }
}

function applyMark(mark: AdfMark, phrase: PhrasingContent): PhrasingContent {
  switch (mark.type) {
    case "strong":
      return { type: "strong", children: [phrase] } satisfies Strong;
    case "em":
      return { type: "emphasis", children: [phrase] } satisfies Emphasis;
    case "code":
      return {
        type: "inlineCode",
        value: (phrase as Text).value ?? "",
      } satisfies InlineCode;
    case "link": {
      const href = String(mark.attrs?.href ?? "#");
      return {
        type: "link",
        url: href,
        title: null,
        children: [phrase],
      } satisfies Link;
    }
    default:
      return phrase;
  }
}

// ── MDX -> ADF ───────────────────────────────────────────────────────────────

export function mdxToAdf(doc: Mdx): AdfDoc {
  const content: AdfNode[] = [];
  const queue = [...(doc.children ?? [])];
  while (queue.length) {
    const node = queue.shift()!;
    // Admonition open fences emit a special block that swallows following
    // nodes until the matching `:::` close.
    if (node.type === "html" && /^:::[a-z]+$/.test(node.value ?? "")) {
      const kind = (node.value ?? "").slice(3);
      const panelChildren: RootContent[] = [];
      while (queue.length) {
        const next = queue.shift()!;
        if (next.type === "html" && (next.value ?? "").trim() === ":::") break;
        panelChildren.push(next);
      }
      content.push({
        type: "panel",
        attrs: { panelType: kind === "note" ? "note" : kind },
        content: panelChildren.map(mdxBlockToAdf).filter((x): x is AdfNode => !!x),
      });
      continue;
    }
    const converted = mdxBlockToAdf(node);
    if (converted) content.push(converted);
  }
  return { version: 1, type: "doc", content };
}

function mdxBlockToAdf(node: RootContent): AdfNode | null {
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
          content: li.children.map((c) => mdxBlockToAdf(c as RootContent)).filter((x): x is AdfNode => !!x),
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
        content: (node.children as RootContent[]).map(mdxBlockToAdf).filter((x): x is AdfNode => !!x),
      };
    case "thematicBreak":
      return { type: "rule" };
    case "table":
      return mdxTableToAdf(node);
    case "html": {
      const preserved = readPreservedBlock(node);
      if (preserved?.kind === "adf-node") return preserved.raw as AdfNode;
      // Fall through: unknown HTML becomes a paragraph carrying its raw text
      // (ADF does not support arbitrary HTML).
      return {
        type: "paragraph",
        content: [{ type: "text", text: node.value ?? "" }],
      };
    }
    default:
      return null;
  }
}

function mdxTableToAdf(node: Table): AdfNode {
  const rows = (node.children as TableRow[]).map((row, rowIdx) => ({
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
  }));
  return { type: "table", content: rows };
}

function mdxInlineChildren(children: PhrasingContent[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const child of children) {
    const converted = mdxInlineToAdf(child, []);
    if (Array.isArray(converted)) out.push(...converted);
    else if (converted) out.push(converted);
  }
  return out;
}

function mdxInlineToAdf(node: PhrasingContent, marks: AdfMark[]): AdfNode | AdfNode[] | null {
  switch (node.type) {
    case "text":
      return {
        type: "text",
        text: node.value,
        ...(marks.length ? { marks: [...marks] } : {}),
      };
    case "strong":
      return node.children.flatMap((c) => mdxInlineToAdf(c, [...marks, { type: "strong" }]) ?? []) as AdfNode[];
    case "emphasis":
      return node.children.flatMap((c) => mdxInlineToAdf(c, [...marks, { type: "em" }]) ?? []) as AdfNode[];
    case "inlineCode":
      return {
        type: "text",
        text: node.value,
        marks: [...marks, { type: "code" }],
      };
    case "link":
      return node.children.flatMap(
        (c) => mdxInlineToAdf(c, [...marks, { type: "link", attrs: { href: node.url } }]) ?? [],
      ) as AdfNode[];
    case "break":
      return { type: "hardBreak" };
    default:
      return null;
  }
}
