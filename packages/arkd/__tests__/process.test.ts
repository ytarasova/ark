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
import { _resetForTests, buildSpawnEnv, DEFAULT_SPAWN_PATH } from "../routes/process.js";
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

// ─── buildSpawnEnv + default-PATH fallback ───────────────────────────────────
//
// On EC2 arkd runs as a systemd unit that sets only HOME; process.env.PATH
// can therefore be empty. A caller that spawns "bash" (unqualified) would
// fail with ENOENT because Bun.spawn resolves the cmd via the CHILD env's
// PATH. buildSpawnEnv injects a POSIX default so unqualified commands keep
// working, and callers that DO set PATH (parent or request) always win.

describe("buildSpawnEnv", () => {
  test("injects DEFAULT_SPAWN_PATH when neither parent nor request env has PATH", () => {
    const out = buildSpawnEnv({}, {});
    expect(out.PATH).toBe(DEFAULT_SPAWN_PATH);
  });

  test("injects DEFAULT_SPAWN_PATH when parent PATH is empty string", () => {
    const out = buildSpawnEnv({ PATH: "" } as NodeJS.ProcessEnv, undefined);
    expect(out.PATH).toBe(DEFAULT_SPAWN_PATH);
  });

  test("preserves parent PATH when no override is supplied", () => {
    const out = buildSpawnEnv({ PATH: "/opt/custom/bin" } as NodeJS.ProcessEnv, {});
    expect(out.PATH).toBe("/opt/custom/bin");
  });

  test("request PATH wins over parent PATH", () => {
    const out = buildSpawnEnv({ PATH: "/inherited" } as NodeJS.ProcessEnv, { PATH: "/from/request" });
    expect(out.PATH).toBe("/from/request");
  });

  test("merges non-PATH keys from both sources, request overrides on conflict", () => {
    const out = buildSpawnEnv({ FOO: "parent", BAR: "parent" } as NodeJS.ProcessEnv, { BAR: "req", BAZ: "req" });
    expect(out.FOO).toBe("parent");
    expect(out.BAR).toBe("req");
    expect(out.BAZ).toBe("req");
    expect(out.PATH).toBe(DEFAULT_SPAWN_PATH);
  });
});

describe("/process/spawn PATH propagation", () => {
  test("caller-supplied env without PATH still produces a child that can resolve shell utilities", async () => {
    // Use an absolute interpreter so the spawn itself doesn't depend on the
    // host's PATH. We want to verify what PATH the CHILD ends up with -- if
    // buildSpawnEnv is missing, a child env assembled from an empty request
    // override could strand the PATH as "" in some Bun versions.
    const logPath = join(workDir, "p-path-echo.out");
    if (existsSync(logPath)) rmSync(logPath);

    const spawn = await postJson<{ ok: boolean; pid: number }>("/process/spawn", {
      handle: "p-path-echo",
      cmd: "/bin/sh",
      args: ["-c", "echo PATH=$PATH"],
      workdir: workDir,
      env: { ARK_SPAWN_TEST: "1" },
      logPath,
    });
    expect(spawn.status).toBe(200);
    expect(spawn.data.ok).toBe(true);

    const exited = await pollUntil(async () => {
      const s = await postJson<{ running: boolean; exitCode?: number }>("/process/status", {
        handle: "p-path-echo",
      });
      return s.data.running === false && typeof s.data.exitCode === "number";
    });
    expect(exited).toBe(true);

    await pollUntil(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("PATH="));
    const out = readFileSync(logPath, "utf8");
    // Either inherited (has /bin or /usr/bin) or the DEFAULT_SPAWN_PATH fallback
    // -- both contain "/bin", which is what bash/sh lookup needs.
    expect(out).toMatch(/PATH=.*\/bin/);
  });
});
