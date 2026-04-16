import { cn } from "../../lib/utils.js";

export interface DiffFile {
  filename: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  lineNumber?: number;
  content: string;
}

export interface DiffViewerProps extends React.ComponentProps<"div"> {
  files: DiffFile[];
  activeFile?: string;
  onFileSelect?: (filename: string) => void;
}

/**
 * Unified diff viewer with file tabs, line numbers, and add/remove coloring.
 */
export function DiffViewer({ files, activeFile, onFileSelect, className, ...props }: DiffViewerProps) {
  const selected = activeFile ?? files[0]?.filename;
  const file = files.find((f) => f.filename === selected);

  return (
    <div className={cn("flex flex-col", className)} {...props}>
      {/* File tabs */}
      {files.length > 1 && (
        <div className="flex gap-0 border-b border-[var(--border)] overflow-x-auto">
          {files.map((f) => (
            <button
              key={f.filename}
              type="button"
              onClick={() => onFileSelect?.(f.filename)}
              className={cn(
                "px-3 py-2 text-[12px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)]",
                "border-b-2 border-transparent cursor-pointer bg-transparent shrink-0",
                "hover:text-[var(--fg)] transition-colors duration-150",
                f.filename === selected && "text-[var(--fg)] border-b-[var(--primary)]",
              )}
            >
              {f.filename}
              <span className="ml-2 text-[10px]">
                <span className="text-[var(--diff-add-fg)]">+{f.additions}</span>
                <span className="text-[var(--diff-rm-fg)] ml-1">-{f.deletions}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Diff content */}
      {file && (
        <div className="overflow-auto font-[family-name:var(--font-mono)] text-[12px] leading-[1.6]">
          {file.lines.map((line, i) => (
            <div
              key={i}
              className={cn("flex px-3 py-0", {
                "bg-[var(--diff-add-bg)]": line.type === "add",
                "bg-[var(--diff-rm-bg)]": line.type === "remove",
              })}
            >
              <span className="w-10 shrink-0 text-right pr-3 select-none text-[var(--fg-faint)] text-[11px]">
                {line.lineNumber ?? ""}
              </span>
              <span
                className={cn("flex-1 whitespace-pre", {
                  "text-[var(--diff-add-fg)]": line.type === "add",
                  "text-[var(--diff-rm-fg)]": line.type === "remove",
                  "text-[var(--fg)]": line.type === "context",
                })}
              >
                {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                {line.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
