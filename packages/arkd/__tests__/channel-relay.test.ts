/**
 * Tests for arkd channel relay -- arkd as conductor transport layer.
 *
 * Tests the 3 sibling routes:
 *   POST /channel/:sessionId  -- agent report published on the `hooks` channel
 *   POST /channel/relay       -- agent-to-agent relay published on the `hooks` channel
 *   POST /channel/deliver     -- conductor-to-agent delivery to local channel port
 *
 * Also tests the /config endpoint for runtime conductorUrl management.
 *
 * Post-SSM-migration shape: report + relay no longer POST to the conductor
 * directly (the EC2 reverse tunnel is gone); instead they publish on arkd's
 * generic `hooks` channel and the conductor subscribes via
 * `/channel/hooks/subscribe`. We verify both that the channel routes still
 * return success to the agent AND that the conductor never receives a
 * direct POST to `/api/channel/...` or `/api/relay` from arkd.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { startArkd } from "../server.js";
import { ArkdClient } from "../client.js";
import { _resetForTests as resetChannels } from "../routes/channels.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let ARKD_PORT: number;
let CONDUCTOR_PORT: number;
let CHANNEL_PORT: number;

let arkdServer: ReturnType<typeof startArkd>;
let client: ArkdClient;

// Captured requests from mock servers
let conductorRequests: { path: string; body: Record<string, unknown> }[] = [];
let channelRequests: { body: Record<string, unknown> }[] = [];
let mockConductor: { stop(closeActiveConnections?: boolean): void };
let mockChannel: { stop(closeActiveConnections?: boolean): void };

beforeAll(async () => {
  ARKD_PORT = await allocatePort();
  CONDUCTOR_PORT = await allocatePort();
  CHANNEL_PORT = await allocatePort();
  // Start arkd with conductor URL pointing to our mock. The conductor URL
  // is no longer used for report/relay (those go through the `hooks`
  // channel), but it still configures `/config` and is kept for back-compat
  // probes.
  arkdServer = startArkd(ARKD_PORT, {
    quiet: true,
    conductorUrl: `http://localhost:${CONDUCTOR_PORT}`,
  });
  client = new ArkdClient(`http://localhost:${ARKD_PORT}`);

  // Mock conductor - captures requests. Used to assert that arkd does NOT
  // POST report/relay to the conductor any more.
  mockConductor = Bun.serve({
    port: CONDUCTOR_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : null;
      conductorRequests.push({ path: url.pathname, body });
      return Response.json({ status: "ok" });
    },
  });

  // Mock channel server - captures delivered messages
  mockChannel = Bun.serve({
    port: CHANNEL_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") return new Response("ark-channel");
      const body = await req.json();
      channelRequests.push({ body });
      return new Response("ok");
    },
  });
});

afterAll(() => {
  arkdServer.stop();
  mockConductor.stop();
  mockChannel.stop();
});

beforeEach(() => {
  resetChannels();
  conductorRequests = [];
  channelRequests = [];
});

// ── Config endpoint ────────────────────────────────────────────────────────

describe("/config", async () => {
  it("GET returns current conductorUrl", async () => {
    const cfg = await client.getConfig();
    expect(cfg.ok).toBe(true);
    expect(cfg.conductorUrl).toBe(`http://localhost:${CONDUCTOR_PORT}`);
  });

  it("POST updates conductorUrl", async () => {
    await client.setConfig({ conductorUrl: "http://example.com:9999" });
    const cfg = await client.getConfig();
    expect(cfg.conductorUrl).toBe("http://example.com:9999");

    // Restore for remaining tests
    await client.setConfig({ conductorUrl: `http://localhost:${CONDUCTOR_PORT}` });
  });
});

/**
 * Open a WS subscriber on `/ws/channel/hooks` and resolve with the first
 * envelope frame after the server's `{ type: "subscribed" }` ack. Times out
 * after 2s so a stuck test fails fast instead of hanging.
 *
 * The ack is sent from inside the server's `open()` handler -- after the
 * subscriber is registered AND after the ring buffer is drained -- so any
 * pre-buffered envelope arrives at the client BEFORE the ack. This helper
 * uses a single message listener that buffers envelope frames into a queue
 * and resolves the ack promise on the control frame; that way no buffered
 * envelope is dropped between ack-wait and reading.
 */
async function readFirstFrame(arkdPort: number, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://localhost:${arkdPort}/ws/channel/hooks`);
  const buffered: Record<string, unknown>[] = [];
  let waker: (() => void) | null = null;
  const wake = (): void => {
    const w = waker;
    waker = null;
    if (w) w();
  };
  let ackResolve!: () => void;
  let ackReject!: (err: Error) => void;
  const ackPromise = new Promise<void>((resolve, reject) => {
    ackResolve = resolve;
    ackReject = reject;
  });

  ws.addEventListener("message", (ev) => {
    try {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame.type === "subscribed") {
        ackResolve();
        return;
      }
      if (typeof frame.type === "string") return; // skip other control frames
      buffered.push(frame);
      wake();
    } catch {
      /* malformed -- skip */
    }
  });
  ws.addEventListener("error", () => ackReject(new Error("ws error before ack")), { once: true });
  ws.addEventListener("close", () => {
    ackReject(new Error("ws closed before ack"));
    wake();
  });

  try {
    await Promise.race([
      ackPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("subscribed ack timeout")), timeoutMs)),
    ]);

    const frame = await Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        const tryDrain = (): void => {
          if (buffered.length > 0) {
            resolve(buffered.shift()!);
            return;
          }
          waker = tryDrain;
        };
        tryDrain();
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first frame timeout")), timeoutMs)),
    ]);
    return frame;
  } finally {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ── Channel report enqueue (no direct POST to conductor) ───────────────────

describe("/channel/:sessionId (report enqueue)", async () => {
  it("returns ok+forwarded and does NOT POST to conductor", async () => {
    const report = { type: "progress", message: "Working on it", stage: "work" };

    const result = await client.channelReport("s-test-123", report);
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    // Critical regression assertion: arkd must not call out to the
    // conductor's `/api/channel/...` directly any more. That POST silently
    // fails on EC2 under pure SSM and was the root cause of stuck sessions.
    // Give the (non-existent) request a tick to fire if it were going to.
    await Bun.sleep(50);
    const directHits = conductorRequests.filter((r) => r.path.startsWith("/api/channel/"));
    expect(directHits.length).toBe(0);
  });

  it("returns ok+forwarded for a completed report with all fields", async () => {
    const report = {
      type: "completed",
      summary: "Done with feature",
      filesChanged: ["src/foo.ts", "src/bar.ts"],
      commits: ["abc123"],
      pr_url: "https://github.com/owner/repo/pull/42",
      stage: "implement",
    };

    const result = await client.channelReport("s-test-456", report);
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);
  });

  it("returns ok+forwarded even when no conductorUrl configured", async () => {
    // The hooks-channel path doesn't depend on the conductor URL at all --
    // arkd just publishes on the channel and the conductor's subscriber is
    // responsible for draining. So clearing the URL must not break report.
    await client.setConfig({ conductorUrl: "" });
    const result = await client.channelReport("s-test-789", { type: "progress", message: "test" });
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    await client.setConfig({ conductorUrl: `http://localhost:${CONDUCTOR_PORT}` });
  });

  it("publishes a channel-report envelope visible on /channel/hooks/subscribe", async () => {
    await client.channelReport("s-stream-1", { type: "completed", summary: "done" });

    const frame = await readFirstFrame(ARKD_PORT);
    expect(frame.kind).toBe("channel-report");
    expect(frame.session).toBe("s-stream-1");
    expect((frame.body as Record<string, unknown>).type).toBe("completed");
    expect((frame.body as Record<string, unknown>).summary).toBe("done");
  });

  it("preserves tenantId from X-Ark-Tenant-Id header on the queued envelope", async () => {
    await fetch(`http://localhost:${ARKD_PORT}/channel/s-tenant-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ark-Tenant-Id": "tenant-acme" },
      body: JSON.stringify({ type: "progress", message: "with tenant" }),
    });

    const frame = await readFirstFrame(ARKD_PORT);
    expect(frame.kind).toBe("channel-report");
    expect(frame.tenantId).toBe("tenant-acme");
  });
});

// ── Channel relay ──────────────────────────────────────────────────────────

describe("/channel/relay", async () => {
  it("returns ok+forwarded and does NOT POST to conductor", async () => {
    const result = await client.channelRelay({
      from: "s-agent-a",
      target: "s-agent-b",
      message: "Hey, I finished the plan",
    });
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    await Bun.sleep(50);
    const directHits = conductorRequests.filter((r) => r.path === "/api/relay");
    expect(directHits.length).toBe(0);
  });

  it("publishes a channel-relay envelope visible on /channel/hooks/subscribe", async () => {
    await client.channelRelay({
      from: "s-a",
      target: "s-b",
      message: "ping",
    });

    const frame = await readFirstFrame(ARKD_PORT);
    expect(frame.kind).toBe("channel-relay");
    const body = frame.body as Record<string, unknown>;
    expect(body.from).toBe("s-a");
    expect(body.target).toBe("s-b");
    expect(body.message).toBe("ping");
  });
});

// ── Channel deliver (conductor -> agent: unchanged) ────────────────────────

describe("/channel/deliver", async () => {
  it("delivers task to local channel port", async () => {
    const result = await client.channelDeliver({
      channelPort: CHANNEL_PORT,
      payload: { type: "task", task: "Implement auth module", sessionId: "s-test", stage: "work" },
    });
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(true);

    expect(channelRequests.length).toBe(1);
    expect(channelRequests[0].body.type).toBe("task");
    expect(channelRequests[0].body.task).toBe("Implement auth module");
  });

  it("delivers steer message to channel", async () => {
    await client.channelDeliver({
      channelPort: CHANNEL_PORT,
      payload: { type: "steer", message: "Focus on the auth part", from: "user", sessionId: "s-test" },
    });
    expect(channelRequests.length).toBe(1);
    expect(channelRequests[0].body.type).toBe("steer");
    expect(channelRequests[0].body.message).toBe("Focus on the auth part");
  });

  it("returns delivered:false when channel port unreachable", async () => {
    const result = await client.channelDeliver({
      channelPort: 1,
      payload: { type: "task", task: "test" },
    });
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
  });
});

// ── Full round-trip ────────────────────────────────────────────────────────

describe("full relay chain", async () => {
  it("report -> arkd -> hooks channel (no direct conductor hit)", async () => {
    // Simulate what channel.ts does: POST report to arkd
    const resp = await fetch(`http://localhost:${ARKD_PORT}/channel/s-roundtrip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: "s-roundtrip",
        stage: "implement",
        summary: "All done",
        filesChanged: ["main.ts"],
        commits: ["def456"],
      }),
    });
    const result = (await resp.json()) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    // No direct conductor POST -- the hooks channel is the only path.
    await Bun.sleep(50);
    expect(conductorRequests.filter((r) => r.path.startsWith("/api/channel/")).length).toBe(0);
  });

  it("deliver -> arkd -> channel (end-to-end, unchanged)", async () => {
    // Simulate what conductor does: POST deliver to arkd
    const resp = await fetch(`http://localhost:${ARKD_PORT}/channel/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelPort: CHANNEL_PORT,
        payload: { type: "task", task: "Review the PR", sessionId: "s-deliver", stage: "review" },
      }),
    });
    const result = (await resp.json()) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(true);

    // Channel received the task
    expect(channelRequests[0].body.task).toBe("Review the PR");
  });
});
