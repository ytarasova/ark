/**
 * Unit tests for `probeReachability`.
 *
 * We stand up a tiny throwaway HTTP server per scenario rather than mocking
 * fetch, because the classifier matches against the messages Bun's real
 * fetch emits -- mocking would let the classifier drift from runtime
 * behaviour and silently regress.
 */

import { describe, it, expect } from "bun:test";
import { probeReachability } from "../infra/reachability.js";

describe("probeReachability", () => {
  it("returns online=true with httpStatus 200 when /health answers 2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/health") return new Response("ok", { status: 200 });
        return new Response("nf", { status: 404 });
      },
    });
    try {
      const r = await probeReachability(`http://localhost:${server.port}`);
      expect(r.online).toBe(true);
      expect(r.url).toBe(`http://localhost:${server.port}`);
      expect(r.httpStatus).toBe(200);
      expect(r.reason).toBeUndefined();
      expect(typeof r.latencyMs).toBe("number");
    } finally {
      server.stop();
    }
  });

  it("returns online=false with reason='http-error' when /health returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("sick", { status: 503 });
      },
    });
    try {
      const r = await probeReachability(`http://localhost:${server.port}`);
      expect(r.online).toBe(false);
      expect(r.reason).toBe("http-error");
      expect(r.httpStatus).toBe(503);
      expect(r.message).toContain("503");
    } finally {
      server.stop();
    }
  });

  it("returns online=false with reason='connection-refused' when nothing listens on the port", async () => {
    // Allocate a port, stop the server immediately -- the port is now free
    // and nothing will accept the probe's connect.
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = server.port;
    server.stop();
    const r = await probeReachability(`http://localhost:${port}`);
    expect(r.online).toBe(false);
    expect(r.reason).toBe("connection-refused");
    expect(r.url).toBe(`http://localhost:${port}`);
  });

  it("returns online=false with reason='timeout' when /health hangs past the timeout", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        // Hang long enough to blow the 150ms timeout we pass below.
        await Bun.sleep(1_000);
        return new Response("late");
      },
    });
    try {
      const r = await probeReachability(`http://localhost:${server.port}`, 150);
      expect(r.online).toBe(false);
      expect(r.reason).toBe("timeout");
      expect(r.message).toContain("150ms");
    } finally {
      server.stop();
    }
  });
});
