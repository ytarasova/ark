import { useEffect, useState } from "react";
import { StaticTerminal } from "../../StaticTerminal.js";
import { LiveTerminalPanel } from "../LiveTerminalPanel.js";
import { CopyAttachCommandButton } from "../CopyAttachCommandButton.js";
import { useApi } from "../../../hooks/useApi.js";
import type { SessionAttachCommandResponse } from "../../../../../protocol/index.js";

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
 * Terminal output. The render branch is driven by the server's AttachPlan,
 * not by re-deriving "is this an interactive runtime?" client-side. The
 * server is the single source of truth for runtime semantics; this
 * component just renders one of three plans.
 *
 *   - "interactive": live PTY available -> xterm + CLI attach card.
 *   - "tail":        non-interactive runtime (claude-agent) -> empty
 *                    state pointing to Conversation / Logs tabs.
 *   - "none":        terminal status / not yet dispatched ->
 *                    static replay (if available) or empty state.
 *
 * While the plan is loading, fall back to the recording (if any) or a
 * loading hint -- avoids flashing the wrong empty state on first render.
 */
export function TerminalTab({ sessionId, output, cols, rows, isActive, tabActive }: TerminalTabProps) {
  const api = useApi();
  const [plan, setPlan] = useState<SessionAttachCommandResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAttachCommand(sessionId)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {
        // Plan unavailable -- keep `plan` null and let the loading
        // fallback render. The CopyAttachCommandButton (for interactive
        // sessions) handles its own error state below.
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  // Plan still resolving: show recording if we have one, otherwise nothing.
  // Avoids flashing "No terminal output" before the plan arrives.
  if (!plan) {
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
        <div className="terminal-tab-empty">Loading...</div>
      </div>
    );
  }

  if (plan.mode === "tail") {
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
        <div className="terminal-tab-empty">{plan.reason}</div>
      </div>
    );
  }

  if (plan.mode === "none") {
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
        <div className="terminal-tab-empty">{plan.reason}</div>
      </div>
    );
  }

  // plan.mode === "interactive": isActive guards us from showing the WS
  // panel for sessions whose row says "running" but whose pane is gone
  // (the Conversation tab's source-of-truth).
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
