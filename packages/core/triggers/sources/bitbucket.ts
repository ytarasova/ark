/**
 * Bitbucket webhook source.
 *
 * Signature scheme: HMAC-SHA256 of the raw body; header
 * `X-Hub-Signature: sha256=<hex>` (Bitbucket Cloud) OR
 * `X-Bitbucket-Signature` (Bitbucket Server). Both are accepted; the first
 * that matches wins.
 *
 * Event name: `X-Event-Key` header (e.g. `pullrequest:created`,
 * `repo:push`) with the colon normalized to a dot for consistency with
 * GitHub-style event names: `pullrequest.created`.
 *
 * Docs: https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function verifyHubSig(body: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeStringEqual(trimmed, expected);
}

interface BbPayload {
  actor?: { uuid?: string; nickname?: string; display_name?: string };
  repository?: { full_name?: string; name?: string };
  pullrequest?: { id?: number; title?: string; source?: { branch?: { name?: string } } };
  push?: { changes?: Array<{ new?: { name?: string } }> };
}

export const bitbucketSource: TriggerSource = {
  name: "bitbucket",
  label: "Bitbucket",
  secretEnvVar: "ARK_TRIGGER_BITBUCKET_SECRET",
  status: "full",

  async verify(req, secret) {
    if (!secret) return false;
    const hub = req.headers.get("x-hub-signature");
    if (hub && verifyHubSig(req.body, hub, secret)) return true;
    const server = req.headers.get("x-bitbucket-signature");
    if (server && verifyHubSig(req.body, server, secret)) return true;
    return false;
  },

  async normalize(req): Promise<NormalizedEvent> {
    const eventKey = req.headers.get("x-event-key") ?? "unknown";
    const requestUuid = req.headers.get("x-request-uuid") ?? undefined;
    const payload = parseJsonBody(req.body) as BbPayload;

    const event = eventKey.replace(":", ".");

    let ref: string | undefined;
    if (payload.pullrequest?.source?.branch?.name) ref = payload.pullrequest.source.branch.name;
    else if (payload.push?.changes?.[0]?.new?.name) ref = payload.push.changes[0].new.name;

    const repo = payload.repository?.full_name;
    const enrichedPayload = repo ? { ...payload, repo } : payload;

    return buildEvent({
      source: "bitbucket",
      event,
      payload: enrichedPayload,
      ref,
      actor: payload.actor
        ? {
            id: payload.actor.uuid,
            name: payload.actor.nickname ?? payload.actor.display_name,
          }
        : undefined,
      sourceMeta: { requestUuid, rawEventKey: eventKey },
    });
  },
};
