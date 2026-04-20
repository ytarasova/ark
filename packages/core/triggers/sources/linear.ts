/**
 * Linear webhook source.
 *
 * Signature scheme: HMAC-SHA256 of the raw body keyed by the signing
 * secret configured in the Linear webhook console. Header:
 * `Linear-Signature: <hex>`.
 *
 * Event name: `type.action` (e.g. `issue.create`, `comment.update`).
 * Edge cases around relationship events (`IssueLabel.create`) are covered
 * via the raw `type` field passthrough in the payload.
 *
 * Docs: https://developers.linear.app/docs/graphql/webhooks
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function verifyLinear(body: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeStringEqual(headerValue, expected);
}

interface LinearPayload {
  action?: string;
  type?: string;
  data?: { id?: string; title?: string; number?: number; identifier?: string };
  actor?: { id?: string; name?: string; email?: string };
  url?: string;
}

export const linearSource: TriggerSource = {
  name: "linear",
  label: "Linear",
  secretEnvVar: "ARK_TRIGGER_LINEAR_SECRET",
  status: "full",

  async verify(req, secret) {
    if (!secret) return false;
    return verifyLinear(req.body, req.headers.get("linear-signature"), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as LinearPayload;
    const innerType = (payload.type ?? "unknown").toLowerCase();
    const action = (payload.action ?? "unknown").toLowerCase();
    const event = `${innerType}.${action}`;
    const ref = payload.data?.identifier ?? payload.data?.id;

    return buildEvent({
      source: "linear",
      event,
      payload,
      ref,
      actor: payload.actor,
      sourceMeta: {},
    });
  },
};
