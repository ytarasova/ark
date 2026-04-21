/**
 * Security-focused tests for arkd: token auth, path confinement, and
 * session name validation.
 *
 * These tests cover the fixes from the 2026-04-19 security audit and
 * should regress anyone who relaxes the relevant guards.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startArkd } from "../server.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let PORT: number;
let BASE: string;
let server: { stop(): void };

const TOKEN = "s3kritt0ken";

beforeAll(async () => {
  PORT = await allocatePort();
  BASE = `http://localhost:${PORT}`;
  server = startArkd(PORT, { quiet: true, token: TOKEN });
});

afterAll(() => {
  server.stop();
});

describe("arkd security", async () => {
  describe("bearer token auth", async () => {
    it("accepts the correct Bearer token", async () => {
      const resp = await fetch(`${BASE}/metrics`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(resp.status).toBe(200);
    });

    it("rejects an unauthenticated request", async () => {
      const resp = await fetch(`${BASE}/metrics`);
      expect(resp.status).toBe(401);
    });

    it("rejects a wrong Bearer token (constant-time compare)", async () => {
      const resp = await fetch(`${BASE}/metrics`, {
        headers: { Authorization: `Bearer ${TOKEN}_wrong` },
      });
      expect(resp.status).toBe(401);
    });

    it("rejects a Bearer token of a different length", async () => {
      const resp = await fetch(`${BASE}/metrics`, {
        headers: { Authorization: "Bearer x" },
      });
      expect(resp.status).toBe(401);
    });

    it("allows /health without a token (auth-exempt)", async () => {
      const resp = await fetch(`${BASE}/health`);
      expect(resp.status).toBe(200);
    });
  });

  describe("agent session name validation", async () => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

    it("rejects path-traversal session names in agent/launch", async () => {
      const resp = await fetch(`${BASE}/agent/launch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "../../tmp/poison", script: "#!/bin/sh\ntrue", workdir: "/tmp" }),
      });
      expect(resp.status).toBe(500);
      const data = (await resp.json()) as { error?: string };
      expect(String(data.error ?? "")).toContain("invalid sessionName");
    });

    it("rejects shell metachars in agent/kill session names", async () => {
      const resp = await fetch(`${BASE}/agent/kill`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "foo;rm -rf /" }),
      });
      expect(resp.status).toBe(500);
    });

    it("rejects session names containing slashes in agent/status", async () => {
      const resp = await fetch(`${BASE}/agent/status`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "a/b" }),
      });
      expect(resp.status).toBe(500);
    });
  });
});
