interface KnowledgeTabProps {
  session: any;
}

/**
 * Knowledge tab -- placeholder composition for the knowledge-graph context
 * items associated with this session. Backend surface not yet landed; once
 * `session.knowledge_refs[]` is populated by the knowledge engine we render
 * a per-item row. For now show empty-state + plumbed prop.
 */
export function KnowledgeTab({ session }: KnowledgeTabProps) {
  const refs: any[] = session?.knowledge_refs ?? session?.config?.knowledge_refs ?? [];
  if (!refs || refs.length === 0) {
    return (
      <div className="max-w-[700px] mx-auto text-center py-12 text-[var(--fg-faint)] font-[family-name:var(--font-mono-ui)] text-[11px] uppercase tracking-[0.05em]">
        No knowledge items attached to this session
      </div>
    );
  }
  return (
    <div className="max-w-[900px] mx-auto flex flex-col gap-[6px]">
      {refs.map((r, i) => (
        <div
          key={i}
          className="flex items-start gap-[10px] px-[12px] py-[10px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)]"
        >
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] uppercase tracking-[0.05em] text-[var(--fg-muted)] shrink-0 pt-[2px]">
            {r.kind || "ref"}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-[family-name:var(--font-sans)] text-[12.5px] font-medium text-[var(--fg)] truncate">
              {r.title || r.path || r.id}
            </div>
            {r.excerpt && (
              <div className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--fg-muted)] mt-[3px] leading-[1.55] line-clamp-3">
                {r.excerpt}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
