/**
 * E2E resilience tests.
 *
 * Exercises error paths and concurrent load against the `/api/rpc` endpoint
 * and `/api/events/stream` SSE to make sure bad input, unknown methods, and
 * burst traffic all surface as clean JSON-RPC errors without taking the web
 * server down. Every assertion ends with a sanity `status/get` call so a
 * regression that wedges the server is caught even if the earlier assertions
 * accidentally pass.
 *
 * These tests hit HTTP directly (no browser needed) to keep them fast and
 * to avoid depending on UI surface area that changes often.
 */

import { test, expect } from "@playwright/test";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;

test.beforeAll(async () => {
  ws = await setupWebServer();
});

test.afterAll(async () => {
  if (ws) await ws.teardown();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Send a raw body to `/api/rpc` without the fixture's JSON-RPC envelope. */
async function postRaw(body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${ws.baseUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

/** Parse a JSON-RPC response body. Tolerates non-200 since the server replies
 * with a 400 + JSON-RPC envelope on malformed envelopes. */
async function parseRpc(
  res: Response,
): Promise<{ id?: unknown; result?: unknown; error?: { code: number; message: string } }> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, got (status=${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Sanity probe -- confirms the server is still serving RPC. */
async function assertServerResponsive(): Promise<void> {
  const data = await ws.rpc<{ total: number }>("status/get");
  expect(typeof data.total).toBe("number");
}

// ── Malformed request envelopes ─────────────────────────────────────────────

test("malformed JSON body is rejected without crashing the server", async () => {
  const res = await postRaw("{not valid json");
  // Server may return 400 or 500 depending on how the JSON body is consumed;
  // what matters is that (a) it doesn't hang, and (b) it doesn't kill the
  // process. We don't pin the exact code -- only that it's an error and not
  // a 2xx masquerading as success.
  expect(res.status).toBeGreaterThanOrEqual(400);
  await assertServerResponsive();
});

test("missing jsonrpc field returns INVALID_REQUEST (-32600)", async () => {
  const res = await postRaw(JSON.stringify({ id: 1, method: "status/get", params: {} }));
  expect(res.status).toBe(400);
  const body = await parseRpc(res);
  expect(body.error?.code).toBe(-32600);
  await assertServerResponsive();
});

test("missing method field returns INVALID_REQUEST (-32600)", async () => {
  const res = await postRaw(JSON.stringify({ jsonrpc: "2.0", id: 2, params: {} }));
  expect(res.status).toBe(400);
  const body = await parseRpc(res);
  expect(body.error?.code).toBe(-32600);
  await assertServerResponsive();
});

test("wrong jsonrpc version returns INVALID_REQUEST (-32600)", async () => {
  const res = await postRaw(JSON.stringify({ jsonrpc: "1.0", id: 3, method: "status/get", params: {} }));
  expect(res.status).toBe(400);
  const body = await parseRpc(res);
  expect(body.error?.code).toBe(-32600);
  await assertServerResponsive();
});

test("empty POST body is rejected without crashing", async () => {
  const res = await postRaw("");
  expect(res.status).toBeGreaterThanOrEqual(400);
  await assertServerResponsive();
});

// ── Router-level errors ─────────────────────────────────────────────────────

test("unknown method returns METHOD_NOT_FOUND (-32601)", async () => {
  const res = await ws.rpcRaw("does/not/exist");
  expect(res.ok).toBe(true); // router-dispatched errors come back as 200 + JSON-RPC error body
  const body = await parseRpc(res);
  expect(body.error?.code).toBe(-32601);
  expect(body.error?.message).toMatch(/unknown method/i);
  await assertServerResponsive();
});

test("missing required param surfaces INVALID_PARAMS (-32602)", async () => {
  // session/read requires `sessionId` -- call with no params.
  const res = await ws.rpcRaw("session/read", {});
  const body = await parseRpc(res);
  expect(body.error?.code).toBe(-32602);
  await assertServerResponsive();
});

test("session/read on unknown id returns SESSION_NOT_FOUND (-32002)", async () => {
  const res = await ws.rpcRaw("session/read", { sessionId: "s-does-not-exist-xyz" });
  const body = await parseRpc(res);
  expect(body.error?.code).toBe(-32002);
  expect(body.error?.message).toMatch(/not found/i);
  await assertServerResponsive();
});

test("malformed params (wrong type) surfaces a JSON-RPC error, not a crash", async () => {
  // `sessionId` is typed as a string in the zod schema. Passing a number
  // should be rejected by validateRequest; if no schema is registered,
  // the handler's extract() still accepts the presence and later code
  // throws -- either way it must be a JSON-RPC error, not a 500/hang.
  const res = await ws.rpcRaw("session/read", { sessionId: 12345 });
  const body = await parseRpc(res);
  expect(body.error).toBeTruthy();
  expect(typeof body.error?.code).toBe("number");
  await assertServerResponsive();
});

// ── Load & concurrency ──────────────────────────────────────────────────────

test("handles a burst of 50 concurrent status/get requests", async () => {
  const requests = Array.from({ length: 50 }, () => ws.rpc<{ total: number }>("status/get"));
  const results = await Promise.all(requests);
  expect(results).toHaveLength(50);
  for (const r of results) {
    expect(typeof r.total).toBe("number");
  }
  await assertServerResponsive();
});

test("mixed valid + invalid concurrent requests don't poison valid ones", async () => {
  // Interleave 20 good calls with 20 bad ones. Every good call must succeed;
  // every bad call must surface a JSON-RPC error. A regression where a bad
  // request took out a shared router/db handle would show up here as either
  // a rejection on the good calls or a timeout.
  const good = Array.from({ length: 20 }, () => ws.rpc<{ total: number }>("status/get"));
  const bad = Array.from({ length: 20 }, () => ws.rpcRaw("does/not/exist"));

  const [goodSettled, badSettled] = await Promise.all([
    Promise.allSettled(good),
    Promise.all(bad.map(async (p) => parseRpc(await p))),
  ]);

  for (const r of goodSettled) {
    expect(r.status).toBe("fulfilled");
  }
  for (const r of badSettled) {
    expect(r.error?.code).toBe(-32601);
  }
  await assertServerResponsive();
});

test("server stays responsive after a 100-request error barrage", async () => {
  // Hammer the router with requests that all fail at dispatch time.
  // If any path leaks memory, holds a lock, or crashes the process, the
  // final `assertServerResponsive()` will time out.
  const barrage = Array.from({ length: 100 }, () => ws.rpcRaw("missing/method"));
  const responses = await Promise.all(barrage);
  for (const res of responses) {
    const body = await parseRpc(res);
    expect(body.error?.code).toBe(-32601);
  }
  await assertServerResponsive();
});

// ── SSE stream resilience ───────────────────────────────────────────────────

test("SSE stream tolerates rapid connect/disconnect cycles", async () => {
  // Open and immediately abort the SSE connection five times. The server
  // registers each stream in an `sseClients` set and removes it on cancel;
  // a regression that forgets to clean up would accumulate orphan
  // controllers and eventually OOM or block new connections.
  for (let i = 0; i < 5; i++) {
    const ac = new AbortController();
    const res = await fetch(`${ws.baseUrl}/api/events/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    ac.abort();
    // Give the cancel callback a tick to drain the client from the set.
    await new Promise((r) => setTimeout(r, 50));
  }
  await assertServerResponsive();
});

test("SSE stream is reachable concurrently with RPC traffic", async () => {
  // Open an SSE stream, then do a few RPC calls -- the RPC path should not
  // be blocked by an active event-stream consumer. This regression would
  // show up as an "await never resolves" in shared-handler code.
  const ac = new AbortController();
  const ssePromise = fetch(`${ws.baseUrl}/api/events/stream`, { signal: ac.signal });

  try {
    const res = await ssePromise;
    expect(res.status).toBe(200);

    // Fire 5 RPC calls while the stream is held open.
    const calls = Array.from({ length: 5 }, () => ws.rpc<{ total: number }>("status/get"));
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(typeof r.total).toBe("number");
    }
  } finally {
    ac.abort();
  }
  await assertServerResponsive();
});

// ── Unknown HTTP routes ─────────────────────────────────────────────────────

test("unknown HTTP path does not crash the server", async () => {
  // The hosted web server falls back to the SPA index.html for most
  // non-API paths, and to a 404 if no index.html is built. Either
  // response is acceptable -- what matters is that a subsequent RPC
  // call still works.
  const res = await fetch(`${ws.baseUrl}/this/route/does/not/exist`);
  expect([200, 404]).toContain(res.status);
  await assertServerResponsive();
});
