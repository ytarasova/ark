/** Footer below the Diff tab: aggregated files changed / insertions / deletions. */
export function DiffFooter({ diffData }: { diffData: any }) {
  return (
    <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
      <span>{diffData.filesChanged} files changed</span>
      <span className="text-[var(--diff-add-fg)]">+{diffData.insertions || 0}</span>
      <span className="text-[var(--diff-rm-fg)]">-{diffData.deletions || 0}</span>
    </div>
  );
}

/** Footer below the Todos tab: completed vs. remaining counts. */
export function TodosFooter({ todos }: { todos: any[] }) {
  return (
    <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
      <span>
        {todos.filter((t) => t.done).length} of {todos.length} completed
      </span>
      <span className="ml-auto">{todos.filter((t) => !t.done).length} remaining</span>
    </div>
  );
}
