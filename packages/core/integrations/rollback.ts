/**
 * Auto-rollback pipeline — monitors merged PRs, polls CI, creates revert PRs on failure.
 */

import type { AppContext } from "../app.js";
import { eventBus } from "../hooks.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RollbackConfig {
  enabled: boolean;
  timeout: number;
  on_timeout: "rollback" | "ignore";
  auto_merge: boolean;
  health_url: string | null;
}

export interface CheckSuiteResult {
  id: number;
  conclusion: string | null;
  status: string;
}

export interface RevertPayload {
  title: string;
  body: string;
  head: string;
  base: string;
}

// ── Pure logic ─────────────────────────────────────────────────────────────

export function shouldRollback(suites: CheckSuiteResult[], _config: RollbackConfig): boolean {
  const completed = suites.filter((s) => s.status === "completed");
  if (completed.length === 0) return false;
  return completed.some((s) => s.conclusion === "failure");
}

export function allCompleted(suites: CheckSuiteResult[]): boolean {
  return suites.length > 0 && suites.every((s) => s.status === "completed");
}

export function createRevertPayload(opts: {
  owner: string;
  repo: string;
  originalPrNumber: number;
  originalPrTitle: string;
  originalBranch: string;
  baseBranch?: string;
  failedChecks: string[];
}): RevertPayload {
  return {
    title: `Revert: ${opts.originalPrTitle}`,
    head: `revert-${opts.originalBranch}`,
    base: opts.baseBranch ?? "main",
    body: [
      `Reverts #${opts.originalPrNumber}`,
      "",
      "**Reason:** CI checks failed after merge.",
      "",
      "**Failed checks:**",
      ...opts.failedChecks.map((c) => `- ${c}`),
      "",
      "_Created automatically by Ark auto-rollback._",
    ].join("\n"),
  };
}

// ── Polling ────────────────────────────────────────────────────────────────

type CheckSuiteFetcher = (sha: string) => Promise<{ check_suites: CheckSuiteResult[] }>;

export async function pollCheckSuites(sha: string, fetcher: CheckSuiteFetcher): Promise<CheckSuiteResult[]> {
  const response = await fetcher(sha);
  return response.check_suites;
}

/** Full health check loop: poll CI + optional health URL. */
export async function watchMergedPR(
  app: AppContext,
  opts: {
    sessionId: string;
    sha: string;
    owner: string;
    repo: string;
    prNumber: number;
    prTitle: string;
    branch: string;
    baseBranch?: string;
    config: RollbackConfig;
    fetcher: CheckSuiteFetcher;
    healthFetcher?: () => Promise<boolean>;
    onRevert: (payload: RevertPayload) => Promise<void>;
    onStop?: (sessionId: string) => Promise<any>;
  },
): Promise<{ action: "none" | "rollback"; reason?: string }> {
  const { config, fetcher } = opts;
  const deadline = Date.now() + config.timeout * 1000;

  while (Date.now() < deadline) {
    const suites = await pollCheckSuites(opts.sha, fetcher);

    if (shouldRollback(suites, config)) {
      const failedChecks = suites.filter((s) => s.conclusion === "failure").map((s) => `Check suite #${s.id}`);
      const payload = createRevertPayload({
        owner: opts.owner,
        repo: opts.repo,
        originalPrNumber: opts.prNumber,
        originalPrTitle: opts.prTitle,
        originalBranch: opts.branch,
        baseBranch: opts.baseBranch,
        failedChecks,
      });
      await opts.onRevert(payload);
      if (opts.onStop) await opts.onStop(opts.sessionId);
      app.events.log(opts.sessionId, "rollback", {
        actor: "system",
        data: { prNumber: opts.prNumber, failedChecks, revertBranch: payload.head },
      });
      eventBus.emit("rollback", opts.sessionId, {
        data: { prNumber: opts.prNumber, revertBranch: payload.head },
      });
      return { action: "rollback", reason: `CI failed: ${failedChecks.join(", ")}` };
    }

    if (allCompleted(suites)) {
      if (config.health_url && opts.healthFetcher) {
        const healthy = await opts.healthFetcher();
        if (!healthy) {
          const failedChecks = [`Health check failed: ${config.health_url}`];
          const payload = createRevertPayload({
            owner: opts.owner,
            repo: opts.repo,
            originalPrNumber: opts.prNumber,
            originalPrTitle: opts.prTitle,
            originalBranch: opts.branch,
            baseBranch: opts.baseBranch,
            failedChecks,
          });
          await opts.onRevert(payload);
          if (opts.onStop) await opts.onStop(opts.sessionId);
          app.events.log(opts.sessionId, "rollback", {
            actor: "system",
            data: { prNumber: opts.prNumber, failedChecks, revertBranch: payload.head },
          });
          eventBus.emit("rollback", opts.sessionId, {
            data: { prNumber: opts.prNumber, revertBranch: payload.head },
          });
          return { action: "rollback", reason: `Health check failed: ${config.health_url}` };
        }
      }
      return { action: "none" };
    }

    await Bun.sleep(30_000);
  }

  // Timeout
  if (config.on_timeout === "rollback") {
    const failedChecks = ["Timeout: CI did not complete"];
    const payload = createRevertPayload({
      owner: opts.owner,
      repo: opts.repo,
      originalPrNumber: opts.prNumber,
      originalPrTitle: opts.prTitle,
      originalBranch: opts.branch,
      baseBranch: opts.baseBranch,
      failedChecks,
    });
    await opts.onRevert(payload);
    if (opts.onStop) await opts.onStop(opts.sessionId);
    app.events.log(opts.sessionId, "rollback", {
      actor: "system",
      data: { prNumber: opts.prNumber, failedChecks, revertBranch: payload.head },
    });
    eventBus.emit("rollback", opts.sessionId, {
      data: { prNumber: opts.prNumber, revertBranch: payload.head },
    });
    return { action: "rollback", reason: "Timeout" };
  }

  return { action: "none" };
}
