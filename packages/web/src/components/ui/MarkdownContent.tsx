import { useMemo } from "react";

/**
 * Lightweight markdown renderer for agent messages.
 * Handles headings, bold, italic, inline code, code blocks, lists, and paragraphs.
 * No external dependencies -- just regex-based parsing.
 */
export function MarkdownContent({ content }: { content: string }) {
  const elements = useMemo(() => parseMarkdown(content), [content]);
  return <div className="text-[13px] leading-[1.7] text-[var(--fg)]">{elements}</div>;
}

/** Inline markdown: bold, italic, inline code */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Process inline patterns: `code`, **bold**, *italic*
  const parts: React.ReactNode[] = [];
  // Combined regex: backtick code | bold ** | bold __ | italic * | italic _
  const inlineRe = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const m = match[0];
    const k = keyPrefix + "-" + match.index;
    if (match[1]) {
      // inline code
      parts.push(
        <code
          key={k}
          className="bg-[var(--bg-code)] px-1 py-0.5 rounded text-[12px] font-[family-name:var(--font-mono)]"
        >
          {m.slice(1, -1)}
        </code>,
      );
    } else if (match[2] || match[3]) {
      // bold
      parts.push(
        <strong key={k} className="font-semibold">
          {m.slice(2, -2)}
        </strong>,
      );
    } else if (match[4] || match[5]) {
      // italic
      parts.push(<em key={k}>{m.slice(1, -1)}</em>);
    }
    lastIndex = match.index + m.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

interface Block {
  type: "heading" | "code" | "ul" | "ol" | "paragraph";
  level?: number; // heading level (2 or 3)
  lang?: string;
  lines: string[];
}

function parseMarkdown(content: string): React.ReactNode[] {
  if (!content) return [];

  const lines = content.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({ type: "code", lang, lines: codeLines });
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{2,3})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, lines: [headingMatch[2]] });
      i++;
      continue;
    }

    // Unordered list items
    if (/^[-*]\s+/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        listLines.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", lines: listLines });
      continue;
    }

    // Ordered list items
    if (/^\d+\.\s+/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        listLines.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", lines: listLines });
      continue;
    }

    // Blank line -- skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-special lines
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^#{2,3}\s+/) &&
      !lines[i].match(/^[-*]\s+/) &&
      !lines[i].match(/^\d+\.\s+/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", lines: paraLines });
  }

  // Render blocks to React elements
  return blocks.map((block, idx) => {
    const key = "b" + idx;
    switch (block.type) {
      case "heading": {
        const text = block.lines[0];
        if (block.level === 2) {
          return (
            <h2 key={key} className="text-[15px] font-semibold mt-4 mb-2 text-[var(--fg)]">
              {renderInline(text, key)}
            </h2>
          );
        }
        return (
          <h3 key={key} className="text-[13px] font-semibold mt-3 mb-1.5 text-[var(--fg)]">
            {renderInline(text, key)}
          </h3>
        );
      }
      case "code":
        return (
          <pre
            key={key}
            className="bg-[var(--bg-code)] border border-[var(--border)] rounded-md p-3 font-[family-name:var(--font-mono)] text-[12px] my-2 overflow-x-auto"
          >
            <code>{block.lines.join("\n")}</code>
          </pre>
        );
      case "ul":
        return (
          <ul key={key} className="list-disc pl-5 my-2 text-[13px] space-y-0.5">
            {block.lines.map((item, li) => (
              <li key={li}>{renderInline(item, key + "-" + li)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol key={key} className="list-decimal pl-5 my-2 text-[13px] space-y-0.5">
            {block.lines.map((item, li) => (
              <li key={li}>{renderInline(item, key + "-" + li)}</li>
            ))}
          </ol>
        );
      case "paragraph":
        return (
          <p key={key} className="mb-3 last:mb-0">
            {renderInline(block.lines.join(" "), key)}
          </p>
        );
      default:
        return null;
    }
  });
}
