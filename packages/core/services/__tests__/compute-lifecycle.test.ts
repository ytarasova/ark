/**
 * Lifecycle GC tests.
 *
 * Validates that template-lifecycle compute rows (k8s, firecracker, docker)
 * get garbage-collected when no live sessions reference them, while
 * persistent-lifecycle rows (local, ec2) stick around regardless.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { garbageCollectComputeIfTemplate } from "../compute-lifecycle.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

describe("garbageCollectComputeIfTemplate", () => {
  it("returns false when computeName is null/undefined/missing", async () => {
    expect(await garbageCollectComputeIfTemplate(app, null)).toBe(false);
    expect(await garbageCollectComputeIfTemplate(app, undefined)).toBe(false);
    expect(await garbageCollectComputeIfTemplate(app, "no-such")).toBe(false);
  });

  it("never gc's persistent-lifecycle (local) compute", async () => {
    expect(await garbageCollectComputeIfTemplate(app, "local")).toBe(false);
    expect(await app.computes.get("local")).not.toBeNull();
  });

  it("gc's template-lifecycle (k8s) compute when no sessions reference it", async () => {
    await app.computeService.create({
      name: "test-k8s",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    expect(await app.computes.get("test-k8s")).not.toBeNull();

    const gc = await garbageCollectComputeIfTemplate(app, "test-k8s");
    expect(gc).toBe(true);
    expect(await app.computes.get("test-k8s")).toBeNull();
  });

  it("skips gc when a live session still references the compute", async () => {
    await app.computeService.create({
      name: "busy-k8s",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    const session = await app.sessions.create({
      repo: "/tmp",
      flow: "quick",
      task: "test",
      agent: "default",
      compute_name: "busy-k8s",
    });
    // Default status from create is "ready" -- not terminal, so gc must skip.
    expect(["ready", "running", "pending", "paused", "waiting"]).toContain(session.status);

    const gc = await garbageCollectComputeIfTemplate(app, "busy-k8s");
    expect(gc).toBe(false);
    expect(await app.computes.get("busy-k8s")).not.toBeNull();
  });

  it("gc's after the referencing session reaches a terminal state", async () => {
    await app.computeService.create({
      name: "ephemeral-k8s",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    const session = await app.sessions.create({
      repo: "/tmp",
      flow: "quick",
      task: "test",
      agent: "default",
      compute_name: "ephemeral-k8s",
    });
    // Mark the session completed -- now gc must succeed.
    await app.sessions.update(session.id, { status: "completed" });

    const gc = await garbageCollectComputeIfTemplate(app, "ephemeral-k8s");
    expect(gc).toBe(true);
    expect(await app.computes.get("ephemeral-k8s")).toBeNull();
  });

  it("local + docker (template isolation over persistent kind) gets gc'd", async () => {
    await app.computeService.create({
      name: "local-docker",
      compute: "local",
      isolation: "docker",
      config: { image: "alpine" },
    });
    const gc = await garbageCollectComputeIfTemplate(app, "local-docker");
    expect(gc).toBe(true);
    expect(await app.computes.get("local-docker")).toBeNull();
  });

  it("cloned_from rows are GC'd even when the kind is persistent", async () => {
    // EC2 + direct is persistent -- would normally be skipped. But the
    // `cloned_from` flag marks this row as an ephemeral clone produced by
    // the dispatcher, so GC should remove it regardless of lifecycle.
    await app.computeService.create({
      name: "ec2-clone",
      compute: "ec2",
      isolation: "direct",
      config: {},
      cloned_from: "ec2-template",
    });
    const gc = await garbageCollectComputeIfTemplate(app, "ec2-clone");
    expect(gc).toBe(true);
    expect(await app.computes.get("ec2-clone")).toBeNull();
  });

  it("persistent row WITHOUT cloned_from is NOT GC'd", async () => {
    // A user-provisioned EC2 box (no clone marker) should stick around
    // across session boundaries -- that's the whole point of persistent
    // infra. GC must leave it alone.
    await app.computeService.create({
      name: "ec2-persistent",
      compute: "ec2",
      isolation: "direct",
      config: {},
    });
    const gc = await garbageCollectComputeIfTemplate(app, "ec2-persistent");
    expect(gc).toBe(false);
    expect(await app.computes.get("ec2-persistent")).not.toBeNull();
  });

  // ── GC + Compute.capabilities.canDelete ─────────────────────────────────
  //
  // The compute-cleanup PR landed here: per-row provider stubs with
  // `canDelete=false` are gone, the canonical capability flag now lives on
  // `Compute.capabilities.canDelete`. The auto-seeded singleton (LocalCompute,
  // canDelete=false) is the only row the GC must refuse; everything else
  // (templates, clones) is freely reapable.

  it("DOES gc a clone row (force-delete bypass for clones is the path)", async () => {
    // Template parent first (is_template exempts it from the singleton / GC
    // paths so we can keep it around as a blueprint).
    await app.computeService.create({
      name: "stub-parent",
      compute: "k8s",
      isolation: "direct",
      is_template: true,
      config: {},
    });
    // Clone of the parent.
    await app.computeService.create({
      name: "stub-clone",
      compute: "k8s",
      isolation: "direct",
      cloned_from: "stub-parent",
      config: {},
    });

    const gc = await garbageCollectComputeIfTemplate(app, "stub-clone");
    expect(gc).toBe(true);
    expect(await app.computes.get("stub-clone")).toBeNull();
    // Parent template is NOT touched by GC (is_template short-circuits the
    // helper well before it gets anywhere near delete()).
    expect(await app.computes.get("stub-parent")).not.toBeNull();
  });
});
