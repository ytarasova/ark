/**
 * GitHub webhook handler for issue-triggered sessions.
 * When an issue gets a specific label, auto-create and dispatch a session.
 */

import { getApp } from "./app.js";

import { dispatch } from "./services/session-orchestration.js";

export interface IssueWebhookPayload {
  action: string;  // "labeled", "opened", "edited"
  issue: {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    html_url: string;
  };
  label?: { name: string };
  repository: {
    full_name: string;
    clone_url: string;
  };
}

export interface IssueWebhookConfig {
  triggerLabel: string;     // e.g., "ark" or "fix-me"
  autoDispatch: boolean;
  flow?: string;
  agent?: string;
  group?: string;
}

/** Handle a GitHub issue webhook event. */
export async function handleIssueWebhook(
  payload: IssueWebhookPayload,
  config: IssueWebhookConfig,
): Promise<{ ok: boolean; sessionId?: string; message: string }> {
  // Only trigger on label events
  if (payload.action !== "labeled") {
    return { ok: false, message: `Ignoring action: ${payload.action}` };
  }

  // Check if the trigger label was added
  if (payload.label?.name !== config.triggerLabel) {
    return { ok: false, message: `Label '${payload.label?.name}' does not match trigger '${config.triggerLabel}'` };
  }

  const issue = payload.issue;
  const repo = payload.repository;

  // Create session from issue
  const createOpts = {
    ticket: `#${issue.number}`,
    summary: issue.title,
    repo: repo.clone_url,
    flow: config.flow ?? "quick",
    group_name: config.group ?? "github-issues",
    config: {
      github_issue_url: issue.html_url,
      github_issue_body: issue.body,
      github_repo: repo.full_name,
    },
  };
  let session;
  session = getApp().sessions.create(createOpts);

  const evOpts = { actor: "github", data: { issue_number: issue.number, label: config.triggerLabel, repo: repo.full_name } };
  try { getApp().events.log(session.id, "issue_webhook_triggered", evOpts); }
  catch { /* app not booted */ }

  // Auto-dispatch if configured
  if (config.autoDispatch) {
    try {
      await dispatch(session.id);
    } catch (e: any) {
      return { ok: true, sessionId: session.id, message: `Session created but dispatch failed: ${e.message}` };
    }
  }

  return { ok: true, sessionId: session.id, message: `Session ${session.id} created from issue #${issue.number}` };
}
