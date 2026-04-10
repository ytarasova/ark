/**
 * ArkD server tests - exercises every endpoint against a live server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../server.js";

const TEST_PORT = 19350;
const BASE = `http://localhost:${TEST_PORT}`;
let server: { stop(): void };
let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `arkd-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  server = startArkd(TEST_PORT, { quiet: true });
});

afterAll(() => {
  server.stop();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() as T };
}

async function get<T>(path: string): Promise<{ status: number; data: T }> {
  const resp = await fetch(`${BASE}${path}`);
  return { status: resp.status, data: await resp.json() as T };
}

/** Poll a condition until true or timeout. Replaces arbitrary setTimeout waits. */
async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  opts?: { timeout?: number; interval?: number; message?: string }
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 100;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(opts?.message ?? `pollUntil timed out after ${timeout}ms`);
}

// ── Health ──────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns status, version, hostname, platform", async () => {
    const { status, data } = await get<any>("/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.version).toBe("0.1.0");
    expect(typeof data.hostname).toBe("string");
    expect(typeof data.platform).toBe("string");
  });
});

// ── File operations ─────────────────────────────────────────────────────────

describe("File operations", () => {
  it("write + read round-trip", async () => {
    const filePath = join(tempDir, "test-roundtrip.txt");
    const content = "hello arkd\nline 2\n";

    const w = await post<any>("/file/write", { path: filePath, content });
    expect(w.status).toBe(200);
    expect(w.data.ok).toBe(true);
    expect(w.data.bytesWritten).toBeGreaterThan(0);

    const r = await post<any>("/file/read", { path: filePath });
    expect(r.status).toBe(200);
    expect(r.data.content).toBe(content);
    expect(r.data.size).toBe(Buffer.byteLength(content));
  });

  it("read nonexistent file returns 404", async () => {
    const { status, data } = await post<any>("/file/read", { path: "/nonexistent/arkd-test.txt" });
    expect(status).toBe(404);
    expect(data.error).toContain("not found");
  });

  it("stat existing file returns metadata", async () => {
    const filePath = join(tempDir, "test-stat.txt");
    writeFileSync(filePath, "stat me");

    const { status, data } = await post<any>("/file/stat", { path: filePath });
    expect(status).toBe(200);
    expect(data.exists).toBe(true);
    expect(data.type).toBe("file");
    expect(data.size).toBe(7);
    expect(typeof data.mtime).toBe("string");
  });

  it("stat nonexistent file returns exists=false", async () => {
    const { data } = await post<any>("/file/stat", { path: "/nonexistent/nope.txt" });
    expect(data.exists).toBe(false);
  });

  it("mkdir creates nested directories", async () => {
    const dirPath = join(tempDir, "nested", "deep", "dir");
    const { status, data } = await post<any>("/file/mkdir", { path: dirPath, recursive: true });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(existsSync(dirPath)).toBe(true);
  });

  it("list returns entries with types", async () => {
    const dir = join(tempDir, "list-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "aaa");
    mkdirSync(join(dir, "subdir"));

    const { status, data } = await post<any>("/file/list", { path: dir });
    expect(status).toBe(200);
    expect(data.entries.length).toBe(2);

    const file = data.entries.find((e: any) => e.name === "a.txt");
    const sub = data.entries.find((e: any) => e.name === "subdir");
    expect(file?.type).toBe("file");
    expect(file?.size).toBe(3);
    expect(sub?.type).toBe("dir");
  });

  it("list recursive includes nested entries", async () => {
    const dir = join(tempDir, "list-recursive");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "top.txt"), "top");
    writeFileSync(join(dir, "sub", "nested.txt"), "nested");

    const { data } = await post<any>("/file/list", { path: dir, recursive: true });
    const names = data.entries.map((e: any) => e.name);
    expect(names).toContain("top.txt");
    expect(names).toContain("sub");
    expect(names).toContain("nested.txt");
    expect(data.entries.length).toBe(3);
  });

  it("list nonexistent directory returns 500", async () => {
    const { status, data } = await post<any>("/file/list", { path: "/nonexistent/dir" });
    expect(status).toBe(500);
    expect(typeof data.error).toBe("string");
  });

  it("stat on directory returns type=dir", async () => {
    const dir = join(tempDir, "stat-dir");
    mkdirSync(dir, { recursive: true });

    const { data } = await post<any>("/file/stat", { path: dir });
    expect(data.exists).toBe(true);
    expect(data.type).toBe("dir");
  });

  it("write to nonexistent parent directory returns 500", async () => {
    const { status, data } = await post<any>("/file/write", {
      path: "/nonexistent/parent/file.txt",
      content: "should fail",
    });
    expect(status).toBe(500);
    expect(typeof data.error).toBe("string");
  });

  it("write with custom mode sets permissions", async () => {
    const filePath = join(tempDir, "test-mode.sh");
    const { data } = await post<any>("/file/write", {
      path: filePath,
      content: "#!/bin/bash\necho hi",
      mode: 0o755,
    });
    expect(data.ok).toBe(true);

    // Verify the file is executable by stat-ing it
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = require("fs");
    const s = statSync(filePath);
    // Check that owner-execute bit is set
    expect(s.mode & 0o100).toBeGreaterThan(0);
  });

  it("handles unicode content correctly", async () => {
    const filePath = join(tempDir, "test-unicode.txt");
    const content = "日本語テスト 🚀 émojis café";

    await post<any>("/file/write", { path: filePath, content });
    const { data } = await post<any>("/file/read", { path: filePath });
    expect(data.content).toBe(content);
    expect(data.size).toBe(Buffer.byteLength(content));
  });
});

// ── Process running ─────────────────────────────────────────────────────────

describe("POST /exec", () => {
  it("runs a command and captures output", async () => {
    const { status, data } = await post<any>("/exec", {
      command: "echo",
      args: ["hello", "arkd"],
    });
    expect(status).toBe(200);
    expect(data.exitCode).toBe(0);
    expect(data.stdout.trim()).toBe("hello arkd");
    expect(data.timedOut).toBe(false);
  });

  it("captures stderr and non-zero exit code", async () => {
    const { data } = await post<any>("/exec", {
      command: "sh",
      args: ["-c", "echo err >&2; exit 42"],
    });
    expect(data.exitCode).toBe(42);
    expect(data.stderr.trim()).toBe("err");
  });

  it("respects cwd", async () => {
    const { data } = await post<any>("/exec", {
      command: "pwd",
      cwd: tempDir,
    });
    // Resolve symlinks (macOS /tmp → /private/tmp)
    expect(data.stdout.trim()).toContain("arkd-test");
  });

  it("times out long-running commands", async () => {
    const { data } = await post<any>("/exec", {
      command: "sleep",
      args: ["60"],
      timeout: 500,
    });
    expect(data.timedOut).toBe(true);
  });

  it("passes stdin to process", async () => {
    const { data } = await post<any>("/exec", {
      command: "cat",
      stdin: "hello from stdin",
    });
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe("hello from stdin");
  });

  it("passes custom env vars", async () => {
    const { data } = await post<any>("/exec", {
      command: "sh",
      args: ["-c", "echo $ARKD_TEST_VAR"],
      env: { ARKD_TEST_VAR: "custom_value" },
    });
    expect(data.exitCode).toBe(0);
    expect(data.stdout.trim()).toBe("custom_value");
  });

  it("handles nonexistent command gracefully", async () => {
    const { status, data } = await post<any>("/exec", {
      command: "arkd_nonexistent_command_xyz",
    });
    // Bun.spawn with invalid command should result in an error
    // Either 500 (spawn throws) or exitCode != 0
    expect(status === 500 || data.exitCode !== 0).toBe(true);
  });
});

// ── Agent lifecycle ─────────────────────────────────────────────────────────

describe("Agent lifecycle (tmux)", () => {
  const SESSION_NAME = `arkd-test-agent-${Date.now()}`;

  afterAll(async () => {
    // Cleanup: kill the session if it's still running
    await post("/agent/kill", { sessionName: SESSION_NAME });
  });

  it("launch → status → capture → kill lifecycle", async () => {
    // Launch
    const launch = await post<any>("/agent/launch", {
      sessionName: SESSION_NAME,
      script: `#!/bin/bash\nwhile true; do echo "arkd agent running"; sleep 1; done`,
      workdir: tempDir,
    });
    expect(launch.status).toBe(200);
    expect(launch.data.ok).toBe(true);

    // Poll until tmux reports the session as running
    await pollUntil(async () => {
      const s = await post<any>("/agent/status", { sessionName: SESSION_NAME });
      return s.data.running === true;
    }, { timeout: 5000, message: "tmux session never started" });

    // Status: should be running
    const status = await post<any>("/agent/status", { sessionName: SESSION_NAME });
    expect(status.data.running).toBe(true);

    // Poll until capture output contains expected text
    let capture: { status: number; data: any } = { status: 0, data: {} };
    await pollUntil(async () => {
      capture = await post<any>("/agent/capture", { sessionName: SESSION_NAME });
      return capture.data.output?.includes("arkd agent running") ?? false;
    }, { timeout: 5000, message: "capture never contained expected output" });
    expect(capture.data.output).toContain("arkd agent running");

    // Kill
    const kill = await post<any>("/agent/kill", { sessionName: SESSION_NAME });
    expect(kill.data.ok).toBe(true);
    expect(kill.data.wasRunning).toBe(true);

    // Status after kill: not running
    const statusAfter = await post<any>("/agent/status", { sessionName: SESSION_NAME });
    expect(statusAfter.data.running).toBe(false);
  });

  it("kill nonexistent session returns wasRunning=false", async () => {
    const { data } = await post<any>("/agent/kill", { sessionName: "arkd-nonexistent-session" });
    expect(data.ok).toBe(true);
    expect(data.wasRunning).toBe(false);
  });

  it("status of nonexistent session returns running=false", async () => {
    const { data } = await post<any>("/agent/status", { sessionName: "arkd-no-such-session" });
    expect(data.running).toBe(false);
  });

  it("capture from nonexistent session returns empty or error gracefully", async () => {
    const { status } = await post<any>("/agent/capture", { sessionName: "arkd-no-such-capture" });
    // Should return 200 with empty output (tmux capture-pane on missing session returns empty)
    // or 500 if tmux errors - either is acceptable as long as server doesn't crash
    expect(status === 200 || status === 500).toBe(true);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe("GET /metrics", () => {
  it("returns cpu, memory, disk, uptime", async () => {
    const { status, data } = await get<any>("/metrics");
    expect(status).toBe(200);
    expect(typeof data.cpu).toBe("number");
    expect(typeof data.memUsedGb).toBe("number");
    expect(typeof data.memTotalGb).toBe("number");
    expect(typeof data.memPct).toBe("number");
    expect(typeof data.diskPct).toBe("number");
    expect(typeof data.uptime).toBe("string");
    expect(data.memTotalGb).toBeGreaterThan(0);
  });
});

// ── Snapshot ────────────────────────────────────────────────────────────────

describe("GET /snapshot", () => {
  it("returns full system snapshot with all sections", async () => {
    const { status, data } = await get<any>("/snapshot");
    expect(status).toBe(200);

    // Metrics section
    expect(typeof data.metrics.cpu).toBe("number");
    expect(typeof data.metrics.memUsedGb).toBe("number");
    expect(typeof data.metrics.memTotalGb).toBe("number");
    expect(data.metrics.memTotalGb).toBeGreaterThan(0);
    expect(typeof data.metrics.memPct).toBe("number");
    expect(typeof data.metrics.diskPct).toBe("number");
    expect(typeof data.metrics.uptime).toBe("string");
    expect(typeof data.metrics.netRxMb).toBe("number");
    expect(typeof data.metrics.netTxMb).toBe("number");
    expect(typeof data.metrics.idleTicks).toBe("number");

    // Sessions, processes, docker are arrays (may be empty in test env)
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(Array.isArray(data.processes)).toBe(true);
    expect(Array.isArray(data.docker)).toBe(true);
  });

  it("snapshot sessions include running tmux sessions", async () => {
    const name = `arkd-snap-test-${Date.now()}`;
    await post("/agent/launch", {
      sessionName: name,
      script: "#!/bin/bash\nsleep 60",
      workdir: tempDir,
    });
    // Poll until tmux session is visible
    await pollUntil(async () => {
      const s = await post<any>("/agent/status", { sessionName: name });
      return s.data.running === true;
    }, { timeout: 5000, message: "snapshot tmux session never started" });

    try {
      const { data } = await get<any>("/snapshot");
      const found = data.sessions.find((s: any) => s.name === name);
      expect(found).toBeDefined();
      expect(found.status).toBe("detached");
    } finally {
      await post("/agent/kill", { sessionName: name });
    }
  });
});

// ── Port probing ────────────────────────────────────────────────────────────

describe("POST /ports/probe", () => {
  it("detects the arkd server's own port as listening", async () => {
    const { data } = await post<any>("/ports/probe", { ports: [TEST_PORT, 19999] });
    expect(data.results.length).toBe(2);

    const arkdPort = data.results.find((r: any) => r.port === TEST_PORT);
    expect(arkdPort?.listening).toBe(true);

    const deadPort = data.results.find((r: any) => r.port === 19999);
    expect(deadPort?.listening).toBe(false);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("Error handling", () => {
  it("invalid JSON returns 400", async () => {
    const resp = await fetch(`${BASE}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(resp.status).toBe(400);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toContain("invalid JSON");
  });

  it("unknown route returns 404", async () => {
    const resp = await fetch(`${BASE}/unknown/route`);
    expect(resp.status).toBe(404);
  });

  it("wrong HTTP method returns 404", async () => {
    // GET on a POST-only endpoint
    const resp = await fetch(`${BASE}/exec`);
    expect(resp.status).toBe(404);
  });
});

// ── Concurrent requests ─────────────────────────────────────────────────────

describe("Concurrent requests", () => {
  it("handles 10 parallel file write+read operations", async () => {
    const ops = Array.from({ length: 10 }, (_, i) => {
      const filePath = join(tempDir, `concurrent-${i}.txt`);
      const content = `content-${i}-${Date.now()}`;
      return (async () => {
        await post("/file/write", { path: filePath, content });
        const { data } = await post<any>("/file/read", { path: filePath });
        expect(data.content).toBe(content);
      })();
    });
    await Promise.all(ops);
  });

  it("handles parallel exec + health + metrics requests", async () => {
    const results = await Promise.all([
      post<any>("/exec", { command: "echo", args: ["a"] }),
      post<any>("/exec", { command: "echo", args: ["b"] }),
      get<any>("/health"),
      get<any>("/metrics"),
      post<any>("/file/stat", { path: tempDir }),
    ]);
    expect(results[0].data.stdout.trim()).toBe("a");
    expect(results[1].data.stdout.trim()).toBe("b");
    expect(results[2].data.status).toBe("ok");
    expect(typeof results[3].data.cpu).toBe("number");
    expect(results[4].data.exists).toBe(true);
  });
});

// ── Server lifecycle ────────────────────────────────────────────────────────

describe("Server lifecycle", () => {
  it("stop() makes the server unreachable", async () => {
    const ephemeralPort = TEST_PORT + 50;
    const ephemeral = startArkd(ephemeralPort, { quiet: true });

    try {
      // Verify it's alive
      const resp = await fetch(`http://localhost:${ephemeralPort}/health`);
      expect(resp.status).toBe(200);

      // Stop it
      ephemeral.stop();

      // Verify it's dead
      try {
        await fetch(`http://localhost:${ephemeralPort}/health`);
        expect(true).toBe(false); // should not reach
      } catch {
        // Expected - connection refused
      }
    } finally {
      // Ensure cleanup even if assertions fail
      try { ephemeral.stop(); } catch { /* cleanup */ }
    }
  });
});
