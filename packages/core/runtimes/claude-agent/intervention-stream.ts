/**
 * Wire-based subscriber for mid-session interventions.
 *
 * Replaces the file-tail (`intervention-tail.ts`) for production: instead of
 * watching `<sessionDir>/interventions.jsonl`, the agent long-polls arkd's
 * `/agent/interventions/stream`. Same external contract as the file-tail
 * (`onMessage` per line, optional `onInterrupt` for control:"interrupt"
 * envelopes), so the launch.ts call sites swap over with a one-line change.
 *
 * Why wire-based:
 *   - The publisher (conductor's session.send) doesn't need to know the
 *     worker's filesystem layout. For remote dispatch it would have had to
 *     either ship every steer through arkd just to write a file, or duplicate
 *     the path resolution; both are coupling the wrong way.
 *   - Backpressure / delivery acks: arkd reports `delivered: true` when an
 *     active stream consumer was parked, `false` when the message was
 *     buffered for a not-yet-attached consumer.
 *   - Same NDJSON framing + SSM-tunnel friendliness as the existing hook
 *     forward path -- one transport, one debugging story.
 *
 * The file-tail (`intervention-tail.ts`) is retained for dev/test scenarios
 * that don't have a reachable arkd, but the production path goes through here.
 */

import { ArkdClient, type InterventionEnvelope } from "../../../arkd/index.js";

export interface InterventionStreamOpts {
  arkdUrl: string;
  sessionName: string;
  authToken?: string;
  onMessage: (content: string) => void;
  /**
   * Called for `control: "interrupt"` envelopes. The content is also passed
   * through `onMessage` first so the correction is already in the prompt
   * queue when abort fires.
   */
  onInterrupt?: () => void;
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
export function startInterventionStream(opts: InterventionStreamOpts & { client?: ArkdClient }): () => void {
  const { arkdUrl, sessionName, authToken, onMessage, onInterrupt, onError } = opts;

  let stopped = false;
  const ac = new AbortController();
  const client = opts.client ?? new ArkdClient(arkdUrl, { token: authToken });

  void (async () => {
    let backoffMs = 250;
    while (!stopped) {
      try {
        for await (const env of client.streamInterventions(sessionName, { signal: ac.signal })) {
          if (typeof env.content === "string" && env.content.length > 0) {
            onMessage(env.content);
          }
          if (env.control === "interrupt" && onInterrupt) {
            // Fire after onMessage so the correction is in the queue before abort.
            onInterrupt();
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

export type { InterventionEnvelope };
