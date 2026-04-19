/**
 * Pure helper functions for the CLI, extracted for testability.
 */

/** Sanitize a session summary: alphanumeric, dash, underscore only, max 60 chars. */
export function sanitizeSummary(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || raw
  );
}

/** Split an editor command string safely for execFileSync. */
export function splitEditorCommand(editor: string): { command: string; args: string[] } {
  const parts = editor.split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

/** Format a byte count into a short human-readable string (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const formatted = i === 0 ? `${n}` : n.toFixed(n >= 10 || i === 0 ? 0 : 1);
  return `${formatted} ${units[i]}`;
}

/** Format a session event for CLI display. */
export function formatEvent(type: string, data?: Record<string, unknown>): string {
  switch (type) {
    case "session_created":
      return `Session created: ${data?.summary ?? data?.jira_summary ?? "new task"}`;
    case "stage_ready":
      return `Ready to run: ${data?.stage ?? "next stage"}`;
    case "stage_started":
      return `Agent started: ${data?.agent ?? "agent"} on ${data?.stage ?? "task"}`;
    case "stage_completed":
      return `Stage completed: ${data?.stage ?? ""}`;
    case "agent_completed":
      return `Agent completed: ${data?.summary ? String(data.summary).slice(0, 80) : "task done"}`;
    case "agent_error":
      return `Agent error: ${data?.error ? String(data.error).slice(0, 80) : "unknown"}`;
    case "agent_exited": {
      const output = data?.last_output ? String(data.last_output).slice(0, 60) : "no output";
      return `Agent crashed: ${output}`;
    }
    case "session_stopped":
      return "Session stopped by user";
    case "session_resumed":
      return `Session retried (was ${data?.from_status ?? "failed"})`;
    case "session_completed":
      return "Session completed successfully";
    case "session_forked":
      return `Session forked from ${data?.forked_from ?? "?"}`;
    case "session_cloned":
      return `Session cloned from ${data?.cloned_from ?? "?"}`;
    case "session_paused":
      return `Session paused: ${data?.reason ?? "user request"}`;
    case "fork_started":
      return `Forked into ${data?.children_count ?? "?"} parallel sessions`;
    case "fork_joined":
      return "All forked sessions joined";
    case "session_handoff":
      return `Handed off to ${data?.to_agent ?? "?"}`;
    case "dispatch_progress":
      return String(data?.message ?? "Provisioning...");
    case "pr_approved":
      return `PR approved by ${(data?.reviewers as string[])?.join(", ") ?? "reviewer"}`;
    case "pr_review_feedback":
      return `PR review feedback (${data?.state ?? "comment"})`;
    case "pr_status":
      return `PR ${typeof data?.state === "string" ? data.state.toLowerCase() : "updated"}`;
    case "pr_detected":
      return `PR detected: ${data?.pr_url ?? ""}`;
    default:
      return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}
