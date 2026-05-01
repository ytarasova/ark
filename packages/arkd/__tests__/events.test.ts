/**
 * /hooks/forward + /events/stream tests. Drive the live arkd HTTP
 * server so we exercise routing + chunked-stream framing end-to-end
 * (reading NDJSON over a real fetch, including the AbortSignal-driven
 * teardown path).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startArkd } from "../server.js";
import { _resetEventBus } from "../routes/events.js";
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

beforeEach(() => {
  _resetEventBus();
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

describe("/hooks/forward + /events/stream", () => {
  test("posted hook events stream out as NDJSON in FIFO order", async () => {
    // Producer: enqueue two events.
    const r1 = await fetch(`${baseUrl}/hooks/forward?session=s-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "AgentMessage", text: "first" }),
    });
    expect(r1.status).toBe(200);
    const r2 = await fetch(`${baseUrl}/hooks/forward?session=s-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(r2.status).toBe(200);

    // Consumer: open the stream, read 2 lines, abort.
    const abort = new AbortController();
    const stream = await fetch(`${baseUrl}/events/stream`, { signal: abort.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("Content-Type")).toBe("application/x-ndjson");

    const lines = (await readNdjsonLines(stream, 2, abort)) as Array<{
      kind: string;
      session: string;
      body: { hook_event_name: string; text?: string };
    }>;
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("hook");
    expect(lines[0].session).toBe("s-1");
    expect(lines[0].body.hook_event_name).toBe("AgentMessage");
    expect(lines[0].body.text).toBe("first");
    expect(lines[1].body.hook_event_name).toBe("Stop");
  });

  test("invalid JSON to /hooks/forward returns 400", async () => {
    const resp = await fetch(`${baseUrl}/hooks/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(resp.status).toBe(400);
  });

  // Note: a "stream parks then wakes when a producer posts later" test
  // is intentionally omitted here. In this test process the stream
  // reader and the POST share Bun's fetch keep-alive pool against the
  // same origin, so the POST queues behind the open stream and never
  // fires -- a test-harness artifact. In production the producer is
  // the agent's curl in a separate process, so the pool is not shared.
  // The park/wake property is exercised by `_resetEventBus + enqueue`
  // in `events-bus.test.ts`.

  test("missing ?session yields session=null on the stream line", async () => {
    await fetch(`${baseUrl}/hooks/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Notification" }),
    });
    const abort = new AbortController();
    const stream = await fetch(`${baseUrl}/events/stream`, { signal: abort.signal });
    const lines = (await readNdjsonLines(stream, 1, abort)) as Array<{
      session: string | null;
    }>;
    expect(lines[0].session).toBeNull();
  });
});
