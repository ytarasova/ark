/**
 * Unit tests for session pause -- covers both the state-only `pause()` in
 * session-lifecycle.ts and the snapshot-backed `pauseWithSnapshot` /
 * `resumeFromSnapshot` in session-snapshot.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { pause } from "../services/session-lifecycle.js";
import { pauseWithSnapshot, resumeFromSnapshot, resolveSessionCompute } from "../services/session-snapshot.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  ProvisionOpts,
  Snapshot,
} from "../../compute/core/types.js";
import { NotSupportedError } from "../../compute/core/types.js";

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

function createSession(overrides: Record<string, unknown> = {}): string {
  const s = app.sessions.create({ summary: "pause-unit-test", repo: ".", flow: "bare", ...overrides });
  app.sessions.update(s.id, { status: "running", stage: "work" });
  return s.id;
}

class FakeCompute implements Compute {
  readonly kind: ComputeKind;
  readonly capabilities: ComputeCapabilities;
  snapshotCalls = 0;
  restoreCalls = 0;
  shouldThrowOnSnapshot: Error | null = null;
  shouldThrowOnRestore: Error | null = null;

  constructor(kind: ComputeKind, snapshot = true) {
    this.kind = kind;
    this.capabilities = { snapshot, pool: false, networkIsolation: false, provisionLatency: "seconds" };
  }

  setApp(_app: AppContext): void {}
  async provision(_opts: ProvisionOpts): Promise<ComputeHandle> {
    return { kind: this.kind, name: `fake-${this.kind}`, meta: {} };
  }
  async start(_h: ComputeHandle): Promise<void> {}
  async stop(_h: ComputeHandle): Promise<void> {}
  async destroy(_h: ComputeHandle): Promise<void> {}
  getArkdUrl(_h: ComputeHandle): string {
    return "http://localhost:19300";
  }
  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    if (this.shouldThrowOnSnapshot) throw this.shouldThrowOnSnapshot;
    this.snapshotCalls++;
    return {
      id: "snap-native",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { key: "value" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    if (this.shouldThrowOnRestore) throw this.shouldThrowOnRestore;
    this.restoreCalls++;
    return { kind: this.kind, name: `fake-${this.kind}`, meta: { restored: true } };
  }
}

function ensureCompute(name: string, provider: string): void {
  if (app.computes.get(name)) return;
  app.computes.create({ name, provider, config: {} });
}

// ── State-only pause (session-lifecycle.ts) ─────────────────────────────

describe("pause() state-only", () => {
  it("sets status to blocked with default reason", () => {
    const id = createSession();
    const result = pause(app, id);
    expect(result.ok).toBe(true);
    const s = app.sessions.get(id)!;
    expect(s.status).toBe("blocked");
    expect(s.breakpoint_reason).toBe("User paused");
  });

  it("stores custom reason", () => {
    const id = createSession();
    pause(app, id, "waiting for review");
    expect(app.sessions.get(id)!.breakpoint_reason).toBe("waiting for review");
  });

  it("returns ok: false for nonexistent session", () => {
    const result = pause(app, "s-doesnotexist");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can pause a session already in ready status", () => {
    const id = createSession();
    app.sessions.update(id, { status: "ready" });
    const result = pause(app, id);
    expect(result.ok).toBe(true);
    expect(app.sessions.get(id)!.status).toBe("blocked");
  });
});

// ── resolveSessionCompute ────────────────────────────────────────────────

describe("resolveSessionCompute", () => {
  it("returns null for nonexistent session", () => {
    expect(resolveSessionCompute(app, "s-nope")).toBeNull();
  });

  it("resolves firecracker-* to firecracker kind", () => {
    ensureCompute("firecracker-pause", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-pause" });
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("firecracker");
  });

  it("resolves ec2-* to ec2 kind", () => {
    ensureCompute("ec2-pause", "ec2");
    const fake = new FakeCompute("ec2");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "ec2-pause" });
    const resolved = resolveSessionCompute(app, id);
    expect(resolved!.kind).toBe("ec2");
  });

  it("defaults unknown compute name to local", () => {
    const id = createSession({ compute_name: "unknown-thing" });
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local");
  });

  it("defaults missing compute_name to local", () => {
    const id = createSession();
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local");
  });
});

// ── pauseWithSnapshot ────────────────────────────────────────────────────

describe("pauseWithSnapshot", () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await pauseWithSnapshot(app, "s-gone");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported for compute without snapshot capability", async () => {
    const id = createSession(); // defaults to local which has no snapshot
    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("snapshots, persists, and sets status to blocked", async () => {
    ensureCompute("firecracker-snap", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-snap" });

    const result = await pauseWithSnapshot(app, id, { reason: "unit test" });
    expect(result.ok).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.sessionId).toBe(id);
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.metadata).toEqual({ key: "value" });
    expect(fake.snapshotCalls).toBe(1);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect(session.breakpoint_reason).toBe("unit test");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
    expect((session.config as Record<string, unknown>).last_snapshot_at).toBeTruthy();
  });

  it("uses default reason when none provided", async () => {
    ensureCompute("firecracker-defr", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-defr" });

    await pauseWithSnapshot(app, id);
    expect(app.sessions.get(id)!.breakpoint_reason).toBe("User paused");
  });

  it("returns ok: false when compute.snapshot() throws a generic error", async () => {
    ensureCompute("firecracker-err", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    fake.shouldThrowOnSnapshot = new Error("VM crashed");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-err" });

    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("VM crashed");
    expect(result.notSupported).toBeUndefined();
  });

  it("returns notSupported when compute.snapshot() throws NotSupportedError", async () => {
    ensureCompute("firecracker-nse", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    fake.shouldThrowOnSnapshot = new NotSupportedError("firecracker", "snapshot");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-nse" });

    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });
});

// ── resumeFromSnapshot ───────────────────────────────────────────────────

describe("resumeFromSnapshot", () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await resumeFromSnapshot(app, "s-gone");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns ok: false when no snapshot is available", async () => {
    const id = createSession();
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot");
  });

  it("restores from last_snapshot_id in session config", async () => {
    ensureCompute("firecracker-res", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-res" });

    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);
    const snapId = pauseResult.snapshot!.id;

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(snapId);
    expect(fake.restoreCalls).toBe(1);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("accepts an explicit snapshotId", async () => {
    ensureCompute("firecracker-exp", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-exp" });

    const pauseResult = await pauseWithSnapshot(app, id);
    const snapId = pauseResult.snapshot!.id;

    const result = await resumeFromSnapshot(app, id, { snapshotId: snapId });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(snapId);
  });

  it("falls back to latest snapshot from store when no last_snapshot_id", async () => {
    ensureCompute("firecracker-fb", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-fb" });

    const pauseResult = await pauseWithSnapshot(app, id);
    const snapId = pauseResult.snapshot!.id;

    // Clear the last_snapshot_id from config
    app.sessions.update(id, { config: {} });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(snapId);
  });

  it("returns ok: false when snapshot load fails", async () => {
    const id = createSession();
    app.sessions.update(id, { config: { last_snapshot_id: "nonexistent-snap" } });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("snapshot load failed");
  });

  it("returns notSupported when compute lacks restore capability", async () => {
    const noSnapCompute = new FakeCompute("e2b", false);
    app.registerCompute(noSnapCompute);

    // Save a snapshot referencing e2b kind
    const blob = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const saved = await app.snapshotStore.save({ computeKind: "e2b", sessionId: "s-nosup", metadata: {} }, blob);

    const id = createSession();
    app.sessions.update(id, { config: { last_snapshot_id: saved.id } });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns ok: false when compute.restore() throws a generic error", async () => {
    ensureCompute("firecracker-resterr", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-resterr" });

    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    fake.shouldThrowOnRestore = new Error("disk full");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("disk full");
  });

  it("returns notSupported when compute.restore() throws NotSupportedError", async () => {
    ensureCompute("firecracker-rnse", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-rnse" });

    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    fake.shouldThrowOnRestore = new NotSupportedError("firecracker", "restore");
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("full pause-resume round-trip preserves session fields", async () => {
    ensureCompute("firecracker-rt", "local-firecracker");
    const fake = new FakeCompute("firecracker");
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-rt" });
    app.sessions.update(id, { agent: "coder", workdir: "/tmp/work" });

    await pauseWithSnapshot(app, id, { reason: "lunch break" });
    let session = app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect(session.agent).toBe("coder");
    expect(session.workdir).toBe("/tmp/work");

    await resumeFromSnapshot(app, id);
    session = app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.agent).toBe("coder");
    expect(session.workdir).toBe("/tmp/work");
    expect(session.breakpoint_reason).toBeNull();
  });
});
