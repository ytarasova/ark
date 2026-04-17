/**
 * ArkdClient integration tests - exercises client methods against a live arkd server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../server.js";
import { ArkdClient, ArkdClientError } from "../client.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

const TEST_PORT = 19351;
let server: { stop(): void };
let client: ArkdClient;
let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `arkd-client-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  server = startArkd(TEST_PORT, { quiet: true });
  client = new ArkdClient(`http://localhost:${TEST_PORT}`);
});

afterAll(() => {
  server.stop();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

// ── Health ──────────────────────────────────────────────────────────────────

describe("client.health()", () => {
  it("returns valid HealthRes", async () => {
    const h = await client.health();
    expect(h.status).toBe("ok");
    expect(h.version).toBe("0.1.0");
    expect(typeof h.hostname).toBe("string");
  });

  it("works with trailing slash in base URL", async () => {
    const trailingClient = new ArkdClient(`http://localhost:${TEST_PORT}/`);
    const h = await trailingClient.health();
    expect(h.status).toBe("ok");
  });
});

// ── File operations ─────────────────────────────────────────────────────────

describe("client file ops", () => {
  it("writeFile + readFile round-trip", async () => {
    const path = join(tempDir, "client-roundtrip.txt");
    const w = await client.writeFile({ path, content: "client test" });
    expect(w.ok).toBe(true);

    const r = await client.readFile(path);
    expect(r.content).toBe("client test");
    expect(r.size).toBe(11);
  });

  it("stat existing file", async () => {
    const path = join(tempDir, "client-stat.txt");
    writeFileSync(path, "hello");

    const s = await client.stat(path);
    expect(s.exists).toBe(true);
    expect(s.type).toBe("file");
    expect(s.size).toBe(5);
  });

  it("stat nonexistent returns exists=false", async () => {
    const s = await client.stat("/nonexistent/client-test.txt");
    expect(s.exists).toBe(false);
  });

  it("mkdir creates directory", async () => {
    const dir = join(tempDir, "client-mkdir", "nested");
    await client.mkdir({ path: dir, recursive: true });

    const s = await client.stat(dir);
    expect(s.exists).toBe(true);
    expect(s.type).toBe("dir");
  });

  it("listDir returns entries", async () => {
    const dir = join(tempDir, "client-list");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.txt"), "xxx");
    mkdirSync(join(dir, "sub"));

    const res = await client.listDir({ path: dir });
    expect(res.entries.length).toBe(2);
    expect(res.entries.find((e) => e.name === "x.txt")?.type).toBe("file");
    expect(res.entries.find((e) => e.name === "sub")?.type).toBe("dir");
  });

  it("listDir recursive includes nested files", async () => {
    const dir = join(tempDir, "client-list-recursive");
    mkdirSync(join(dir, "inner"), { recursive: true });
    writeFileSync(join(dir, "top.txt"), "top");
    writeFileSync(join(dir, "inner", "deep.txt"), "deep");

    const res = await client.listDir({ path: dir, recursive: true });
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("top.txt");
    expect(names).toContain("inner");
    expect(names).toContain("deep.txt");
  });
});

// ── Process running ─────────────────────────────────────────────────────────

describe("client.run()", () => {
  it("runs command and captures stdout", async () => {
    const res = await client.run({ command: "echo", args: ["client-test"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("client-test");
    expect(res.timedOut).toBe(false);
  });

  it("captures non-zero exit code", async () => {
    const res = await client.run({ command: "sh", args: ["-c", "exit 7"] });
    expect(res.exitCode).toBe(7);
  });

  it("passes env vars through", async () => {
    const res = await client.run({
      command: "sh",
      args: ["-c", "echo $MY_CLIENT_VAR"],
      env: { MY_CLIENT_VAR: "from_client" },
    });
    expect(res.stdout.trim()).toBe("from_client");
  });

  it("passes stdin through", async () => {
    const res = await client.run({ command: "cat", stdin: "piped input" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("piped input");
  });
});

// ── Agent lifecycle ─────────────────────────────────────────────────────────

describe("client agent lifecycle", () => {
  const SESSION_NAME = `arkd-client-test-${Date.now()}`;

  afterAll(async () => {
    try {
      await client.killAgent({ sessionName: SESSION_NAME });
    } catch {
      /* cleanup */
    }
  });

  it("launch → status → capture → kill", async () => {
    const launch = await client.launchAgent({
      sessionName: SESSION_NAME,
      script: `#!/bin/bash\nwhile true; do echo "client agent up"; sleep 1; done`,
      workdir: tempDir,
    });
    expect(launch.ok).toBe(true);

    await waitFor(
      async () => {
        const s = await client.agentStatus({ sessionName: SESSION_NAME });
        return s.running === true;
      },
      { timeout: 5000 },
    );

    const status = await client.agentStatus({ sessionName: SESSION_NAME });
    expect(status.running).toBe(true);

    await waitFor(
      async () => {
        const c = await client.captureOutput({ sessionName: SESSION_NAME });
        return c.output.includes("client agent up");
      },
      { timeout: 5000 },
    );
    const capture = await client.captureOutput({ sessionName: SESSION_NAME });
    expect(capture.output).toContain("client agent up");

    const kill = await client.killAgent({ sessionName: SESSION_NAME });
    expect(kill.ok).toBe(true);
    expect(kill.wasRunning).toBe(true);

    const after = await client.agentStatus({ sessionName: SESSION_NAME });
    expect(after.running).toBe(false);
  });
});

// ── System ──────────────────────────────────────────────────────────────────

describe("client system", () => {
  it("metrics returns numeric fields", async () => {
    const m = await client.metrics();
    expect(typeof m.cpu).toBe("number");
    expect(m.memTotalGb).toBeGreaterThan(0);
    expect(typeof m.diskPct).toBe("number");
  });

  it("snapshot returns full system state", async () => {
    const snap = await client.snapshot();
    expect(typeof snap.metrics.cpu).toBe("number");
    expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
    expect(Array.isArray(snap.sessions)).toBe(true);
    expect(Array.isArray(snap.processes)).toBe(true);
    expect(Array.isArray(snap.docker)).toBe(true);
  }, 30_000);

  it("probePorts detects server port", async () => {
    const res = await client.probePorts([TEST_PORT, 19999]);
    const arkd = res.results.find((r) => r.port === TEST_PORT);
    expect(arkd?.listening).toBe(true);
    const dead = res.results.find((r) => r.port === 19999);
    expect(dead?.listening).toBe(false);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("client errors", () => {
  it("read nonexistent file throws ArkdClientError", async () => {
    try {
      await client.readFile("/nonexistent/client-err.txt");
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e).toBeInstanceOf(ArkdClientError);
      expect(e.httpStatus).toBe(404);
      expect(e.message).toContain("not found");
    }
  });

  it("client to dead server throws", async () => {
    const dead = new ArkdClient("http://localhost:19399");
    try {
      await dead.health();
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e).toBeTruthy();
    }
  });

  it("ArkdClientError has correct properties", async () => {
    try {
      await client.readFile("/nonexistent/props-test.txt");
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e).toBeInstanceOf(ArkdClientError);
      expect(e.name).toBe("ArkdClientError");
      expect(e.httpStatus).toBe(404);
      expect(e.code).toBe("ENOENT");
      expect(e.message).toContain("/file/read");
    }
  });
});
