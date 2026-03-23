import { useState, useEffect } from "react";
import * as core from "../../core/index.js";

/**
 * Poll tmux pane output for a running session.
 * Returns the latest captured output, refreshed every pollMs.
 */
export function useAgentOutput(sessionId: string | null, tmuxName: string | null, isRunning: boolean, pollMs = 2000): string {
  const [output, setOutput] = useState("");

  useEffect(() => {
    if (!sessionId || !tmuxName || !isRunning) {
      setOutput("");
      return;
    }

    const poll = async () => {
      try {
        const { capturePaneAsync } = await import("../../core/tmux.js");
        const text = await capturePaneAsync(tmuxName, { lines: 15 });
        setOutput(text.trim());
      } catch {
        // tmux session may be gone
      }
    };

    poll();
    const t = setInterval(poll, pollMs);
    return () => clearInterval(t);
  }, [sessionId, tmuxName, isRunning, pollMs]);

  return output;
}
