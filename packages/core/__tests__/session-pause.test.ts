/**
 * Unit tests for session pause/resume -- both state-only and snapshot-backed.
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

// ── Fake computes ────────────────────────────────────────────────────────────

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

  setApp() {}
  async provision(_opts: ProvisionOpts): Promise<ComputeHandle> {
    return { kind: this.kind, name: "fake-fc", meta: {} };
  }
  async start() {}
  async stop() {}
  async destroy() {}
  getArkdUrl() {
    return "http://localhost:19300";
  }
  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    this.snapshotCalls++;
    if (this.shouldFailSnapshot) throw new Error("snapshot engine exploded");
    return {
      id: "native-id",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { memFilePath: "/tmp/m" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    this.restoreCalls++;
    this.lastRestored = s;
    return { kind: this.kind, name: "fake-fc", meta: { restored: true } };
  }
}

class FakeNoSnapshotCompute implements Compute {
  readonly kind: ComputeKind = "e2b";
  readonly capabilities: ComputeCapabilities = {
    snapshot: false,
    pool: false,
    networkIsolation: false,
    provisionLatency: "seconds",
  };
  setApp() {}
  async provision(_opts: ProvisionOpts): Promise<ComputeHandle> {
    return { kind: this.kind, name: "fake-e2b", meta: {} };
  }
  async start() {}
  async stop() {}
  async destroy() {}
  getArkdUrl() {
    return "http://localhost:19300";
  }
  async snapshot(): Promise<Snapshot> {
    throw new NotSupportedError(this.kind, "snapshot");
  }
  async restore(): Promise<ComputeHandle> {
    throw new NotSupportedError(this.kind, "restore");
  }
}

function createSession(overrides: Record<string, unknown> = {}): string {
  const session = app.sessions.create({ summary: "pause-test", ...overrides });
  app.sessions.update(session.id, { status: "running", stage: "work", ...overrides });
  return session.id;
}

// ── State-only pause (session-lifecycle.ts) ──────────────────────────────────

describe("state-only pause()", () => {
  it("sets status to blocked with default reason", () => {
    const id = createSession();
    const result = pause(app, id);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Paused");

    const s = app.sessions.get(id)!;
    expect(s.status).toBe("blocked");
    expect(s.breakpoint_reason).toBe("User paused");
  });

  it("uses custom reason when provided", () => {
    const id = createSession();
    pause(app, id, "Waiting for approval");

    const s = app.sessions.get(id)!;
    expect(s.breakpoint_reason).toBe("Waiting for approval");
  });

  it("returns ok: false for nonexistent session", () => {
    const result = pause(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can pause from any status", () => {
    for (const status of ["running", "ready", "waiting", "failing"] as const) {
      const id = createSession({ status });
      const result = pause(app, id);
      expect(result.ok).toBe(true);
      expect(app.sessions.get(id)!.status).toBe("blocked");
    }
  });

  it("preserves other session fields", () => {
    const id = createSession({ agent: "coder", workdir: "/tmp/work" });
    pause(app, id);

    const s = app.sessions.get(id)!;
    expect(s.agent).toBe("coder");
    expect(s.workdir).toBe("/tmp/work");
    expect(s.stage).toBe("work");
  });
});

// ── resolveSessionCompute ────────────────────────────────────────────────────

describe("resolveSessionCompute()", () => {
  it("returns null for nonexistent session", () => {
    expect(resolveSessionCompute(app, "s-ghost")).toBeNull();
  });

  it("defaults to local when no compute_name", () => {
    const id = createSession();
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local");
  });

  it("infers firecracker kind from compute name prefix", () => {
    app.registerCompute(new FakeSnapshotCompute());
    if (!app.computes.get("firecracker-test")) {
      app.computes.create({ name: "firecracker-test", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-test" });
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("firecracker");
  });

  it("returns null when compute kind is not registered", () => {
    const id = createSession({ compute_name: "fly-machines-test" });
    const resolved = resolveSessionCompute(app, id);
    expect(resolved).toBeNull();
  });
});

// ── pauseWithSnapshot ────────────────────────────────────────────────────────

describe("pauseWithSnapshot()", () => {
  it("snapshots and persists when compute supports it", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-pause")) {
      app.computes.create({ name: "firecracker-pause", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-pause" });

    const result = await pauseWithSnapshot(app, id, { reason: "test pause" });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.sessionId).toBe(id);
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m" });
    expect(fake.snapshotCalls).toBe(1);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect(session.breakpoint_reason).toBe("test pause");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
  });

  it("returns notSupported when compute lacks snapshot capability", async () => {
    const fake = new FakeNoSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("e2b-test")) {
      app.computes.create({ name: "e2b-test", provider: "e2b", config: {} });
    }
    const id = createSession({ compute_name: "e2b-test" });

    const result = await pauseWithSnapshot(app, id);

    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
    expect(result.snapshot).toBeUndefined();
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await pauseWithSnapshot(app, "s-nope");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns ok: false when compute.snapshot() throws a non-NotSupportedError", async () => {
    const fake = new FakeSnapshotCompute();
    fake.shouldFailSnapshot = true;
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-fail")) {
      app.computes.create({ name: "firecracker-fail", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-fail" });

    const result = await pauseWithSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("snapshot failed");
    expect(result.message).toContain("exploded");
  });

  it("uses default reason when none provided", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-dflt")) {
      app.computes.create({ name: "firecracker-dflt", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-dflt" });

    await pauseWithSnapshot(app, id);
    const session = app.sessions.get(id)!;
    expect(session.breakpoint_reason).toBe("User paused");
  });
});

// ── resumeFromSnapshot ───────────────────────────────────────────────────────

describe("resumeFromSnapshot()", () => {
  it("restores from session's last_snapshot_id and clears blocked state", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-resume")) {
      app.computes.create({ name: "firecracker-resume", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-resume" });

    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    const resumeResult = await resumeFromSnapshot(app, id);
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.snapshotId).toBe(pauseResult.snapshot!.id);
    expect(fake.restoreCalls).toBe(1);

    const session = app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("accepts explicit snapshotId", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-explicit")) {
      app.computes.create({ name: "firecracker-explicit", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-explicit" });

    const p1 = await pauseWithSnapshot(app, id);
    expect(p1.ok).toBe(true);
    // Resume the session so we can pause again
    app.sessions.update(id, { status: "running" });

    const p2 = await pauseWithSnapshot(app, id);
    expect(p2.ok).toBe(true);

    // Resume with the first snapshot explicitly
    const result = await resumeFromSnapshot(app, id, { snapshotId: p1.snapshot!.id });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(p1.snapshot!.id);
    expect(fake.lastRestored!.id).toBe(p1.snapshot!.id);
  });

  it("falls back to latest snapshot when no last_snapshot_id in config", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-latest")) {
      app.computes.create({ name: "firecracker-latest", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-latest" });

    const pauseResult = await pauseWithSnapshot(app, id);
    expect(pauseResult.ok).toBe(true);

    // Clear last_snapshot_id from config to force list() fallback
    const session = app.sessions.get(id)!;
    const config = { ...(session.config as Record<string, unknown>) };
    delete config.last_snapshot_id;
    app.sessions.update(id, { config });

    const resumeResult = await resumeFromSnapshot(app, id);
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("returns ok: false when no snapshots exist for session", async () => {
    const id = createSession();
    // Clear any config snapshot refs
    app.sessions.update(id, { config: {} });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await resumeFromSnapshot(app, "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported when compute lacks restore capability", async () => {
    const noSnap = new FakeNoSnapshotCompute();
    app.registerCompute(noSnap);

    // Save a snapshot referencing e2b compute kind
    const blob = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const saved = await app.snapshotStore.save({ computeKind: "e2b", sessionId: "s-no-restore", metadata: {} }, blob);

    if (!app.computes.get("e2b-norestore")) {
      app.computes.create({ name: "e2b-norestore", provider: "e2b", config: {} });
    }
    const id = createSession({ compute_name: "e2b-norestore" });
    app.sessions.update(id, {
      config: { last_snapshot_id: saved.id },
    });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns ok: false when snapshot load fails", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-loadfail")) {
      app.computes.create({ name: "firecracker-loadfail", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-loadfail" });
    app.sessions.update(id, {
      config: { last_snapshot_id: "deleted-snapshot-id" },
    });

    const result = await resumeFromSnapshot(app, id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("snapshot load failed");
  });
});

// ── Full pause/resume round-trip ─────────────────────────────────────────────

describe("pause -> resume round-trip", () => {
  it("snapshot data persists across pause and resume", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-roundtrip")) {
      app.computes.create({ name: "firecracker-roundtrip", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-roundtrip" });

    const pauseResult = await pauseWithSnapshot(app, id, { reason: "deploy gate" });
    expect(pauseResult.ok).toBe(true);
    expect(app.sessions.get(id)!.status).toBe("blocked");

    const resumeResult = await resumeFromSnapshot(app, id);
    expect(resumeResult.ok).toBe(true);
    expect(app.sessions.get(id)!.status).toBe("ready");

    // The restored snapshot metadata matches what was saved
    expect(fake.lastRestored!.metadata).toEqual({ memFilePath: "/tmp/m" });
    expect(fake.lastRestored!.computeKind).toBe("firecracker");
  });

  it("multiple pause/resume cycles produce independent snapshots", async () => {
    const fake = new FakeSnapshotCompute();
    app.registerCompute(fake);

    if (!app.computes.get("firecracker-multi")) {
      app.computes.create({ name: "firecracker-multi", provider: "local-firecracker", config: {} });
    }
    const id = createSession({ compute_name: "firecracker-multi" });

    const p1 = await pauseWithSnapshot(app, id);
    expect(p1.ok).toBe(true);
    const r1 = await resumeFromSnapshot(app, id);
    expect(r1.ok).toBe(true);

    // Second cycle
    app.sessions.update(id, { status: "running" });
    const p2 = await pauseWithSnapshot(app, id);
    expect(p2.ok).toBe(true);

    expect(p1.snapshot!.id).not.toBe(p2.snapshot!.id);
    expect(fake.snapshotCalls).toBe(2);

    // Both snapshots exist in the store
    const refs = await app.snapshotStore.list({ sessionId: id });
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });
});
