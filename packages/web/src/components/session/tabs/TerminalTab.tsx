import { StaticTerminal } from "../../StaticTerminal.js";
import { LiveTerminalPanel } from "../LiveTerminalPanel.js";
import { CopyAttachCommandButton } from "../CopyAttachCommandButton.js";

interface TerminalTabProps {
  sessionId: string;
  output: string | null | undefined;
  cols?: number;
  rows?: number;
  isActive: boolean;
  /** Parent hash-router tab key; controls lazy-mount of the live socket. */
  tabActive: boolean;
}

/**
 * Terminal output. Prefers the live bridge (via the server daemon's
 * /terminal/:sessionId WS route) when the session is running; falls back to
 * the static recording for completed sessions. Always renders a CLI attach
 * button below so users can drop into a native shell.
 */
export function TerminalTab({ sessionId, output, cols, rows, isActive, tabActive }: TerminalTabProps) {
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {isActive ? (
        <div className="flex-1 min-h-0" style={{ minHeight: "360px" }}>
          <LiveTerminalPanel
            sessionId={sessionId}
            isActive={tabActive}
            fallback={<span>Live terminal unavailable. Copy the CLI command below to attach.</span>}
          />
        </div>
      ) : output ? (
        <div className="flex-1 min-h-0">
          <StaticTerminal output={output} cols={cols} rows={rows} />
        </div>
      ) : (
        <div className="terminal-tab-empty">No terminal output available</div>
      )}
      <CopyAttachCommandButton sessionId={sessionId} />
    </div>
  );
}
