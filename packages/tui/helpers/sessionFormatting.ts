// ── Session formatting helpers ───────────────────────────────────────────────
// Pure functions for session display formatting. No side effects, no I/O.

import type { Session, SessionConfig } from "../../types/index.js";
import { humanTokens, ago } from "../helpers.js";
import { ICON } from "../constants.js";

/** Accepts a full Session or a partial object (for tests that pass bare `{}`). */
type SessionLike = { config?: Partial<SessionConfig> };

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

/** Format token totals (from usage_records aggregation) into a display string. */
export function formatTokenDisplay(totals: TokenTotals | null): string | null {
  if (!totals || totals.total_tokens === 0) return null;
  return `${humanTokens(totals.total_tokens)} (in:${humanTokens(totals.input_tokens)} out:${humanTokens(totals.output_tokens)} cache:${humanTokens(totals.cache_read_tokens)})`;
}

export interface FileLink {
  path: string;
  url: string | null;
}

/** Build file link data from session config. Returns null if no files changed. */
export function buildFileLinks(session: SessionLike): FileLink[] | null {
  const files = session.config?.filesChanged;
  if (!files?.length) return null;
  const ghBase = session.config?.github_url ?? null;
  return files.map(f => ({
    path: f,
    url: ghBase ? `${ghBase}/blob/main/${f}` : null,
  }));
}

export interface CommitLink {
  sha: string;
  shortSha: string;
  url: string | null;
}

/** Build commit link data from session config. Returns null if no commits. */
export function buildCommitLinks(session: SessionLike): CommitLink[] | null {
  const commits = session.config?.commits;
  if (!commits?.length) return null;
  const ghBase = session.config?.github_url ?? null;
  return commits.map(c => ({
    sha: c,
    shortSha: c.slice(0, 7),
    url: ghBase ? `${ghBase}/commit/${c}` : null,
  }));
}

/** Sanitize text for safe terminal rendering: strip ANSI, control chars, collapse whitespace, truncate. */
export function sanitizeForTerminal(text: string, maxLen = 200): string {
  const clean = text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")              // strip ANSI
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")   // strip control chars
    .replace(/\n+/g, " ")                                  // newlines to spaces
    .replace(/\s{2,}/g, " ")                               // collapse whitespace
    .trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
}

/** Strip ANSI escape codes and control characters, filter blank lines, return last N lines. */
export function stripAnsiAndFilter(output: string, lastN = 12): string[] {
  return output
    .split("\n")
    .map(line => line
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")       // strip ANSI
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")  // strip control chars
    )
    .filter(line => line.trim())
    .slice(-lastN);
}

/** Format elapsed duration from ISO timestamp to now (or between two ISO timestamps). */
export function formatDuration(from: string | null, to?: string | null): string {
  if (!from) return "";
  const start = new Date(from).getTime();
  if (isNaN(start)) return "";
  const end = to ? new Date(to).getTime() : Date.now();
  if (isNaN(end)) return "";
  const s = Math.max(0, Math.floor((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── Stage timeline helpers ──────────────────────────────────────────────────

export interface StageTimelineEntry {
  name: string;
  status: "completed" | "running" | "pending" | "failed";
  agent: string | null;
  startedAt: string | null;
  completedAt: string | null;
  duration: string | null;
}

export interface StageTimelineInput {
  stages: { name: string; agent?: string }[];
  events: { type: string; stage?: string | null; data?: Record<string, unknown> | null; created_at: string }[];
  currentStage: string | null;
  sessionStatus: string;
}

/** Build per-stage timeline entries from flow stages and session events. Pure function. */
export function buildStageTimeline(input: StageTimelineInput): StageTimelineEntry[] {
  const { stages, events, currentStage, sessionStatus } = input;
  if (stages.length === 0) return [];

  // Index events by stage name
  const startEvents = new Map<string, string>(); // stage -> created_at
  const completeEvents = new Map<string, string>(); // stage -> created_at
  const failedStages = new Set<string>();

  for (const ev of events) {
    const stageName = (ev.data?.stage as string) ?? ev.stage ?? null;
    if (!stageName) continue;

    if (ev.type === "stage_started") {
      startEvents.set(stageName, ev.created_at);
    } else if (ev.type === "stage_completed") {
      completeEvents.set(stageName, ev.created_at);
    } else if (ev.type === "agent_error" || ev.type === "agent_exited") {
      // Only mark as failed if it matches the current stage and session is failed
      if (stageName === currentStage && sessionStatus === "failed") {
        failedStages.add(stageName);
      }
    }
  }

  return stages.map((stage) => {
    const started = startEvents.get(stage.name) ?? null;
    const completed = completeEvents.get(stage.name) ?? null;
    const agent = stage.agent ?? null;

    let status: StageTimelineEntry["status"];
    if (completed) {
      status = "completed";
    } else if (failedStages.has(stage.name)) {
      status = "failed";
    } else if (stage.name === currentStage) {
      status = sessionStatus === "failed" ? "failed" : "running";
    } else {
      status = "pending";
    }

    let duration: string | null = null;
    if (started && completed) {
      duration = formatDuration(started, completed);
    } else if (started && status === "running") {
      duration = formatDuration(started);
    }

    return { name: stage.name, status, agent, startedAt: started, completedAt: completed, duration };
  });
}

/** Extract a friendly repository name from a path or URL. Returns null for null input. */
export function formatRepoName(repo: string | null): string | null {
  if (!repo) return null;
  // Already a simple name (no path separators)?
  if (!repo.includes("/") && !repo.includes("\\")) return repo;
  // Git URL: extract name, strip .git suffix
  const urlMatch = repo.match(/\/([^/]+?)(?:\.git)?$/);
  if (urlMatch) return urlMatch[1];
  // Local path: extract basename
  const parts = repo.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || repo;
}

// ── Session list row formatting ─────────────────────────────────────────────

/** Compute responsive column widths based on terminal width. */
export function getColumnWidths(cols: number): { summary: number; id: number; stage: number } {
  if (cols > 140) return { summary: 42, id: 8, stage: 12 };
  if (cols > 100) return { summary: 28, id: 8, stage: 10 };
  return { summary: 20, id: 0, stage: 0 };
}

/** Truncate text with ellipsis or pad to width. If width is 0, returns empty string. */
export function fitText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length > width) return text.slice(0, width - 1) + "\u2026";
  return text.padEnd(width);
}

/** Format a session's short ID (e.g. "s-abc12" -> "abc12"). */
export function shortId(id: string): string {
  return id.replace(/^s-/, "").slice(0, 6);
}

/** Get the best display text for a session in a list row. */
export function sessionLabel(s: Pick<Session, "summary" | "ticket" | "repo">): string {
  return s.summary ?? s.ticket ?? formatRepoName(s.repo) ?? "(no summary)";
}

/** Format a session row as a plain string for ListRow highlight matching. */
export function formatSessionRow(
  s: Session,
  cols: number,
  unreadCount: number,
): string {
  const widths = getColumnWidths(cols);
  const icon = ICON[s.status] ?? "?";
  const summary = fitText(sessionLabel(s), widths.summary);
  const id = widths.id > 0 ? ` ${shortId(s.id).padEnd(widths.id - 1)}` : "";
  const stage = widths.stage > 0 ? ` ${(s.stage ?? "").padEnd(widths.stage)}` : "";
  const age = ` ${ago(s.updated_at ?? s.created_at).padStart(4)}`;
  const badge = unreadCount > 0 ? ` (${unreadCount})` : "";
  return `${icon} ${summary}${id}${stage}${age}${badge}`;
}

/** Format a child (fork) session row as a plain string. */
export function formatChildRow(child: Session): string {
  const icon = ICON[child.status] ?? "?";
  const label = (child.summary ?? "(fork)").slice(0, 24);
  const age = ago(child.updated_at ?? child.created_at).padStart(4);
  return `${icon} ${label}  ${age}`;
}
