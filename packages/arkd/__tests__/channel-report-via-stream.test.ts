/**
 * Regression test for the SSM channel-report fix.
 *
 * Pre-fix: arkd's `/channel/<sid>` handler POSTed to `${conductorUrl}/api/channel/...`,
 * which under pure SSM (no SSH `-R 19100:...` reverse tunnel) lands on the
 * EC2 instance's own loopback, where no conductor runs. Reports were silently
 * dropped and sessions stayed at "running" forever even though the agent had
 * reported "completed".
 *
 * Post-fix: arkd enqueues channel reports onto its events ring, the conductor
 * pulls them via the `/events/stream` long-poll over the forward `-L` tunnel,
 * and dispatches them through `handleReport` exactly like the legacy direct
 * HTTP path used to.
 *
 * What this test verifies (per the spec):
 *   1. A report POST to `arkd:/channel/<sid>` produces a `channel-report`
 *      typed frame on `/events/stream`, with the right session id, body,
 *      and tenantId.
 *   2. arkd does NOT make a separate POST to `${conductor}/api/channel/...`
 *      (regression guard against the silent-drop path).
 *   3. The arkd response to the channel-report POST is `{ ok: true,
 *      forwarded: true }` so the agent's channel MCP keeps treating it as
 *      success and the user-facing behaviour is unchanged.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startArkd } from "../server.js";
import { _resetEventBus } from "../routes/events.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let ARKD_PORT: number;
let CONDUCTOR_PORT: number;

let arkdServer: { stop(): void };
let conductorRequests: { path: string; method: string; body: unknown }[] = [];
let mockConductor: { stop(closeActiveConnections?: boolean): void };

beforeAll(async () => {
  ARKD_PORT = await allocatePort();
  CONDUCTOR_PORT = await allocatePort();

  // Stub conductor: any direct POST it receives is a regression. We
  // capture them so the assertions can prove arkd isn't calling out
  // any more.
  mockConductor = Bun.serve({
    port: CONDUCTOR_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      conductorRequests.push({ path: url.pathname, method: req.method, body });
      return Response.json({ status: "ok" });
    },
  });

  arkdServer = startArkd(ARKD_PORT, {
    quiet: true,
    conductorUrl: `http://127.0.0.1:${CONDUCTOR_PORT}`,
  });
});

afterAll(() => {
  arkdServer.stop();
  mockConductor.stop();
});

beforeEach(() => {
  _resetEventBus();
  conductorRequests = [];
});

afterEach(() => {
  _resetEventBus();
});

/**
 * Read NDJSON frames off `/events/stream` until `count` are collected
 * (or the stream closes), then abort and return.
 */
async function readFrames(arkdPort: number, count: number): Promise<unknown[]> {
  const abort = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${arkdPort}/events/stream`, { signal: abort.signal });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("Content-Type")).toBe("application/x-ndjson");

  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  const out: unknown[] = [];
  let buf = "";
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0 && out.length < count) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) out.push(JSON.parse(line));
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

describe("channel-report via /events/stream (SSM fix)", () => {
  test("report POST yields ok+forwarded and a channel-report frame on the stream", async () => {
    const sessionId = "s-stream-report";
    const report = {
      type: "completed",
      sessionId,
      stage: "implement",
      summary: "Did the thing",
      filesChanged: ["a.ts", "b.ts"],
      commits: ["abc123"],
    };

    const resp = await fetch(`http://127.0.0.1:${ARKD_PORT}/channel/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as { ok: boolean; forwarded: boolean };
    // Constraint: agent-visible response must remain `{ ok: true, forwarded: true }`.
    expect(j.ok).toBe(true);
    expect(j.forwarded).toBe(true);

    const frames = (await readFrames(ARKD_PORT, 1)) as Array<{
      kind: string;
      session: string;
      tenantId: string | null;
      body: { type: string; summary: string };
    }>;
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("channel-report");
    expect(frames[0].session).toBe(sessionId);
    expect(frames[0].body.type).toBe("completed");
    expect(frames[0].body.summary).toBe("Did the thing");
  });

  test("does NOT POST to ${conductor}/api/channel/... (regression guard)", async () => {
    const sessionId = "s-no-direct";
    await fetch(`http://127.0.0.1:${ARKD_PORT}/channel/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "completed", sessionId, summary: "done" }),
    });

    // Give any (now-removed) outbound POST a tick to fire.
    await Bun.sleep(50);
    const hits = conductorRequests.filter((r) => r.path.startsWith("/api/channel/"));
    expect(hits.length).toBe(0);
  });

  test("preserves X-Ark-Tenant-Id on the queued frame", async () => {
    await fetch(`http://127.0.0.1:${ARKD_PORT}/channel/s-tenant-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ark-Tenant-Id": "tenant-zzz",
      },
      body: JSON.stringify({ type: "progress", sessionId: "s-tenant-stream", message: "tick" }),
    });

    const frames = (await readFrames(ARKD_PORT, 1)) as Array<{
      kind: string;
      tenantId: string | null;
    }>;
    expect(frames[0].kind).toBe("channel-report");
    expect(frames[0].tenantId).toBe("tenant-zzz");
  });

  test("relay POST also yields a channel-relay frame on the stream", async () => {
    const resp = await fetch(`http://127.0.0.1:${ARKD_PORT}/channel/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "s-a", target: "s-b", message: "hello" }),
    });
    expect(resp.status).toBe(200);
    const j = (await resp.json()) as { ok: boolean; forwarded: boolean };
    expect(j.ok).toBe(true);
    expect(j.forwarded).toBe(true);

    // No direct conductor hit.
    await Bun.sleep(50);
    expect(conductorRequests.filter((r) => r.path === "/api/relay").length).toBe(0);

    const frames = (await readFrames(ARKD_PORT, 1)) as Array<{
      kind: string;
      tenantId: string | null;
      body: { from: string; target: string; message: string };
    }>;
    expect(frames[0].kind).toBe("channel-relay");
    expect(frames[0].body.from).toBe("s-a");
    expect(frames[0].body.target).toBe("s-b");
    expect(frames[0].body.message).toBe("hello");
  });
});
