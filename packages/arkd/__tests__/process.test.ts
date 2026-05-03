/**
 * /process/* tests. Drives a live arkd to verify the generic process
 * supervisor primitives: spawn returns a tracked pid, kill SIGTERM
 * transitions status to exited, kill SIGKILL skips the grace, logPath
 * captures stdout, and validation rejects bad input.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../server.js";
import { _resetForTests } from "../routes/process.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let server: { stop(): void };
let port: number;
let baseUrl: string;
let workDir: string;

beforeAll(async () => {
  port = await allocatePort();
  server = startArkd(port, { quiet: true });
  baseUrl = `http://127.0.0.1:${port}`;
  workDir = join(tmpdir(), `arkd-process-test-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
});

afterAll(() => {
  server.stop();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

afterEach(() => {
  _resetForTests();
});

async function postJson<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: (await resp.json()) as T };
}

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("/process/spawn + /process/status", () => {
  test("spawn returns a pid and status reports running=true", async () => {
    const spawn = await postJson<{ ok: boolean; pid: number }>("/process/spawn", {
      handle: "p-running",
      cmd: "sleep",
      args: ["30"],
      workdir: workDir,
    });
    expect(spawn.status).toBe(200);
    expect(spawn.data.ok).toBe(true);
    expect(typeof spawn.data.pid).toBe("number");
    expect(spawn.data.pid).toBeGreaterThan(0);

    const status = await postJson<{ running: boolean; pid: number }>("/process/status", {
      handle: "p-running",
    });
    expect(status.status).toBe(200);
    expect(status.data.running).toBe(true);
    expect(status.data.pid).toBe(spawn.data.pid);

    // Cleanup so the sleep does not outlive the test.
    await postJson("/process/kill", { handle: "p-running", signal: "SIGKILL" });
  });

  test("two concurrent spawns with different handles do not collide", async () => {
    const [a, b] = await Promise.all([
      postJson<{ ok: boolean; pid: number }>("/process/spawn", {
        handle: "p-multi-a",
        cmd: "sleep",
        args: ["30"],
        workdir: workDir,
      }),
      postJson<{ ok: boolean; pid: number }>("/process/spawn", {
        handle: "p-multi-b",
        cmd: "sleep",
        args: ["30"],
        workdir: workDir,
      }),
    ]);
    expect(a.data.ok).toBe(true);
    expect(b.data.ok).toBe(true);
    expect(a.data.pid).not.toBe(b.data.pid);

    const sa = await postJson<{ running: boolean; pid: number }>("/process/status", { handle: "p-multi-a" });
    const sb = await postJson<{ running: boolean; pid: number }>("/process/status", { handle: "p-multi-b" });
    expect(sa.data.running).toBe(true);
    expect(sb.data.running).toBe(true);
    expect(sa.data.pid).toBe(a.data.pid);
    expect(sb.data.pid).toBe(b.data.pid);

    await postJson("/process/kill", { handle: "p-multi-a", signal: "SIGKILL" });
    await postJson("/process/kill", { handle: "p-multi-b", signal: "SIGKILL" });
  });
});

describe("/process/kill", () => {
  test("SIGTERM transitions status to running=false with exitCode set", async () => {
    await postJson<{ ok: boolean; pid: number }>("/process/spawn", {
      handle: "p-term",
      cmd: "sleep",
      args: ["30"],
      workdir: workDir,
    });

    const kill = await postJson<{ ok: boolean; wasRunning: boolean }>("/process/kill", {
      handle: "p-term",
      signal: "SIGTERM",
    });
    expect(kill.status).toBe(200);
    expect(kill.data.ok).toBe(true);
    expect(kill.data.wasRunning).toBe(true);

    // After SIGTERM + grace, status must report not-running with an exitCode.
    const ok = await pollUntil(async () => {
      const s = await postJson<{ running: boolean; exitCode?: number }>("/process/status", {
        handle: "p-term",
      });
      return s.data.running === false && typeof s.data.exitCode === "number";
    });
    expect(ok).toBe(true);
  });

  test("SIGKILL bypasses the 1s SIGTERM grace", async () => {
    // Trap SIGTERM so the process would otherwise survive 5s. SIGKILL must
    // tear it down well under the SIGTERM grace + 5s trap window.
    await postJson<{ ok: boolean; pid: number }>("/process/spawn", {
      handle: "p-kill",
      cmd: "bash",
      args: ["-c", "trap '' TERM; sleep 5"],
      workdir: workDir,
    });
    // Give the trap installer a beat so the SIGKILL is racing the running sleep.
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    const kill = await postJson<{ ok: boolean; wasRunning: boolean }>("/process/kill", {
      handle: "p-kill",
      signal: "SIGKILL",
    });
    const elapsed = Date.now() - start;
    expect(kill.data.wasRunning).toBe(true);
    // SIGKILL is synchronous from arkd's side -- no grace loop. Allow generous
    // headroom for slow CI; the SIGTERM grace alone would push past 1000ms.
    expect(elapsed).toBeLessThan(900);

    const ok = await pollUntil(async () => {
      const s = await postJson<{ running: boolean }>("/process/status", { handle: "p-kill" });
      return s.data.running === false;
    });
    expect(ok).toBe(true);
  });

  test("kill on unknown handle returns wasRunning=false (no error)", async () => {
    const r = await postJson<{ ok: boolean; wasRunning: boolean }>("/process/kill", {
      handle: "p-unknown",
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.wasRunning).toBe(false);
  });
});

describe("/process/status edge cases", () => {
  test("status on unknown handle returns running=false", async () => {
    const r = await postJson<{ running: boolean; pid?: number }>("/process/status", {
      handle: "p-never-spawned",
    });
    expect(r.status).toBe(200);
    expect(r.data.running).toBe(false);
    expect(r.data.pid).toBeUndefined();
  });
});

describe("logPath capture", () => {
  test("logPath captures stdout", async () => {
    const logPath = join(workDir, "p-log.out");
    if (existsSync(logPath)) rmSync(logPath);

    await postJson<{ ok: boolean; pid: number }>("/process/spawn", {
      handle: "p-log",
      cmd: "bash",
      args: ["-c", "echo hello"],
      workdir: workDir,
      logPath,
    });

    // Wait for the child to exit + the pump to drain.
    const ok = await pollUntil(async () => {
      const s = await postJson<{ running: boolean; exitCode?: number }>("/process/status", { handle: "p-log" });
      return s.data.running === false && typeof s.data.exitCode === "number";
    });
    expect(ok).toBe(true);

    // Pump runs async; allow a couple ticks for the appendFile to flush.
    await pollUntil(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("hello"));
    expect(readFileSync(logPath, "utf8")).toContain("hello");
  });
});

describe("validation", () => {
  test("rejects handle with spaces", async () => {
    const r = await postJson<{ error: string }>("/process/spawn", {
      handle: "has spaces",
      cmd: "sleep",
      args: ["1"],
      workdir: workDir,
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBeTruthy();
  });

  test("rejects empty cmd", async () => {
    const r = await postJson<{ error: string }>("/process/spawn", {
      handle: "p-empty-cmd",
      cmd: "",
      args: [],
      workdir: workDir,
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBeTruthy();
  });

  test("kill rejects handle with spaces", async () => {
    const r = await postJson<{ error: string }>("/process/kill", {
      handle: "bad handle",
    });
    expect(r.status).toBe(400);
  });

  test("status rejects handle with spaces", async () => {
    const r = await postJson<{ error: string }>("/process/status", {
      handle: "bad handle",
    });
    expect(r.status).toBe(400);
  });
});
