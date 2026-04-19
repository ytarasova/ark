/**
 * Unit tests for session pause (state-only) and pause/resume with snapshots.
 *
 * Covers:
 *   - `pause()` from session-lifecycle.ts (state-only)
 *   - `pauseWithSnapshot()` / `resumeFromSnapshot()` from session-snapshot.ts
 *   - `resolveSessionCompute()` helper
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

// ── Fake compute for snapshot tests ──────────────────────────────────────────

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
  shouldFailSnapshot = false;
  shouldFailRestore = false;

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
    if (this.shouldFailSnapshot) throw new Error("snapshot exploded");
    return {
      id: "snap-native",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    this.restoreCalls++;
    this.lastRestored = s;
    if (this.shouldFailRestore) throw new Error("restore exploded");
    return { kind: this.kind, name: "fake-fc", meta: { restored: true } };
  }
}

function ensureCompute(ctx: AppContext, name: string, provider: string): void {
  if (ctx.computes.get(name)) return;
  ctx.computes.create({ name, provider, config: {} });
}

function createSession(opts: Record<string, unknown> = {}): string {
  const session = app.sessions.create({ summary: "pause-test", ...opts });
  app.sessions.update(session.id, { status: "running", stage: "work" });
  return session.id;
}

// ── pause() -- state-only ────────────────────────────────────────────────────

describe("pause() state-only", () => {
  it("sets status to blocked", () => {
    const id = createSession();
    const result = pause(app, id);

    expect(result.ok).toBe(true);
    expect(app.sessions.get(id)!.status).toBe("blocked");
  });

  it("sets breakpoint_reason to custom reason", () => {
    const id = createSession();
    pause(app, id, "waiting for review");

    expect(app.sessions.get(id)!.breakpoint_reason).toBe("waiting for review");
  });

  it("defaults breakpoint_reason to 'User paused'", () => {
    const id = createSession();
    pause(app, id);

    expect(app.sessions.get(id)!.breakpoint_reason).toBe("User paused");
  });

  it("returns ok: false for nonexistent session", () => {
    const result = pause(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can pause a session in ready state", () => {
    const id = createSession();
    app.sessions.update(id, { status: "ready" });

    const result = pause(app, id);
    expect(result.ok).toBe(true);
    expect(app.sessions.get(id)!.status).toBe("blocked");
  });

  it("can pause a session already blocked (idempotent)", () => {
    const id = createSession();
    pause(app, id, "first reason");
    const result = pause(app, id, "second reason");

    expect(result.ok).toBe(true);
    expect(app.sessions.get(id)!.breakpoint_reason).toBe("second reason");
  });

  it("preserves other session fields", () => {
    const id = createSession({ repo: "/my/repo" });
    app.sessions.update(id, { agent: "coder", workdir: "/tmp/work" });

    pause(app, id);

    const s = app.sessions.get(id)!;
    expect(s.repo).toBe("/my/repo");
    expect(s.agent).toBe("coder");
    expect(s.workdir).toBe("/tmp/work");
    expect(s.stage).toBe("work");
  });

  it("logs session_paused event", () => {
    const id = createSession();
    pause(app, id, "test-reason");

    const events = app.events.list(id);
    const pauseEvent = events.find((e) => e.type === "session_paused");
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent!.data).toMatchObject({
      reason: "test-reason",
      was_status: "running",
    });
  });
});

// ── resolveSessionCompute() ──────────────────────────────────────────────────

describe("resolveSessionCompute()", () => {
  it("returns null for nonexistent session", () => {
    expect(resolveSessionCompute(app, "s-nope")).toBeNull();
  });

  it("defaults to local kind when compute_name is absent", () => {
    const id = createSession();
    const result = resolveSessionCompute(app, id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("local");
  });

  it("infers firecracker kind from compute_name prefix", () => {
    ensureCompute(app, "firecracker-test", "local-firecracker");
    const id = createSession({ compute_name: "firecracker-test" });
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    const result = resolveSessionCompute(app, id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("firecracker");
  });

  it("infers ec2 kind from compute_name prefix", () => {
    ensureCompute(app, "ec2-prod", "ec2");
    const id = createSession({ compute_name: "ec2-prod" });

    const result = resolveSessionCompute(app, id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("ec2");
  });

  it("infers k8s-kata kind from compute_name prefix", () => {
    ensureCompute(app, "k8s-kata-1", "k8s-kata");
    const id = createSession({ compute_name: "k8s-kata-1" });

    const result = resolveSessionCompute(app, id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("k8s-kata");
  });
});

// ── pauseWithSnapshot() ──────────────────────────────────────────────────────

describe("pauseWithSnapshot()", () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await pauseWithSnapshot(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported for compute without snapshot capability", async () => {
    const id = createSession();

    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
    expect(result.message).toContain("snapshot");
  });

  it("snapshots and persists to SnapshotStore on capable compute", async () => {
    ensureCompute(app, "firecracker-snap", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-snap" });

    const result = await pauseWithSnapshot(app, id);

    expect(result.ok).toBe(true);
    expect(fake.snapshotCalls).toBe(1);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.sessionId).toBe(id);
    expect(result.snapshot!.metadata).toEqual({ memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" });
  });

  it("sets session to blocked and records snapshot id in config", async () => {
    ensureCompute(app, "firecracker-cfg", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-cfg" });

    const result = await pauseWithSnapshot(app, id);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
    expect((session.config as Record<string, unknown>).last_snapshot_at).toBeTruthy();
  });

  it("uses custom breakpoint_reason", async () => {
    ensureCompute(app, "firecracker-reason", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-reason" });

    await pauseWithSnapshot(app, id, { reason: "checkpoint before deploy" });

    const session = app.sessions.get(id)!;
    expect(session.breakpoint_reason).toBe("checkpoint before deploy");
  });

  it("logs session_paused event with snapshot data", async () => {
    ensureCompute(app, "firecracker-evt", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-evt" });

    const result = await pauseWithSnapshot(app, id);

    const events = app.events.list(id);
    const pauseEvent = events.find((e) => e.type === "session_paused");
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent!.data).toMatchObject({
      snapshot_id: result.snapshot!.id,
      was_status: "running",
    });
  });

  it("returns ok: false when compute.snapshot() throws", async () => {
    ensureCompute(app, "firecracker-fail", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    fake.shouldFailSnapshot = true;
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-fail" });

    const result = await pauseWithSnapshot(app, id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("snapshot exploded");
    expect(app.sessions.get(id)!.status).toBe("running");
  });
});

// ── resumeFromSnapshot() ─────────────────────────────────────────────────────

describe("resumeFromSnapshot()", () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await resumeFromSnapshot(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns ok: false when no snapshot available", async () => {
    const id = createSession();
    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("resumes from session's last_snapshot_id", async () => {
    ensureCompute(app, "firecracker-res", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-res" });

    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    const result = await resumeFromSnapshot(app, id);

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
    expect(fake.restoreCalls).toBe(1);
    expect(fake.lastRestored!.id).toBe(pauseResult.snapshot!.id);
  });

  it("sets session to ready and clears breakpoint_reason", async () => {
    ensureCompute(app, "firecracker-clr", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-clr" });

    await pauseWithSnapshot(app, id, { reason: "test checkpoint" });
    expect(app.sessions.get(id)!.breakpoint_reason).toBe("test checkpoint");

    await resumeFromSnapshot(app, id);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("accepts explicit snapshotId", async () => {
    ensureCompute(app, "firecracker-exp", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-exp" });

    const pauseResult = await pauseWithSnapshot(app, id);
    const snapshotId = pauseResult.snapshot!.id;

    // Clear last_snapshot_id from config to prove explicit id is used
    app.sessions.update(id, { config: {} });

    const result = await resumeFromSnapshot(app, id, { snapshotId });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(snapshotId);
  });

  it("falls back to latest snapshot from store when no config ref", async () => {
    ensureCompute(app, "firecracker-latest", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-latest" });

    // Pause to create a snapshot, then wipe the config reference
    const pauseResult = await pauseWithSnapshot(app, id);
    app.sessions.update(id, { config: {} });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("returns notSupported when snapshot's compute can't restore", async () => {
    const id = createSession();

    // Manually save a snapshot referencing the "local" compute kind
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

  it("returns ok: false when compute.restore() throws", async () => {
    ensureCompute(app, "firecracker-rfail", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-rfail" });

    await pauseWithSnapshot(app, id);

    fake.shouldFailRestore = true;
    const result = await resumeFromSnapshot(app, id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("restore exploded");
  });

  it("logs session_resumed event with snapshot id", async () => {
    ensureCompute(app, "firecracker-revt", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-revt" });

    const pauseResult = await pauseWithSnapshot(app, id);
    await resumeFromSnapshot(app, id);

    const events = app.events.list(id);
    const resumeEvent = events.find((e) => e.type === "session_resumed");
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent!.data).toMatchObject({
      snapshot_id: pauseResult.snapshot!.id,
      from_status: "blocked",
    });
  });

  it("full pause/resume cycle preserves session identity", async () => {
    ensureCompute(app, "firecracker-full", "local-firecracker");
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);
    const id = createSession({ compute_name: "firecracker-full", repo: "/project" });
    app.sessions.update(id, { agent: "architect", stage: "design" });

    await pauseWithSnapshot(app, id, { reason: "checkpoint" });
    expect(app.sessions.get(id)!.status).toBe("blocked");

    await resumeFromSnapshot(app, id);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.repo).toBe("/project");
    expect(session.agent).toBe("architect");
    expect(session.stage).toBe("design");
  });
});
