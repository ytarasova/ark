import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

/**
 * Markdown renderer for agent messages.
 *
 * Uses `react-markdown` + `rehype-sanitize` (default schema) -- swapped in
 * for a hand-rolled regex parser per Agent 6's build-vs-buy audit (F1 /
 * P3-6). Sanitization drops raw HTML that fell through the regex parser
 * previously, closing the XSS-adjacent surface.
 *
 * Public signature (<MarkdownContent content={...} />) and visual output
 * are unchanged from the previous implementation: same Tailwind classes
 * for headings, code blocks, lists, inline code, bold/italic, paragraphs.
 * We intentionally do not enable `remark-gfm` -- the old parser did not
 * support GFM features (tables, autolinks, task lists) and introducing
 * them here would be a behaviour change.
 */
export function MarkdownContent({ content }: { content: string }) {
  if (!content) {
    return <div className="text-[13px] leading-[1.7] text-[var(--fg)]" />;
  }
  return (
    <div className="text-[13px] leading-[1.7] text-[var(--fg)]">
      <Markdown rehypePlugins={[rehypeSanitize]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}

/**
 * Component overrides -- keep the exact Tailwind classes the previous
 * renderer emitted so visual output is unchanged.
 */
const components: Components = {
  h1: ({ children }) => <h2 className="text-[15px] font-semibold mt-4 mb-2 text-[var(--fg)]">{children}</h2>,
  h2: ({ children }) => <h2 className="text-[15px] font-semibold mt-4 mb-2 text-[var(--fg)]">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[13px] font-semibold mt-3 mb-1.5 text-[var(--fg)]">{children}</h3>,
  h4: ({ children }) => <h3 className="text-[13px] font-semibold mt-3 mb-1.5 text-[var(--fg)]">{children}</h3>,
  h5: ({ children }) => <h3 className="text-[13px] font-semibold mt-3 mb-1.5 text-[var(--fg)]">{children}</h3>,
  h6: ({ children }) => <h3 className="text-[13px] font-semibold mt-3 mb-1.5 text-[var(--fg)]">{children}</h3>,
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-2 text-[13px] space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-2 text-[13px] space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  pre: ({ children }) => (
    <pre className="bg-[var(--bg-code)] border border-[var(--border)] rounded-md p-3 font-[family-name:var(--font-mono)] text-[12px] my-2 overflow-x-auto">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    // react-markdown hands us both inline <code> and the <code> inside <pre>.
    // Fenced code blocks get a `language-*` class (or nothing if no lang);
    // inline code never does when rendered inside a paragraph.
    // When nested in <pre> the parent <pre> supplies the block styling;
    // here we style the inline case only (match legacy inline-code classes).
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="bg-[var(--bg-code)] px-1 py-0.5 rounded text-[12px] font-[family-name:var(--font-mono)]"
        {...props}
      >
        {children}
      </code>
    );
  },
};
