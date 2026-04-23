import type { DiffFile } from "../../ui/DiffViewer.js";

interface FilesTabProps {
  diffFiles: DiffFile[];
  onSelect?: (path: string) => void;
}

/**
 * Files tab -- a flat list of files modified in this session's worktree,
 * parsed from the same unified-diff stream the Diff tab consumes. Each row
 * links (via onSelect) to the Diff tab focused on that file.
 */
export function FilesTab({ diffFiles, onSelect }: FilesTabProps) {
  if (!diffFiles || diffFiles.length === 0) {
    return (
      <div className="text-center py-12 text-[var(--fg-faint)] font-[family-name:var(--font-mono-ui)] text-[11px] uppercase tracking-[0.05em]">
        No files changed in this session
      </div>
    );
  }
  return (
    <div className="max-w-[900px] mx-auto flex flex-col gap-[4px]">
      <div className="flex items-center justify-between mb-[8px] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--fg-muted)]">
        <span>Files &middot; {diffFiles.length}</span>
        <span className="tabular-nums">
          <span className="text-[#34d399]">+{diffFiles.reduce((t, f) => t + f.additions, 0)}</span>{" "}
          <span className="text-[#f87171]">-{diffFiles.reduce((t, f) => t + f.deletions, 0)}</span>
        </span>
      </div>
      {diffFiles.map((f) => (
        <button
          type="button"
          key={f.filename}
          onClick={() => onSelect?.(f.filename)}
          className={[
            "flex items-center gap-[10px] w-full text-left px-[12px] py-[8px] rounded-[7px]",
            "border border-[var(--border)] bg-[var(--bg-card)] cursor-pointer",
            "hover:border-[rgba(107,89,222,0.4)] transition-colors",
          ].join(" ")}
        >
          <span className="flex-1 min-w-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--fg)]">
            {f.filename}
          </span>
          <span className="shrink-0 font-[family-name:var(--font-mono-ui)] text-[10px] tabular-nums">
            <span className="text-[#34d399]">+{f.additions}</span>{" "}
            <span className="text-[#f87171]">-{f.deletions}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
