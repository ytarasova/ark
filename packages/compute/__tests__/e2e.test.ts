/**
 * End-to-end integration tests for the Ark compute foundation.
 *
 * Exercises the full flow: host CRUD, provider registry, session launch,
 * port probing, arc.json resolution, and metrics collection.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  createHost,
  getHost,
  updateHost,
  deleteHost,
  listHosts,
} from "../../core/store.js";

import {
  getProvider,
  listProviders,
  resolvePortDecls,
} from "../index.js";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const fakeSession = {
  id: "s-e2etest",
  jira_key: null,
  jira_summary: null,
  repo: null,
  branch: null,
  compute_name: "test-local",
  session_id: null,
  claude_session_id: null,
  stage: null,
  status: "ready",
  pipeline: "default",
  agent: null,
  workdir: null,
  pr_url: null,
  pr_id: null,
  error: null,
  parent_id: null,
  fork_group: null,
  group_name: null,
  breakpoint_reason: null,
  attached_by: null,
  config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Track resources for cleanup
const hostNames: string[] = [];
const tmuxSessions: string[] = [];

function cleanupHosts() {
  for (const name of hostNames) {
    try { deleteHost(name); } catch { /* already gone */ }
  }
  hostNames.length = 0;
}

function cleanupTmux() {
  for (const name of tmuxSessions) {
    try {
      execFileSync("tmux", ["kill-session", "-t", name], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { /* session already dead */ }
  }
  tmuxSessions.length = 0;
}

// ── Test 1: Full host lifecycle ──────────────────────────────────────────────

describe("E2E: Full host lifecycle", () => {
  afterEach(() => {
    cleanupHosts();
    cleanupTmux();
  });

  it("creates, provisions, updates, collects metrics, destroys, and deletes a host", async () => {
    // Create a host in the DB
    const host = createHost({ name: "test-local", provider: "local" });
    hostNames.push("test-local");
    expect(host.name).toBe("test-local");
    expect(host.provider).toBe("local");
    expect(host.status).toBe("running"); // local hosts are always running

    // Look up its provider
    const provider = getProvider("local");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("local");

    // Provision (no-op for local)
    await provider!.provision(host);

    // Update host status to running
    const running = updateHost("test-local", { status: "running" });
    expect(running).not.toBeNull();
    expect(running!.status).toBe("running");

    // Collect metrics -- verify valid snapshot
    const snapshot = await provider!.getMetrics(running!);
    expect(snapshot).toBeDefined();
    expect(snapshot.metrics).toBeDefined();
    expect(typeof snapshot.metrics.cpu).toBe("number");
    expect(typeof snapshot.metrics.memTotalGb).toBe("number");
    expect(snapshot.metrics.memTotalGb).toBeGreaterThan(0);
    expect(typeof snapshot.metrics.memUsedGb).toBe("number");
    expect(typeof snapshot.metrics.memPct).toBe("number");
    expect(typeof snapshot.metrics.diskPct).toBe("number");
    expect(typeof snapshot.metrics.uptime).toBe("string");
    expect(Array.isArray(snapshot.sessions)).toBe(true);
    expect(Array.isArray(snapshot.processes)).toBe(true);
    expect(Array.isArray(snapshot.docker)).toBe(true);

    // Update host status to stopped
    const stopped = updateHost("test-local", { status: "stopped" });
    expect(stopped!.status).toBe("stopped");

    // Destroy (no-op for local)
    await provider!.destroy(stopped!);

    // Delete from DB
    const deleted = deleteHost("test-local");
    expect(deleted).toBe(true);
    hostNames.length = 0; // already cleaned up

    // Verify gone
    const gone = getHost("test-local");
    expect(gone).toBeNull();
  }, 30_000);
});

// ── Test 2: Launch and probe a session ───────────────────────────────────────

describe("E2E: Launch and probe a session", () => {
  afterEach(() => {
    cleanupTmux();
    cleanupHosts();
  });

  it("launches a tmux session, probes ports with a live server", async () => {
    // Create host
    const host = createHost({ name: "test-local-launch", provider: "local" });
    hostNames.push("test-local-launch");

    const provider = getProvider("local")!;
    expect(provider).not.toBeNull();

    // Launch tmux session
    const tmuxName = `ark-e2e-test-${Date.now()}`;
    tmuxSessions.push(tmuxName);

    await provider.launch(host, fakeSession as any, {
      tmuxName,
      workdir: "/tmp",
      launcherContent: "#!/bin/bash\nsleep 30",
      ports: [],
    });

    // Verify tmux session exists
    let sessionExists = false;
    try {
      execFileSync("tmux", ["has-session", "-t", tmuxName], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      sessionExists = true;
    } catch {
      sessionExists = false;
    }
    expect(sessionExists).toBe(true);

    // Start a Bun.serve() on a random port
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    const port = server.port;

    try {
      // Probe that port -- should be listening
      const probeUp = await provider.probePorts(host, [
        { port, source: "test" },
      ]);
      expect(probeUp).toHaveLength(1);
      expect(probeUp[0].port).toBe(port);
      expect(probeUp[0].listening).toBe(true);

      // Stop the server
      server.stop(true);

      // Give OS a moment to release the port
      await new Promise((r) => setTimeout(r, 500));

      // Probe again -- should not be listening
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

// ── Test 3: arc.json -> port resolution -> probing ───────────────────────────

describe("E2E: arc.json port resolution and probing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ark-e2e-arcjson-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    cleanupHosts();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("resolves ports from arc.json and devcontainer.json, probes them", async () => {
    // Use high ephemeral ports unlikely to be in use
    const arcPort = 59170;
    const devPort = 59171;

    // Create arc.json declaring a port
    writeFileSync(
      join(tempDir, "arc.json"),
      JSON.stringify({ ports: [{ port: arcPort, name: "web" }] }),
    );

    // Create .devcontainer/devcontainer.json with forwardPorts
    const devcontainerDir = join(tempDir, ".devcontainer");
    mkdirSync(devcontainerDir, { recursive: true });
    writeFileSync(
      join(devcontainerDir, "devcontainer.json"),
      JSON.stringify({ forwardPorts: [devPort] }),
    );

    // Resolve ports -- should find 2
    const portDecls = resolvePortDecls(tempDir);
    expect(portDecls).toHaveLength(2);

    const portNumbers = portDecls.map((p) => p.port).sort((a, b) => a - b);
    expect(portNumbers).toEqual([arcPort, devPort]);

    // Verify sources
    const arcDecl = portDecls.find((p) => p.port === arcPort);
    expect(arcDecl).toBeDefined();
    expect(arcDecl!.source).toBe("arc.json");
    expect(arcDecl!.name).toBe("web");

    const devDecl = portDecls.find((p) => p.port === devPort);
    expect(devDecl).toBeDefined();
    expect(devDecl!.source).toBe("devcontainer.json");

    // Probe those ports via provider -- both should be not listening
    const host = createHost({ name: "test-local-arcjson", provider: "local" });
    hostNames.push("test-local-arcjson");

    const provider = getProvider("local")!;
    const statuses = await provider.probePorts(host, portDecls);
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.listening).toBe(false);
    }
  });
});

// ── Test 4: Host -> provider resolution flow ─────────────────────────────────

describe("E2E: Host to provider resolution flow", () => {
  afterEach(() => {
    cleanupHosts();
  });

  it("resolves providers for hosts with different provider types", () => {
    // Create hosts with different providers
    const localHost = createHost({ name: "my-local", provider: "local" });
    hostNames.push("my-local");
    const ec2Host = createHost({ name: "my-ec2", provider: "ec2" });
    hostNames.push("my-ec2");

    expect(localHost.provider).toBe("local");
    expect(ec2Host.provider).toBe("ec2");

    // Verify getProvider("local") returns the local provider
    const localProvider = getProvider("local");
    expect(localProvider).not.toBeNull();
    expect(localProvider!.name).toBe("local");

    // Verify getProvider("ec2") returns the EC2 provider (now registered)
    const ec2Provider = getProvider("ec2");
    expect(ec2Provider).not.toBeNull();
    expect(ec2Provider!.name).toBe("ec2");

    // Verify listProviders() contains both
    const providerNames = listProviders();
    expect(providerNames).toContain("local");
    expect(providerNames).toContain("ec2");

    // Verify hosts can be listed
    const hosts = listHosts();
    const testHosts = hosts.filter((h) =>
      h.name === "my-local" || h.name === "my-ec2"
    );
    expect(testHosts.length).toBe(2);

    // Clean up
    deleteHost("my-local");
    deleteHost("my-ec2");
    hostNames.length = 0;

    expect(getHost("my-local")).toBeNull();
    expect(getHost("my-ec2")).toBeNull();
  });
});
