/**
 * pi-sage webhook source (scaffolded).
 *
 * pi-sage is Paytm's internal Jira + KB intelligence layer. When a pi-sage
 * analysis completes, it can POST to Ark's webhook endpoint to kick a flow
 * that fans out one session per affected repo. The default flow shipped
 * today is `from-sage-analysis` (owned by another agent, not yet merged).
 *
 * Signature scheme: HMAC-SHA256 of the raw body. Header defaults to
 * `X-Sage-Signature` (optionally prefixed `sha256=`). When a different
 * header is configured on the pi-sage side, override via
 * `ARK_TRIGGER_PI_SAGE_HEADER`.
 *
 * Event name: `analysis.ready` for the canonical analysis-completion event.
 * The payload carries an `analysis_id` + `base_url`, or an inline JSON
 * payload under `analysis`, which the `from-sage-analysis` flow consumes.
 *
 * TODO: promote to `full` once we have end-to-end fixtures from pi-sage.
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function pickHeader(): string {
  return (process.env.ARK_TRIGGER_PI_SAGE_HEADER ?? "x-sage-signature").toLowerCase();
}

function verifyPiSage(body: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeStringEqual(trimmed, expected);
}

interface PiSagePayload {
  event?: string;
  analysis_id?: string;
  base_url?: string;
  ticket?: string;
  analysis?: { id?: string; ticket?: string };
  actor?: { id?: string; name?: string };
}

export const piSageSource: TriggerSource = {
  name: "pi-sage",
  label: "Pi-sage",
  secretEnvVar: "ARK_TRIGGER_PI_SAGE_SECRET",
  status: "scaffolded",

  async verify(req, secret) {
    if (!secret) return false;
    return verifyPiSage(req.body, req.headers.get(pickHeader()), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as PiSagePayload;
    const event = payload.event ?? "analysis.ready";
    const analysisId = payload.analysis_id ?? payload.analysis?.id;
    const ticket = payload.ticket ?? payload.analysis?.ticket;
    const ref = analysisId ?? ticket;

    return buildEvent({
      source: "pi-sage",
      event,
      payload,
      ref,
      actor: payload.actor,
      sourceMeta: {
        analysisId,
        baseUrl: payload.base_url,
        ticket,
      },
    });
  },
};
