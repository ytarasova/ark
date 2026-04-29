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
 * Terminal output. Three render branches, picked by session state:
 *   - Live: WS-backed xterm via /terminal/:sessionId, plus a CLI-attach
 *     command card so the user can drop into a native shell.
 *   - Completed/failed (with a recording): full-height static replay only.
 *     The CLI-attach card is hidden -- there's no pane to attach to, and
 *     telling the user otherwise next to a visible replay is confusing.
 *   - No live pane and no recording: empty-state copy.
 */
export function TerminalTab({ sessionId, output, cols, rows, isActive, tabActive }: TerminalTabProps) {
  if (isActive) {
    return (
      <div className="terminal-tab">
        <div className="terminal-tab-body">
          <LiveTerminalPanel
            sessionId={sessionId}
            isActive={tabActive}
            fallback={<span>Live terminal unavailable. Copy the CLI command below to attach.</span>}
          />
        </div>
        <CopyAttachCommandButton sessionId={sessionId} />
      </div>
    );
  }
  if (output) {
    return (
      <div className="terminal-tab">
        <div className="terminal-tab-body">
          <StaticTerminal output={output} cols={cols} rows={rows} />
        </div>
      </div>
    );
  }
  return (
    <div className="terminal-tab">
      <div className="terminal-tab-empty">No terminal output available</div>
    </div>
  );
}
