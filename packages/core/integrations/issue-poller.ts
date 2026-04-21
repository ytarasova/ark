/**
 * GitHub Issues polling -- auto-creates sessions from labeled issues.
 *
 * Polls `gh issue list` for issues with a specific label.
 * For each new issue (not already linked to a session), creates a session
 * and optionally auto-dispatches it.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";

import { safeAsync } from "../safe.js";

const execFileAsync = promisify(execFile);

type GhExecFn = (args: string[]) => Promise<{ stdout: string }>;

const defaultGhExec: GhExecFn = async (args) => {
  return execFileAsync("gh", args, { encoding: "utf-8", timeout: 15_000 });
};

// Replaceable via setGhExec() for testing
let _ghExec: GhExecFn = defaultGhExec;

/** Replace the gh exec function (for testing). */
export function setGhExec(fn: GhExecFn): void {
  _ghExec = fn;
}

export interface IssuePollerOptions {
  /** Label to watch for (default: "ark") */
  label?: string;
  /** Poll interval in ms (default: 60000) */
  intervalMs?: number;
  /** Auto-dispatch created sessions */
  autoDispatch?: boolean;
  /** Override gh exec (for testing) */
  ghExec?: GhExecFn;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string }>;
}

/**
 * Fetch open issues with a specific label via gh CLI.
 * Returns null if the CLI call fails.
 */
export async function fetchLabeledIssues(label: string, ghExec: GhExecFn = _ghExec): Promise<GhIssue[] | null> {
  try {
    const { stdout } = await ghExec([
      "issue",
      "list",
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,title,body,url,labels",
    ]);
    return JSON.parse(stdout) as GhIssue[];
  } catch {
    return null;
  }
}

/**
 * Check if a session already exists for a given issue ticket.
 * Ticket format is "#<number>" (e.g. "#42").
 */
export async function issueAlreadyTracked(app: AppContext, ticket: string): Promise<boolean> {
  const sessions = await app.sessions.list({ limit: 500 });
  return sessions.some((s) => s.ticket === ticket);
}

/**
 * Create a session from a GitHub issue.
 * Returns the created session, or null if skipped (duplicate).
 */
export async function createSessionFromIssue(
  app: AppContext,
  issue: GhIssue,
  opts?: { autoDispatch?: boolean },
): Promise<Session | null> {
  const ticket = `#${issue.number}`;

  if (await issueAlreadyTracked(app, ticket)) return null;

  // Lazy import to avoid circular deps (same pattern as pr-poller.ts)
  const { startSession, dispatch } = await import("../services/session-orchestration.js");

  const session = await startSession(app, {
    ticket,
    summary: issue.title,
    config: {
      issue_url: issue.url,
      issue_body: issue.body,
      issue_labels: issue.labels.map((l) => l.name),
    },
  });

  await app.events.log(session.id, "issue_imported", {
    actor: "github",
    data: {
      issue_number: issue.number,
      issue_url: issue.url,
      title: issue.title,
    },
  });

  if (opts?.autoDispatch) {
    await safeAsync(`issue-poller: dispatch ${session.id}`, async () => {
      await dispatch(app, session.id);
    });
  }

  return session as Session;
}

/**
 * Main poller tick. Fetches labeled issues and creates sessions for new ones.
 */
export async function pollIssues(app: AppContext, opts?: IssuePollerOptions): Promise<void> {
  const label = opts?.label ?? "ark";
  const ghExec = opts?.ghExec ?? _ghExec;

  const issues = await fetchLabeledIssues(label, ghExec);
  if (!issues) return;

  for (const issue of issues) {
    await safeAsync(`issue-poller: process issue #${issue.number}`, async () => {
      await createSessionFromIssue(app, issue, { autoDispatch: opts?.autoDispatch });
    });
  }
}

/**
 * Start a recurring issue poller. Returns a handle to stop it.
 */
export function startIssuePoller(app: AppContext, opts?: IssuePollerOptions): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? 60_000;

  // fire-and-forget: initial poll runs in background
  safeAsync("issue-poller: initial poll", () => pollIssues(app, opts));

  const timer = setInterval(() => safeAsync("issue-poller: poll tick", () => pollIssues(app, opts)), intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
