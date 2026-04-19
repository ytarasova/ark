/**
 * FlyMachinesCompute unit tests.
 *
 * Every HTTP call is stubbed via `setFlyHooksForTesting({ fetchFn })` so the
 * tests never touch the real Fly API. The stub fetch is a small router that
 * matches `<METHOD> <PATH>` to a handler and returns canned JSON.
 *
 * Target: the mapping `(ProvisionOpts, Fly API responses) -> handle.meta.fly`
 * plus the lifecycle wrappers (start / stop / destroy / snapshot / restore /
 * getArkdUrl) and the FLY_API_TOKEN gate.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { FlyMachinesCompute, setFlyHooksForTesting, type FlyMeta } from "../core/fly/compute.js";
import type { ComputeHandle, Snapshot } from "../core/types.js";

// ── Stub fetch harness ─────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type StubHandler = (req: RecordedRequest) => Response | Promise<Response>;

interface StubFetch {
  fn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedRequest[];
  setHandler: (key: string, h: StubHandler) => void;
  setDefault: (h: StubHandler) => void;
}

function makeStubFetch(): StubFetch {
  const handlers = new Map<string, StubHandler>();
  let defaultHandler: StubHandler = (req) => jsonResponse(404, { error: `unhandled ${req.method} ${req.url}` });
  const calls: RecordedRequest[] = [];

  async function fn(input: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedRequest = { method, url: input, headers, body };
    calls.push(req);

    // Match longest key first so `/machines/<id>/start` wins over `/machines/<id>`.
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── Default "happy path" wiring ────────────────────────────────────────────

function wireHappyPath(stub: StubFetch, overrides?: { privateIp?: string; region?: string; name?: string }): void {
  const privateIp = overrides?.privateIp ?? "fdaa:0:1234::2";
  const region = overrides?.region ?? "ord";
  const name = overrides?.name ?? "vm1";

  // App create: 200.
  stub.setHandler("POST /apps", () => jsonResponse(200, { name: "ark-vm1" }));

  // Machine create returns id + region; private_ip is filled in by the
  // subsequent GET poll, just like the real API often does.
  stub.setHandler("POST /machines", (req) => {
    const body = req.body as { name?: string; region?: string };
    return jsonResponse(200, {
      id: "m_abc123",
      name: body?.name ?? name,
      region: body?.region ?? region,
      state: "starting",
    });
  });

  // First GET returns "starting"; second and later return "started" with ip.
  let pollCount = 0;
  stub.setHandler("GET /machines/m_abc123", () => {
    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse(200, { id: "m_abc123", state: "starting", region });
    }
    return jsonResponse(200, {
      id: "m_abc123",
      state: "started",
      region,
      private_ip: privateIp,
    });
  });

  // Lifecycle endpoints all 200.
  stub.setHandler("POST /machines/m_abc123/start", () => jsonResponse(200, {}));
  stub.setHandler("POST /machines/m_abc123/stop", () => jsonResponse(200, {}));
  stub.setHandler("POST /machines/m_abc123/suspend", () => jsonResponse(200, {}));
  stub.setHandler("DELETE /machines/m_abc123?force=true", () => jsonResponse(200, {}));
}

// ── Global fixture wiring ──────────────────────────────────────────────────

let stub: StubFetch;
let compute: FlyMachinesCompute;

beforeEach(() => {
  stub = makeStubFetch();
  setFlyHooksForTesting({
    fetchFn: stub.fn,
    sleep: async () => {}, // never actually sleep in tests
    now: () => 1_700_000_000_000,
  });
  process.env.FLY_API_TOKEN = "fo_test_token";
  compute = new FlyMachinesCompute();
});

afterEach(() => {
  setFlyHooksForTesting(null);
  delete process.env.FLY_API_TOKEN;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("FlyMachinesCompute kind + capabilities", () => {
  it("reports kind=fly-machines", () => {
    expect(compute.kind).toBe("fly-machines");
  });

  it("capabilities declare snapshot + networkIsolation, provisionLatency=seconds", () => {
    expect(compute.capabilities).toEqual({
      snapshot: true,
      pool: false,
      networkIsolation: true,
      provisionLatency: "seconds",
    });
  });
});

describe("provision token gate", () => {
  it("throws with an actionable error when FLY_API_TOKEN is absent", async () => {
    delete process.env.FLY_API_TOKEN;
    await expect(compute.provision({ tags: { name: "vm1" } })).rejects.toThrow(/FLY_API_TOKEN/);
    // Nothing should have been dispatched to fetch when the gate fires.
    expect(stub.calls).toEqual([]);
  });
});

describe("provision happy path", () => {
  it("creates app + machine, polls until started, returns the fly meta shape", async () => {
    wireHappyPath(stub);

    const h = await compute.provision({ tags: { name: "vm1" } });

    expect(h.kind).toBe("fly-machines");
    expect(h.name).toBe("vm1");
    const meta = (h.meta as { fly: FlyMeta }).fly;
    expect(meta).toMatchObject({
      machineId: "m_abc123",
      region: "ord",
      privateIp: "fdaa:0:1234::2",
      arkdPort: 19300,
      arkdUrl: "http://[fdaa:0:1234::2]:19300",
    });

    // Call order: POST /apps -> POST /machines -> GET (x2+ until started).
    const methods = stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(methods[0]).toBe("POST /v1/apps");
    expect(methods[1]).toMatch(/POST \/v1\/apps\/[^/]+\/machines$/);
    expect(methods.filter((m) => m.includes("GET")).length).toBeGreaterThanOrEqual(2);
  });

  it("sends Authorization: Bearer <token> on every request", async () => {
    wireHappyPath(stub);
    await compute.provision({ tags: { name: "vm1" } });
    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.headers["Authorization"]).toBe("Bearer fo_test_token");
    }
  });

  it("passes image + env through to the machine config body", async () => {
    wireHappyPath(stub);

    await compute.provision({
      tags: { name: "vm1" },
      config: {
        image: "registry.fly.io/my-arkd:custom",
        env: { FOO: "bar", ARK_TOKEN: "tok" },
        region: "lax",
        size: "performance-2x",
      },
    });

    const createCall = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/machines"));
    expect(createCall).toBeDefined();
    const body = createCall!.body as {
      name?: string;
      region: string;
      config: { image: string; env: Record<string, string>; services: Array<{ internal_port: number }>; size: string };
    };
    expect(body.region).toBe("lax");
    expect(body.config.image).toBe("registry.fly.io/my-arkd:custom");
    expect(body.config.env).toEqual({ FOO: "bar", ARK_TOKEN: "tok" });
    expect(body.config.size).toBe("performance-2x");
    // Services: arkd on 19300 tcp, no public ports.
    expect(body.config.services).toEqual([{ internal_port: 19300, protocol: "tcp", ports: [] }]);
  });

  it("treats 422 from POST /apps as 'app already exists' and continues", async () => {
    stub.setHandler("POST /apps", () => jsonResponse(422, { error: "Validation: app_name has already been taken" }));
    stub.setHandler("POST /machines", () => jsonResponse(200, { id: "m_abc123", region: "ord", state: "starting" }));
    stub.setHandler("GET /machines/m_abc123", () =>
      jsonResponse(200, { id: "m_abc123", state: "started", region: "ord", private_ip: "fdaa::1" }),
    );

    const h = await compute.provision({ tags: { name: "vm1" } });
    expect((h.meta as { fly: FlyMeta }).fly.machineId).toBe("m_abc123");
  });

  it("throws when POST /apps returns a non-422 non-2xx status", async () => {
    stub.setHandler("POST /apps", () => jsonResponse(500, { error: "internal" }));
    await expect(compute.provision({ tags: { name: "vm1" } })).rejects.toThrow(/POST \/apps/);
  });

  it("throws with useful context when POST /machines fails", async () => {
    stub.setHandler("POST /apps", () => jsonResponse(200, {}));
    stub.setHandler("POST /machines", () => jsonResponse(400, { error: "image not found" }));
    await expect(compute.provision({ tags: { name: "vm1" } })).rejects.toThrow(/image not found/);
  });

  it("polls GET /machines/<id> until state=started before returning", async () => {
    wireHappyPath(stub);
    await compute.provision({ tags: { name: "vm1" } });

    const gets = stub.calls.filter((c) => c.method === "GET" && c.url.endsWith("/machines/m_abc123"));
    // Happy-path wiring has first GET return "starting", second return "started".
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it("throws when the machine reaches a terminal failed state during provision", async () => {
    stub.setHandler("POST /apps", () => jsonResponse(200, {}));
    stub.setHandler("POST /machines", () => jsonResponse(200, { id: "m_abc123", region: "ord", state: "starting" }));
    stub.setHandler("GET /machines/m_abc123", () =>
      jsonResponse(200, { id: "m_abc123", state: "failed", region: "ord" }),
    );
    await expect(compute.provision({ tags: { name: "vm1" } })).rejects.toThrow(/terminal state=failed/);
  });

  it("throws when the machine is started but has no private_ip", async () => {
    stub.setHandler("POST /apps", () => jsonResponse(200, {}));
    stub.setHandler("POST /machines", () => jsonResponse(200, { id: "m_abc123", region: "ord", state: "starting" }));
    stub.setHandler("GET /machines/m_abc123", () =>
      // Started but no private_ip (shouldn't happen on a healthy Fly but we
      // must fail closed so the handle never carries an unreachable URL).
      jsonResponse(200, { id: "m_abc123", state: "started", region: "ord" }),
    );
    await expect(compute.provision({ tags: { name: "vm1" } })).rejects.toThrow(/no private_ip/);
  });

  it("generates a random machine name when opts.tags.name is absent", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({});
    expect(h.name).toMatch(/^fly-[a-z0-9]+$/);
  });

  it("emits onLog callbacks for app + machine create + ready", async () => {
    wireHappyPath(stub);
    const messages: string[] = [];
    await compute.provision({ tags: { name: "vm1" }, onLog: (m) => messages.push(m) });
    expect(messages.some((m) => m.includes("app"))).toBe(true);
    expect(messages.some((m) => m.includes("machine m_abc123 created"))).toBe(true);
    expect(messages.some((m) => m.includes("ready"))).toBe(true);
  });
});

describe("start / stop / destroy", () => {
  it("start() hits POST /machines/<id>/start", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({ tags: { name: "vm1" } });
    stub.calls.length = 0;

    await compute.start(h);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("POST");
    expect(stub.calls[0].url).toMatch(/\/machines\/m_abc123\/start$/);
  });

  it("stop() hits POST /machines/<id>/stop", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({ tags: { name: "vm1" } });
    stub.calls.length = 0;

    await compute.stop(h);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("POST");
    expect(stub.calls[0].url).toMatch(/\/machines\/m_abc123\/stop$/);
  });

  it("destroy() hits DELETE /machines/<id>?force=true", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({ tags: { name: "vm1" } });
    stub.calls.length = 0;

    await compute.destroy(h);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("DELETE");
    expect(stub.calls[0].url).toContain("/machines/m_abc123");
    expect(stub.calls[0].url).toContain("force=true");
  });
});

describe("snapshot / restore", () => {
  it("snapshot() calls POST /machines/<id>/suspend and returns a Snapshot carrying machineId + appName", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({ tags: { name: "vm1" } });
    stub.calls.length = 0;

    const snap = await compute.snapshot(h);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("POST");
    expect(stub.calls[0].url).toMatch(/\/machines\/m_abc123\/suspend$/);

    expect(snap.computeKind).toBe("fly-machines");
    expect(snap.id).toBe("m_abc123");
    expect(typeof snap.createdAt).toBe("string");
    const md = snap.metadata as { machineId: string; appName: string; privateIp: string };
    expect(md.machineId).toBe("m_abc123");
    expect(md.appName).toBeTruthy();
    expect(md.privateIp).toBe("fdaa:0:1234::2");
  });

  it("restore() calls POST /machines/<id>/start and rebuilds handle from snapshot metadata", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({ tags: { name: "vm1" } });
    const snap = await compute.snapshot(h);
    stub.calls.length = 0;

    const restored = await compute.restore(snap);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("POST");
    expect(stub.calls[0].url).toMatch(/\/machines\/m_abc123\/start$/);

    expect(restored.kind).toBe("fly-machines");
    const meta = (restored.meta as { fly: FlyMeta }).fly;
    expect(meta.machineId).toBe("m_abc123");
    expect(meta.privateIp).toBe("fdaa:0:1234::2");
    expect(meta.arkdUrl).toBe("http://[fdaa:0:1234::2]:19300");
  });

  it("restore() rejects snapshots taken on a different compute kind", async () => {
    const bad: Snapshot = {
      id: "m_abc",
      computeKind: "ec2",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { machineId: "m_abc", appName: "ark-x", privateIp: "fdaa::1" },
    };
    await expect(compute.restore(bad)).rejects.toThrow(/Snapshot is for ec2/);
  });

  it("restore() rejects snapshots with missing required metadata fields", async () => {
    const bad: Snapshot = {
      id: "m_abc",
      computeKind: "fly-machines",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { machineId: "m_abc" /* missing appName, privateIp */ },
    };
    await expect(compute.restore(bad)).rejects.toThrow(/missing required fields/);
  });
});

describe("getArkdUrl", () => {
  it("returns the bracketed IPv6 URL built from privateIp + port 19300", async () => {
    wireHappyPath(stub);
    const h = await compute.provision({ tags: { name: "vm1" } });
    expect(compute.getArkdUrl(h)).toBe("http://[fdaa:0:1234::2]:19300");
  });

  it("throws when handle.meta.fly is missing", () => {
    const bogus: ComputeHandle = { kind: "fly-machines", name: "x", meta: {} };
    expect(() => compute.getArkdUrl(bogus)).toThrow(/meta\.fly missing/);
  });
});
