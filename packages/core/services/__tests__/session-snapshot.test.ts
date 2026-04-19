/**
 * Unit tests for pauseWithSnapshot / resumeFromSnapshot / resolveSessionCompute.
 *
 * Tests the core pause/resume-with-snapshot orchestration independently from
 * the RPC layer. Uses a minimal fake compute + in-memory snapshot store to
 * exercise all branches: success, session not found, compute not found,
 * capability not supported, snapshot/restore errors, and persist failures.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import { pauseWithSnapshot, resumeFromSnapshot, resolveSessionCompute } from "../session-snapshot.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  ProvisionOpts,
  Snapshot,
} from "../../../compute/core/types.js";
import { NotSupportedError } from "../../../compute/core/types.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ── Fake computes ─────────────────────────────────────────────────────────

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
  snapshotError: Error | null = null;
  restoreError: Error | null = null;

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
    if (this.snapshotError) throw this.snapshotError;
    return {
      id: "snap-native",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { memFilePath: "/tmp/m", stateFilePath: "/tmp/s" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    this.restoreCalls++;
    this.lastRestored = s;
    if (this.restoreError) throw this.restoreError;
    return { kind: this.kind, name: "fake-fc", meta: { restored: true } };
  }
}

function seedSession(computeName?: string): string {
  const session = app.sessionService.start({ summary: "pause-snap-test", repo: ".", flow: "bare" });
  if (computeName) {
    app.sessions.update(session.id, { compute_name: computeName });
  }
  return session.id;
}

function ensureCompute(name: string, provider: string): void {
  if (app.computes.get(name)) return;
  app.computes.create({ name, provider, config: {} });
}

// ── resolveSessionCompute ─────────────────────────────────────────────────

describe("resolveSessionCompute", () => {
  it("returns null for nonexistent session", () => {
    expect(resolveSessionCompute(app, "s-does-not-exist")).toBeNull();
  });

  it("resolves local compute by default", () => {
    const id = seedSession();
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local");
    expect(resolved!.handle.kind).toBe("local");
  });

  it("resolves firecracker compute from compute_name prefix", () => {
    ensureCompute("firecracker-test", "firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = seedSession("firecracker-test");
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("firecracker");
  });

  it("resolves ec2 compute from compute_name prefix", () => {
    const id = seedSession("ec2-large");
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("ec2");
  });

  it("resolves k8s-kata compute from compute_name prefix", () => {
    const id = seedSession("k8s-kata-1");
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("k8s-kata");
  });

  it("resolves k8s compute from compute_name prefix", () => {
    const id = seedSession("k8s-default");
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("k8s");
  });

  it("includes compute_handle metadata from session config", () => {
    const id = seedSession();
    app.sessions.update(id, {
      config: { compute_handle: { instanceId: "i-abc" } },
    });
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.handle.meta).toEqual({ instanceId: "i-abc" });
  });
});

// ── pauseWithSnapshot ─────────────────────────────────────────────────────

describe("pauseWithSnapshot", () => {
  let fake: FakeSnapshotCompute;

  beforeEach(() => {
    fake = new FakeSnapshotCompute();
    fake.snapshotError = null;
    fake.restoreError = null;
    fake.snapshotCalls = 0;
    fake.restoreCalls = 0;
    app.registerCompute(fake);
    ensureCompute("firecracker-snap", "firecracker");
  });

  it("snapshots + persists + marks session blocked", async () => {
    const id = seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id, { reason: "test pause" });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Paused");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.sessionId).toBe(id);
    expect(result.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });
    expect(fake.snapshotCalls).toBe(1);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect(session.breakpoint_reason).toBe("test pause");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
  });

  it("defaults reason to 'User paused'", async () => {
    const id = seedSession("firecracker-snap");
    await pauseWithSnapshot(app, id);
    expect(app.sessions.get(id)!.breakpoint_reason).toBe("User paused");
  });

  it("returns not-found for missing session", async () => {
    const result = await pauseWithSnapshot(app, "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported for non-snapshot compute", async () => {
    const id = seedSession(); // local compute
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns error when compute.snapshot() throws generic error", async () => {
    fake.snapshotError = new Error("VM crashed");
    const id = seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("VM crashed");
    expect(result.notSupported).toBeUndefined();
  });

  it("returns notSupported when compute.snapshot() throws NotSupportedError", async () => {
    fake.snapshotError = new NotSupportedError("firecracker", "snapshot");
    const id = seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("logs session_paused event with snapshot data", async () => {
    const id = seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id, { reason: "deploy" });
    const evts = app.events.list(id, { type: "session_paused" });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts[evts.length - 1];
    expect(latest.data).toBeDefined();
    const data = typeof latest.data === "string" ? JSON.parse(latest.data) : latest.data;
    expect(data.snapshot_id).toBe(result.snapshot!.id);
  });
});

// ── resumeFromSnapshot ────────────────────────────────────────────────────

describe("resumeFromSnapshot", () => {
  let fake: FakeSnapshotCompute;

  beforeEach(() => {
    fake = new FakeSnapshotCompute();
    fake.snapshotError = null;
    fake.restoreError = null;
    fake.snapshotCalls = 0;
    fake.restoreCalls = 0;
    app.registerCompute(fake);
    ensureCompute("firecracker-res", "firecracker");
  });

  it("restores from session's last_snapshot_id", async () => {
    const id = seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
    expect(fake.restoreCalls).toBe(1);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("accepts explicit snapshotId", async () => {
    const id = seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id);

    const result = await resumeFromSnapshot(app, id, { snapshotId: pauseResult.snapshot!.id });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("falls back to latest snapshot from store when no last_snapshot_id", async () => {
    const id = seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id);

    // Clear last_snapshot_id from config
    app.sessions.update(id, { config: {} });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("returns not-found for missing session", async () => {
    const result = await resumeFromSnapshot(app, "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when no snapshot available", async () => {
    const id = seedSession("firecracker-res");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("returns error when compute.restore() throws generic error", async () => {
    const id = seedSession("firecracker-res");
    await pauseWithSnapshot(app, id);
    fake.restoreError = new Error("disk full");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("disk full");
  });

  it("returns notSupported when compute.restore() throws NotSupportedError", async () => {
    const id = seedSession("firecracker-res");
    await pauseWithSnapshot(app, id);
    fake.restoreError = new NotSupportedError("firecracker", "restore");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns notSupported when referenced compute lacks restore capability", async () => {
    const id = seedSession(); // local compute (no snapshot support)

    // Manually save a snapshot referencing "local" compute kind
    const blob = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const saved = await app.snapshotStore.save({ computeKind: "local", sessionId: id, metadata: {} }, blob);
    app.sessions.update(id, {
      config: { last_snapshot_id: saved.id },
    });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("logs session_resumed event with snapshot data", async () => {
    const id = seedSession("firecracker-res");
    await pauseWithSnapshot(app, id);
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);

    const evts = app.events.list(id, { type: "session_resumed" });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts[evts.length - 1];
    const data = typeof latest.data === "string" ? JSON.parse(latest.data) : latest.data;
    expect(data.snapshot_id).toBe(result.snapshotId);
  });

  it("round-trips pause + resume preserving snapshot metadata", async () => {
    const id = seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id, { reason: "round-trip" });
    expect(pauseResult.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });

    const resumeResult = await resumeFromSnapshot(app, id);
    expect(resumeResult.ok).toBe(true);
    expect(fake.lastRestored!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });
  });
});
