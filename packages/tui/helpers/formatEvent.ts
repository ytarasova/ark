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
    default:
      // Humanize unknown types: stage_started -> Stage started
      return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}
