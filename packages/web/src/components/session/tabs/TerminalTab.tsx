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
  /**
   * Executor that spawned this session's agent. Used to skip the live-
   * terminal WS path for runtimes that don't have an interactive PTY
   * (claude-agent runs as a plain process via arkd /process/spawn, so
   * there is no tmux pane to attach to and the WS just reconnect-loops).
   */
  launchExecutor?: string;
}

/**
 * Terminal output. Render branches by session state + runtime:
 *   - Process-only runtimes (claude-agent / agent-sdk): there is no
 *     interactive PTY. Show explanatory empty state with a pointer to
 *     Conversation / Logs tabs. Suppresses the "Reconnecting..." loop
 *     that fires when LiveTerminalPanel tries to attach to a missing
 *     pane.
 *   - Live PTY runtime + active session: WS-backed xterm via
 *     /terminal/:sessionId, plus an `ark session attach` hint for users
 *     who want a native shell.
 *   - Completed/failed with a recording: full-height static replay.
 *     The CLI-attach card is hidden -- there's no pane to attach to.
 *   - No live pane and no recording: empty-state copy.
 */
const PROCESS_ONLY_RUNTIMES = new Set(["claude-agent", "agent-sdk"]);

export function TerminalTab({ sessionId, output, cols, rows, isActive, tabActive, launchExecutor }: TerminalTabProps) {
  const isProcessOnly = launchExecutor !== undefined && PROCESS_ONLY_RUNTIMES.has(launchExecutor);

  if (isProcessOnly) {
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
        <div className="terminal-tab-empty">
          This agent runs as a plain process and has no interactive terminal.
          <br />
          Live output is in the Conversation and Logs tabs.
        </div>
      </div>
    );
  }

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
