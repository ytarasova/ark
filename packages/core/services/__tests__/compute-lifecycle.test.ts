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
    await app.computes.create({
      name: "test-k8s",
      compute: "k8s",
      runtime: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    expect(await app.computes.get("test-k8s")).not.toBeNull();

    const gc = await garbageCollectComputeIfTemplate(app, "test-k8s");
    expect(gc).toBe(true);
    expect(await app.computes.get("test-k8s")).toBeNull();
  });

  it("skips gc when a live session still references the compute", async () => {
    await app.computes.create({
      name: "busy-k8s",
      compute: "k8s",
      runtime: "direct",
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
    await app.computes.create({
      name: "ephemeral-k8s",
      compute: "k8s",
      runtime: "direct",
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

  it("local + docker (template runtime over persistent kind) gets gc'd", async () => {
    await app.computes.create({
      name: "local-docker",
      compute: "local",
      runtime: "docker",
      config: { image: "alpine" },
    });
    const gc = await garbageCollectComputeIfTemplate(app, "local-docker");
    expect(gc).toBe(true);
    expect(await app.computes.get("local-docker")).toBeNull();
  });
});
