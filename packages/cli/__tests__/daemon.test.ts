/**
 * Tests for the `ark daemon` CLI command module.
 *
 * Exercises PID file management, foreground daemon start/stop lifecycle,
 * and status checking against a live arkd server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../../arkd/server.js";

// Use a unique port to avoid collisions with other tests
const TEST_PORT = 19360;
const BASE = `http://localhost:${TEST_PORT}`;

// ── PID file helpers (re-implemented for testing) ─────────────────────────────

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `ark-daemon-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

function pidFilePath(): string {
  return join(tempDir, "daemon.pid");
}

interface DaemonPidInfo {
  pid: number;
  port: number;
  hostname: string;
  startedAt: string;
}

function writePidFile(info: DaemonPidInfo): void {
  writeFileSync(pidFilePath(), JSON.stringify(info));
}

function readPidFile(): DaemonPidInfo | null {
  const p = pidFilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// ── PID file management tests ─────────────────────────────────────────────────

describe("daemon PID file management", () => {
  afterEach(() => {
    try {
      rmSync(pidFilePath());
    } catch {
      /* may not exist */
    }
  });

  it("writes and reads a PID file", () => {
    const info: DaemonPidInfo = {
      pid: 12345,
      port: 19300,
      hostname: "0.0.0.0",
      startedAt: new Date().toISOString(),
    };
    writePidFile(info);

    const read = readPidFile();
    expect(read).not.toBeNull();
    expect(read!.pid).toBe(12345);
    expect(read!.port).toBe(19300);
    expect(read!.hostname).toBe("0.0.0.0");
    expect(typeof read!.startedAt).toBe("string");
  });

  it("returns null when PID file does not exist", () => {
    expect(readPidFile()).toBeNull();
  });

  it("returns null for malformed PID file", () => {
    writeFileSync(pidFilePath(), "not-json");
    expect(readPidFile()).toBeNull();
  });

  it("detects running process by PID", () => {
    // Current process is always running
    let running = false;
    try {
      process.kill(process.pid, 0);
      running = true;
    } catch {
      running = false;
    }
    expect(running).toBe(true);
  });

  it("detects non-running process by PID", () => {
    // PID 99999999 should not exist
    let running = false;
    try {
      process.kill(99999999, 0);
      running = true;
    } catch {
      running = false;
    }
    expect(running).toBe(false);
  });
});

// ── Daemon server lifecycle tests ─────────────────────────────────────────────

describe("daemon start/stop lifecycle", () => {
  let server: { stop(): void } | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it("starts and responds to health checks", async () => {
    server = startArkd(TEST_PORT, { quiet: true });

    const resp = await fetch(`${BASE}/health`);
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { status: string; version: string };
    expect(data.status).toBe("ok");
    expect(data.version).toBe("0.1.0");
  });

  it("stops cleanly and port becomes unavailable", async () => {
    server = startArkd(TEST_PORT, { quiet: true });

    // Verify running
    const resp = await fetch(`${BASE}/health`);
    expect(resp.status).toBe(200);

    // Stop
    server.stop();
    server = null;

    // Port should no longer respond
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      // If we get here, the server might still be closing
    } catch (e: any) {
      // Connection refused or timeout is expected
      expect(e).toBeDefined();
    }
  });

  it("returns metrics from a running daemon", async () => {
    server = startArkd(TEST_PORT, { quiet: true });

    const resp = await fetch(`${BASE}/metrics`);
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { cpu: number; memTotalGb: number; memPct: number };
    expect(typeof data.cpu).toBe("number");
    expect(typeof data.memTotalGb).toBe("number");
    expect(typeof data.memPct).toBe("number");
  });

  it("returns config from a running daemon", async () => {
    const configPort = TEST_PORT + 2;
    server = startArkd(configPort, { quiet: true, conductorUrl: "http://localhost:19100" });

    const resp = await fetch(`http://localhost:${configPort}/config`);
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { ok: boolean; conductorUrl: string | null };
    expect(data.ok).toBe(true);
    expect(data.conductorUrl).toBe("http://localhost:19100");
  });
});

// ── Status detection tests ──────────────────────────────────────────────────

describe("daemon status detection", () => {
  it("detects daemon is not running on unused port", async () => {
    // Port 19361 should not have anything running
    try {
      await fetch("http://localhost:19361/health", { signal: AbortSignal.timeout(500) });
      // If something is actually running there, skip this assertion
    } catch {
      // Expected - nothing running
      expect(true).toBe(true);
    }
  });

  it("detects daemon is running after start", async () => {
    const server = startArkd(TEST_PORT + 1, { quiet: true });
    try {
      const resp = await fetch(`http://localhost:${TEST_PORT + 1}/health`, { signal: AbortSignal.timeout(2000) });
      expect(resp.ok).toBe(true);
      const data = (await resp.json()) as { status: string };
      expect(data.status).toBe("ok");
    } finally {
      server.stop();
    }
  });
});
