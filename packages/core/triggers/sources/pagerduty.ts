/**
 * PagerDuty webhook source (scaffolded).
 *
 * Signature scheme: HMAC-SHA256 of the raw body keyed by the v3 webhook
 * secret. Header: `X-PagerDuty-Signature: v1=<hex>`. Multiple signatures
 * may be present comma-separated (during key rotation); we accept a match
 * against any.
 *
 * Docs: https://developer.pagerduty.com/docs/db0fa8c8984fc-overview
 *
 * TODO: cover the full event-type surface area (incident + service + team
 * scopes). Incident events are well-defined; others land under
 * `pagerduty.unknown` until fixtures land.
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function verifyPagerduty(body: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(body).digest("hex");
  for (const sig of headerValue.split(",").map((s) => s.trim())) {
    if (timingSafeStringEqual(sig, expected)) return true;
  }
  return false;
}

interface PdPayload {
  event?: {
    event_type?: string;
    id?: string;
    data?: { incident?: { id?: string; title?: string; urgency?: string }; title?: string };
    agent?: { id?: string; summary?: string };
  };
}

export const pagerdutySource: TriggerSource = {
  name: "pagerduty",
  label: "PagerDuty",
  secretEnvVar: "ARK_TRIGGER_PAGERDUTY_SECRET",
  status: "scaffolded",

  async verify(req, secret) {
    if (!secret) return false;
    return verifyPagerduty(req.body, req.headers.get("x-pagerduty-signature"), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as PdPayload;
    const event = payload.event?.event_type ?? "pagerduty.unknown";
    const ref = payload.event?.data?.incident?.id ?? payload.event?.id;

    return buildEvent({
      source: "pagerduty",
      event,
      payload,
      ref,
      actor: payload.event?.agent ? { id: payload.event.agent.id, name: payload.event.agent.summary } : undefined,
      sourceMeta: {},
    });
  },
};
