/**
 * Dispatch: session-lifecycle.ts must resolve a ComputeTarget from the
 * `compute_kind` / `isolation_kind` columns. The legacy `provider` column
 * was dropped in migration 015 (Task 5 of the compute cleanup); callers
 * pass the two-axis pair directly to `computeService.create`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../index.js";
import { setApp, clearApp } from "./test-helpers.js";

describe("session-lifecycle compute/isolation dispatch", async () => {
  let app: AppContext;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  it("resolves ComputeTarget for the seeded local compute row", async () => {
    const session = await app.sessions.create({
      summary: "lifecycle cr test 1",
      compute_name: "local",
    });
    const { target, compute } = await app.resolveComputeTarget(await app.sessions.get(session.id)!);
    expect(target).not.toBeNull();
    expect(compute).not.toBeNull();
    expect(target!.compute.kind).toBe("local");
    expect(target!.isolation.kind).toBe("direct");
  });

  it("dispatches with explicit compute + isolation kinds (post-provider-column drop)", async () => {
    // Two-axis create -- the legacy `provider` parameter is gone.
    const created = await app.computeService.create({
      name: "two-axis-docker",
      compute: "local",
      isolation: "docker",
    });
    expect((created as any).compute_kind).toBe("local");
    expect((created as any).isolation_kind).toBe("docker");

    const session = await app.sessions.create({
      summary: "lifecycle cr test 2",
      compute_name: "two-axis-docker",
    });
    const { target } = await app.resolveComputeTarget(await app.sessions.get(session.id)!);
    expect(target).not.toBeNull();
    expect(target!.isolation.kind).toBe("docker");
  });

  it("returns {target: null} when (compute, isolation) pair is not registered", async () => {
    // Seed a row with an unregistered compute_kind. resolveComputeTarget
    // should refuse gracefully instead of dispatching.
    const ts = new Date().toISOString();
    app.db
      .prepare(
        `INSERT INTO compute (name, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
       VALUES (?, 'unregistered-kind', 'direct', 'stopped', '{}', 'default', ?, ?)`,
      )
      .run("unregistered-test", ts, ts);
    const session = await app.sessions.create({
      summary: "lifecycle cr test 3",
      compute_name: "unregistered-test",
    });
    const { target, compute } = await app.resolveComputeTarget(await app.sessions.get(session.id)!);
    expect(compute).not.toBeNull();
    expect(target).toBeNull(); // no registered Compute impl
  });

  it("round-trips compute_kind + isolation_kind on a new row", async () => {
    const created = await app.computeService.create({
      name: "cr-test-docker",
      compute: "local",
      isolation: "docker",
    });
    expect((created as any).compute_kind).toBe("local");
    expect((created as any).isolation_kind).toBe("docker");

    const read = await app.computes.get("cr-test-docker");
    expect((read as any).compute_kind).toBe("local");
    expect((read as any).isolation_kind).toBe("docker");
  });
});
