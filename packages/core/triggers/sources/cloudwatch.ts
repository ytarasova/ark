/**
 * CloudWatch Alarms / SNS webhook source (scaffolded).
 *
 * AWS SNS posts a JSON message with a `Signature` (base64 RSA-SHA1 over a
 * canonical string) plus `SigningCertURL`. Proper verification needs
 * fetching the cert from the signing URL and caching it.
 *
 * This scaffold accepts ONLY the subscription-confirmation flow + a pre-
 * shared token check as a stopgap:
 *   - `x-amz-sns-message-type: SubscriptionConfirmation` -- webhook handler
 *     is expected to GET the `SubscribeURL` out-of-band.
 *   - `Authorization: Bearer <secret>` verifies against the configured
 *     secret (the topic owner can wrap SNS posts through an HTTP proxy
 *     that adds bearer auth).
 *
 * Event name: `<AlarmName>.<NewStateValue>` from the parsed SNS message
 * body, or `sns.<message_type>` for confirmation / notification envelopes.
 *
 * TODO: wire full SNS certificate-based signature verification + SubscribeURL
 * auto-confirm. This is a stopgap meant to accept traffic in trusted VPCs.
 */

import type { TriggerSource, NormalizedEvent } from "../types.js";
import { buildEvent, parseJsonBody, timingSafeStringEqual } from "../normalizer.js";

interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  Message?: string;
  Subject?: string;
  TopicArn?: string;
}

interface CwAlarm {
  AlarmName?: string;
  NewStateValue?: string;
  Region?: string;
}

export const cloudwatchSource: TriggerSource = {
  name: "cloudwatch",
  label: "CloudWatch / SNS",
  secretEnvVar: "ARK_TRIGGER_CLOUDWATCH_SECRET",
  status: "scaffolded",

  async verify(req, secret) {
    if (!secret) return false;
    const auth = req.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) return false;
    return timingSafeStringEqual(auth.slice(7), secret);
  },

  async normalize(req): Promise<NormalizedEvent> {
    const envelope = parseJsonBody(req.body) as SnsEnvelope;
    const messageType = req.headers.get("x-amz-sns-message-type") ?? envelope.Type ?? "Notification";

    let event = `sns.${messageType.toLowerCase()}`;
    let alarm: CwAlarm | null = null;
    if (envelope.Message) {
      try {
        alarm = JSON.parse(envelope.Message) as CwAlarm;
        if (alarm.AlarmName && alarm.NewStateValue) {
          event = `${alarm.AlarmName}.${alarm.NewStateValue.toLowerCase()}`;
        }
      } catch {
        // Message is not JSON -- leave event as sns.<type>.
      }
    }

    return buildEvent({
      source: "cloudwatch",
      event,
      payload: { envelope, alarm },
      ref: alarm?.AlarmName,
      sourceMeta: {
        messageId: envelope.MessageId,
        topicArn: envelope.TopicArn,
        region: alarm?.Region,
      },
    });
  },
};
