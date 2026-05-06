/**
 * Unit tests for pauseWithSnapshot / resumeFromSnapshot / resolveSessionCompute.
 *
 * Tests the core pause/resume-with-snapshot orchestration independently from
 * the RPC layer. Uses a minimal fake compute + in-memory snapshot store to
 * exercise all branches: success, session not found, compute not found,
 * capability not supported, snapshot/restore errors, and persist failures.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../app.js";
import { pauseWithSnapshot, resumeFromSnapshot, resolveSessionCompute } from "../session-snapshot.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  ProvisionOpts,
  Snapshot,
} from "../../compute/core/types.js";
import { NotSupportedError } from "../../compute/core/types.js";
import { setApp } from "../../__tests__/test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
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

async function seedSession(computeName?: string): Promise<string> {
  const session = await app.sessionService.start({ summary: "pause-snap-test", repo: ".", flow: "bare" });
  if (computeName) {
    await app.sessions.update(session.id, { compute_name: computeName });
  }
  return session.id;
}

async function ensureCompute(name: string, provider: string, computeKind?: string): Promise<void> {
  if (await app.computes.get(name)) return;
  await app.computeService.create({
    name,
    provider,
    // When the compute_kind differs from `providerToPair(provider).compute`
    // (e.g. provider="firecracker" maps to compute="local" in the legacy
    // table, but we want the snapshot tests to resolve to ComputeKind
    // "firecracker"), pass the axis explicitly so the stored row carries
    // the right kind.
    ...(computeKind ? { compute: computeKind as any } : {}),
    config: {},
  });
}

// ── resolveSessionCompute ─────────────────────────────────────────────────

describe("resolveSessionCompute", async () => {
  it("returns null for nonexistent session", async () => {
    expect(await resolveSessionCompute(app, "s-does-not-exist")).toBeNull();
  });

  it("resolves local compute by default", async () => {
    const id = await seedSession();
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local");
    expect(resolved!.handle.kind).toBe("local");
  });

  it("resolves firecracker compute from compute_kind column", async () => {
    await ensureCompute("firecracker-test", "firecracker", "firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = await seedSession("firecracker-test");
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("firecracker");
  });

  it("resolves ec2 compute from compute_kind column", async () => {
    await ensureCompute("ec2-large", "ec2");
    const id = await seedSession("ec2-large");
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("ec2");
  });

  it("resolves k8s-kata compute from compute_kind column", async () => {
    await ensureCompute("k8s-kata-1", "k8s-kata");
    const id = await seedSession("k8s-kata-1");
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("k8s-kata");
  });

  it("resolves k8s compute from compute_kind column", async () => {
    await ensureCompute("k8s-default", "k8s");
    const id = await seedSession("k8s-default");
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("k8s");
  });

  // Regression: the old helper derived kind from the compute name prefix
  // (e.g. "kata-prod" -> "local"). Now that we read `compute.compute_kind`
  // directly, a user-chosen name pointing at a k8s-kata compute resolves
  // to the correct kind.
  it("reads compute_kind column for user-named k8s-kata compute", async () => {
    await ensureCompute("kata-prod", "k8s-kata");
    const id = await seedSession("kata-prod");
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("k8s-kata");
  });

  it("returns null when compute_name points at a missing compute row", async () => {
    const id = await seedSession("does-not-exist");
    expect(await resolveSessionCompute(app, id)).toBeNull();
  });

  it("includes compute_handle metadata from session config", async () => {
    const id = await seedSession();
    await app.sessions.update(id, {
      config: { compute_handle: { instanceId: "i-abc" } },
    });
    const resolved = await resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.handle.meta).toEqual({ instanceId: "i-abc" });
  });
});

// ── pauseWithSnapshot ─────────────────────────────────────────────────────

describe("pauseWithSnapshot", async () => {
  let fake: FakeSnapshotCompute;

  beforeEach(async () => {
    fake = new FakeSnapshotCompute();
    fake.snapshotError = null;
    fake.restoreError = null;
    fake.snapshotCalls = 0;
    fake.restoreCalls = 0;
    app.registerCompute(fake);
    await ensureCompute("firecracker-snap", "firecracker", "firecracker");
  });

  it("snapshots + persists + marks session blocked", async () => {
    const id = await seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id, { reason: "test pause" });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Paused");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.sessionId).toBe(id);
    expect(result.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });
    expect(fake.snapshotCalls).toBe(1);

    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect(session.breakpoint_reason).toBe("test pause");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
  });

  it("defaults reason to 'User paused'", async () => {
    const id = await seedSession("firecracker-snap");
    await pauseWithSnapshot(app, id);
    expect((await app.sessions.get(id))!.breakpoint_reason).toBe("User paused");
  });

  it("returns not-found for missing session", async () => {
    const result = await pauseWithSnapshot(app, "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported for non-snapshot compute", async () => {
    const id = await seedSession(); // local compute
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns error when compute.snapshot() throws generic error", async () => {
    fake.snapshotError = new Error("VM crashed");
    const id = await seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("VM crashed");
    expect(result.notSupported).toBeUndefined();
  });

  it("returns notSupported when compute.snapshot() throws NotSupportedError", async () => {
    fake.snapshotError = new NotSupportedError("firecracker", "snapshot");
    const id = await seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("logs session_paused event with snapshot data", async () => {
    const id = await seedSession("firecracker-snap");
    const result = await pauseWithSnapshot(app, id, { reason: "deploy" });
    const evts = await app.events.list(id, { type: "session_paused" });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts[evts.length - 1];
    expect(latest.data).toBeDefined();
    const data = typeof latest.data === "string" ? JSON.parse(latest.data) : latest.data;
    expect(data.snapshot_id).toBe(result.snapshot!.id);
  });
});

// ── resumeFromSnapshot ────────────────────────────────────────────────────

describe("resumeFromSnapshot", async () => {
  let fake: FakeSnapshotCompute;

  beforeEach(async () => {
    fake = new FakeSnapshotCompute();
    fake.snapshotError = null;
    fake.restoreError = null;
    fake.snapshotCalls = 0;
    fake.restoreCalls = 0;
    app.registerCompute(fake);
    await ensureCompute("firecracker-res", "firecracker", "firecracker");
  });

  it("restores from session's last_snapshot_id", async () => {
    const id = await seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
    expect(fake.restoreCalls).toBe(1);

    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("accepts explicit snapshotId", async () => {
    const id = await seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id);

    const result = await resumeFromSnapshot(app, id, { snapshotId: pauseResult.snapshot!.id });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("falls back to latest snapshot from store when no last_snapshot_id", async () => {
    const id = await seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id);

    // Clear last_snapshot_id from config
    await app.sessions.update(id, { config: {} });

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
    const id = await seedSession("firecracker-res");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("returns error when compute.restore() throws generic error", async () => {
    const id = await seedSession("firecracker-res");
    await pauseWithSnapshot(app, id);
    fake.restoreError = new Error("disk full");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("disk full");
  });

  it("returns notSupported when compute.restore() throws NotSupportedError", async () => {
    const id = await seedSession("firecracker-res");
    await pauseWithSnapshot(app, id);
    fake.restoreError = new NotSupportedError("firecracker", "restore");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns notSupported when referenced compute lacks restore capability", async () => {
    const id = await seedSession(); // local compute (no snapshot support)

    // Manually save a snapshot referencing "local" compute kind
    const blob = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const saved = await app.snapshotStore.save({ computeKind: "local", sessionId: id, metadata: {} }, blob);
    await app.sessions.update(id, {
      config: { last_snapshot_id: saved.id },
    });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("logs session_resumed event with snapshot data", async () => {
    const id = await seedSession("firecracker-res");
    await pauseWithSnapshot(app, id);
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);

    const evts = await app.events.list(id, { type: "session_resumed" });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts[evts.length - 1];
    const data = typeof latest.data === "string" ? JSON.parse(latest.data) : latest.data;
    expect(data.snapshot_id).toBe(result.snapshotId);
  });

  it("round-trips pause + resume preserving snapshot metadata", async () => {
    const id = await seedSession("firecracker-res");
    const pauseResult = await pauseWithSnapshot(app, id, { reason: "round-trip" });
    expect(pauseResult.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });

    const resumeResult = await resumeFromSnapshot(app, id);
    expect(resumeResult.ok).toBe(true);
    expect(fake.lastRestored!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });
  });
});
