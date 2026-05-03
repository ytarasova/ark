/**
 * /agent/user-message + /agent/user-messages/stream tests. Drives a live
 * arkd to verify FIFO ordering, multi-session isolation, control:"interrupt"
 * passthrough, request validation, and AbortSignal teardown.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startArkd } from "../server.js";
import { _resetForTests } from "../routes/user-messages.js";
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

describe("/agent/user-message", () => {
  test("buffers messages until a stream subscribes, then drains FIFO", async () => {
    // Publish two while no consumer is parked.
    const r1 = await fetch(`${baseUrl}/agent/user-message?session=ark-s-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "first" }),
    });
    expect(r1.ok).toBe(true);
    expect(((await r1.json()) as { delivered: boolean }).delivered).toBe(false);

    const r2 = await fetch(`${baseUrl}/agent/user-message?session=ark-s-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "second", control: "interrupt" }),
    });
    expect(r2.ok).toBe(true);

    // Subscribe and drain both.
    const ac = new AbortController();
    const resp = await fetch(`${baseUrl}/agent/user-messages/stream?session=ark-s-1`, { signal: ac.signal });
    const lines = (await readNdjsonLines(resp, 2, ac)) as Array<{ content: string; control?: string }>;
    expect(lines).toEqual([{ content: "first" }, { content: "second", control: "interrupt" }]);
  });

  test("hands directly to a parked consumer (delivered=true)", async () => {
    const ac = new AbortController();
    const respPromise = fetch(`${baseUrl}/agent/user-messages/stream?session=ark-s-2`, { signal: ac.signal });
    // Give arkd a moment to register the parked waiter before the publish.
    await new Promise((r) => setTimeout(r, 25));

    const r = await fetch(`${baseUrl}/agent/user-message?session=ark-s-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(((await r.json()) as { delivered: boolean }).delivered).toBe(true);

    const resp = await respPromise;
    const lines = await readNdjsonLines(resp, 1, ac);
    expect(lines).toEqual([{ content: "hello" }]);
  });

  test("multi-session isolation: A's queue is untouched while B drains", async () => {
    await fetch(`${baseUrl}/agent/user-message?session=ark-s-A`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "for A" }),
    });
    await fetch(`${baseUrl}/agent/user-message?session=ark-s-B`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "for B" }),
    });

    const ac = new AbortController();
    const resp = await fetch(`${baseUrl}/agent/user-messages/stream?session=ark-s-B`, { signal: ac.signal });
    const lines = await readNdjsonLines(resp, 1, ac);
    expect(lines).toEqual([{ content: "for B" }]);

    // A's queue should still hold its message, retrievable on its own subscription.
    const ac2 = new AbortController();
    const resp2 = await fetch(`${baseUrl}/agent/user-messages/stream?session=ark-s-A`, { signal: ac2.signal });
    const lines2 = await readNdjsonLines(resp2, 1, ac2);
    expect(lines2).toEqual([{ content: "for A" }]);
  });

  test("rejects missing/invalid session param", async () => {
    const r1 = await fetch(`${baseUrl}/agent/user-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(r1.status).toBe(400);

    const r2 = await fetch(`${baseUrl}/agent/user-message?session=has spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(r2.status).toBe(400);
  });

  test("rejects empty content", async () => {
    const r = await fetch(`${baseUrl}/agent/user-message?session=ark-s-3`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(r.status).toBe(400);
  });

  test("rejects unknown control values", async () => {
    const r = await fetch(`${baseUrl}/agent/user-message?session=ark-s-4`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x", control: "explode" }),
    });
    expect(r.status).toBe(400);
  });
});
