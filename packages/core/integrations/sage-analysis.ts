/**
 * Pi-sage analysis fetcher.
 *
 * Pi-sage (`bitbucket.org/paytmteam/pi-sage`) is Paytm's internal Jira + KB
 * intelligence layer. It exposes an HTTP API at
 * `${baseUrl}/api/analysis/{jiraId}` that returns a JSON document describing
 * the deep KB analysis for a ticket -- a per-repo plan, a list of TDD tasks
 * per repo, the gaps it identified, etc.
 *
 * This module is the runtime-neutral consumer of that JSON. The
 * `from-sage-analysis` flow uses it in Stage 1 to materialise the analysis
 * JSON onto disk so subsequent stages (and child sessions in fan-out) can
 * read it via `{inputs.files.analysis_json}`.
 *
 * `baseUrl` accepts both `http(s)://...` (live pi-sage) and `file:///...`
 * (offline fixture). The latter is what tests + the example sample exercise.
 *
 * Auth: when the env var `SAGE_BEARER_TOKEN` is set, it is forwarded as
 * `Authorization: Bearer <token>` on HTTP requests. file:// reads ignore the
 * token entirely -- no auth there to perform.
 */

import { readFile } from "fs/promises";
import { fileURLToPath } from "url";

// ── Public types: mirror pi-sage's api_analysis.py output shape ─────────────

/** A single TDD task within a plan stream. Mirrors pi-sage's task record. */
export interface SageTask {
  /** Short title (the agent uses this as the subtask summary). */
  title: string;
  /** Files the task is expected to touch / create. */
  files?: string[];
  /** Free-form description of the change to make. */
  description?: string;
  /**
   * Validation strategy -- usually a short note ("run unit tests for X") or
   * a shell snippet pi-sage suggests for the agent to verify success.
   */
  validation?: string;
}

/**
 * One plan stream in the analysis -- corresponds to a single affected repo.
 * Pi-sage emits one stream per repo so fan-out can dispatch one Ark child
 * session per stream.
 */
export interface SagePlanStream {
  repo: string;
  /** Optional branch the analysis targeted (`main` if unset). */
  branch?: string;
  tasks: SageTask[];
}

/**
 * One affected-repo entry in pi-sage's `affected_repos` array. We only keep
 * the fields we render into prompts; the upstream record carries other
 * housekeeping fields we ignore.
 */
export interface SageAffectedRepo {
  name: string;
  branch?: string;
  reason?: string;
}

/**
 * The minimal subset of pi-sage's analysis response that this flow consumes.
 * Pi-sage returns a much richer envelope (gaps split by audience, repo
 * snapshots, KB searches, audit log, ...); we deliberately only declare what
 * the Ark dispatcher needs to know about. Extra fields on the wire are
 * preserved on `raw` so downstream consumers can still reach them.
 */
export interface SageAnalysis {
  /** Jira ticket key the analysis describes (e.g. "IN-12345"). */
  jira_id: string;
  /** Pi-sage's natural-language summary of the change set. */
  summary?: string;
  /** All repos the analysis flagged as affected. */
  affected_repos?: SageAffectedRepo[];
  /** Outstanding gaps pi-sage believes need answers before implementation. */
  gaps?: Array<{ id?: string; question: string; audience?: "product" | "tech"; status?: string }>;
  /** Per-repo plan streams (one entry per repo, each with an ordered task list). */
  plan_streams: SagePlanStream[];
  /** The full upstream JSON, kept verbatim for debugging / forward-compat. */
  raw?: Record<string, unknown>;
}

// ── Fetcher ────────────────────────────────────────────────────────────────

/**
 * Resolve a `file://` URL into a local filesystem path. Falls back to a raw
 * absolute path when the input doesn't look like a URL at all -- this matches
 * how callers pass either `file:///abs/path.json` or `/abs/path.json`.
 */
function resolveFilePath(baseUrl: string, analysisId: string): string {
  if (baseUrl.startsWith("file://")) {
    const rootPath = fileURLToPath(baseUrl);
    // If the file:// URL already points at a JSON file, use it directly.
    // Otherwise treat it as a directory containing `<analysisId>.json`.
    if (rootPath.endsWith(".json")) return rootPath;
    return `${rootPath.replace(/\/$/, "")}/${analysisId}.json`;
  }
  if (baseUrl.endsWith(".json")) return baseUrl;
  return `${baseUrl.replace(/\/$/, "")}/${analysisId}.json`;
}

/**
 * Coerce an unknown JSON shape into a typed `SageAnalysis`. Pi-sage wraps the
 * actual analysis under `analysis` + `raw` keys (see api_analysis.py's
 * `_build_analysis_response`); we accept both the wrapped shape and a raw
 * inline analysis so fixtures stay readable.
 */
function coerceAnalysis(jiraId: string, payload: any): SageAnalysis {
  // Pi-sage HTTP shape: `{ analysis: {...}, raw: {...}, ... }`.
  // raw carries the structured plan, the wrapper carries the row metadata.
  const raw = payload?.raw ?? payload;
  const meta = payload?.analysis ?? {};

  const planStreams = Array.isArray(raw?.plan_streams) ? raw.plan_streams : [];

  return {
    jira_id: meta.jira_id ?? raw?.jira_id ?? jiraId,
    summary: raw?.summary ?? meta.summary ?? undefined,
    affected_repos: Array.isArray(raw?.affected_repos) ? raw.affected_repos : undefined,
    gaps: Array.isArray(raw?.gaps) ? raw.gaps : undefined,
    plan_streams: planStreams,
    raw: typeof raw === "object" && raw !== null ? raw : undefined,
  };
}

/**
 * Fetch a pi-sage analysis by id. Supports HTTP(S) (live pi-sage) and
 * `file://` (offline fixtures + the bundled example).
 *
 * Throws on transport / parse / not-found errors so callers can surface a
 * clean message; never returns `null`.
 */
export async function fetchAnalysis(baseUrl: string, analysisId: string): Promise<SageAnalysis> {
  if (!analysisId) throw new Error("fetchAnalysis: analysisId is required");
  if (!baseUrl) throw new Error("fetchAnalysis: baseUrl is required");

  // file:// path or raw filesystem path -- read the JSON directly.
  if (baseUrl.startsWith("file://") || baseUrl.startsWith("/") || baseUrl.endsWith(".json")) {
    const path = resolveFilePath(baseUrl, analysisId);
    let body: string;
    try {
      body = await readFile(path, "utf-8");
    } catch (e: any) {
      throw new Error(`fetchAnalysis: failed to read ${path}: ${e?.message ?? e}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e: any) {
      throw new Error(`fetchAnalysis: invalid JSON in ${path}: ${e?.message ?? e}`);
    }
    return coerceAnalysis(analysisId, parsed);
  }

  // HTTP fetch against the live pi-sage API.
  const url = `${baseUrl.replace(/\/$/, "")}/api/analysis/${encodeURIComponent(analysisId)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = process.env.SAGE_BEARER_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e: any) {
    throw new Error(`fetchAnalysis: HTTP request to ${url} failed: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fetchAnalysis: ${res.status} from ${url}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e: any) {
    throw new Error(`fetchAnalysis: invalid JSON from ${url}: ${e?.message ?? e}`);
  }
  return coerceAnalysis(analysisId, payload);
}

// ── Subtask materialisation (used by the fan-out dispatcher) ────────────────

export interface SageStreamSubtask {
  /** Stable name -- `<repo>-stream` or similar. */
  name: string;
  /**
   * Fully-formed prompt body for the child session. Includes the analysis
   * summary, the stream's repo context, and an ordered task list with
   * description + files + validation per task. Runtime-neutral by design.
   */
  task: string;
  /** Original repo / branch the stream targets, for downstream metadata. */
  repo: string;
  branch?: string;
}

/** Render a per-task block in the order pi-sage emitted them. */
function renderTask(idx: number, task: SageTask): string {
  const lines: string[] = [`### Task ${idx + 1}: ${task.title || "(untitled)"}`];
  if (task.description) lines.push(task.description.trim());
  if (task.files?.length) {
    lines.push("");
    lines.push("**Files:**");
    for (const f of task.files) lines.push(`- \`${f}\``);
  }
  if (task.validation) {
    lines.push("");
    lines.push("**Validation:**");
    lines.push(task.validation.trim());
  }
  return lines.join("\n");
}

/** Build one subtask prompt per plan stream. */
export function buildStreamSubtasks(analysis: SageAnalysis): SageStreamSubtask[] {
  return analysis.plan_streams.map((stream, idx) => {
    const header: string[] = [];
    header.push(`# ${analysis.jira_id} -- repo: ${stream.repo}`);
    if (analysis.summary) {
      header.push("");
      header.push("## Ticket summary");
      header.push(analysis.summary.trim());
    }
    if (analysis.gaps?.length) {
      header.push("");
      header.push("## Resolved gaps");
      for (const gap of analysis.gaps) {
        const status = gap.status ? ` [${gap.status}]` : "";
        header.push(`- ${gap.question}${status}`);
      }
    }
    header.push("");
    header.push(`## TDD task list (${stream.tasks.length} task${stream.tasks.length === 1 ? "" : "s"})`);
    header.push("Work each task in order. After each task: run validation, commit, move on.");
    header.push("");
    const taskBlocks = stream.tasks.map((t, i) => renderTask(i, t));
    return {
      name: `stream-${idx + 1}-${stream.repo.replace(/[^a-zA-Z0-9-]/g, "-")}`.slice(0, 60),
      task: [...header, ...taskBlocks].join("\n"),
      repo: stream.repo,
      branch: stream.branch,
    };
  });
}
