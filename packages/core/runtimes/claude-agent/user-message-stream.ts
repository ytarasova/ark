/**
 * Wire-based subscriber for mid-session interventions.
 *
 * The agent subscribes to the global `user-input` channel via arkd's generic
 * pub/sub (`GET /channel/user-input/subscribe`). Envelopes carry `{ session,
 * content, control? }`; we filter by `envelope.session === sessionName` so
 * each agent only consumes its own steers. Same external contract as the
 * legacy intervention-tail (`onMessage` per content, optional `onInterrupt`
 * for control:"interrupt" envelopes).
 *
 * Why wire-based:
 *   - The publisher (conductor's session.send) doesn't need to know the
 *     worker's filesystem layout. For remote dispatch it would have had to
 *     either ship every steer through arkd just to write a file, or duplicate
 *     the path resolution; both are coupling the wrong way.
 *   - Backpressure / delivery acks: arkd reports `delivered: true` when an
 *     active subscriber was parked, `false` when the message was buffered
 *     for a not-yet-attached consumer.
 *   - Same NDJSON framing + SSM-tunnel friendliness as the hooks channel
 *     (agent->conductor) -- one transport, one debugging story.
 *
 * Channel scope is GLOBAL: a single `user-input` queue is shared across all
 * sessions on this arkd. Each subscriber filters envelopes whose `session`
 * field matches its own ARK_SESSION_ID. This lets one consumer process
 * drain everyone's user-input traffic without N subscriptions; in practice
 * each agent only opens one subscriber for itself.
 *
 * The file-tail (`intervention-tail.ts`) is retained for dev/test scenarios
 * that don't have a reachable arkd, but the production path goes through here.
 */

import { ArkdClient } from "../../../arkd/client/index.js";

/** Envelope shape the conductor publishes on the `user-input` channel. */
export interface UserMessageEnvelope {
  session: string;
  content: string;
  control?: "interrupt";
}

export interface UserMessageStreamOpts {
  arkdUrl: string;
  sessionName: string;
  authToken?: string;
  /**
   * Called for non-interrupt envelopes. Caller pushes `content` to the
   * SDK prompt queue; the SDK consumes it between turns.
   */
  onMessage: (content: string) => void;
  /**
   * Called for `control: "interrupt"` envelopes. The content is delivered
   * here -- NOT through `onMessage` -- so the caller can buffer it for the
   * next query attempt rather than pushing it into a queue that may have a
   * dying iterator parked on `next()`. The caller should:
   *   1. Buffer `content` for the next attempt
   *   2. Call query.interrupt() to end the current turn
   *   3. After the abort settles, push the buffered content into the queue
   *      so the resumed SDK consumes it as the first message of the new
   *      turn.
   */
  onInterrupt?: (content: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Start a long-running subscription. The returned function tears it down --
 * call it when the agent's result message arrives, or when SIGTERM/SIGINT
 * fires, so the underlying fetch stream is closed cleanly.
 *
 * Reconnect-on-error: a transient network drop while the session is still
 * alive would otherwise lose interventions silently. We retry with backoff
 * (250ms, 500ms, 1s, 2s, capped) until `stop()` is called. Tests inject a
 * test-only `client` so they can drive specific failure modes.
 */
export function subscribeUserMessages(opts: UserMessageStreamOpts & { client?: ArkdClient }): () => void {
  const { arkdUrl, sessionName, authToken, onMessage, onInterrupt, onError } = opts;

  let stopped = false;
  const ac = new AbortController();
  const client = opts.client ?? new ArkdClient(arkdUrl, { token: authToken });

  console.error(`[user-input] starting subscriber arkdUrl=${arkdUrl} session=${sessionName}`);

  void (async () => {
    let backoffMs = 250;
    while (!stopped) {
      try {
        console.error(`[user-input] connecting to channel...`);
        const iter = await client.subscribeToChannel<UserMessageEnvelope>("user-input", {
          signal: ac.signal,
        });
        console.error(`[user-input] subscribed (ack received), waiting for envelopes`);
        for await (const env of iter) {
          // Log every raw envelope BEFORE filtering, so we see same-session
          // and other-session traffic equally.
          console.error(
            `[user-input] raw frame: session=${env.session} bytes=${env.content?.length ?? 0} ` +
              `control=${env.control ?? "none"}`,
          );
          // Channel is global; ignore envelopes destined for other sessions.
          if (env.session !== sessionName) continue;
          console.error(
            `[user-input] received: bytes=${env.content?.length ?? 0} ` +
              `control=${env.control ?? "none"} session=${env.session}`,
          );
          const content = typeof env.content === "string" ? env.content : "";
          if (env.control === "interrupt") {
            // Interrupt envelope: route the content through onInterrupt so
            // the launcher buffers it and pushes it onto the queue only
            // AFTER the current turn aborts. Pushing here would race with
            // the still-running SDK iterator -- it can grab the message
            // via its parked `next()` resolver and lose it when the abort
            // tears the turn down.
            if (onInterrupt) {
              console.error("[user-input] firing interrupt to preempt the current SDK turn");
              onInterrupt(content);
            }
          } else if (content.length > 0) {
            // Non-interrupt envelope: push to the queue; SDK consumes
            // between turns.
            onMessage(content);
          }
          // Successful read -- reset backoff so a long-lived stream that
          // briefly drops and reconnects doesn't keep escalating.
          backoffMs = 250;
        }
        if (stopped) return;
        // Stream closed cleanly without our asking. Reconnect.
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 2000);
      } catch (err) {
        if (stopped) return;
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 2000);
      }
    }
  })();

  return function stop(): void {
    stopped = true;
    ac.abort();
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
