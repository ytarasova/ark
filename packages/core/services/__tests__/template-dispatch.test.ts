/**
 * Template-dispatch integration tests.
 *
 * When a stage references a named template row, the dispatcher clones it
 * into a fresh per-session concrete row. The clone is tagged with
 * `cloned_from = <template>` so the GC pass can prune it once the session
 * reaches a terminal state.
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

describe("resolveComputeForStage + template cloning", () => {
  it("clones a template row into a per-session concrete row", async () => {
    // Seed a template.
    await app.computeService.create({
      name: "k8s-tmpl",
      compute: "k8s",
      runtime: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
      is_template: true,
    });

    const sessionId = "abcdef1234567890";
    const stageDef = { compute: "k8s-tmpl" } as any;

    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, sessionId);
    // Clone name is `<template>-<first 8 of sessionId>`.
    expect(resolved).toBe("k8s-tmpl-abcdef12");

    const clone = await app.computes.get("k8s-tmpl-abcdef12");
    expect(clone).not.toBeNull();
    expect(clone!.is_template).toBe(false);
    expect(clone!.cloned_from).toBe("k8s-tmpl");
    expect(clone!.compute_kind).toBe("k8s");
    expect(clone!.runtime_kind).toBe("direct");

    // Template row stays intact.
    const tmpl = await app.computes.get("k8s-tmpl");
    expect(tmpl?.is_template).toBe(true);
  });

  it("returns concrete compute name as-is (no cloning)", async () => {
    await app.computeService.create({
      name: "shared-ec2",
      provider: "ec2",
      config: {},
    });
    const sessionId = "abcdef1234567890";
    const stageDef = { compute: "shared-ec2" } as any;
    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, sessionId);
    expect(resolved).toBe("shared-ec2");

    // No clone was created.
    const would = await app.computes.get("shared-ec2-abcdef12");
    expect(would).toBeNull();
  });

  it("legacy compute_template field resolves through the same path", async () => {
    await app.computeService.create({
      name: "legacy-tmpl",
      compute: "k8s",
      runtime: "direct",
      config: { context: "c", namespace: "ns", image: "img" },
      is_template: true,
    });
    const sessionId = "fedcba0987654321";
    const stageDef = { compute_template: "legacy-tmpl" } as any;

    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, sessionId);
    expect(resolved).toBe("legacy-tmpl-fedcba09");

    const clone = await app.computes.get("legacy-tmpl-fedcba09");
    expect(clone?.cloned_from).toBe("legacy-tmpl");
  });

  it("returns null when the named row is not found", async () => {
    const stageDef = { compute: "does-not-exist" } as any;
    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, "abcdef1234567890");
    expect(resolved).toBeNull();
  });

  it("GC prunes the clone when the session completes; template is preserved", async () => {
    await app.computeService.create({
      name: "k8s-tmpl2",
      compute: "k8s",
      runtime: "direct",
      config: { context: "c", namespace: "ns", image: "img" },
      is_template: true,
    });

    const sessionId = "1111222233334444";
    const resolved = await app.dispatchService.resolveComputeForStage({ compute: "k8s-tmpl2" } as any, sessionId);
    expect(resolved).toBe("k8s-tmpl2-11112222");

    // Tie the clone to a session, then drive it to terminal.
    const s = await app.sessions.create({
      repo: "/tmp",
      flow: "quick",
      task: "test",
      agent: "default",
      compute_name: "k8s-tmpl2-11112222",
    });
    await app.sessions.update(s.id, { status: "completed" });

    const gc = await garbageCollectComputeIfTemplate(app, "k8s-tmpl2-11112222");
    expect(gc).toBe(true);
    expect(await app.computes.get("k8s-tmpl2-11112222")).toBeNull();

    // Template row is untouched.
    const tmpl = await app.computes.get("k8s-tmpl2");
    expect(tmpl).not.toBeNull();
    expect(tmpl?.is_template).toBe(true);
  });
});
