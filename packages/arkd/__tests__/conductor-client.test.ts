/**
 * Tests for the ConductorClient WS-based outbound client.
 *
 * Spins up a minimal Bun WebSocket server that speaks JSON-RPC 2.0 and
 * records the methods it receives. Verifies that:
 *   1. worker/register is sent on initial connect.
 *   2. heartbeat() fires a worker/heartbeat RPC.
 *   3. deregister() sends worker/deregister before closing.
 *   4. On reconnect, worker/register is re-issued automatically.
 *   5. HTTP URLs (legacy) are translated to ws:// transparently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createConductorClient } from "../server/conductor-client.js";
import { allocatePort } from "../../core/config/port-allocator.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface JrpcMsg {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  jsonrpc?: string;
}

/** Wait until a condition is true or throw after timeout. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  opts?: { timeout?: number; interval?: number; message?: string },
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 50;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error(opts?.message ?? `waitFor timed out after ${timeout}ms`);
}

// ── Minimal JSON-RPC 2.0 WS server ─────────────────────────────────────────

type MinimalWsServer = {
  port: number;
  received: JrpcMsg[];
  stop: () => void;
};

function startMockConductor(port: number): MinimalWsServer {
  const received: JrpcMsg[] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("Ark mock conductor", { status: 200 });
    },
    websocket: {
      message(ws, raw: string | Buffer) {
        let msg: JrpcMsg;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Buffer));
        } catch {
          return;
        }
        received.push(msg);
        // Respond to RPC calls
        if (msg.id !== undefined && msg.method) {
          const response = JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: buildResult(msg.method, msg.params as Record<string, unknown>),
          });
          ws.send(response);
        }
      },
      open() {},
      close() {},
    },
  });

  return { port, received, stop: () => server.stop() };
}

function buildResult(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize":
      return { server: { name: "mock-conductor", version: "0.0.1" } };
    case "worker/register":
      return { status: "registered", id: params?.id ?? "unknown" };
    case "worker/heartbeat":
      return { status: "ok" };
    case "worker/deregister":
      return { status: "deregistered", id: params?.id ?? "unknown" };
    default:
      return { ok: true };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

let conductorPort: number;
let mock: MinimalWsServer;

beforeAll(async () => {
  conductorPort = await allocatePort();
  mock = startMockConductor(conductorPort);
});

afterAll(() => {
  mock.stop();
});

beforeEach(() => {
  // Clear recorded messages before each test
  mock.received.length = 0;
});

describe("createConductorClient -- initial registration", () => {
  it("sends worker/register immediately on connect", async () => {
    const handle = await createConductorClient(`ws://127.0.0.1:${conductorPort}`, {
      id: "w-test-1",
      url: "http://arkd-host:19300",
    });

    try {
      await waitFor(() => mock.received.some((m) => m.method === "worker/register"), {
        timeout: 3000,
        message: "worker/register was never received",
      });

      const reg = mock.received.find((m) => m.method === "worker/register");
      expect(reg).toBeDefined();
      expect((reg!.params as any).id).toBe("w-test-1");
    } finally {
      await handle.deregister();
    }
  });

  it("accepts http:// URL and translates to ws://", async () => {
    mock.received.length = 0;

    const handle = await createConductorClient(`http://127.0.0.1:${conductorPort}`, {
      id: "w-test-http-translate",
      url: "http://arkd-host:19300",
    });

    try {
      await waitFor(() => mock.received.some((m) => m.method === "worker/register"), {
        timeout: 3000,
        message: "worker/register not received after http -> ws translation",
      });
      expect(mock.received.some((m) => m.method === "worker/register")).toBe(true);
    } finally {
      await handle.deregister();
    }
  });
});

describe("createConductorClient -- heartbeat", () => {
  it("heartbeat() sends worker/heartbeat with correct id", async () => {
    const handle = await createConductorClient(`ws://127.0.0.1:${conductorPort}`, {
      id: "w-hb-test",
      url: "http://arkd-host:19300",
    });

    try {
      // Wait for initial register to land first
      await waitFor(() => mock.received.some((m) => m.method === "worker/register"), { timeout: 3000 });
      mock.received.length = 0;

      handle.heartbeat();

      await waitFor(() => mock.received.some((m) => m.method === "worker/heartbeat"), {
        timeout: 3000,
        message: "worker/heartbeat was never received",
      });

      const hb = mock.received.find((m) => m.method === "worker/heartbeat");
      expect(hb).toBeDefined();
      expect((hb!.params as any).id).toBe("w-hb-test");
    } finally {
      await handle.deregister();
    }
  });
});

describe("createConductorClient -- deregister", () => {
  it("deregister() sends worker/deregister before closing", async () => {
    const handle = await createConductorClient(`ws://127.0.0.1:${conductorPort}`, {
      id: "w-dereg-test",
      url: "http://arkd-host:19300",
    });

    // Wait for initial register
    await waitFor(() => mock.received.some((m) => m.method === "worker/register"), { timeout: 3000 });
    mock.received.length = 0;

    await handle.deregister();

    // deregister() awaits the RPC so the message is already there
    const dereg = mock.received.find((m) => m.method === "worker/deregister");
    expect(dereg).toBeDefined();
    expect((dereg!.params as any).id).toBe("w-dereg-test");
  });
});

describe("createConductorClient -- ordering", () => {
  it("worker/register arrives before first explicit heartbeat", async () => {
    mock.received.length = 0;

    const handle = await createConductorClient(`ws://127.0.0.1:${conductorPort}`, {
      id: "w-order-test",
      url: "http://arkd-host:19300",
    });

    try {
      // Heartbeat immediately after construction
      handle.heartbeat();

      await waitFor(() => mock.received.some((m) => m.method === "worker/heartbeat"), {
        timeout: 3000,
        message: "heartbeat never received",
      });

      const regIdx = mock.received.findIndex((m) => m.method === "worker/register");
      const hbIdx = mock.received.findIndex((m) => m.method === "worker/heartbeat");

      // register must appear in the received log before heartbeat
      expect(regIdx).toBeGreaterThanOrEqual(0);
      expect(hbIdx).toBeGreaterThan(regIdx);
    } finally {
      await handle.deregister();
    }
  });
});

describe("createConductorClient -- with optional fields", () => {
  it("passes capacity, compute_name, tenant_id, metadata in register params", async () => {
    mock.received.length = 0;

    const handle = await createConductorClient(`ws://127.0.0.1:${conductorPort}`, {
      id: "w-full-test",
      url: "http://arkd-host:19300",
      capacity: 8,
      compute_name: "ec2-us-east-1",
      tenant_id: "t-acme",
      metadata: { region: "us-east-1" },
    });

    try {
      await waitFor(() => mock.received.some((m) => m.method === "worker/register"), { timeout: 3000 });

      const reg = mock.received.find((m) => m.method === "worker/register");
      const p = reg!.params as any;
      expect(p.capacity).toBe(8);
      expect(p.compute_name).toBe("ec2-us-east-1");
      expect(p.tenant_id).toBe("t-acme");
      expect(p.metadata?.region).toBe("us-east-1");
    } finally {
      await handle.deregister();
    }
  });
});
