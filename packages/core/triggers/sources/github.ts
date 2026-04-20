/**
 * GitHub webhook source.
 *
 * Signature scheme: HMAC-SHA256 of the raw body keyed by the webhook's
 * signing secret. Header: `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Event name: `X-GitHub-Event` header combined with the payload's `action`
 * field. `pull_request.opened`, `issues.labeled`. Events without `action`
 * (e.g. `push`, `ping`) use the raw event name.
 *
 * Docs: https://docs.github.com/en/webhooks
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function verifySignature(body: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue || !headerValue.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeStringEqual(headerValue, expected);
}

interface GhPayload {
  action?: string;
  repository?: { full_name?: string };
  sender?: { login?: string; email?: string; id?: number | string };
  pull_request?: { number?: number; head?: { ref?: string } };
  issue?: { number?: number; labels?: Array<{ name?: string }> };
  ref?: string;
}

export const githubSource: TriggerSource = {
  name: "github",
  label: "GitHub",
  secretEnvVar: "ARK_TRIGGER_GITHUB_SECRET",
  status: "full",

  async verify(req, secret) {
    if (!secret) return false;
    return verifySignature(req.body, req.headers.get("x-hub-signature-256"), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const ghEvent = req.headers.get("x-github-event") ?? "unknown";
    const deliveryId = req.headers.get("x-github-delivery") ?? undefined;
    const payload = parseJsonBody(req.body) as GhPayload;

    const event = payload.action ? `${ghEvent}.${payload.action}` : ghEvent;

    let ref: string | undefined;
    if (payload.pull_request?.head?.ref) ref = payload.pull_request.head.ref;
    else if (payload.issue?.number) ref = `issue:${payload.issue.number}`;
    else if (typeof payload.ref === "string") ref = payload.ref;

    // Surface repo full_name as `payload.repo` for easy matching.
    const repo = payload.repository?.full_name;
    const enrichedPayload = repo ? { ...payload, repo } : payload;

    return buildEvent({
      source: "github",
      event,
      payload: enrichedPayload,
      ref,
      actor: payload.sender
        ? {
            id: payload.sender.id != null ? String(payload.sender.id) : undefined,
            name: payload.sender.login,
            email: payload.sender.email,
          }
        : undefined,
      sourceMeta: { deliveryId, rawEvent: ghEvent },
    });
  },
};
