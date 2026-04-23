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
 * DiffViewer -- terminal-panel style per /tmp/ark-design-system/preview/code-diff.html
 *
 * Frame:
 *   - radius 9, raised shell (light top border + dark bottom), subtle gradient
 *   - chrome header: red/yellow/green traffic lights + mono-ui `tab` chip +
 *     meta strip (+N -N)
 *   - sunken code well inside (dark bg-code with inner shadow)
 *   - diff lines get a 2px left indicator via inset box-shadow + 90deg gradient
 */
export function DiffViewer({ files, activeFile, onFileSelect, className, ...props }: DiffViewerProps) {
  const selected = activeFile ?? files[0]?.filename;
  const file = files.find((f) => f.filename === selected);

  return (
    <div className={cn("flex flex-col gap-[10px]", className)} {...props}>
      {files.length > 1 && (
        <div className="flex gap-[4px] overflow-x-auto">
          {files.map((f) => {
            const on = f.filename === selected;
            return (
              <button
                key={f.filename}
                type="button"
                onClick={() => onFileSelect?.(f.filename)}
                className={cn(
                  "inline-flex items-center gap-[6px] px-[9px] h-[26px] rounded-[5px] shrink-0",
                  "font-[family-name:var(--font-mono-ui)] text-[10.5px] font-medium tracking-[0.02em] cursor-pointer",
                  "border border-[var(--border)] transition-colors",
                  on
                    ? "text-[var(--fg)] bg-[linear-gradient(180deg,#1f1f35,#181829)] border-t-[rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.3)]"
                    : "text-[var(--fg-muted)] bg-transparent hover:text-[var(--fg)]",
                )}
              >
                <span className="truncate max-w-[220px]">{f.filename}</span>
                <span className="shrink-0">
                  <span className="text-[#34d399]">+{f.additions}</span>{" "}
                  <span className="text-[#f87171]">-{f.deletions}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {file && <DiffFrame file={file} />}
    </div>
  );
}

function DiffFrame({ file }: { file: DiffFile }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[9px] border border-[var(--border)]",
        "bg-[linear-gradient(180deg,rgba(255,255,255,0.04)_0%,rgba(255,255,255,0)_20%,rgba(0,0,0,0.15)_100%),var(--bg-card)]",
        "border-t-[rgba(255,255,255,0.08)] border-b-[rgba(0,0,0,0.5)]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.45),0_1px_2px_rgba(0,0,0,0.45),0_10px_22px_-6px_rgba(0,0,0,0.4)]",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-[8px] px-[12px] py-[8px] border-b border-[var(--border)]",
          "bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(0,0,0,0.1))]",
          "font-[family-name:var(--font-mono-ui)] text-[10.5px] font-medium text-[var(--fg-muted)]",
        )}
      >
        <TrafficDot color="#f87171" />
        <TrafficDot color="#fbbf24" />
        <TrafficDot color="#34d399" />
        <span
          className={cn(
            "inline-flex items-center gap-[5px] px-[7px] py-[3px] rounded-[4px]",
            "text-[var(--fg)]",
            "bg-[linear-gradient(180deg,#1f1f35,#181829)]",
            "border border-[var(--border)] border-t-[rgba(255,255,255,0.08)]",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.3)]",
          )}
        >
          diff · {file.filename}
        </span>
        <span className="ml-auto text-[9.5px] tracking-[0.05em] uppercase text-[var(--fg-faint)]">
          <b className="font-medium text-[#34d399]">+{file.additions}</b>{" "}
          <b className="font-medium text-[#f87171]">-{file.deletions}</b>
        </span>
      </div>

      <pre
        className={cn(
          "m-0 px-[12px] py-[10px] whitespace-pre overflow-x-auto",
          "font-[family-name:var(--font-mono)] text-[11px] leading-[18px] text-[var(--fg)]",
          "bg-[linear-gradient(180deg,rgba(0,0,0,0.2)_0%,rgba(0,0,0,0)_6%),var(--bg-code)]",
          "shadow-[inset_0_2px_4px_rgba(0,0,0,0.35)]",
        )}
      >
        {file.lines.map((line, i) => (
          <DiffRow key={i} line={line} />
        ))}
      </pre>
    </div>
  );
}

function TrafficDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="w-[6px] h-[6px] rounded-full shrink-0"
      style={{ backgroundColor: color, boxShadow: `0 0 3px ${color}99` }}
    />
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const isAdd = line.type === "add";
  const isRm = line.type === "remove";
  const marker = isAdd ? "+" : isRm ? "-" : " ";
  return (
    <span
      className={cn(
        "block pl-[6px] relative",
        isAdd &&
          "bg-[linear-gradient(90deg,rgba(52,211,153,0.15)_0%,rgba(52,211,153,0.03)_100%)] text-[#34d399] shadow-[inset_2px_0_0_#34d399]",
        isRm &&
          "bg-[linear-gradient(90deg,rgba(248,113,113,0.15)_0%,rgba(248,113,113,0.03)_100%)] text-[#f87171] shadow-[inset_2px_0_0_#f87171]",
      )}
    >
      <span className="inline-block w-[42px] text-right pr-[10px] text-[var(--fg-faint)] select-none">
        {line.lineNumber ?? ""}
      </span>
      <span className="inline-block w-[14px] text-center text-[var(--fg-faint)] select-none">{marker}</span>
      <span className="whitespace-pre">{highlight(line.content)}</span>
    </span>
  );
}

/**
 * Tiny heuristic syntax highlighter. Not a full parser -- just colors common
 * tokens (keywords, strings, numbers, line comments) so diffs read better.
 */
function highlight(src: string): React.ReactNode {
  if (!src) return "";
  const parts: React.ReactNode[] = [];
  const pattern =
    /(\/\/[^\n]*|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|\b(import|export|async|await|function|const|let|var|if|else|return|for|while|class|new|throw|try|catch|finally|typeof|instanceof|in|of|this|null|undefined|true|false|default|from|as)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src))) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    if (m[1])
      parts.push(
        <span key={parts.length} className="text-[var(--fg-muted)]">
          {m[1]}
        </span>,
      );
    else if (m[2])
      parts.push(
        <span key={parts.length} className="text-[#86dbe4]">
          {m[2]}
        </span>,
      );
    else if (m[3])
      parts.push(
        <span key={parts.length} className="text-[#fbbf24]">
          {m[3]}
        </span>,
      );
    else if (m[4])
      parts.push(
        <span key={parts.length} className="text-[var(--primary)]">
          {m[4]}
        </span>,
      );
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return <>{parts}</>;
}
