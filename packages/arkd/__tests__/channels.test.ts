/**
 * /channel/{name}/publish + /channel/{name}/subscribe tests.
 *
 * Drives a live arkd to verify the generic pub/sub primitive:
 *   - publish-before-subscribe buffers; subscriber drains FIFO on connect
 *   - publish-after-subscribe hands directly to the parked waiter
 *   - per-channel isolation
 *   - validation (channel name, envelope shape, JSON body)
 *   - clean teardown when the subscriber aborts
 *   - opaque envelopes (arkd does not parse, deeply-nested JSON round-trips)
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startArkd } from "../server.js";
import { _resetForTests } from "../routes/channels.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let server: { stop(): void };
let port: number;
let baseUrl: string;

beforeAll(async () => {
  port = await allocatePort();
  server = startArkd(port, { quiet: true });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  _resetForTests();
});

async function readNdjsonLines(resp: Response, max: number, abort: AbortController): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0 && out.length < max) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) out.push(JSON.parse(line));
      nl = buf.indexOf("\n");
    }
  }
  abort.abort();
  try {
    await reader.cancel();
  } catch {
    /* already cancelled */
  }
  return out;
}

async function publish(channel: string, envelope: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/channel/${encodeURIComponent(channel)}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
}

describe("/channel/{name}/publish + /channel/{name}/subscribe", () => {
  test("buffers envelopes until a subscriber connects, then drains FIFO", async () => {
    // Publish two while no consumer is parked.
    const r1 = await publish("hooks", { kind: "hook", session: "s-1", body: { event: "first" } });
    expect(r1.ok).toBe(true);
    expect(((await r1.json()) as { delivered: boolean }).delivered).toBe(false);

    const r2 = await publish("hooks", { kind: "hook", session: "s-1", body: { event: "second" } });
    expect(r2.ok).toBe(true);
    expect(((await r2.json()) as { delivered: boolean }).delivered).toBe(false);

    // Subscribe and drain both.
    const ac = new AbortController();
    const resp = await fetch(`${baseUrl}/channel/hooks/subscribe`, { signal: ac.signal });
    expect(resp.headers.get("Content-Type")).toBe("application/x-ndjson");
    const lines = (await readNdjsonLines(resp, 2, ac)) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect((lines[0].body as { event: string }).event).toBe("first");
    expect((lines[1].body as { event: string }).event).toBe("second");
  });

  test("hands directly to a parked subscriber (delivered=true)", async () => {
    const ac = new AbortController();
    const respPromise = fetch(`${baseUrl}/channel/user-input/subscribe`, { signal: ac.signal });
    // Give arkd a moment to register the parked waiter before the publish.
    await new Promise((r) => setTimeout(r, 25));

    const r = await publish("user-input", { session: "s-x", content: "hello" });
    expect(((await r.json()) as { delivered: boolean }).delivered).toBe(true);

    const resp = await respPromise;
    const lines = (await readNdjsonLines(resp, 1, ac)) as Array<Record<string, unknown>>;
    expect(lines).toEqual([{ session: "s-x", content: "hello" }]);
  });

  test("multi-channel isolation: publish to A does not appear on B", async () => {
    await publish("a-channel", { tag: "for A" });
    await publish("b-channel", { tag: "for B" });

    // Subscribe to B first; should see exactly its own payload.
    const acB = new AbortController();
    const respB = await fetch(`${baseUrl}/channel/b-channel/subscribe`, { signal: acB.signal });
    const linesB = (await readNdjsonLines(respB, 1, acB)) as Array<Record<string, unknown>>;
    expect(linesB).toEqual([{ tag: "for B" }]);

    // A's queue is untouched.
    const acA = new AbortController();
    const respA = await fetch(`${baseUrl}/channel/a-channel/subscribe`, { signal: acA.signal });
    const linesA = (await readNdjsonLines(respA, 1, acA)) as Array<Record<string, unknown>>;
    expect(linesA).toEqual([{ tag: "for A" }]);
  });

  test("rejects channel names with spaces or slashes (publish)", async () => {
    const r1 = await fetch(`${baseUrl}/channel/${encodeURIComponent("has spaces")}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: { ok: 1 } }),
    });
    expect(r1.status).toBe(400);

    // Nested path -- two segments between /channel/ and /publish.
    const r2 = await fetch(`${baseUrl}/channel/foo/bar/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: { ok: 1 } }),
    });
    expect(r2.status).toBe(400);
  });

  test("rejects channel names with spaces or slashes (subscribe)", async () => {
    const r1 = await fetch(`${baseUrl}/channel/${encodeURIComponent("has spaces")}/subscribe`);
    expect(r1.status).toBe(400);

    const r2 = await fetch(`${baseUrl}/channel/foo/bar/subscribe`);
    expect(r2.status).toBe(400);
  });

  test("rejects publish with missing or invalid envelope", async () => {
    // Missing envelope field
    const r1 = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);

    // Envelope is not an object
    const r2 = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: "not-an-object" }),
    });
    expect(r2.status).toBe(400);

    // Envelope is an array (also rejected -- want a JSON object)
    const r3 = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: [1, 2, 3] }),
    });
    expect(r3.status).toBe(400);
  });

  test("rejects publish with invalid JSON body", async () => {
    const r = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });

  test("subscriber abort cleanly closes the stream", async () => {
    const ac = new AbortController();
    // Open the subscribe -- the server parks a waiter on this connection.
    const respPromise = fetch(`${baseUrl}/channel/c-abort/subscribe`, { signal: ac.signal });
    // Give the server a moment to register the parked waiter.
    await Bun.sleep(50);
    // Abort the request. Bun's fetch surfaces the abort as a rejection on
    // the response promise (and arkd's request signal aborts, tearing
    // down the drain loop server-side).
    ac.abort();
    const aborted = await respPromise.then(
      () => ({ thrown: false }),
      () => ({ thrown: true }),
    );
    // We don't care which shape Bun chose -- the property under test is
    // that the server-side waiter was removed cleanly. We assert that by
    // publishing on the same channel afterwards: with no parked waiter,
    // `delivered` must be false (the envelope is buffered).
    expect(aborted.thrown).toBe(true);
    // Tick to give the abort listener time to splice the waiter out of
    // the channel's parked-list.
    await Bun.sleep(50);
    const r = await publish("c-abort", { ok: 1 });
    expect(((await r.json()) as { delivered: boolean }).delivered).toBe(false);
  });

  test("envelope is opaque: arbitrary nested objects round-trip unchanged", async () => {
    const env = {
      kind: "hook",
      session: "s-deep",
      meta: {
        nested: {
          arr: [1, "two", { three: true }],
          n: null,
          b: false,
        },
      },
      ts: "2026-05-02T00:00:00.000Z",
    };
    await publish("opaque", env);
    const ac = new AbortController();
    const resp = await fetch(`${baseUrl}/channel/opaque/subscribe`, { signal: ac.signal });
    const lines = (await readNdjsonLines(resp, 1, ac)) as Array<Record<string, unknown>>;
    expect(lines[0]).toEqual(env);
  });
});
