/**
 * E2E tests for provider isolation modes.
 *
 * Validates that each provider reports the correct isolation modes:
 * - LocalProvider: worktree + inplace
 * - EC2Provider: inplace only
 * - DockerProvider: container only
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("provider isolation modes", () => {
  it("LocalProvider has worktree and inplace modes", () => {
    const provider = app.getProvider("local");
    expect(provider).not.toBeNull();

    const modes = provider!.isolationModes;
    expect(modes.length).toBe(2);

    const values = modes.map(m => m.value);
    expect(values).toContain("worktree");
    expect(values).toContain("inplace");
  });

  it("LocalProvider worktree mode has correct label", () => {
    const provider = app.getProvider("local")!;
    const worktree = provider.isolationModes.find(m => m.value === "worktree");
    expect(worktree).toBeTruthy();
    expect(worktree!.label).toContain("worktree");
  });

  it("LocalProvider inplace mode has correct label", () => {
    const provider = app.getProvider("local")!;
    const inplace = provider.isolationModes.find(m => m.value === "inplace");
    expect(inplace).toBeTruthy();
    expect(inplace!.label).toContain("direct");
  });

  it("EC2Provider has inplace mode only", () => {
    const provider = app.getProvider("ec2");
    expect(provider).not.toBeNull();

    const modes = provider!.isolationModes;
    expect(modes.length).toBe(1);
    expect(modes[0].value).toBe("inplace");
  });

  it("EC2Provider inplace mode has correct label", () => {
    const provider = app.getProvider("ec2")!;
    const inplace = provider.isolationModes[0];
    expect(inplace.label).toContain("Remote");
  });

  it("DockerProvider has container mode only", () => {
    const provider = app.getProvider("docker");
    expect(provider).not.toBeNull();

    const modes = provider!.isolationModes;
    expect(modes.length).toBe(1);
    expect(modes[0].value).toBe("container");
  });

  it("DockerProvider container mode has correct label", () => {
    const provider = app.getProvider("docker")!;
    const container = provider.isolationModes[0];
    expect(container.label).toContain("Docker");
  });

  it("all providers are registered after boot", () => {
    const providers = app.listProviders();
    expect(providers).toContain("local");
    expect(providers).toContain("ec2");
    expect(providers).toContain("docker");
  });

  it("each provider has a unique name", () => {
    const providers = app.listProviders();
    const unique = new Set(providers);
    expect(unique.size).toBe(providers.length);
  });

  it("getIsolationModes returns correct modes via compute index", async () => {
    const { getIsolationModes } = await import("../../compute/index.js");

    const localModes = getIsolationModes("local");
    expect(localModes.length).toBe(2);

    const ec2Modes = getIsolationModes("ec2");
    expect(ec2Modes.length).toBe(1);
    expect(ec2Modes[0].value).toBe("inplace");

    const dockerModes = getIsolationModes("docker");
    expect(dockerModes.length).toBe(1);
    expect(dockerModes[0].value).toBe("container");
  });
});
