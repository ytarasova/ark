/**
 * Generic HMAC source -- fallback for sources that don't have a dedicated
 * connector yet but speak HMAC-SHA256 signatures.
 *
 * Signature scheme: HMAC-SHA256 of the raw body. Header defaults to
 * `X-Signature`, overrideable via `ARK_TRIGGER_GENERIC_HMAC_HEADER`.
 * Accepts the hex with or without a `sha256=` prefix.
 *
 * Event name: `X-Event-Name` header, falling back to the payload's
 * `event` / `type` field, then `generic-hmac.unknown`.
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function pickHeader(): string {
  return (process.env.ARK_TRIGGER_GENERIC_HMAC_HEADER ?? "x-signature").toLowerCase();
}

function verifyGeneric(body: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeStringEqual(trimmed, expected);
}

interface GenericPayload {
  event?: string;
  type?: string;
  actor?: { id?: string; name?: string; email?: string };
  ref?: string;
}

export const genericHmacSource: TriggerSource = {
  name: "generic-hmac",
  label: "Generic (HMAC-SHA256)",
  secretEnvVar: "ARK_TRIGGER_GENERIC_HMAC_SECRET",
  status: "full",

  async verify(req, secret) {
    if (!secret) return false;
    return verifyGeneric(req.body, req.headers.get(pickHeader()), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as GenericPayload;
    const hdrEvent = req.headers.get("x-event-name");
    const event = hdrEvent ?? payload.event ?? payload.type ?? "generic-hmac.unknown";
    return buildEvent({
      source: "generic-hmac",
      event,
      payload,
      ref: payload.ref,
      actor: payload.actor,
      sourceMeta: { header: pickHeader() },
    });
  },
};
