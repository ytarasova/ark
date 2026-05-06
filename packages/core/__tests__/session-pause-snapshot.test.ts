import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { pauseWithSnapshot, resumeFromSnapshot, resolveSessionCompute } from "../services/session-snapshot.js";
import type { Compute, ComputeHandle, Snapshot } from "../compute/core/types.js";
import { NotSupportedError } from "../compute/core/types.js";
import { FsSnapshotStore } from "../compute/core/snapshot-store-fs.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let app: AppContext;
let snapRoot: string;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  snapRoot = mkdtempSync(join(tmpdir(), "ark-pause-test-"));
  (app as any)._container.register("snapshotStore", { resolve: () => new FsSnapshotStore(snapRoot) });
});

afterEach(async () => {
  await app?.shutdown();
  rmSync(snapRoot, { recursive: true, force: true });
});

function makeSnapshotCapableCompute(kind = "firecracker" as const): Compute {
  return {
    kind,
    capabilities: { snapshot: true, pool: false, networkIsolation: false, provisionLatency: "seconds" },
    async provision() {
      return { kind, name: `${kind}-test`, meta: {} };
    },
    async start() {},
    async stop() {},
    async destroy() {},
    getArkdUrl() {
      return "http://localhost:19300";
    },
    async snapshot(h: ComputeHandle): Promise<Snapshot> {
      return {
        id: "snap-1",
        computeKind: kind,
        createdAt: new Date().toISOString(),
        sizeBytes: 0,
        metadata: { memFilePath: "/tmp/mem", stateFilePath: "/tmp/state" },
      };
    },
    async restore(s: Snapshot): Promise<ComputeHandle> {
      return { kind, name: `${kind}-restored`, meta: { restored: true } };
    },
  };
}

function makeNoSnapshotCompute(kind = "local" as const): Compute {
  return {
    kind,
    capabilities: { snapshot: false, pool: false, networkIsolation: false, provisionLatency: "instant" },
    async provision() {
      return { kind, name: `${kind}-test`, meta: {} };
    },
    async start() {},
    async stop() {},
    async destroy() {},
    getArkdUrl() {
      return "http://localhost:19300";
    },
    async snapshot(): Promise<Snapshot> {
      throw new NotSupportedError(kind, "snapshot");
    },
    async restore(): Promise<ComputeHandle> {
      throw new NotSupportedError(kind, "restore");
    },
  };
}

/**
 * Seed a compute row so the session-snapshot resolver can read its
 * `compute_kind` column. Tests used to rely on name-prefix inference; the
 * resolver now reads the DB column directly, so every test that sets a
 * `compute_name` must first persist a compute row with the right kind.
 */
async function ensureComputeRow(name: string, provider: string, computeKind: string): Promise<void> {
  if (await app.computes.get(name)) return;
  await app.computeService.create({
    name,
    provider,
    compute: computeKind as any,
    config: {},
  });
}

describe("pauseWithSnapshot", async () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await pauseWithSnapshot(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported when compute lacks snapshot capability", async () => {
    const session = await app.sessions.create({ summary: "pause-no-snap" });
    await ensureComputeRow("local-test", "docker", "local");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "local-test",
    });
    app.registerCompute(makeNoSnapshotCompute());

    const result = await pauseWithSnapshot(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
    expect(result.message).toContain("does not support");
  });

  it("pauses a running session with snapshot-capable compute", async () => {
    const session = await app.sessions.create({ summary: "pause-ok" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    const result = await pauseWithSnapshot(app, session.id);
    expect(result.ok).toBe(true);
    expect(result.snapshot).toBeTruthy();
    expect(result.snapshot!.computeKind).toBe("firecracker");
    expect(result.snapshot!.sessionId).toBe(session.id);
  });

  it("sets session status to blocked with breakpoint_reason", async () => {
    const session = await app.sessions.create({ summary: "pause-status" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    await pauseWithSnapshot(app, session.id, { reason: "manual pause" });

    const updated = await app.sessions.get(session.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.breakpoint_reason).toBe("manual pause");
  });

  it("uses default reason when none provided", async () => {
    const session = await app.sessions.create({ summary: "pause-default-reason" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    await pauseWithSnapshot(app, session.id);

    const updated = await app.sessions.get(session.id)!;
    expect(updated.breakpoint_reason).toBe("User paused");
  });

  it("stores last_snapshot_id in session config", async () => {
    const session = await app.sessions.create({ summary: "pause-config" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    const result = await pauseWithSnapshot(app, session.id);

    const updated = await app.sessions.get(session.id)!;
    const config = updated.config as Record<string, unknown>;
    expect(config.last_snapshot_id).toBe(result.snapshot!.id);
    expect(config.last_snapshot_at).toBeTruthy();
  });

  it("returns ok: false when session has no resolvable compute", async () => {
    const session = await app.sessions.create({ summary: "pause-no-compute" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "unknown-xyz",
    });

    const result = await pauseWithSnapshot(app, session.id);
    expect(result.ok).toBe(false);
  });

  it("persists snapshot bytes to the store", async () => {
    const session = await app.sessions.create({ summary: "pause-persist" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    const result = await pauseWithSnapshot(app, session.id);

    const refs = await app.snapshotStore.list({ sessionId: session.id });
    expect(refs.length).toBe(1);
    expect(refs[0].id).toBe(result.snapshot!.id);
  });
});

describe("resumeFromSnapshot", async () => {
  it("returns ok: false for nonexistent session", async () => {
    const result = await resumeFromSnapshot(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns ok: false when no snapshot is available", async () => {
    const session = await app.sessions.create({ summary: "resume-no-snap" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, { status: "blocked", stage: "work", compute_name: "firecracker-test" });
    app.registerCompute(makeSnapshotCapableCompute());

    const result = await resumeFromSnapshot(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("resumes from the latest snapshot when snapshotId is omitted", async () => {
    const session = await app.sessions.create({ summary: "resume-latest" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    const pauseResult = await pauseWithSnapshot(app, session.id);
    expect(pauseResult.ok).toBe(true);

    const resumeResult = await resumeFromSnapshot(app, session.id);
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("sets session status to ready after resume", async () => {
    const session = await app.sessions.create({ summary: "resume-status" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    await pauseWithSnapshot(app, session.id, { reason: "test pause" });
    const paused = await app.sessions.get(session.id)!;
    expect(paused.status).toBe("blocked");

    await resumeFromSnapshot(app, session.id);
    const resumed = await app.sessions.get(session.id)!;
    expect(resumed.status).toBe("ready");
    expect(resumed.breakpoint_reason).toBeNull();
  });

  it("resumes using explicit snapshotId", async () => {
    const session = await app.sessions.create({ summary: "resume-explicit" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    const pauseResult = await pauseWithSnapshot(app, session.id);

    const resumeResult = await resumeFromSnapshot(app, session.id, {
      snapshotId: pauseResult.snapshot!.id,
    });
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("returns notSupported when compute lacks snapshot capability on resume", async () => {
    const session = await app.sessions.create({ summary: "resume-no-cap" });
    await ensureComputeRow("local-test", "docker", "local");
    await app.sessions.update(session.id, { status: "blocked", stage: "work", compute_name: "local-test" });

    const fcCompute = makeSnapshotCapableCompute();
    app.registerCompute(fcCompute);

    const pauseResult = await pauseWithSnapshot(app, session.id);
    expect(pauseResult.ok).toBe(false);

    app.registerCompute(makeNoSnapshotCompute());

    const store = app.snapshotStore;
    const ref = await store.save(
      { computeKind: "local", sessionId: session.id, metadata: {} },
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );
    await app.sessions.update(session.id, { config: { last_snapshot_id: ref.id } });

    const resumeResult = await resumeFromSnapshot(app, session.id);
    expect(resumeResult.ok).toBe(false);
    expect(resumeResult.notSupported).toBe(true);
  });

  it("full pause/resume round-trip preserves session fields", async () => {
    const session = await app.sessions.create({ summary: "round-trip", repo: "/my/repo" });
    await ensureComputeRow("firecracker-test", "firecracker", "firecracker");
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      agent: "coder",
      compute_name: "firecracker-test",
    });
    app.registerCompute(makeSnapshotCapableCompute());

    await pauseWithSnapshot(app, session.id, { reason: "cost savings" });
    await resumeFromSnapshot(app, session.id);

    const updated = await app.sessions.get(session.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.summary).toBe("round-trip");
    expect(updated.repo).toBe("/my/repo");
    expect(updated.agent).toBe("coder");
    expect(updated.stage).toBe("work");
  });
});

describe("resolveSessionCompute", async () => {
  it("returns null for nonexistent session", async () => {
    const result = await resolveSessionCompute(app, "s-nonexistent");
    expect(result).toBeNull();
  });

  it("reads compute_kind=firecracker from the compute row", async () => {
    const session = await app.sessions.create({ summary: "resolve-fc" });
    await ensureComputeRow("firecracker-xl", "firecracker", "firecracker");
    await app.sessions.update(session.id, { compute_name: "firecracker-xl" });
    app.registerCompute(makeSnapshotCapableCompute("firecracker"));

    const result = await resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("firecracker");
  });

  it("reads compute_kind=ec2 from the compute row", async () => {
    const session = await app.sessions.create({ summary: "resolve-ec2" });
    await ensureComputeRow("ec2-medium", "ec2", "ec2");
    await app.sessions.update(session.id, { compute_name: "ec2-medium" });
    app.registerCompute(makeSnapshotCapableCompute("ec2" as any));

    const result = await resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("ec2");
  });

  it("returns null when compute_name points at a missing compute row", async () => {
    const session = await app.sessions.create({ summary: "resolve-missing" });
    await app.sessions.update(session.id, { compute_name: "something-weird" });

    const result = await resolveSessionCompute(app, session.id);
    expect(result).toBeNull();
  });

  it("defaults to local when session has no compute_name", async () => {
    const session = await app.sessions.create({ summary: "resolve-local-default" });
    app.registerCompute(makeNoSnapshotCompute());

    const result = await resolveSessionCompute(app, session.id);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("local");
  });
});
