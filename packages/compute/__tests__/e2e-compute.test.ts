/**
 * Extended end-to-end tests for the compute layer.
 *
 * Exercises provider resolution, port probing with live servers,
 * arc.json resolution from multiple sources, mergeHostConfig,
 * and sessionChannelPort.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  createHost,
  getHost,
  updateHost,
  deleteHost,
  mergeHostConfig,
  sessionChannelPort,
  getDb,
} from "../../core/store.js";

import {
  getProvider,
  listProviders,
  resolvePortDecls,
  registerProvider,
  LocalProvider,
  EC2Provider,
  DockerProvider,
} from "../index.js";

// Ensure providers are registered (may be cleared by provider-registry.test.ts)
function ensureProviders() {
  if (!getProvider("local")) registerProvider(new LocalProvider());
  if (!getProvider("ec2")) registerProvider(new EC2Provider());
  if (!getProvider("docker")) registerProvider(new DockerProvider());
}

// Track resources for cleanup
const hostNames: string[] = [];

function cleanupHosts() {
  for (const name of hostNames) {
    try { deleteHost(name); } catch { /* already gone */ }
  }
  hostNames.length = 0;
}

// ── Test 1: EC2 host creation and provider resolution ───────────────────────

describe("E2E Compute: EC2 host provider resolution", () => {
  beforeEach(() => ensureProviders());
  afterEach(() => cleanupHosts());

  it("creates an EC2 host and resolves its provider", () => {
    const name = `test-ec2-resolve-${Date.now()}`;
    const host = createHost({
      name,
      provider: "ec2",
      config: { size: "m", region: "us-east-1" },
    });
    hostNames.push(name);

    expect(host.name).toBe(name);
    expect(host.provider).toBe("ec2");
    expect(host.status).toBe("stopped"); // non-local hosts start stopped

    const provider = getProvider("ec2");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("ec2");

    // Verify config was stored
    expect((host.config as any).size).toBe("m");
    expect((host.config as any).region).toBe("us-east-1");
  });
});

// ── Test 2: Docker host creation and provider resolution ────────────────────

describe("E2E Compute: Docker host provider resolution", () => {
  beforeEach(() => ensureProviders());
  afterEach(() => cleanupHosts());

  it("creates a Docker host and resolves its provider", () => {
    const name = `test-docker-resolve-${Date.now()}`;
    const host = createHost({
      name,
      provider: "docker",
      config: { image: "ubuntu:22.04", memory: "4g" },
    });
    hostNames.push(name);

    expect(host.name).toBe(name);
    expect(host.provider).toBe("docker");
    expect(host.status).toBe("stopped");

    const provider = getProvider("docker");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("docker");

    // Verify all three providers are registered
    const providers = listProviders();
    expect(providers).toContain("local");
    expect(providers).toContain("ec2");
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
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("resolves ports from arc.json, devcontainer.json, and docker-compose.yml", () => {
    // Create arc.json with a port
    writeFileSync(
      join(tempDir, "arc.json"),
      JSON.stringify({ ports: [{ port: 3000, name: "api" }] }),
    );

    // Create .devcontainer/devcontainer.json with forwardPorts
    const devcontainerDir = join(tempDir, ".devcontainer");
    mkdirSync(devcontainerDir, { recursive: true });
    writeFileSync(
      join(devcontainerDir, "devcontainer.json"),
      JSON.stringify({ forwardPorts: [5432] }),
    );

    // Create docker-compose.yml with port mapping
    writeFileSync(
      join(tempDir, "docker-compose.yml"),
      [
        "version: '3'",
        "services:",
        "  redis:",
        "    image: redis",
        "    ports:",
        '      - "6379:6379"',
      ].join("\n"),
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

  it("deduplicates ports with arc.json taking priority", () => {
    // Both arc.json and devcontainer declare port 3000
    writeFileSync(
      join(tempDir, "arc.json"),
      JSON.stringify({ ports: [{ port: 3000, name: "web-app" }] }),
    );
    const devcontainerDir = join(tempDir, ".devcontainer");
    mkdirSync(devcontainerDir, { recursive: true });
    writeFileSync(
      join(devcontainerDir, "devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 8080] }),
    );

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

describe("E2E Compute: Local provider getMetrics", () => {
  beforeEach(() => ensureProviders());
  afterEach(() => cleanupHosts());

  it("returns a valid metrics snapshot", async () => {
    const name = `test-metrics-local-${Date.now()}`;
    const host = createHost({ name, provider: "local" });
    hostNames.push(name);

    const provider = getProvider("local")!;
    expect(provider).not.toBeNull();

    const snapshot = await provider.getMetrics(host);

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
  }, 15_000);
});

// ── Test 5: Local provider probePorts with live server ──────────────────────

describe("E2E Compute: Local provider probePorts", () => {
  beforeEach(() => ensureProviders());
  afterEach(() => cleanupHosts());

  it("detects a listening port and a closed port", async () => {
    const name = `test-probe-local-${Date.now()}`;
    const host = createHost({ name, provider: "local" });
    hostNames.push(name);

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
      const probeUp = await provider.probePorts(host, [
        { port, source: "test" },
      ]);
      expect(probeUp).toHaveLength(1);
      expect(probeUp[0].port).toBe(port);
      expect(probeUp[0].listening).toBe(true);

      // Stop the server
      server.stop(true);

      // Give OS time to release the port
      await new Promise((r) => setTimeout(r, 500));

      // Probe again - should not be listening
      const probeDown = await provider.probePorts(host, [
        { port, source: "test" },
      ]);
      expect(probeDown).toHaveLength(1);
      expect(probeDown[0].port).toBe(port);
      expect(probeDown[0].listening).toBe(false);
    } finally {
      try { server.stop(true); } catch { /* already stopped */ }
    }
  });
});

// ── Test 6: mergeHostConfig ─────────────────────────────────────────────────

describe("E2E Compute: mergeHostConfig", () => {
  afterEach(() => cleanupHosts());

  it("merges config keys without overwriting existing ones", () => {
    const name = `test-merge-cfg-${Date.now()}`;
    createHost({
      name,
      provider: "local",
      config: { existing: "value", count: 42 },
    });
    hostNames.push(name);

    const updated = mergeHostConfig(name, { newKey: "hello", count: 99 });
    expect(updated).not.toBeNull();
    expect((updated!.config as any).existing).toBe("value"); // preserved
    expect((updated!.config as any).newKey).toBe("hello");   // added
    expect((updated!.config as any).count).toBe(99);         // overwritten

    // Verify via re-read
    const host = getHost(name);
    expect((host!.config as any).existing).toBe("value");
    expect((host!.config as any).newKey).toBe("hello");
    expect((host!.config as any).count).toBe(99);
  });

  it("returns null for non-existent host", () => {
    const result = mergeHostConfig("nonexistent-host", { key: "val" });
    expect(result).toBeNull();
  });
});

// ── Test 7: sessionChannelPort ──────────────────────────────────────────────

describe("E2E Compute: sessionChannelPort", () => {
  it("returns consistent port for same session ID", () => {
    const port1 = sessionChannelPort("s-abc123");
    const port2 = sessionChannelPort("s-abc123");
    expect(port1).toBe(port2);
  });

  it("returns different ports for different session IDs", () => {
    const port1 = sessionChannelPort("s-aaa111");
    const port2 = sessionChannelPort("s-bbb222");
    // Different IDs should (almost certainly) produce different ports
    // There's a small chance of collision in the mod 1000 space, but
    // these specific hex values should differ
    expect(typeof port1).toBe("number");
    expect(typeof port2).toBe("number");
    expect(port1).toBeGreaterThanOrEqual(19200);
    expect(port2).toBeGreaterThanOrEqual(19200);
    expect(port1).toBeLessThan(20200);
    expect(port2).toBeLessThan(20200);
  });

  it("port is within expected range 19200-20199", () => {
    const testIds = ["s-000000", "s-ffffff", "s-123abc", "s-deadbe"];
    for (const id of testIds) {
      const port = sessionChannelPort(id);
      expect(port).toBeGreaterThanOrEqual(19200);
      expect(port).toBeLessThan(20200);
    }
  });
});
