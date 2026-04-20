/**
 * Alertmanager webhook source (scaffolded).
 *
 * Alertmanager does not sign its webhook deliveries natively -- the
 * expected pattern is TLS + a shared secret in the URL or an
 * `Authorization: Basic` header. We verify by timing-safe compare of the
 * basic-auth password (base64 of `user:pass` -- user part is ignored).
 * Bearer tokens are accepted as an alternative.
 *
 * Payload shape: grouped notification carrying one or more alerts.
 * Event name: `<alertname>.<status>` using `commonLabels.alertname` and
 * top-level `status` (`firing` / `resolved`).
 *
 * Docs: https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
 *
 * TODO: fan-out semantics for multi-alert deliveries -- current normalize
 * emits one event per delivery using the common labels. Promote to `full`
 * once real usage is established.
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

interface AlertmgrPayload {
  status?: "firing" | "resolved";
  groupKey?: string;
  commonLabels?: Record<string, string>;
  alerts?: Array<{ status?: string; labels?: Record<string, string> }>;
}

export const alertmanagerSource: TriggerSource = {
  name: "alertmanager",
  label: "Alertmanager",
  secretEnvVar: "ARK_TRIGGER_ALERTMANAGER_SECRET",
  status: "scaffolded",

  async verify(req, secret) {
    if (!secret) return false;
    const cred = extractCredential(req);
    if (!cred) return false;
    return timingSafeStringEqual(cred, secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as AlertmgrPayload;
    const alertName = payload.commonLabels?.alertname ?? "unknown";
    const status = payload.status ?? "firing";
    const event = `${alertName}.${status}`;

    return buildEvent({
      source: "alertmanager",
      event,
      payload,
      ref: payload.groupKey,
      sourceMeta: { alertCount: payload.alerts?.length ?? 0 },
    });
  },
};
