/**
 * Legacy adapter tests -- Wave 1 only maps `LocalWorktreeProvider` onto a
 * `ComputeTarget` (LocalCompute + DirectRuntime). Every other provider
 * returns null so call sites continue using the legacy path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { LocalWorktreeProvider, LocalDockerProvider, LocalDevcontainerProvider } from "../providers/local-arkd.js";
import { computeProviderToTarget } from "../adapters/legacy.js";
import { LocalCompute } from "../core/local.js";
import { DirectRuntime } from "../runtimes/direct.js";
import { DockerRuntime } from "../runtimes/docker.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

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

describe("computeProviderToTarget", () => {
  it("maps LocalWorktreeProvider onto LocalCompute + DirectRuntime", () => {
    const legacy = new LocalWorktreeProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(LocalCompute);
    expect(target!.runtime).toBeInstanceOf(DirectRuntime);
  });

  it("returned ComputeTarget is wired to the running AppContext", () => {
    const legacy = new LocalWorktreeProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app)!;
    const handle = { kind: "local" as const, name: "local", meta: {} };
    // getArkdUrl must read config.ports.arkd from the injected AppContext.
    expect(target.getArkdUrl(handle)).toBe(`http://localhost:${app.config.ports.arkd}`);
  });

  it("maps LocalDockerProvider onto LocalCompute + DockerRuntime", () => {
    const legacy = new LocalDockerProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(LocalCompute);
    expect(target!.runtime).toBeInstanceOf(DockerRuntime);
  });

  it("returns null for providers that have not been migrated yet", () => {
    const legacy = new LocalDevcontainerProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).toBeNull();
  });

  it("ComputeTarget.provision is a no-op that mints a handle", async () => {
    const legacy = new LocalWorktreeProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app)!;
    const h = await target.provision({ tags: { name: "local" } });
    expect(h.kind).toBe("local");
    expect(h.name).toBe("local");
  });
});
