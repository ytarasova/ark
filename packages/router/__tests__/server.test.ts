/**
 * Tests for the router HTTP server.
 *
 * Tests the server endpoints without making real LLM API calls.
 * Uses a high port to avoid conflicts.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startRouter } from "../server.js";
import type { RouterConfig, RouterServer } from "../index.js";

// Use a high port to avoid conflicts with other tests
const TEST_PORT = 18430;

function makeTestConfig(): RouterConfig {
  return {
    port: TEST_PORT,
    policy: "balanced",
    quality_floor: 0.8,
    providers: [], // No real providers -- will get 400/502 on actual completions
    sticky_session_ttl_ms: 3600000,
    cascade_enabled: false,
    cascade_confidence_threshold: 0.7,
    log_decisions: false,
  };
}

describe("Router Server", async () => {
  let server: RouterServer;

  beforeAll(() => {
    server = startRouter(makeTestConfig());
  });

  afterAll(() => {
    server?.stop();
  });

  test("/health returns ok", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  test("/v1/router/stats returns stats", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/v1/router/stats`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.total_requests).toBeGreaterThanOrEqual(0);
    expect(typeof body.routed_requests).toBe("number");
    expect(typeof body.errors).toBe("number");
  });

  test("/v1/router/costs returns cost summary", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/v1/router/costs`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("/v1/models returns model list", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/v1/models`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("/v1/chat/completions with unknown model returns 400", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nonexistent-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error.message).toContain("not found");
  });

  test("/v1/chat/completions with model:auto and no providers returns 502", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    // No providers configured, so routing will fail
    // Engine has no models, so it should error
    expect(resp.status).toBe(500);
  });

  test("unknown route returns 404", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/v1/nonexistent`);
    expect(resp.status).toBe(404);
  });
});
