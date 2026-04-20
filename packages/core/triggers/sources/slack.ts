/**
 * Slack Events API source.
 *
 * Signature scheme: HMAC-SHA256 of `v0:<timestamp>:<body>` keyed by the
 * Slack signing secret. Header: `X-Slack-Signature: v0=<hex>`; timestamp
 * in `X-Slack-Request-Timestamp`.
 *
 * A 5-minute replay window is enforced. Events older than 5 minutes are
 * rejected even when the HMAC is valid.
 *
 * Special case: `url_verification` events carry a `challenge` field; the
 * webhook handler echoes the challenge verbatim without matching triggers.
 *
 * Docs: https://api.slack.com/authentication/verifying-requests-from-slack
 */

import { createHmac } from "crypto";
import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

const REPLAY_WINDOW_SEC = 5 * 60;

function verifySlack(body: string, ts: string | null, sig: string | null, secret: string): boolean {
  if (!ts || !sig || !sig.startsWith("v0=")) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_SEC) return false;
  const base = `v0:${ts}:${body}`;
  const expected = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  return timingSafeStringEqual(sig, expected);
}

interface SlackPayload {
  type?: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    user?: string;
    channel?: string;
    text?: string;
    ts?: string;
  };
  event_id?: string;
  command?: string;
  text?: string;
}

export const slackSource: TriggerSource = {
  name: "slack",
  label: "Slack",
  secretEnvVar: "ARK_TRIGGER_SLACK_SECRET",
  status: "full",

  async verify(req, secret) {
    if (!secret) return false;
    return verifySlack(
      req.body,
      req.headers.get("x-slack-request-timestamp"),
      req.headers.get("x-slack-signature"),
      secret,
    );
  },

  async normalize(req): Promise<NormalizedEvent> {
    const payload = parseJsonBody(req.body) as SlackPayload;

    const topType = payload.type ?? "unknown";
    const innerType = payload.event?.type;
    const subtype = payload.event?.subtype;
    // Slash-command dispatch: Slack posts with `command` instead of `event`.
    const commandEvent = payload.command ? `slash.${payload.command.replace(/^\//, "")}` : null;

    const event = commandEvent ? commandEvent : innerType ? (subtype ? `${innerType}.${subtype}` : innerType) : topType;
    const ref = payload.event?.channel;

    return buildEvent({
      source: "slack",
      event,
      payload,
      ref,
      actor: payload.event?.user ? { id: payload.event.user } : undefined,
      sourceMeta: {
        teamId: payload.team_id,
        eventId: payload.event_id,
      },
    });
  },
};
