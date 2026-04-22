/**
 * session/pause + session/resume RPC tests.
 *
 * Exercises both the snapshot-capable path (fake compute, snapshots persisted
 * to the FS SnapshotStore) and the graceful-degradation path for the default
 * `LocalCompute` (no snapshot support -> state-only pause, surfaced via
 * `notSupported: true`).
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  ProvisionOpts,
  Snapshot,
} from "../../compute/core/types.js";
import { NotSupportedError } from "../../compute/core/types.js";
import { setApp } from "../../core/__tests__/test-helpers.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

// ── A fake snapshot-capable compute we can swap into the registry per test ──
class FakeSnapshotCompute implements Compute {
  readonly kind: ComputeKind = "firecracker";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    pool: false,
    networkIsolation: true,
    provisionLatency: "seconds",
  };
  snapshotCalls = 0;
  restoreCalls = 0;
  lastRestored: Snapshot | null = null;

  setApp(_app: AppContext): void {}

  async provision(_opts: ProvisionOpts): Promise<ComputeHandle> {
    return { kind: this.kind, name: "fake-fc", meta: {} };
  }
  async start(_h: ComputeHandle): Promise<void> {}
  async stop(_h: ComputeHandle): Promise<void> {}
  async destroy(_h: ComputeHandle): Promise<void> {}
  getArkdUrl(_h: ComputeHandle): string {
    return "http://localhost:19300";
  }
  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    this.snapshotCalls++;
    return {
      id: "snap-native-id", // overridden by the SnapshotStore mint
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { memFilePath: "/tmp/m", stateFilePath: "/tmp/s" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    this.restoreCalls++;
    this.lastRestored = s;
    return { kind: this.kind, name: "fake-fc", meta: { restored: true } };
  }
}

/** Create a compute row if it doesn't already exist. */
function ensureCompute(ctx: AppContext, name: string, provider: string): void {
  if (ctx.computes.get(name)) return;
  ctx.computeService.create({ name, provider, config: {} });
}

async function startSession(opts: Record<string, unknown> = {}): Promise<string> {
  const res = await router.dispatch(
    createRequest(1, "session/start", { summary: "pause-test", repo: ".", flow: "bare", ...opts }),
  );
  const session = ((res as JsonRpcResponse).result as Record<string, any>).session;
  return session.id as string;
}

describe("session/pause", async () => {
  it("on a snapshot-capable compute: calls compute.snapshot() and persists via SnapshotStore", async () => {
    // Seed a compute row so the session resolves to the firecracker kind.
    ensureCompute(app, "firecracker-1", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const id = await startSession({ compute_name: "firecracker-1" });

    const res = await router.dispatch(createRequest(2, "session/pause", { sessionId: id, reason: "test" }));
    const result = (res as JsonRpcResponse).result as Record<string, any>;

    expect(result.ok).toBe(true);
    expect(fake.snapshotCalls).toBe(1);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.id).toBeTruthy();
    expect(result.snapshot.computeKind).toBe("firecracker");
    expect(result.snapshot.sessionId).toBe(id);
    expect(result.snapshot.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });

    // The session row records the snapshot id for use by resume().
    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot.id);
  });

  it("on a non-snapshot compute: degrades to state-only pause with notSupported=true", async () => {
    const id = await startSession(); // defaults to local compute

    const res = await router.dispatch(createRequest(2, "session/pause", { sessionId: id }));
    const result = (res as JsonRpcResponse).result as Record<string, any>;

    expect(result.ok).toBe(true);
    expect(result.notSupported).toBe(true);
    expect(result.snapshot).toBe(null);

    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
  });
});

describe("session/resume", async () => {
  it("restores from the session's last snapshot and clears blocked state", async () => {
    ensureCompute(app, "firecracker-resume", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const id = await startSession({ compute_name: "firecracker-resume" });
    // Pause to produce a snapshot.
    const pauseRes = await router.dispatch(createRequest(2, "session/pause", { sessionId: id }));
    const pauseResult = (pauseRes as JsonRpcResponse).result as Record<string, any>;
    expect(pauseResult.snapshot.id).toBeTruthy();

    // Now resume.
    const res = await router.dispatch(createRequest(3, "session/resume", { sessionId: id }));
    const result = (res as JsonRpcResponse).result as Record<string, any>;

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot.id);
    expect(fake.restoreCalls).toBe(1);
    expect(fake.lastRestored?.id).toBe(pauseResult.snapshot.id);

    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("on a session with no snapshot: falls through to state-only resume", async () => {
    const id = await startSession();
    // Pause via state-only path (local compute).
    await router.dispatch(createRequest(2, "session/pause", { sessionId: id }));

    const res = await router.dispatch(createRequest(3, "session/resume", { sessionId: id }));
    const result = (res as JsonRpcResponse).result as Record<string, any>;

    expect(result.ok).toBe(true);
    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("ready");
  });

  it("falls back to state-only resume when the referenced snapshot's compute lacks restore support", async () => {
    // Save a snapshot referencing a kind whose registered compute doesn't support restore.
    // We use the vanilla LocalCompute (kind = "local", capabilities.snapshot = false).
    const blob = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const saved = await app.snapshotStore.save({ computeKind: "local", sessionId: "s-nope", metadata: {} }, blob);

    // Create a session and point it at that snapshot.
    const id = await startSession();
    await app.sessions.update(id, {
      config: { ...((await app.sessions.get(id))!.config as Record<string, unknown>), last_snapshot_id: saved.id },
    });

    const res = await router.dispatch(createRequest(2, "session/resume", { sessionId: id }));
    // notSupported path: falls back to state-only resume.
    const result = (res as JsonRpcResponse).result as Record<string, any>;
    expect(result.ok).toBe(true);
    expect((await app.sessions.get(id))!.status).toBe("ready");
  });
});

describe("NotSupportedError surface", () => {
  it("NotSupportedError carries compute kind + op label", () => {
    const e = new NotSupportedError("local", "snapshot");
    expect(e.name).toBe("NotSupportedError");
    expect(e.computeKind).toBe("local");
    expect(e.op).toBe("snapshot");
    expect(e.message).toContain("local");
    expect(e.message).toContain("snapshot");
  });
});
