/**
 * `/hooks/github/merge` webhook handler.
 *
 * GitHub POSTs a `pull_request` event when a PR transitions to closed; if
 * the PR merged and rollback is enabled for the app, we start a background
 * `watchMergedPR` watcher that will revert the merge commit if the upstream
 * check-suite or health probe fails within the configured timeout.
 */

import type { AppContext } from "../../core/app.js";
import { logError } from "../../core/observability/structured-log.js";
import { watchMergedPR, type RollbackConfig } from "../../core/integrations/rollback.js";

/** GitHub PR merge webhook payload (subset of fields we use). */
interface GitHubPRWebhookPayload {
  action?: string;
  pull_request?: {
    merged?: boolean;
    html_url?: string;
    merge_commit_sha?: string;
    number?: number;
    title?: string;
    head?: { ref?: string };
    base?: { ref?: string };
  };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
  };
}

export async function handlePRMergeWebhook(app: AppContext, req: Request): Promise<Response> {
  const payload = (await req.json()) as GitHubPRWebhookPayload;
  if (payload.action !== "closed" || !payload.pull_request?.merged) {
    return Response.json({ status: "ignored" });
  }

  const pr = payload.pull_request;
  const repo = payload.repository;

  if (!repo?.owner?.login || !repo?.name || !pr?.head?.ref || !pr?.base?.ref || !pr?.merge_commit_sha) {
    return Response.json({ status: "incomplete_payload" }, { status: 400 });
  }

  const sessions = await app.sessions.list();
  const matchedSession = sessions.find((s) => {
    return s.config?.github_url === pr.html_url || s.branch === pr.head?.ref;
  });

  if (!matchedSession) return Response.json({ status: "no_session" });

  const config: RollbackConfig = app.rollbackConfig ?? {
    enabled: false,
    timeout: 600,
    on_timeout: "ignore",
    auto_merge: false,
    health_url: null,
  };

  if (!config.enabled) return Response.json({ status: "rollback_disabled" });

  const ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const fetcher = async (sha: string) => {
    const res = await fetch(`https://api.github.com/repos/${repo.full_name}/commits/${sha}/check-suites`, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
    });
    return res.json() as Promise<{ check_suites: import("../../core/integrations/rollback.js").CheckSuiteResult[] }>;
  };

  const healthFetcher = config.health_url
    ? async () => {
        try {
          const res = await fetch(config.health_url!);
          return res.ok;
        } catch {
          return false;
        }
      }
    : undefined;

  const onRevert = async (revertPayload: import("../../core/integrations/rollback.js").RevertPayload) => {
    await fetch(`https://api.github.com/repos/${repo?.full_name}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(revertPayload),
    });
  };

  watchMergedPR(app, {
    sessionId: matchedSession.id,
    sha: pr.merge_commit_sha,
    owner: repo.owner.login,
    repo: repo.name,
    prNumber: pr.number,
    prTitle: pr.title,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    config,
    fetcher,
    healthFetcher,
    onRevert,
    onStop: async (id) => {
      await app.sessionLifecycle.stop(id);
    },
  }).catch((e) => logError("conductor", `rollback watcher error: ${e}`));

  return Response.json({ status: "watching" });
}
