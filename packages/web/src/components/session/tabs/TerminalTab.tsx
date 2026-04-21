import { StaticTerminal } from "../../StaticTerminal.js";

interface TerminalTabProps {
  output: string | null | undefined;
  cols?: number;
  rows?: number;
  isActive: boolean;
}

/**
 * Terminal output (live PTY recording). Renders `StaticTerminal` with the
 * provided output, or an empty state when nothing has been captured yet.
 */
export function TerminalTab({ output, cols, rows, isActive }: TerminalTabProps) {
  return (
    <div className="flex-1 min-h-0">
      {output ? (
        <StaticTerminal output={output} cols={cols} rows={rows} />
      ) : (
        <div className="text-center py-12 text-[var(--fg-faint)] font-[family-name:var(--font-mono)] text-[12px]">
          No terminal output available{isActive ? " yet" : ""}
        </div>
      )}
    </div>
  );
}
