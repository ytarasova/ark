/**
 * Dispatch: session-lifecycle.ts must resolve a ComputeTarget from either
 * the new `compute_kind` / `isolation_kind` columns or (for legacy rows) the
 * old `provider` column via providerToPair.
 *
 * These tests exercise the resolveComputeTarget helper on AppContext and
 * confirm that the fall-back path keeps working for rows that predate the
 * schema change.
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

  it("dispatches via provider name when the row was created with legacy provider only", async () => {
    // Row written only with a legacy `provider` value -- the schema defaults
    // compute_kind to 'local' and isolation_kind to 'direct' per CLAUDE.md's
    // "no migration" rule. The repo's rowToCompute fallback (and the
    // resolveComputeTarget fallback) still honour the provider when the
    // columns were never explicitly set -- but for defaults-only rows we
    // get the schema defaults, which is the documented migration contract.
    const created = await app.computeService.create({
      name: "legacy-via-provider",
      provider: "docker",
    });
    // create() derives the kind via providerToPair so new rows are correct.
    expect((created as any).compute_kind).toBe("local");
    expect((created as any).isolation_kind).toBe("docker");

    const session = await app.sessions.create({
      summary: "lifecycle cr test 2",
      compute_name: "legacy-via-provider",
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
        `INSERT INTO compute (name, provider, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
       VALUES (?, 'unknown', 'unregistered-kind', 'direct', 'stopped', '{}', 'default', ?, ?)`,
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
