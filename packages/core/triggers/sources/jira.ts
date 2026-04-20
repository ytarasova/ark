/**
 * Jira source. Supports BOTH webhook and poll kinds:
 *   - webhook (Jira Cloud / Server with outgoing webhooks)
 *   - poll (deployments where outgoing webhooks are unavailable -- TODO)
 *
 * Webhook signature: Jira Cloud signs with HMAC-SHA256 via
 * `X-Hub-Signature: sha256=<hex>`. Jira Server does not sign natively, so
 * we fall back to a bearer token check against the same secret.
 *
 * Event name: Jira delivers `webhookEvent` (e.g. `jira:issue_created`).
 * We strip the `jira:` prefix and swap `_` for `.`: `issue.created`.
 *
 * Docs:
 *   webhooks: https://developer.atlassian.com/cloud/jira/platform/webhooks/
 *   polling:  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent, TriggerConfig } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function verifyJira(body: string, headerValue: string | null, authHeader: string | null, secret: string): boolean {
  if (headerValue) {
    const trimmed = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    if (timingSafeStringEqual(trimmed, expected)) return true;
  }
  if (authHeader?.startsWith("Bearer ")) {
    return timingSafeStringEqual(authHeader.slice(7), secret);
  }
  return false;
}

interface JiraPayload {
  webhookEvent?: string;
  issue?: { id?: string; key?: string; fields?: { summary?: string } };
  user?: { accountId?: string; displayName?: string; emailAddress?: string };
}

export const jiraSource: TriggerSource = {
  name: "jira",
  label: "Jira",
  secretEnvVar: "ARK_TRIGGER_JIRA_SECRET",
  status: "full",

  async verify(req, secret) {
    if (!secret) return false;
    return verifyJira(req.body, req.headers.get("x-hub-signature"), req.headers.get("authorization"), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as JiraPayload;
    const raw = payload.webhookEvent ?? "unknown";
    const event = raw.replace(/^jira:/, "").replace(/_/g, ".");

    return buildEvent({
      source: "jira",
      event,
      payload,
      ref: payload.issue?.key,
      actor: payload.user
        ? {
            id: payload.user.accountId,
            name: payload.user.displayName,
            email: payload.user.emailAddress,
          }
        : undefined,
      sourceMeta: {},
    });
  },

  // TODO: implement JQL-based polling for deployments without outbound webhooks.
  async poll(_opts: { cursor?: string; config: TriggerConfig }) {
    return { events: [] };
  },
};
