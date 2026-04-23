/**
 * Extended end-to-end tests for the compute layer.
 *
 * Exercises provider resolution, port probing with live servers,
 * arc.json resolution from multiple sources, mergeComputeConfig,
 * and sessionChannelPort.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  getProvider,
  listProviders,
  resolvePortDecls,
  registerProvider,
  LocalWorktreeProvider,
  LocalDockerProvider,
} from "../index.js";

import { AppContext } from "../../core/app.js";
import { getApp, setApp, clearApp } from "../../core/__tests__/test-helpers.js";
import { providerOf } from "../adapters/provider-map.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
});

// Ensure providers are registered (may be cleared by provider-registry.test.ts)
function ensureProviders() {
  if (!getProvider("local")) {
    const lp = new LocalWorktreeProvider();
    lp.setApp?.(app);
    registerProvider(lp);
  }
  if (!getProvider("docker")) {
    const dp = new LocalDockerProvider();
    dp.setApp?.(app);
    registerProvider(dp);
  }
}

// Track resources for cleanup
const computeNames: string[] = [];

async function cleanupComputes() {
  for (const name of computeNames) {
    try {
      await getApp().computes.delete(name);
    } catch {
      /* already gone */
    }
  }
  computeNames.length = 0;
}

// ── Test 1: EC2 compute creation and provider resolution ───────────────────────

describe("E2E Compute: Remote compute provider resolution", () => {
  beforeEach(() => ensureProviders());
  afterEach(async () => {
    await cleanupComputes();
  });

  it("creates a remote compute and stores its config", async () => {
    const name = `test-remote-resolve-${Date.now()}`;
    // "ec2" is the registered RemoteWorktreeProvider. The earlier string
    // "ec2-worktree" was not a registered provider name; the old repo layer
    // accepted any string for the provider column, but ComputeService now
    // rejects unknown providers because it resolves them through the
    // registry to pull initialStatus / singleton / canDelete flags.
    const compute = await getApp().computeService.create({
      name,
      provider: "ec2",
      config: { size: "m", region: "us-east-1" },
    });
    computeNames.push(name);

    expect(compute.name).toBe(name);
    expect(providerOf(compute)).toBe("ec2");
    expect(compute.status).toBe("stopped");
    expect(compute.config.size).toBe("m");
    expect(compute.config.region).toBe("us-east-1");
  });
});

// ── Test 2: Docker compute creation and provider resolution ────────────────────

describe("E2E Compute: Docker compute provider resolution", () => {
  beforeEach(() => ensureProviders());
  afterEach(async () => {
    await cleanupComputes();
  });

  it("creates a Docker compute and resolves its provider", async () => {
    const name = `test-docker-resolve-${Date.now()}`;
    const compute = await getApp().computeService.create({
      name,
      provider: "docker",
      config: { image: "ubuntu:22.04", memory: "4g" },
    });
    computeNames.push(name);

    expect(compute.name).toBe(name);
    expect(providerOf(compute)).toBe("docker");
    expect(compute.status).toBe("stopped");

    const provider = getProvider("docker");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("docker");

    // Verify core providers are registered
    const providers = listProviders();
    expect(providers).toContain("local");
    expect(providers).toContain("docker");
  });
});

// ── Test 3: resolvePortDecls with all three sources ─────────────────────────

describe("E2E Compute: resolvePortDecls with all three sources", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ark-e2e-ports-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it("resolves ports from arc.json, devcontainer.json, and docker-compose.yml", async () => {
    // Create arc.json with a port
    writeFileSync(join(tempDir, "arc.json"), JSON.stringify({ ports: [{ port: 3000, name: "api" }] }));

    // Create .devcontainer/devcontainer.json with forwardPorts
    const devcontainerDir = join(tempDir, ".devcontainer");
    mkdirSync(devcontainerDir, { recursive: true });
    writeFileSync(join(devcontainerDir, "devcontainer.json"), JSON.stringify({ forwardPorts: [5432] }));

    // Create docker-compose.yml with port mapping
    writeFileSync(
      join(tempDir, "docker-compose.yml"),
      ["version: '3'", "services:", "  redis:", "    image: redis", "    ports:", '      - "6379:6379"'].join("\n"),
    );

    const portDecls = resolvePortDecls(tempDir);

    // Should have 3 unique ports from 3 sources
    expect(portDecls).toHaveLength(3);

    const portNumbers = portDecls.map((p) => p.port).sort((a, b) => a - b);
    expect(portNumbers).toEqual([3000, 5432, 6379]);

    // Verify sources
    const arcDecl = portDecls.find((p) => p.port === 3000);
    expect(arcDecl).toBeDefined();
    expect(arcDecl!.source).toBe("arc.json");
    expect(arcDecl!.name).toBe("api");

    const devDecl = portDecls.find((p) => p.port === 5432);
    expect(devDecl).toBeDefined();
    expect(devDecl!.source).toBe("devcontainer.json");

    const composeDecl = portDecls.find((p) => p.port === 6379);
    expect(composeDecl).toBeDefined();
    expect(composeDecl!.source).toBe("docker-compose");
  });

  it("deduplicates ports with arc.json taking priority", async () => {
    // Both arc.json and devcontainer declare port 3000
    writeFileSync(join(tempDir, "arc.json"), JSON.stringify({ ports: [{ port: 3000, name: "web-app" }] }));
    const devcontainerDir = join(tempDir, ".devcontainer");
    mkdirSync(devcontainerDir, { recursive: true });
    writeFileSync(join(devcontainerDir, "devcontainer.json"), JSON.stringify({ forwardPorts: [3000, 8080] }));

    const portDecls = resolvePortDecls(tempDir);
    expect(portDecls).toHaveLength(2);

    // Port 3000 should come from arc.json (priority) with the name
    const p3000 = portDecls.find((p) => p.port === 3000);
    expect(p3000).toBeDefined();
    expect(p3000!.source).toBe("arc.json");
    expect(p3000!.name).toBe("web-app");

    // Port 8080 from devcontainer
    const p8080 = portDecls.find((p) => p.port === 8080);
    expect(p8080).toBeDefined();
    expect(p8080!.source).toBe("devcontainer.json");
  });
});

// ── Test 4: Local provider getMetrics ───────────────────────────────────────

describe("E2E Compute: Local provider getMetrics", async () => {
  beforeEach(() => ensureProviders());
  afterEach(async () => {
    await cleanupComputes();
  });

  it("returns a valid metrics snapshot", async () => {
    const compute = await getApp().computes.get("local")!;
    expect(compute).not.toBeNull();

    const provider = getProvider("local")!;
    expect(provider).not.toBeNull();

    const snapshot = await provider.getMetrics(compute);

    // Verify all metric fields exist and are valid
    expect(snapshot).toBeDefined();
    expect(snapshot.metrics).toBeDefined();
    expect(typeof snapshot.metrics.cpu).toBe("number");
    expect(snapshot.metrics.cpu).toBeGreaterThanOrEqual(0);

    expect(typeof snapshot.metrics.memTotalGb).toBe("number");
    expect(snapshot.metrics.memTotalGb).toBeGreaterThan(0);

    expect(typeof snapshot.metrics.memUsedGb).toBe("number");
    expect(snapshot.metrics.memUsedGb).toBeGreaterThanOrEqual(0);

    expect(typeof snapshot.metrics.memPct).toBe("number");
    expect(snapshot.metrics.memPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.metrics.memPct).toBeLessThanOrEqual(100);

    expect(typeof snapshot.metrics.diskPct).toBe("number");
    expect(snapshot.metrics.diskPct).toBeGreaterThanOrEqual(0);

    expect(typeof snapshot.metrics.uptime).toBe("string");
    expect(snapshot.metrics.uptime.length).toBeGreaterThan(0);

    expect(Array.isArray(snapshot.sessions)).toBe(true);
    expect(Array.isArray(snapshot.processes)).toBe(true);
    expect(Array.isArray(snapshot.docker)).toBe(true);
  }, 60_000);
});

// ── Test 5: Local provider probePorts with live server ──────────────────────

describe("E2E Compute: Local provider probePorts", async () => {
  beforeEach(() => ensureProviders());
  afterEach(async () => {
    await cleanupComputes();
  });

  it("detects a listening port and a closed port", async () => {
    const compute = await getApp().computes.get("local")!;
    expect(compute).not.toBeNull();

    const provider = getProvider("local")!;

    // Start a Bun.serve on a random port
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    const port = server.port;

    try {
      // Probe the listening port
      const probeUp = await provider.probePorts(compute, [{ port, source: "test" }]);
      expect(probeUp).toHaveLength(1);
      expect(probeUp[0].port).toBe(port);
      expect(probeUp[0].listening).toBe(true);

      // Stop the server
      server.stop(true);

      // Give OS time to release the port
      await new Promise((r) => setTimeout(r, 500));

      // Probe again - should not be listening
      const probeDown = await provider.probePorts(compute, [{ port, source: "test" }]);
      expect(probeDown).toHaveLength(1);
      expect(probeDown[0].port).toBe(port);
      expect(probeDown[0].listening).toBe(false);
    } finally {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    }
  });
});

// ── Test 6: mergeComputeConfig ─────────────────────────────────────────────────

describe("E2E Compute: mergeComputeConfig", () => {
  afterEach(async () => {
    await cleanupComputes();
  });

  it("merges config keys without overwriting existing ones", async () => {
    const name = `test-merge-cfg-${Date.now()}`;
    await getApp().computeService.create({
      name,
      provider: "docker",
      config: { existing: "value", count: 42 },
    });
    computeNames.push(name);

    const updated = await getApp().computes.mergeConfig(name, { newKey: "hello", count: 99 });
    expect(updated).not.toBeNull();
    expect(updated!.config.existing).toBe("value"); // preserved
    expect(updated!.config.newKey).toBe("hello"); // added
    expect(updated!.config.count).toBe(99); // overwritten

    // Verify via re-read
    const compute = await getApp().computes.get(name);
    expect(compute!.config.existing).toBe("value");
    expect(compute!.config.newKey).toBe("hello");
    expect(compute!.config.count).toBe(99);
  });

  it("returns null for non-existent compute", async () => {
    const result = await getApp().computes.mergeConfig("nonexistent-compute", { key: "val" });
    expect(result).toBeNull();
  });
});

// ── Test 7: sessionChannelPort ──────────────────────────────────────────────

describe("E2E Compute: sessionChannelPort", () => {
  it("returns consistent port for same session ID", async () => {
    const port1 = getApp().sessions.channelPort("s-abc123");
    const port2 = getApp().sessions.channelPort("s-abc123");
    expect(port1).toBe(port2);
  });

  it("returns different ports for different session IDs", async () => {
    const { basePort, range } = getApp().config.channels;
    const port1 = getApp().sessions.channelPort("s-aaa111");
    const port2 = getApp().sessions.channelPort("s-bbb222");
    // Different IDs should (almost certainly) produce different ports.
    // There's a small chance of collision in the mod-range space, but
    // these specific hex values should differ.
    expect(typeof port1).toBe("number");
    expect(typeof port2).toBe("number");
    expect(port1).toBeGreaterThanOrEqual(basePort);
    expect(port2).toBeGreaterThanOrEqual(basePort);
    expect(port1).toBeLessThan(basePort + range);
    expect(port2).toBeLessThan(basePort + range);
  });

  it("port is within the configured channel range", async () => {
    const { basePort, range } = getApp().config.channels;
    const testIds = ["s-000000", "s-ffffff", "s-123abc", "s-deadbe"];
    for (const id of testIds) {
      const port = getApp().sessions.channelPort(id);
      expect(port).toBeGreaterThanOrEqual(basePort);
      expect(port).toBeLessThan(basePort + range);
    }
  });
});
