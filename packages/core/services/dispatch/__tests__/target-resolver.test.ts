/**
 * resolveTargetAndHandle tests. Covers the three reachable paths:
 *   - Session has no compute -> {target: null, handle: null}
 *   - Session has compute, no persisted handle -> provisions fresh, persists
 *   - Session has compute + persisted handle -> rehydrates without provisioning
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../../app.js";
import { resolveTargetAndHandle } from "../target-resolver.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("resolveTargetAndHandle", () => {
  test("returns null target when compute_kind / isolation_kind don't resolve", async () => {
    // Insert a row with a phantom compute_kind so resolveComputeTarget
    // returns {target: null}. This exercises the early-return branch.
    await app.computes.insert({
      name: "phantom-kind",
      provider: "phantom",
      compute_kind: "phantom-compute" as never,
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as never);
    const s = await app.sessions.create({ summary: "phantom", compute_name: "phantom-kind" });
    const r = await resolveTargetAndHandle(app, s);
    expect(r.target).toBeNull();
    expect(r.handle).toBeNull();
  });

  test("rehydrates persisted handle without re-provisioning", async () => {
    // We pre-populate session.config.compute_handle so the test can
    // assert rehydrate vs fresh-provision without depending on host
    // state. The persisted handle is returned as-is.
    await app.computes.insert({
      name: "local-rehydrate",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as never);
    const s = await app.sessions.create({ summary: "rehydrate", compute_name: "local-rehydrate" });
    await app.sessions.update(s.id, {
      config: {
        ...((s.config as object | null) ?? {}),
        compute_handle: { kind: "local", name: "local-rehydrate", meta: { rehydrated: true } },
      },
    });
    const refetched = (await app.sessions.get(s.id))!;
    const r = await resolveTargetAndHandle(app, refetched);
    expect(r.target).not.toBeNull();
    expect(r.handle).not.toBeNull();
    expect((r.handle!.meta as Record<string, unknown>).rehydrated).toBe(true);
  });

  test("provisions a fresh handle and persists it on first dispatch", async () => {
    await app.computes.insert({
      name: "local-fresh",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as never);
    const s = await app.sessions.create({ summary: "fresh", compute_name: "local-fresh" });
    const r = await resolveTargetAndHandle(app, s);
    expect(r.target).not.toBeNull();
    expect(r.handle).not.toBeNull();
    expect(r.handle!.kind).toBe("local");
    // Handle persisted on session.config.
    const refetched = (await app.sessions.get(s.id))!;
    const persisted = (refetched.config as { compute_handle?: unknown }).compute_handle;
    expect(persisted).toBeDefined();
  });
});
