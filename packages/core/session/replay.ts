/**
 * Replay -- build a step-by-step timeline from a session's events.
 *
 * Used by the TUI replay view to let users step through a completed
 * session's history event-by-event.
 */

import type { Event } from "../../types/index.js";
import type { AppContext } from "../app.js";

export interface ReplayStep {
  index: number;
  timestamp: string;
  elapsed: string;       // time since session start (e.g. "00:03:42")
  type: string;          // event type
  stage: string | null;
  actor: string | null;
  summary: string;       // human-readable one-line summary
  detail: string | null; // expanded detail (multi-line)
  data: Record<string, unknown> | null;
}

/** Format milliseconds as HH:MM:SS */
function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Build a human-readable summary for an event */
function summarize(type: string, data: Record<string, unknown> | null): string {
  const d = data ?? {};
  switch (type) {
    case "session_created": {
      const flow = d.flow ?? "default";
      const summary = d.summary ?? d.jira_summary ?? "";
      return summary ? `Created with flow:${flow} - ${String(summary).slice(0, 60)}` : `Created with flow:${flow}`;
    }
    case "stage_ready":
      return `Stage ${d.stage ?? "next"} ready for dispatch`;
    case "stage_started":
      return `Started ${d.stage ?? "stage"} with agent:${d.agent ?? "agent"}`;
    case "stage_completed":
      return `Stage ${d.stage ?? ""} completed`;
    case "agent_progress": {
      const msg = d.message ?? d.summary ?? "";
      return `Progress: ${String(msg).slice(0, 70)}` || "Progress update";
    }
    case "agent_completed": {
      const parts: string[] = ["Completed"];
      if (d.files_changed != null) parts.push(`${d.files_changed} files changed`);
      if (d.commits != null) parts.push(`${d.commits} commits`);
      if (d.summary) parts[0] = `Completed - ${String(d.summary).slice(0, 60)}`;
      else if (parts.length > 1) parts[0] = "Completed -";
      return parts.join(", ").replace("- ,", "-");
    }
    case "agent_error": {
      const err = d.error ?? d.message ?? "unknown";
      return `Error: ${String(err).slice(0, 70)}`;
    }
    case "agent_exited": {
      const output = d.last_output ? String(d.last_output).slice(0, 60) : "no output";
      return `Agent crashed: ${output}`;
    }
    case "hook_status": {
      const status = d.status ?? d.state ?? "unknown";
      const event = d.hook_event ?? d.event ?? "";
      return event ? `Agent ${status} (via ${event})` : `Agent ${status}`;
    }
    case "retry_with_context": {
      const attempt = d.attempt ?? d.retry ?? "?";
      const err = d.error ?? d.reason ?? "";
      return err ? `Retry attempt ${attempt}: ${String(err).slice(0, 60)}` : `Retry attempt ${attempt}`;
    }
    case "checkpoint":
      return "Checkpoint saved";
    case "session_stopped":
      return "Session stopped by user";
    case "session_resumed":
      return `Session resumed (was ${d.from_status ?? "stopped"})`;
    case "session_completed":
      return "Session completed successfully";
    case "session_forked":
      return `Forked from ${d.forked_from ?? "?"}`;
    case "session_cloned":
      return `Cloned from ${d.cloned_from ?? "?"}`;
    case "session_paused":
      return `Paused: ${d.reason ?? "user request"}`;
    case "fork_started":
      return `Forked into ${d.children_count ?? "?"} parallel sessions`;
    case "fork_joined":
      return "All forked sessions joined";
    case "session_handoff":
      return `Handed off to ${d.to_agent ?? "?"}`;
    case "dispatch_progress":
      return String(d.message ?? "Provisioning...");
    case "pr_detected":
      return `PR detected: ${d.pr_url ?? ""}`;
    case "pr_approved":
      return `PR approved by ${(d.reviewers as string[])?.join(", ") ?? "reviewer"}`;
    case "pr_review_feedback":
      return `PR review feedback (${d.state ?? "comment"})`;
    case "pr_status":
      return `PR ${typeof d.state === "string" ? d.state.toLowerCase() : "updated"}`;
    default:
      return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

/** Build expanded detail text for an event */
function buildDetail(type: string, data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === "") continue;
    const str = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    parts.push(`${key}: ${str}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Build a replay timeline from a session's events */
export function buildReplay(app: AppContext, sessionId: string): ReplayStep[] {
  const events = app.events.list(sessionId, { limit: 1000 }) as Event[];
  const session = app.sessions.get(sessionId);
  if (events.length === 0) return [];
  const baseTime = session
    ? new Date(session.created_at).getTime()
    : new Date(events[0].created_at).getTime();

  return events.map((ev, i): ReplayStep => {
    const evTime = new Date(ev.created_at).getTime();
    return {
      index: i,
      timestamp: ev.created_at,
      elapsed: formatElapsed(evTime - baseTime),
      type: ev.type,
      stage: ev.stage,
      actor: ev.actor,
      summary: summarize(ev.type, ev.data),
      detail: buildDetail(ev.type, ev.data),
      data: ev.data,
    };
  });
}
