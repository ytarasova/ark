/**
 * Fly 6PN tunnel unit tests.
 *
 * Covers `openFlyTunnel` (the `flyctl proxy` wrapper) plus the
 * `FlyMachinesCompute` integration points (meta fields, destroy ordering,
 * rollback on tunnel failure, feature flag gating).
 *
 * Every test uses DI -- no real `flyctl` binary, no real child_process,
 * no real loopback socket. A `FakeChildProcess` impersonates enough of
 * `child_process.ChildProcess` for `openFlyTunnel` to drive it, and the
 * Fly API surface is stubbed via the existing `setFlyHooksForTesting` +
 * `setDepsForTesting` pair.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import { openFlyTunnel, type SpawnFn } from "../core/fly/tunnel.js";
import { FlyMachinesCompute, setFlyHooksForTesting, type FlyMeta } from "../core/fly/compute.js";

// ── Fake ChildProcess ──────────────────────────────────────────────────────

interface FakeChildOpts {
  pid?: number;
  /** When true, child never responds to `kill()` -- forces SIGKILL escalation. */
  ignoreSigterm?: boolean;
}

class FakeChildProcess extends EventEmitter {
  public pid: number;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public stdout: Readable;
  public stderr: Readable;
  public killedSignals: string[] = [];
  private readonly opts: FakeChildOpts;

  constructor(opts: FakeChildOpts = {}) {
    super();
    this.opts = opts;
    this.pid = opts.pid ?? 12345;
    // Minimal readable stubs -- they never emit. Tunnel only reads "data"
    // for diagnostic logging, which is optional.
    this.stdout = new EventEmitter() as unknown as Readable;
    this.stderr = new EventEmitter() as unknown as Readable;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const sig = typeof signal === "number" ? `SIG${signal}` : signal;
    this.killedSignals.push(sig);
    if (sig === "SIGKILL" || !this.opts.ignoreSigterm) {
      this.simulateExit(null, sig as NodeJS.Signals);
    }
    return true;
  }

  simulateExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

// ── Fake fetch ─────────────────────────────────────────────────────────────

interface FakeFetchState {
  calls: string[];
  /** Sequence of responses the probe should return, in order. Last entry repeats. */
  sequence: Array<() => Response | Promise<Response>>;
}

function makeFakeFetch(state: FakeFetchState) {
  let idx = 0;
  return async (input: string): Promise<Response> => {
    state.calls.push(input);
    const fn = state.sequence[Math.min(idx, state.sequence.length - 1)];
    idx += 1;
    return fn();
  };
}

function okResponse(body: unknown = { status: "ok" }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── openFlyTunnel tests ────────────────────────────────────────────────────

describe("openFlyTunnel", () => {
  it("allocates a local port and spawns flyctl with the expected args", async () => {
    const spawnCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const child = new FakeChildProcess({ pid: 4242 });
    const spawn: SpawnFn = (command, args) => {
      spawnCalls.push({ command, args: [...args] });
      return child as unknown as ChildProcess;
    };
    const fetchState: FakeFetchState = { calls: [], sequence: [() => okResponse()] };

    const tunnel = await openFlyTunnel({
      appName: "ark-vm1",
      machineId: "m_abc123",
      remotePort: 19300,
      spawn,
      allocatePort: async () => 51234,
      fetchFn: makeFakeFetch(fetchState),
      sleep: async () => {},
      now: () => 1_700_000_000_000,
    });

    expect(tunnel.localPort).toBe(51234);
    expect(tunnel.pid).toBe(4242);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("flyctl");
    expect(spawnCalls[0].args).toEqual(["proxy", "51234:19300", "m_abc123.vm.ark-vm1.internal", "-a", "ark-vm1"]);

    await tunnel.close();
  });

  it("polls the local port until the probe returns 200, then resolves", async () => {
    const child = new FakeChildProcess();
    const spawn: SpawnFn = () => child as unknown as ChildProcess;
    // First two probes fail, third succeeds.
    const fetchState: FakeFetchState = {
      calls: [],
      sequence: [
        () => {
          throw new Error("ECONNREFUSED");
        },
        () => jsonResponse(503, { status: "not ready" }),
        () => okResponse(),
      ],
    };
    const sleeps: number[] = [];

    const tunnel = await openFlyTunnel({
      appName: "ark-vm1",
      machineId: "m_abc",
      remotePort: 19300,
      spawn,
      allocatePort: async () => 40000,
      fetchFn: makeFakeFetch(fetchState),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_700_000_000_000,
    });

    // Three probe attempts (2 failed + 1 success), two sleeps between them.
    expect(fetchState.calls).toHaveLength(3);
    expect(fetchState.calls.every((u) => u === "http://localhost:40000/health")).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(tunnel.localPort).toBe(40000);

    await tunnel.close();
  });

  it("rejects with a clear timeout error when arkd never answers before the deadline", async () => {
    const child = new FakeChildProcess();
    const spawn: SpawnFn = () => child as unknown as ChildProcess;
    // Probe always fails.
    const fetchState: FakeFetchState = {
      calls: [],
      sequence: [
        () => {
          throw new Error("ECONNREFUSED");
        },
      ],
    };
    // Virtual clock: advance by 5s per tick so we cross the 10s deadline quickly.
    let t = 1_000_000;
    const now = () => t;

    await expect(
      openFlyTunnel({
        appName: "ark-vm1",
        machineId: "m_never_ready",
        remotePort: 19300,
        spawn,
        allocatePort: async () => 40001,
        fetchFn: makeFakeFetch(fetchState),
        sleep: async () => {
          t += 5_000;
        },
        now,
        readyTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/readiness timed out after 10000ms.*m_never_ready/s);

    // Timeout path must tear the child down so we don't leak a flyctl proc.
    expect(child.killedSignals).toContain("SIGTERM");
  });

  it("rejects when the flyctl child exits before arkd becomes reachable", async () => {
    // Simulate a crashed flyctl: spawn returns a live child; after the first
    // probe attempt fails, sleep triggers the exit signal. On the next loop
    // iteration the tunnel's childExited check should win and surface the
    // "exited before ready" error (not the generic timeout message).
    const child = new FakeChildProcess({ pid: 3333 });
    const spawn: SpawnFn = () => child as unknown as ChildProcess;
    const fetchState: FakeFetchState = {
      calls: [],
      sequence: [
        () => {
          throw new Error("ECONNREFUSED");
        },
      ],
    };
    let sleepCalls = 0;

    await expect(
      openFlyTunnel({
        appName: "ark-vm1",
        machineId: "m_crash",
        remotePort: 19300,
        spawn,
        allocatePort: async () => 40002,
        fetchFn: makeFakeFetch(fetchState),
        sleep: async () => {
          if (sleepCalls === 0) {
            // Fire exit synchronously while the tunnel's probe loop is awaiting
            // `sleep`, so the next iteration's childExited check catches it.
            child.simulateExit(1, null);
          }
          sleepCalls += 1;
        },
        now: () => 1_700_000_000_000,
      }),
    ).rejects.toThrow(/flyctl proxy exited before arkd became reachable.*code=1/s);
  });

  it("close() sends SIGTERM, waits, and escalates to SIGKILL if the child doesn't exit", async () => {
    const child = new FakeChildProcess({ ignoreSigterm: true });
    const spawn: SpawnFn = () => child as unknown as ChildProcess;
    const fetchState: FakeFetchState = { calls: [], sequence: [() => okResponse()] };

    const tunnel = await openFlyTunnel({
      appName: "ark-vm1",
      machineId: "m_stubborn",
      remotePort: 19300,
      spawn,
      allocatePort: async () => 40003,
      fetchFn: makeFakeFetch(fetchState),
      sleep: async () => {},
      now: () => 0,
    });

    await tunnel.close();

    expect(child.killedSignals[0]).toBe("SIGTERM");
    expect(child.killedSignals).toContain("SIGKILL");
  });

  it("close() is idempotent (safe to call twice)", async () => {
    const child = new FakeChildProcess();
    const spawn: SpawnFn = () => child as unknown as ChildProcess;
    const fetchState: FakeFetchState = { calls: [], sequence: [() => okResponse()] };

    const tunnel = await openFlyTunnel({
      appName: "ark-vm1",
      machineId: "m_double_close",
      remotePort: 19300,
      spawn,
      allocatePort: async () => 40004,
      fetchFn: makeFakeFetch(fetchState),
      sleep: async () => {},
      now: () => 0,
    });

    await tunnel.close();
    await tunnel.close(); // second call is a no-op
    // SIGTERM was sent once (first close); second close short-circuits.
    expect(child.killedSignals.filter((s) => s === "SIGTERM")).toHaveLength(1);
  });
});

// ── FlyMachinesCompute integration ─────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

interface StubFetch {
  fn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedRequest[];
  setHandler: (key: string, h: (req: RecordedRequest) => Response | Promise<Response>) => void;
  setDefault: (h: (req: RecordedRequest) => Response | Promise<Response>) => void;
}

function makeStubFetch(): StubFetch {
  const handlers = new Map<string, (req: RecordedRequest) => Response | Promise<Response>>();
  let defaultHandler: (req: RecordedRequest) => Response | Promise<Response> = (req) =>
    jsonResponse(404, { error: `unhandled ${req.method} ${req.url}` });
  const calls: RecordedRequest[] = [];

  async function fn(input: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedRequest = { method, url: input, body };
    calls.push(req);

    const keys = Array.from(handlers.keys()).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const [hm, hp] = key.split(" ", 2);
      if (hm === method && input.endsWith(hp)) {
        return handlers.get(key)!(req);
      }
    }
    return defaultHandler(req);
  }

  return {
    fn,
    calls,
    setHandler: (key, h) => {
      handlers.set(key, h);
    },
    setDefault: (h) => {
      defaultHandler = h;
    },
  };
}

/**
 * Wire the Fly API happy path -- app create, machine create, machine reaches
 * started, plus lifecycle endpoints. This matches the pattern in
 * fly-compute.test.ts but is duplicated here to keep test files independent.
 */
function wireFlyApiHappyPath(stub: StubFetch, overrides?: { privateIp?: string }): void {
  const privateIp = overrides?.privateIp ?? "fdaa:0:1234::2";
  stub.setHandler("POST /apps", () => jsonResponse(200, { name: "ark-vm1" }));
  stub.setHandler("POST /machines", () => jsonResponse(200, { id: "m_abc123", region: "ord", state: "starting" }));
  stub.setHandler("GET /machines/m_abc123", () =>
    jsonResponse(200, { id: "m_abc123", state: "started", region: "ord", private_ip: privateIp }),
  );
  stub.setHandler("POST /machines/m_abc123/start", () => jsonResponse(200, {}));
  stub.setHandler("POST /machines/m_abc123/stop", () => jsonResponse(200, {}));
  stub.setHandler("POST /machines/m_abc123/suspend", () => jsonResponse(200, {}));
  stub.setHandler("DELETE /machines/m_abc123?force=true", () => jsonResponse(200, {}));
  // Tunnel readiness probe -- any localhost /health call succeeds immediately.
  // The compute routes its tunnel probe fetch through the same fetchFn as the
  // Fly API, so we register /health here too.
  stub.setHandler("GET /health", () => jsonResponse(200, { status: "ok" }));
}

let stub: StubFetch;

beforeEach(() => {
  stub = makeStubFetch();
  process.env.FLY_API_TOKEN = "fo_test_token";
});

afterEach(() => {
  setFlyHooksForTesting(null);
  delete process.env.FLY_API_TOKEN;
  delete process.env.ARK_FLY_TUNNEL;
});

describe("FlyMachinesCompute tunnel integration", () => {
  it("provision({ useTunnel: true }) records arkdLocalPort/tunnelPid and getArkdUrl returns localhost", async () => {
    wireFlyApiHappyPath(stub);
    const child = new FakeChildProcess({ pid: 7777 });
    const spawnCalls: Array<ReadonlyArray<string>> = [];

    setFlyHooksForTesting({
      fetchFn: stub.fn,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      spawn: ((_cmd, args) => {
        spawnCalls.push([...args]);
        return child as unknown as ChildProcess;
      }) as SpawnFn,
      allocatePort: async () => 55555,
    });

    const compute = new FlyMachinesCompute({ useTunnel: true });
    const h = await compute.provision({ tags: { name: "vm1" } });

    const meta = (h.meta as { fly: FlyMeta }).fly;
    expect(meta.arkdLocalPort).toBe(55555);
    expect(meta.tunnelPid).toBe(7777);
    expect(meta.arkdRemoteUrl).toBe("http://[fdaa:0:1234::2]:19300");
    expect(compute.getArkdUrl(h)).toBe("http://localhost:55555");

    // Spawn was called once with the expected flyctl args, pinned to the machine.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(["proxy", "55555:19300", "m_abc123.vm.ark-vm1.internal", "-a", "ark-vm1"]);
  });

  it("provision() without useTunnel keeps the legacy 6PN URL and never spawns flyctl", async () => {
    wireFlyApiHappyPath(stub);
    const spawnCalls: Array<ReadonlyArray<string>> = [];

    setFlyHooksForTesting({
      fetchFn: stub.fn,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      spawn: ((_cmd, args) => {
        spawnCalls.push([...args]);
        return new FakeChildProcess() as unknown as ChildProcess;
      }) as SpawnFn,
      allocatePort: async () => 55555,
    });

    const compute = new FlyMachinesCompute(); // no useTunnel, no ARK_FLY_TUNNEL
    const h = await compute.provision({ tags: { name: "vm1" } });

    const meta = (h.meta as { fly: FlyMeta }).fly;
    expect(meta.arkdLocalPort).toBeUndefined();
    expect(meta.tunnelPid).toBeUndefined();
    expect(meta.arkdUrl).toBe("http://[fdaa:0:1234::2]:19300");
    expect(compute.getArkdUrl(h)).toBe("http://[fdaa:0:1234::2]:19300");
    expect(spawnCalls).toHaveLength(0);
  });

  it("honours ARK_FLY_TUNNEL=1 env var even without an explicit useTunnel option", async () => {
    wireFlyApiHappyPath(stub);
    const child = new FakeChildProcess({ pid: 8888 });
    const spawnCalls: Array<ReadonlyArray<string>> = [];
    process.env.ARK_FLY_TUNNEL = "1";

    setFlyHooksForTesting({
      fetchFn: stub.fn,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      spawn: ((_cmd, args) => {
        spawnCalls.push([...args]);
        return child as unknown as ChildProcess;
      }) as SpawnFn,
      allocatePort: async () => 40042,
    });

    const compute = new FlyMachinesCompute();
    const h = await compute.provision({ tags: { name: "vm1" } });

    expect(spawnCalls).toHaveLength(1);
    const meta = (h.meta as { fly: FlyMeta }).fly;
    expect(meta.arkdLocalPort).toBe(40042);
    expect(compute.getArkdUrl(h)).toBe("http://localhost:40042");
  });

  it("destroy() kills the tunnel before hitting the Fly destroy API", async () => {
    wireFlyApiHappyPath(stub);
    const child = new FakeChildProcess({ pid: 9999 });

    setFlyHooksForTesting({
      fetchFn: stub.fn,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      spawn: (() => child as unknown as ChildProcess) as SpawnFn,
      allocatePort: async () => 40043,
    });

    const compute = new FlyMachinesCompute({ useTunnel: true });
    const h = await compute.provision({ tags: { name: "vm1" } });

    // Monkey-patch process.kill so the test doesn't actually try to send a
    // signal to PID 9999 on the host.
    const originalKill = process.kill;
    const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    try {
      stub.calls.length = 0;
      await compute.destroy(h);
    } finally {
      process.kill = originalKill;
    }

    // Tunnel killed (SIGTERM + SIGKILL escalation) before the destroy API fires.
    expect(killCalls.length).toBeGreaterThanOrEqual(2);
    expect(killCalls[0]).toEqual({ pid: 9999, signal: "SIGTERM" });
    expect(killCalls[killCalls.length - 1]).toEqual({ pid: 9999, signal: "SIGKILL" });

    // DELETE /machines/m_abc123?force=true was called last.
    const deleteCall = stub.calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.url).toContain("/machines/m_abc123");
    expect(deleteCall!.url).toContain("force=true");
  });

  it("rolls back the machine when the tunnel fails to become ready", async () => {
    wireFlyApiHappyPath(stub);
    // Override /health so the readiness probe NEVER succeeds -- this forces
    // openFlyTunnel to fall into the timeout path and reject.
    stub.setHandler("GET /health", () => jsonResponse(502, { error: "bad gateway" }));

    const child = new FakeChildProcess({ pid: 1111 });

    // Virtual clock to burn past the 10 s readiness deadline quickly.
    let t = 0;
    setFlyHooksForTesting({
      fetchFn: stub.fn,
      sleep: async () => {
        t += 5_000;
      },
      now: () => t,
      spawn: (() => child as unknown as ChildProcess) as SpawnFn,
      allocatePort: async () => 40044,
    });

    const compute = new FlyMachinesCompute({ useTunnel: true });

    await expect(compute.provision({ tags: { name: "vm1" } })).rejects.toThrow(/readiness timed out/);

    // Rollback: DELETE /machines/m_abc123?force=true must have been called
    // so we don't leak a half-provisioned machine on failure.
    const deleteCall = stub.calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.url).toContain("/machines/m_abc123");
    expect(deleteCall!.url).toContain("force=true");
  });
});
