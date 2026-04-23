import { DiffViewer, type DiffFile } from "../../ui/DiffViewer.js";

interface DiffTabProps {
  diffData: any;
  diffFiles: DiffFile[];
  activeDiffFile: string | undefined;
  onFileSelect: (name: string) => void;
  hasWorkdir: boolean;
}

/**
 * Diff of the session worktree against its base branch. Shows a parsed,
 * per-file diff via `DiffViewer` when available, falls back to the raw
 * `git diff --stat` string otherwise.
 */
export function DiffTab({ diffData, diffFiles, activeDiffFile, onFileSelect, hasWorkdir }: DiffTabProps) {
  return (
    <div className="max-w-[800px] mx-auto">
      {diffData ? (
        <div>
          <div className="text-[11px] text-[var(--fg-muted)] mb-3 font-[family-name:var(--font-mono)]">
            {diffData.filesChanged} files changed, +{diffData.insertions || 0} -{diffData.deletions || 0}
          </div>
          {diffFiles.length > 0 ? (
            <DiffViewer files={diffFiles} activeFile={activeDiffFile} onFileSelect={onFileSelect} />
          ) : diffData.stat ? (
            <pre className="bg-[var(--bg-code)] border border-[var(--border)] rounded-lg p-3.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.7] overflow-auto whitespace-pre-wrap text-[var(--fg-muted)]">
              {diffData.stat}
            </pre>
          ) : null}
        </div>
      ) : (
        <div className="text-center py-12 text-[var(--fg-faint)]">
          {hasWorkdir ? "Loading diff..." : "No worktree associated with this session"}
        </div>
      )}
    </div>
  );
}
