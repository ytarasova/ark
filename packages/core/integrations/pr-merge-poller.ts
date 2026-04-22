/**
 * PR merge poller -- monitors sessions waiting for CI after `gh pr merge --auto`.
 *
 * When the `auto_merge` action fires, it queues the PR for merge via `--auto`
 * and transitions the session to `waiting`. This poller checks `gh pr view`
 * to detect when the PR actually merges (or gets closed), then advances or
 * fails the session accordingly.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import { logInfo } from "../observability/structured-log.js";

const execFileAsync = promisify(execFile);

/** Cooldown between merge checks per session (30s -- faster than review poller since this blocks flow completion) */
const MERGE_POLL_COOLDOWN_MS = 25_000;

type GhExecFn = (args: string[]) => Promise<{ stdout: string }>;

const defaultGhExec: GhExecFn = async (args) => {
  return execFileAsync("gh", args, { encoding: "utf-8", timeout: 15_000 });
};

let _ghExec: GhExecFn = defaultGhExec;

/** Replace the gh exec function (for testing). */
export function setGhExec(fn: GhExecFn): void {
  _ghExec = fn;
}

export interface MergePollerOptions {
  ghExec?: GhExecFn;
}

interface GhPRState {
  state: string;
  mergedAt?: string;
}

/**
 * Fetch PR state via gh CLI.
 * Returns null if the CLI call fails (network error, rate limit, etc.).
 */
export async function fetchPRState(prUrl: string, ghExec: GhExecFn = _ghExec): Promise<GhPRState | null> {
  try {
    const { stdout } = await ghExec(["pr", "view", prUrl, "--json", "state,mergedAt"]);
    return JSON.parse(stdout) as GhPRState;
  } catch {
    return null;
  }
}

/**
 * Main poller tick. Called every 30s from the conductor.
 * Finds sessions in `waiting` status with `merge_queued_at` in config and checks PR state.
 */
export async function pollPRMerges(app: AppContext, opts?: MergePollerOptions): Promise<void> {
  const sessions = (await app.sessions.list({ limit: 100 })) as Session[];
  const now = Date.now();

  for (const s of sessions) {
    if (s.status !== "waiting") continue;
    if (!s.pr_url) continue;

    const config = (s.config ?? {}) as Record<string, any>;
    if (!config.merge_queued_at) continue;

    // Cooldown: skip if checked recently
    const lastCheck = config.last_merge_check ? new Date(config.last_merge_check).getTime() : 0;
    if (now - lastCheck < MERGE_POLL_COOLDOWN_MS) continue;

    try {
      await checkSessionMerge(app, s, opts);
    } catch {
      logInfo("bridge", "Don't let one session's failure block others");
    }
  }
}

/**
 * Check a single session's PR merge status and take appropriate action.
 */
export async function checkSessionMerge(app: AppContext, session: Session, opts?: MergePollerOptions): Promise<void> {
  const config = (session.config ?? {}) as Record<string, any>;
  const ghExec = opts?.ghExec ?? _ghExec;

  const data = await fetchPRState(session.pr_url!, ghExec);
  if (!data) {
    // gh CLI error -- update timestamp and keep polling
    await app.sessions.update(session.id, {
      config: { ...config, last_merge_check: new Date().toISOString() },
    });
    return;
  }

  if (data.state === "MERGED") {
    await app.events.log(session.id, "pr_merged_confirmed", {
      stage: session.stage ?? undefined,
      actor: "github",
      data: { pr_url: session.pr_url, merged_at: data.mergedAt },
    });

    // Advance past the merge stage -- advance() will see no next stage and mark session completed
    const { advance } = await import("../services/stage-advance.js");
    await advance(app, session.id, true);
    return;
  }

  if (data.state === "CLOSED") {
    await app.events.log(session.id, "pr_merge_failed", {
      stage: session.stage ?? undefined,
      actor: "github",
      data: { pr_url: session.pr_url, reason: "PR was closed without merging" },
    });

    await app.sessions.update(session.id, {
      status: "failed",
      error: "PR was closed without merging -- CI checks may have failed",
    });
    return;
  }

  // state === "OPEN" -- still waiting for CI, update timestamp
  await app.sessions.update(session.id, {
    config: { ...config, last_merge_check: new Date().toISOString() },
  });
}
