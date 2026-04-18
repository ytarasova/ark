/**
 * Security tests for ArkD server:
 * - Bearer token authentication
 * - Exec command allowlist
 * - P1-4 workspace confinement for /file/* and /exec
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startArkd } from "../server.js";
import { allocatePort } from "../../core/config/port-allocator.js";

// ── Auth tests ────────────────────────────────────────────────────────────────

describe("ArkD auth (token option)", () => {
  let AUTH_PORT: number;
  let AUTH_BASE: string;
  const TOKEN = "test-secret-token-12345";
  let server: { stop(): void };

  beforeAll(async () => {
    AUTH_PORT = await allocatePort();
    AUTH_BASE = `http://localhost:${AUTH_PORT}`;
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
  let EXEC_PORT: number;
  let EXEC_BASE: string;
  let server: { stop(): void };

  beforeAll(async () => {
    EXEC_PORT = await allocatePort();
    EXEC_BASE = `http://localhost:${EXEC_PORT}`;
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

// ── P1-4: workspace-root confinement ──────────────────────────────────────────
//
// When arkd is booted with `workspaceRoot`, /file/* and /exec must reject
// every path that resolves outside that root, and honour the confinement
// for cwd on /exec. The legacy no-confinement mode is preserved for
// local-only / single-user deployments (tested elsewhere).

describe("ArkD workspace confinement (P1-4)", () => {
  const CONFINE_PORT = 19372;
  const CONFINE_BASE = `http://localhost:${CONFINE_PORT}`;
  let server: { stop(): void };
  let workspaceRoot: string;

  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "arkd-confined-"));
    // Seed a readable file inside the root so happy-path tests have something
    // to read back without depending on the host filesystem.
    writeFileSync(join(workspaceRoot, "ok.txt"), "inside");
    server = startArkd(CONFINE_PORT, { quiet: true, workspaceRoot });
  });

  afterAll(() => {
    server.stop();
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("/file/read of /etc/passwd returns 403", async () => {
    const resp = await fetch(`${CONFINE_BASE}/file/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/etc/passwd" }),
    });
    expect(resp.status).toBe(403);
    const data = (await resp.json()) as any;
    expect(data.error).toMatch(/workspace/);
  });

  it("/file/read with ../../escape is rejected with 403", async () => {
    const resp = await fetch(`${CONFINE_BASE}/file/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../../etc/passwd" }),
    });
    expect(resp.status).toBe(403);
  });

  it("/file/write to an absolute path outside root returns 403", async () => {
    const resp = await fetch(`${CONFINE_BASE}/file/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/evil-should-not-exist.txt", content: "nope" }),
    });
    expect(resp.status).toBe(403);
  });

  it("/file/mkdir outside root returns 403", async () => {
    const resp = await fetch(`${CONFINE_BASE}/file/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/var/tmp/arkd-breakout" }),
    });
    expect(resp.status).toBe(403);
  });

  it("/file/list of / is rejected with 403", async () => {
    const resp = await fetch(`${CONFINE_BASE}/file/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/" }),
    });
    expect(resp.status).toBe(403);
  });

  it("/file/read of a path inside the root succeeds", async () => {
    const resp = await fetch(`${CONFINE_BASE}/file/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(workspaceRoot, "ok.txt") }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    expect(data.content).toBe("inside");
  });

  it("/file/write inside the root succeeds", async () => {
    const target = join(workspaceRoot, "subdir/new.txt");
    // Create the parent first via /file/mkdir (also confined).
    const mkResp = await fetch(`${CONFINE_BASE}/file/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(workspaceRoot, "subdir") }),
    });
    expect(mkResp.status).toBe(200);
    const resp = await fetch(`${CONFINE_BASE}/file/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target, content: "ok" }),
    });
    expect(resp.status).toBe(200);
  });

  it("/exec with cwd outside root returns 403", async () => {
    const resp = await fetch(`${CONFINE_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo", args: ["hi"], cwd: "/etc" }),
    });
    expect(resp.status).toBe(403);
  });

  it("/exec without cwd defaults to the workspace root", async () => {
    const resp = await fetch(`${CONFINE_BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd", args: [] }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as any;
    // resolved workspaceRoot may differ by one trailing symlink segment on
    // macOS (/var vs /private/var). Compare by endsWith on the last path
    // component, which is unique per `mkdtempSync` invocation.
    const lastSeg = workspaceRoot.split("/").filter(Boolean).pop()!;
    expect(data.stdout.trim()).toContain(lastSeg);
  });
});
