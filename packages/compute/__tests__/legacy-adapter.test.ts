/**
 * Legacy adapter tests -- Wave 1 only maps `LocalWorktreeProvider` onto a
 * `ComputeTarget` (LocalCompute + DirectRuntime). Every other provider
 * returns null so call sites continue using the legacy path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import {
  LocalWorktreeProvider,
  LocalDockerProvider,
  LocalDevcontainerProvider,
  LocalFirecrackerProvider,
} from "../providers/local-arkd.js";
import {
  RemoteWorktreeProvider,
  RemoteDockerProvider,
  RemoteDevcontainerProvider,
  RemoteFirecrackerProvider,
} from "../providers/remote-arkd.js";
import { K8sProvider, KataProvider } from "../providers/k8s.js";
import { computeProviderToTarget } from "../adapters/legacy.js";
import { LocalCompute } from "../core/local.js";
import { EC2Compute } from "../core/ec2.js";
import { FirecrackerCompute } from "../core/firecracker/compute.js";
import { K8sCompute } from "../core/k8s.js";
import { KataCompute } from "../core/k8s-kata.js";
import { DirectRuntime } from "../runtimes/direct.js";
import { DockerRuntime } from "../runtimes/docker.js";
import { DevcontainerRuntime } from "../runtimes/devcontainer.js";
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

  it("maps LocalFirecrackerProvider onto FirecrackerCompute + DirectRuntime (Phase 2)", () => {
    const legacy = new LocalFirecrackerProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(FirecrackerCompute);
    expect(target!.runtime).toBeInstanceOf(DirectRuntime);
  });

  it("maps K8sProvider onto K8sCompute + DirectRuntime", () => {
    const legacy = new K8sProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(K8sCompute);
    expect(target!.runtime).toBeInstanceOf(DirectRuntime);
  });

  it("maps KataProvider onto KataCompute + DirectRuntime (Kata checked before K8s)", () => {
    const legacy = new KataProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    // KataCompute extends K8sCompute, so instanceof K8sCompute also passes --
    // the point of this assertion is that we got the *Kata* subclass back,
    // not the base K8sCompute.
    expect(target!.compute).toBeInstanceOf(KataCompute);
    expect(target!.compute.kind).toBe("k8s-kata");
    expect(target!.runtime).toBeInstanceOf(DirectRuntime);
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

  // ── Wave 3: remote (EC2-backed) providers ────────────────────────────────

  it("maps RemoteWorktreeProvider onto EC2Compute + DirectRuntime", () => {
    const legacy = new RemoteWorktreeProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(EC2Compute);
    expect(target!.runtime).toBeInstanceOf(DirectRuntime);
  });

  it("maps RemoteDockerProvider onto EC2Compute + DockerRuntime", () => {
    const legacy = new RemoteDockerProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(EC2Compute);
    expect(target!.runtime).toBeInstanceOf(DockerRuntime);
  });

  it("maps RemoteDevcontainerProvider onto EC2Compute + DevcontainerRuntime", () => {
    const legacy = new RemoteDevcontainerProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(EC2Compute);
    expect(target!.runtime).toBeInstanceOf(DevcontainerRuntime);
  });

  it("returns null for RemoteFirecrackerProvider (Phase 2 owns the microVM side)", () => {
    const legacy = new RemoteFirecrackerProvider();
    legacy.setApp?.(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).toBeNull();
  });
});
