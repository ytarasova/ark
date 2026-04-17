/**
 * Terminal recording utilities -- paths + read helpers for tmux pipe-pane recordings.
 *
 * Recordings are stored under ~/.ark/recordings/<sessionId>.log. They are
 * created when a tmux session starts (via pipe-pane) and automatically stop
 * when the tmux session is killed. Completed sessions can replay the output.
 */

import { join } from "path";
import { existsSync, readFileSync, unlinkSync } from "fs";

/** Return the canonical recording file path for a session. */
export function recordingPath(arkDir: string, sessionId: string): string {
  return join(arkDir, "recordings", `${sessionId}.log`);
}

/** Read a session's recording, or null if none exists. */
export function readRecording(arkDir: string, sessionId: string): string | null {
  const p = recordingPath(arkDir, sessionId);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Remove a session's recording file. Non-fatal if missing. */
export function removeRecording(arkDir: string, sessionId: string): void {
  const p = recordingPath(arkDir, sessionId);
  try {
    unlinkSync(p);
  } catch {
    /* already gone or never created */
  }
}
