/**
 * Agent-initiated handoff — agents signal which agent should run next.
 * Detected from agent output patterns like "HANDOFF: reviewer" or structured JSON.
 */

export interface HandoffSignal {
  targetAgent: string;
  reason: string;
  context?: Record<string, unknown>;
}

/** Detect handoff signals in agent output. */
export function detectHandoff(output: string): HandoffSignal | null {
  // Pattern 1: HANDOFF: <agent> — <reason>
  const handoffMatch = output.match(/HANDOFF:\s*(\w+)\s*(?:\u2014|-)\s*(.+?)(?:\n|$)/i);
  if (handoffMatch) {
    return { targetAgent: handoffMatch[1], reason: handoffMatch[2].trim() };
  }

  // Pattern 2: JSON block with handoff — capture everything between ```json and ```
  const jsonBlockMatch = output.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch && jsonBlockMatch[1].includes('"handoff"')) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.handoff) {
        return {
          targetAgent: parsed.handoff,
          reason: parsed.reason ?? "Agent-initiated handoff",
          context: parsed.context,
        };
      }
    } catch { /* fall through */ }
    // Fallback: extract handoff value with simple regex
    const fallback = jsonBlockMatch[1].match(/"handoff"\s*:\s*"(\w+)"/);
    if (fallback) {
      return { targetAgent: fallback[1], reason: "Agent-initiated handoff" };
    }
  }

  // Pattern 3: "Hand off to <agent>"
  const naturalMatch = output.match(/hand\s*off\s+to\s+(\w+)/i);
  if (naturalMatch) {
    return { targetAgent: naturalMatch[1], reason: "Agent-initiated handoff" };
  }

  return null;
}

/** Check if an agent's output contains a handoff signal. */
export function hasHandoff(output: string): boolean {
  return detectHandoff(output) !== null;
}
