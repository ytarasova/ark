/**
 * Legacy adapter tests -- verifies `computeProviderToTarget` maps every
 * known legacy provider onto its matching `ComputeTarget`, and returns null
 * for any provider not yet wired (so call sites continue using the legacy
 * path).
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
import { DirectIsolation } from "../isolation/direct.js";
import { DockerIsolation } from "../isolation/docker.js";
import { DevcontainerIsolation } from "../isolation/devcontainer.js";
import { AppContext } from "../../core/app.js";
import { setApp, clearApp } from "../../core/__tests__/test-helpers.js";

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

describe("computeProviderToTarget", async () => {
  it("maps LocalWorktreeProvider onto LocalCompute + DirectIsolation", () => {
    const legacy = new LocalWorktreeProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(LocalCompute);
    expect(target!.isolation).toBeInstanceOf(DirectIsolation);
  });

  it("returned ComputeTarget is wired to the running AppContext", () => {
    const legacy = new LocalWorktreeProvider(app);
    const target = computeProviderToTarget(legacy, app)!;
    const handle = { kind: "local" as const, name: "local", meta: {} };
    // getArkdUrl must read config.ports.arkd from the injected AppContext.
    expect(target.getArkdUrl(handle)).toBe(`http://localhost:${app.config.ports.arkd}`);
  });

  it("maps LocalDockerProvider onto LocalCompute + DockerIsolation", () => {
    const legacy = new LocalDockerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(LocalCompute);
    expect(target!.isolation).toBeInstanceOf(DockerIsolation);
  });

  it("maps LocalFirecrackerProvider onto FirecrackerCompute + DirectIsolation", () => {
    const legacy = new LocalFirecrackerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(FirecrackerCompute);
    expect(target!.isolation).toBeInstanceOf(DirectIsolation);
  });

  it("maps K8sProvider onto K8sCompute + DirectIsolation", () => {
    const legacy = new K8sProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(K8sCompute);
    expect(target!.isolation).toBeInstanceOf(DirectIsolation);
  });

  it("maps KataProvider onto KataCompute + DirectIsolation (Kata checked before K8s)", () => {
    const legacy = new KataProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    // KataCompute extends K8sCompute, so instanceof K8sCompute also passes --
    // the point of this assertion is that we got the *Kata* subclass back,
    // not the base K8sCompute.
    expect(target!.compute).toBeInstanceOf(KataCompute);
    expect(target!.compute.kind).toBe("k8s-kata");
    expect(target!.isolation).toBeInstanceOf(DirectIsolation);
  });

  it("returns null for providers that have not been migrated yet", () => {
    const legacy = new LocalDevcontainerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).toBeNull();
  });

  it("ComputeTarget.provision is a no-op that mints a handle", async () => {
    const legacy = new LocalWorktreeProvider(app);
    const target = computeProviderToTarget(legacy, app)!;
    const h = await target.provision({ tags: { name: "local" } });
    expect(h.kind).toBe("local");
    expect(h.name).toBe("local");
  });

  // ── Remote (EC2-backed) providers ────────────────────────────────────────

  it("maps RemoteWorktreeProvider onto EC2Compute + DirectIsolation", () => {
    const legacy = new RemoteWorktreeProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(EC2Compute);
    expect(target!.isolation).toBeInstanceOf(DirectIsolation);
  });

  it("maps RemoteDockerProvider onto EC2Compute + DockerIsolation", () => {
    const legacy = new RemoteDockerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(EC2Compute);
    expect(target!.isolation).toBeInstanceOf(DockerIsolation);
  });

  it("maps RemoteDevcontainerProvider onto EC2Compute + DevcontainerIsolation", () => {
    const legacy = new RemoteDevcontainerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).not.toBeNull();
    expect(target!.compute).toBeInstanceOf(EC2Compute);
    expect(target!.isolation).toBeInstanceOf(DevcontainerIsolation);
  });

  it("returns null for RemoteFirecrackerProvider (microVM-on-EC2 not yet wired)", () => {
    const legacy = new RemoteFirecrackerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    expect(target).toBeNull();
  });
});
