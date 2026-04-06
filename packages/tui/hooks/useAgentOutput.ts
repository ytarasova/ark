import { useState, useEffect } from "react";
import { useArkClient } from "./useArkClient.js";

/**
 * Poll agent output for a running session via the provider-aware getOutput().
 * Returns the latest captured output, refreshed every pollMs.
 */
export function useAgentOutput(sessionId: string | null, tmuxName: string | null, isRunning: boolean, pollMs = 2000): string {
  const ark = useArkClient();
  const [output, setOutput] = useState("");

  useEffect(() => {
    if (!sessionId || !tmuxName || !isRunning) {
      setOutput("");
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const text = await ark.sessionOutput(sessionId, 15);
        if (!cancelled) setOutput(text.trim());
      } catch {
        // session may be gone
      }
    };

    poll();
    const t = setInterval(poll, pollMs);
    return () => { cancelled = true; clearInterval(t); };
  }, [ark, sessionId, tmuxName, isRunning, pollMs]);

  return output;
}
