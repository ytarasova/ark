/**
 * ArkdClient request-timeout tests.
 *
 * Pass-5 silent-failure remediation: a live EC2 dispatch hung for 7+ minutes
 * because the fetch against an unreachable arkd URL never resolved. Every
 * fetch in `arkd/client.ts` MUST honour a per-call `AbortSignal.timeout` so
 * an unreachable daemon surfaces as an AbortError within the configured
 * window rather than wedging the dispatch listener forever.
 *
 * Strategy:
 *   - Stand up a Bun.serve() that accepts the connection but never writes a
 *     response body. fetch() against this hangs until the timeout fires.
 *   - Set requestTimeoutMs to ~250ms; assert each method (post, get,
 *     attachStream, run) rejects within timeout + 500ms.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ArkdClient } from "../client.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let server: { stop(): Promise<void> | void };
let baseUrl: string;
const inflightAborts: AbortController[] = [];

beforeAll(async () => {
  const port = await allocatePort();
  // A server that holds the request open until the test forces a tear-down.
  // We register every connection's AbortController in `inflightAborts` so
  // afterAll can cancel them; without that, `s.stop(true)` waits for the
  // handler Promise to resolve and our intentionally-never-resolves handler
  // would hang the suite shutdown.
  const s = Bun.serve({
    port,
    fetch: () =>
      new Promise<Response>((_resolve, reject) => {
        const ac = new AbortController();
        inflightAborts.push(ac);
        ac.signal.addEventListener("abort", () => reject(new Error("test teardown")));
      }),
  });
  server = { stop: () => s.stop(true) };
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  // Cancel any handler still parked in the never-resolves Promise so
  // server.stop() doesn't block on them.
  for (const ac of inflightAborts) {
    try {
      ac.abort();
    } catch {
      /* noop */
    }
  }
  await server?.stop();
});

const TIMEOUT_MS = 250;
const SLACK_MS = 750; // generous: GC pauses on CI shouldn't false-fail

async function timeIt<T>(fn: () => Promise<T>): Promise<{ ms: number; err: unknown }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0, err: null };
  } catch (err) {
    return { ms: Date.now() - t0, err };
  }
}

describe("ArkdClient request timeout", () => {
  it("post-shaped call (writeFile) rejects within timeout window when server hangs", async () => {
    const client = new ArkdClient(baseUrl, { requestTimeoutMs: TIMEOUT_MS });
    const { ms, err } = await timeIt(() => client.writeFile({ path: "/tmp/x", content: "x" }));
    expect(err).toBeTruthy();
    expect(ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  });

  it("get-shaped call (health) rejects within timeout window when server hangs", async () => {
    const client = new ArkdClient(baseUrl, { requestTimeoutMs: TIMEOUT_MS });
    const { ms, err } = await timeIt(() => client.health());
    expect(err).toBeTruthy();
    expect(ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  });

  it("attachStream rejects within timeout window when server hangs (connect timeout)", async () => {
    const client = new ArkdClient(baseUrl, { requestTimeoutMs: TIMEOUT_MS });
    const { ms, err } = await timeIt(() => client.attachStream("h-1"));
    expect(err).toBeTruthy();
    expect(ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  });

  it("run() effective timeout outlasts the requestTimeoutMs ceiling (server-side timeout + buffer)", async () => {
    // run() pads the fetch timeout with +30s above the server-side timeout.
    // We can't easily assert against the +30s buffer without waiting 30s,
    // but we CAN verify the early-abort path is gone: with requestTimeoutMs
    // set to TIMEOUT_MS (250ms), a normal post() rejects at 250ms+. run()
    // must NOT reject in that window -- its effective timeout is
    // max(250, 0 + 30_000) = 30_000ms. We confirm run() is still pending
    // after TIMEOUT_MS * 4 (1s), proving the requestTimeoutMs ceiling is
    // not what's gating run().
    const client = new ArkdClient(baseUrl, { requestTimeoutMs: TIMEOUT_MS });
    // Prove the post() floor first: a fast post fires at ~TIMEOUT_MS.
    const postReject = await timeIt(() => client.health());
    expect(postReject.err).toBeTruthy();
    expect(postReject.ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);

    // Now race run() against a 1s timer. run() must not reject in this
    // window. We attach a .catch so the eventual late-rejection (when the
    // server is stopped in afterAll) doesn't surface as unhandled.
    let runResolved = false;
    const runPromise = client
      .run({ command: "echo", args: ["hi"] })
      .then(() => {
        runResolved = true;
      })
      .catch(() => {
        runResolved = true;
      });
    await new Promise<void>((r) => setTimeout(r, TIMEOUT_MS * 4));
    expect(runResolved).toBe(false);
    // Don't leave the promise dangling: void it. afterAll's server.stop(true)
    // will close the socket and the promise will resolve via .catch.
    void runPromise;
  });
});
