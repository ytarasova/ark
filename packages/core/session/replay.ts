/**
 * Replay -- build a step-by-step timeline from a session's events.
 *
 * Used by the replay view to let users step through a completed
 * session's history event-by-event.
 */

import type { Event } from "../../types/index.js";
import type { AppContext } from "../app.js";

export interface ReplayStep {
  index: number;
  timestamp: string;
  elapsed: string; // time since session start (e.g. "00:03:42")
  type: string; // event type
  stage: string | null;
  actor: string | null;
  summary: string; // human-readable one-line summary
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

/**
 * Per-event-type summariser. Adding a new event only requires a new key here
 * -- no switch to edit, no default arm to forget. Unknown types fall through
 * to `defaultSummary` which title-cases the type name.
 */
type Summariser = (d: Record<string, unknown>) => string;

function defaultSummary(type: string): string {
  return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const SUMMARISERS: Record<string, Summariser> = {
  session_created: (d) => {
    const flow = d.flow ?? "default";
    const summary = d.summary ?? d.jira_summary ?? "";
    return summary ? `Created with flow:${flow} - ${String(summary).slice(0, 60)}` : `Created with flow:${flow}`;
  },
  stage_ready: (d) => `Stage ${d.stage ?? "next"} ready for dispatch`,
  stage_started: (d) => `Started ${d.stage ?? "stage"} with agent:${d.agent ?? "agent"}`,
  stage_completed: (d) => `Stage ${d.stage ?? ""} completed`,
  agent_progress: (d) => {
    const msg = d.message ?? d.summary ?? "";
    return `Progress: ${String(msg).slice(0, 70)}` || "Progress update";
  },
  agent_completed: (d) => {
    const parts: string[] = ["Completed"];
    if (d.files_changed != null) parts.push(`${d.files_changed} files changed`);
    if (d.commits != null) parts.push(`${d.commits} commits`);
    if (d.summary) parts[0] = `Completed - ${String(d.summary).slice(0, 60)}`;
    else if (parts.length > 1) parts[0] = "Completed -";
    return parts.join(", ").replace("- ,", "-");
  },
  agent_error: (d) => `Error: ${String(d.error ?? d.message ?? "unknown").slice(0, 70)}`,
  agent_exited: (d) => {
    const output = d.last_output ? String(d.last_output).slice(0, 60) : "no output";
    return `Agent crashed: ${output}`;
  },
  hook_status: (d) => {
    const status = d.status ?? d.state ?? "unknown";
    const event = d.hook_event ?? d.event ?? "";
    return event ? `Agent ${status} (via ${event})` : `Agent ${status}`;
  },
  retry_with_context: (d) => {
    const attempt = d.attempt ?? d.retry ?? "?";
    const err = d.error ?? d.reason ?? "";
    return err ? `Retry attempt ${attempt}: ${String(err).slice(0, 60)}` : `Retry attempt ${attempt}`;
  },
  checkpoint: () => "Checkpoint saved",
  session_stopped: () => "Session stopped by user",
  session_resumed: (d) => `Session resumed (was ${d.from_status ?? "stopped"})`,
  session_completed: () => "Session completed successfully",
  session_forked: (d) => `Forked from ${d.forked_from ?? "?"}`,
  session_cloned: (d) => `Cloned from ${d.cloned_from ?? "?"}`,
  session_paused: (d) => `Paused: ${d.reason ?? "user request"}`,
  fork_started: (d) => `Forked into ${d.children_count ?? "?"} parallel sessions`,
  fork_joined: () => "All forked sessions joined",
  session_handoff: (d) => `Handed off to ${d.to_agent ?? "?"}`,
  dispatch_progress: (d) => String(d.message ?? "Provisioning..."),
  pr_detected: (d) => `PR detected: ${d.pr_url ?? ""}`,
  pr_approved: (d) => `PR approved by ${(d.reviewers as string[])?.join(", ") ?? "reviewer"}`,
  pr_review_feedback: (d) => `PR review feedback (${d.state ?? "comment"})`,
  pr_status: (d) => `PR ${typeof d.state === "string" ? d.state.toLowerCase() : "updated"}`,
};

/** Build a human-readable summary for an event. */
function summarize(type: string, data: Record<string, unknown> | null): string {
  const summariser = SUMMARISERS[type];
  return summariser ? summariser(data ?? {}) : defaultSummary(type);
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
  const baseTime = session ? new Date(session.created_at).getTime() : new Date(events[0].created_at).getTime();

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
