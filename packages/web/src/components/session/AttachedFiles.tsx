import { useState } from "react";

/**
 * Collapsible display for session-scoped attachment files. Renders a header
 * row with the count, then each attachment with an expand/collapse toggle.
 */
export function AttachedFiles({
  attachments,
}: {
  attachments: Array<{ name: string; content: string; type: string }>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div className="mb-4 border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-[var(--bg-hover)] border-b border-[var(--border)]">
        <span className="text-[11px] font-semibold text-[var(--fg-muted)] uppercase tracking-[0.04em]">
          Attached Files ({attachments.length})
        </span>
      </div>
      {attachments.map((att) => {
        const isBinary = att.content?.startsWith("data:");
        const isOpen = expanded[att.name] ?? false;
        return (
          <div key={att.name} className="border-b border-[var(--border)] last:border-b-0">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
              onClick={() => setExpanded((prev) => ({ ...prev, [att.name]: !prev[att.name] }))}
            >
              <span className="text-[12px] font-medium text-[var(--fg)]">{att.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
                {att.type || "unknown"}
              </span>
              <span className="ml-auto text-[10px] text-[var(--fg-muted)]">{isOpen ? "collapse" : "expand"}</span>
            </button>
            {isOpen && (
              <div className="px-3 pb-2">
                {isBinary ? (
                  <span className="text-[11px] text-[var(--fg-muted)] italic">
                    Binary file -- preview not available
                  </span>
                ) : (
                  <pre className="text-[11px] leading-relaxed text-[var(--fg)] bg-[var(--bg)] rounded p-2 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap font-[family-name:var(--font-mono-ui)]">
                    {att.content}
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
