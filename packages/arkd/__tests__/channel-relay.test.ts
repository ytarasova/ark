/**
 * Tests for arkd channel relay - arkd as conductor transport layer.
 *
 * Tests the 3 relay endpoints:
 *   POST /channel/:sessionId  - agent report forwarding to conductor
 *   POST /channel/relay       - agent-to-agent relay via conductor
 *   POST /channel/deliver     - conductor-to-agent delivery to local channel port
 *
 * Also tests the /config endpoint for runtime conductorUrl management.
 *
 * Uses a real arkd + a mock conductor + a mock channel server to verify
 * the full forwarding chain.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startArkd } from "../server.js";
import { ArkdClient } from "../client.js";

const ARKD_PORT = 19310;
const CONDUCTOR_PORT = 19311;
const CHANNEL_PORT = 19312;

let arkdServer: ReturnType<typeof startArkd>;
let client: ArkdClient;

// Captured requests from mock servers
let conductorRequests: { path: string; body: Record<string, unknown> }[] = [];
let channelRequests: { body: Record<string, unknown> }[] = [];
let mockConductor: { stop(closeActiveConnections?: boolean): void };
let mockChannel: { stop(closeActiveConnections?: boolean): void };

beforeAll(() => {
  // Start arkd with conductor URL pointing to our mock
  arkdServer = startArkd(ARKD_PORT, {
    quiet: true,
    conductorUrl: `http://localhost:${CONDUCTOR_PORT}`,
  });
  client = new ArkdClient(`http://localhost:${ARKD_PORT}`);

  // Mock conductor - captures requests
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

// ── Config endpoint ────────────────────────────────────────────────────────

describe("/config", () => {
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

// ── Channel report forwarding ──────────────────────────────────────────────

describe("/channel/:sessionId (report forwarding)", () => {
  it("forwards report to conductor", async () => {
    conductorRequests = [];
    const report = { type: "progress", message: "Working on it", stage: "work" };

    const result = await client.channelReport("s-test-123", report);
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    // Verify conductor received it
    expect(conductorRequests.length).toBe(1);
    expect(conductorRequests[0].path).toBe("/api/channel/s-test-123");
    expect(conductorRequests[0].body.type).toBe("progress");
    expect(conductorRequests[0].body.message).toBe("Working on it");
  });

  it("forwards completed report with all fields", async () => {
    conductorRequests = [];
    const report = {
      type: "completed",
      summary: "Done with feature",
      filesChanged: ["src/foo.ts", "src/bar.ts"],
      commits: ["abc123"],
      pr_url: "https://github.com/owner/repo/pull/42",
      stage: "implement",
    };

    await client.channelReport("s-test-456", report);
    expect(conductorRequests[0].body.type).toBe("completed");
    expect(conductorRequests[0].body.pr_url).toBe("https://github.com/owner/repo/pull/42");
    expect(conductorRequests[0].body.filesChanged).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("returns forwarded:false when no conductorUrl", async () => {
    await client.setConfig({ conductorUrl: "" });
    const result = await client.channelReport("s-test-789", { type: "progress", message: "test" });
    expect(result.forwarded).toBe(false);

    // Restore
    await client.setConfig({ conductorUrl: `http://localhost:${CONDUCTOR_PORT}` });
  });

  it("returns forwarded:false when conductor unreachable", async () => {
    await client.setConfig({ conductorUrl: "http://localhost:1" });
    const result = await client.channelReport("s-test-000", { type: "error", error: "boom" });
    expect(result.ok).toBe(false);
    expect(result.forwarded).toBe(false);

    // Restore
    await client.setConfig({ conductorUrl: `http://localhost:${CONDUCTOR_PORT}` });
  });
});

// ── Channel relay ──────────────────────────────────────────────────────────

describe("/channel/relay", () => {
  it("forwards relay to conductor /api/relay", async () => {
    conductorRequests = [];

    const result = await client.channelRelay({
      from: "s-agent-a",
      target: "s-agent-b",
      message: "Hey, I finished the plan",
    });
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    expect(conductorRequests.length).toBe(1);
    expect(conductorRequests[0].path).toBe("/api/relay");
    expect(conductorRequests[0].body.from).toBe("s-agent-a");
    expect(conductorRequests[0].body.target).toBe("s-agent-b");
    expect(conductorRequests[0].body.message).toBe("Hey, I finished the plan");
  });
});

// ── Channel deliver ────────────────────────────────────────────────────────

describe("/channel/deliver", () => {
  it("delivers task to local channel port", async () => {
    channelRequests = [];

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
    channelRequests = [];

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

describe("full relay chain", () => {
  it("report → arkd → conductor (end-to-end)", async () => {
    conductorRequests = [];

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
    const result = await resp.json() as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);

    // Conductor received the full report
    const req = conductorRequests[0];
    expect(req.path).toBe("/api/channel/s-roundtrip");
    expect(req.body.summary).toBe("All done");
  });

  it("deliver → arkd → channel (end-to-end)", async () => {
    channelRequests = [];

    // Simulate what conductor does: POST deliver to arkd
    const resp = await fetch(`http://localhost:${ARKD_PORT}/channel/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelPort: CHANNEL_PORT,
        payload: { type: "task", task: "Review the PR", sessionId: "s-deliver", stage: "review" },
      }),
    });
    const result = await resp.json() as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(true);

    // Channel received the task
    expect(channelRequests[0].body.task).toBe("Review the PR");
  });
});
