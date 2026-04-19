/**
 * Tests for session pause -- both state-only and snapshot-backed paths.
 *
 * Covers:
 *   - pause() from session-lifecycle.ts (state-only, no compute interaction)
 *   - pauseWithSnapshot() + resumeFromSnapshot() from session-snapshot.ts
 *   - resolveSessionCompute() helper
 *   - Graceful degradation when compute lacks snapshot capability
 *   - Error surfaces (missing session, missing compute, snapshot failures)
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

function createSession(overrides: Record<string, unknown> = {}) {
  const session = app.sessions.create({ summary: "pause-test", ...overrides });
  app.sessions.update(session.id, { status: "running", stage: "work", ...overrides });
  return app.sessions.get(session.id)!;
}

function ensureCompute(name: string, provider: string): void {
  if (app.computes.get(name)) return;
  app.computes.create({ name, provider, config: {} });
}

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
  shouldFail = false;

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
    if (this.shouldFail) throw new Error("snapshot backend failure");
    this.snapshotCalls++;
    return {
      id: "snap-native",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    if (this.shouldFail) throw new Error("restore backend failure");
    this.restoreCalls++;
    this.lastRestored = s;
    return { kind: this.kind, name: "fake-fc", meta: { restored: true } };
  }
}

// ── State-only pause (session-lifecycle.ts) ──────────────────────────────

describe("pause() state-only", () => {
  it("sets status to blocked", () => {
    const session = createSession();
    const result = pause(app, session.id, "manual hold");
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(session.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.breakpoint_reason).toBe("manual hold");
  });

  it("defaults breakpoint_reason to 'User paused'", () => {
    const session = createSession();
    pause(app, session.id);

    const updated = app.sessions.get(session.id)!;
    expect(updated.breakpoint_reason).toBe("User paused");
  });

  it("returns ok: false for nonexistent session", () => {
    const result = pause(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can pause a session in any active status", () => {
    for (const status of ["running", "ready", "waiting"] as const) {
      const session = createSession({ status });
      const result = pause(app, session.id);
      expect(result.ok).toBe(true);
      expect(app.sessions.get(session.id)!.status).toBe("blocked");
    }
  });

  it("preserves other session fields", () => {
    const session = createSession({ agent: "coder", stage: "deploy" });
    pause(app, session.id);

    const updated = app.sessions.get(session.id)!;
    expect(updated.agent).toBe("coder");
    expect(updated.stage).toBe("deploy");
  });
});

// ── resolveSessionCompute() ──────────────────────────────────────────────

describe("resolveSessionCompute()", () => {
  it("returns null for nonexistent session", () => {
    expect(resolveSessionCompute(app, "s-no-such")).toBeNull();
  });

  it("defaults to local kind when compute_name is missing", () => {
    const session = createSession();
    const result = resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("local");
  });

  it("infers firecracker kind from compute name prefix", () => {
    ensureCompute("firecracker-test", "local-firecracker");
    app.registerCompute(new FakeSnapshotCompute());
    const session = createSession({ compute_name: "firecracker-test" });
    const result = resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("firecracker");
  });

  it("infers ec2 kind from compute name prefix", () => {
    ensureCompute("ec2-test", "ec2");
    const session = createSession({ compute_name: "ec2-test" });
    const result = resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("ec2");
  });

  it("infers k8s-kata kind from compute name prefix", () => {
    ensureCompute("k8s-kata-test", "k8s-kata");
    const session = createSession({ compute_name: "k8s-kata-test" });
    const result = resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("k8s-kata");
  });

  it("carries compute_handle metadata from session config", () => {
    const session = createSession({
      config: { compute_handle: { instanceId: "i-abc123" } },
    });
    const result = resolveSessionCompute(app, session.id);
    expect(result!.handle.meta).toEqual({ instanceId: "i-abc123" });
  });
});

// ── pauseWithSnapshot() ──────────────────────────────────────────────────

describe("pauseWithSnapshot()", () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await pauseWithSnapshot(app, "s-nope");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported for local compute", async () => {
    const session = createSession();
    const result = await pauseWithSnapshot(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("snapshots and persists via SnapshotStore on capable compute", async () => {
    ensureCompute("firecracker-snap", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-snap" });
    const result = await pauseWithSnapshot(app, session.id, { reason: "checkpoint" });

    expect(result.ok).toBe(true);
    expect(fake.snapshotCalls).toBe(1);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.sessionId).toBe(session.id);
    expect(result.snapshot!.metadata).toEqual({ memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" });

    const updated = app.sessions.get(session.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.breakpoint_reason).toBe("checkpoint");
    expect((updated.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
  });

  it("surfaces compute.snapshot() failures cleanly", async () => {
    ensureCompute("firecracker-fail", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    fake.shouldFail = true;
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-fail" });
    const result = await pauseWithSnapshot(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("snapshot failed");
  });

  it("defaults reason to 'User paused'", async () => {
    ensureCompute("firecracker-def", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-def" });
    await pauseWithSnapshot(app, session.id);

    const updated = app.sessions.get(session.id)!;
    expect(updated.breakpoint_reason).toBe("User paused");
  });
});

// ── resumeFromSnapshot() ─────────────────────────────────────────────────

describe("resumeFromSnapshot()", () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await resumeFromSnapshot(app, "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns ok: false when no snapshot exists for session", async () => {
    const session = createSession();
    const result = await resumeFromSnapshot(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("restores from the session's last_snapshot_id", async () => {
    ensureCompute("firecracker-res", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-res" });

    // Pause to produce a snapshot
    const pauseResult = await pauseWithSnapshot(app, session.id);
    expect(pauseResult.ok).toBe(true);
    const snapId = pauseResult.snapshot!.id;

    // Resume
    const resumeResult = await resumeFromSnapshot(app, session.id);
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.snapshotId).toBe(snapId);
    expect(fake.restoreCalls).toBe(1);
    expect(fake.lastRestored!.metadata).toEqual({ memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" });

    const updated = app.sessions.get(session.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.breakpoint_reason).toBeNull();
  });

  it("accepts an explicit snapshotId override", async () => {
    ensureCompute("firecracker-expl", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-expl" });

    // Save a snapshot manually
    const ref = await app.snapshotStore.save(
      { computeKind: "firecracker", sessionId: session.id, metadata: { custom: true } },
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );

    const result = await resumeFromSnapshot(app, session.id, { snapshotId: ref.id });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(ref.id);
    expect(fake.lastRestored!.metadata).toEqual({ custom: true });
  });

  it("falls back to latest snapshot when last_snapshot_id is not set", async () => {
    ensureCompute("firecracker-latest", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-latest" });

    // Save two snapshots directly (not via pauseWithSnapshot, so no last_snapshot_id on session)
    await app.snapshotStore.save(
      { computeKind: "firecracker", sessionId: session.id, metadata: { v: 1 } },
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );
    await Bun.sleep(15);
    const newer = await app.snapshotStore.save(
      { computeKind: "firecracker", sessionId: session.id, metadata: { v: 2 } },
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );

    const result = await resumeFromSnapshot(app, session.id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(newer.id);
    expect(fake.lastRestored!.metadata).toEqual({ v: 2 });
  });

  it("returns notSupported when compute lacks restore capability", async () => {
    const session = createSession();

    // Save a snapshot referencing local compute (no snapshot support)
    const ref = await app.snapshotStore.save(
      { computeKind: "local", sessionId: session.id, metadata: {} },
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );
    app.sessions.update(session.id, {
      config: { last_snapshot_id: ref.id },
    });

    const result = await resumeFromSnapshot(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("surfaces compute.restore() failures", async () => {
    ensureCompute("firecracker-rfail", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-rfail" });
    const pauseResult = await pauseWithSnapshot(app, session.id);
    expect(pauseResult.ok).toBe(true);

    // Make restore fail
    fake.shouldFail = true;
    const result = await resumeFromSnapshot(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("restore failed");
  });
});

// ── Round-trip: pause -> resume ──────────────────────────────────────────

describe("pause/resume round-trip", () => {
  it("full cycle: running -> blocked -> ready with snapshot preservation", async () => {
    ensureCompute("firecracker-rt", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const session = createSession({ compute_name: "firecracker-rt" });
    expect(app.sessions.get(session.id)!.status).toBe("running");

    // Pause
    const pauseResult = await pauseWithSnapshot(app, session.id, { reason: "lunch break" });
    expect(pauseResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("blocked");
    expect(app.sessions.get(session.id)!.breakpoint_reason).toBe("lunch break");

    // Resume
    const resumeResult = await resumeFromSnapshot(app, session.id);
    expect(resumeResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("ready");
    expect(app.sessions.get(session.id)!.breakpoint_reason).toBeNull();

    // Snapshot metadata survived the round-trip
    expect(fake.lastRestored!.metadata).toEqual({ memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" });
  });

  it("state-only pause -> state-only resume (no snapshot involved)", () => {
    const session = createSession();

    const pauseResult = pause(app, session.id, "hold for review");
    expect(pauseResult.ok).toBe(true);

    const blocked = app.sessions.get(session.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.breakpoint_reason).toBe("hold for review");

    // Simulate state-only resume (update fields directly like session-lifecycle resume does)
    app.sessions.update(session.id, {
      status: "ready",
      breakpoint_reason: null,
    });

    const resumed = app.sessions.get(session.id)!;
    expect(resumed.status).toBe("ready");
    expect(resumed.breakpoint_reason).toBeNull();
  });
});
