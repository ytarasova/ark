/**
 * Prometheus webhook source (scaffolded).
 *
 * This is the same receiver shape as alertmanager -- Prometheus's
 * alerting pipeline almost always terminates at Alertmanager, so we
 * accept identical signature + payload semantics here to avoid forcing
 * callers to choose between the two names.
 *
 * Signature scheme: Bearer token or HTTP Basic password (timing-safe
 * compare against the configured secret).
 *
 * Event name: `<alertname>.<status>`.
 *
 * TODO: when we have a real Prometheus push-gateway integration with a
 * different payload shape, split this from alertmanager.
 */

import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

function decodeBasicAuth(auth: string): string | null {
  if (!auth.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

function extractCredential(req: { headers: Headers }): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const basicPass = decodeBasicAuth(auth);
  if (basicPass) return basicPass;
  return null;
}

interface PromPayload {
  status?: "firing" | "resolved";
  groupKey?: string;
  commonLabels?: Record<string, string>;
  alerts?: Array<{ status?: string; labels?: Record<string, string> }>;
}

export const prometheusSource: TriggerSource = {
  name: "prometheus",
  label: "Prometheus (via Alertmanager)",
  secretEnvVar: "ARK_TRIGGER_PROMETHEUS_SECRET",
  status: "scaffolded",

  async verify(req, secret) {
    if (!secret) return false;
    const cred = extractCredential(req);
    if (!cred) return false;
    return timingSafeStringEqual(cred, secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as PromPayload;
    const alertName = payload.commonLabels?.alertname ?? "unknown";
    const status = payload.status ?? "firing";
    const event = `${alertName}.${status}`;

    return buildEvent({
      source: "prometheus",
      event,
      payload,
      ref: payload.groupKey,
      sourceMeta: { alertCount: payload.alerts?.length ?? 0 },
    });
  },
};
