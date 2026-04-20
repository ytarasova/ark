/**
 * End-to-end integration tests for the Ark compute foundation.
 *
 * Exercises the full flow: compute CRUD, provider registry, session launch,
 * port probing, arc.json resolution, and metrics collection.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getProvider, listProviders, resolvePortDecls } from "../index.js";

import { AppContext } from "../../core/app.js";
import { getApp, setApp, clearApp } from "../../core/__tests__/test-helpers.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ── Shared fixtures ──────────────────────────────────────────────────────────

import type { Session } from "../types.js";

const fakeSession: Session = {
  id: "s-e2etest",
  ticket: null,
  summary: null,
  repo: null,
  branch: null,
  compute_name: "test-local",
  session_id: null,
  claude_session_id: null,
  stage: null,
  status: "ready",
  flow: "default",
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
const computeNames: string[] = [];
const tmuxSessions: string[] = [];

function cleanupComputes() {
  for (const name of computeNames) {
    try {
      getApp().computes.delete(name);
    } catch {
      /* already gone */
    }
  }
  computeNames.length = 0;
}

function cleanupTmux() {
  for (const name of tmuxSessions) {
    try {
      execFileSync("tmux", ["kill-session", "-t", name], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* session already dead */
    }
  }
  tmuxSessions.length = 0;
}

// ── Test 1: Full compute lifecycle ──────────────────────────────────────────────

describe("E2E: Full compute lifecycle", () => {
  afterEach(() => {
    cleanupComputes();
    cleanupTmux();
  });

  it("uses the auto-created local compute, provisions, updates, and collects metrics", async () => {
    // The "local" compute is auto-created by ensureLocalCompute() in getDb()
    const compute = getApp().computes.get("local");
    expect(compute).not.toBeNull();
    expect(compute!.name).toBe("local");
    expect(compute!.provider).toBe("local");
    expect(compute!.status).toBe("running"); // local computes are always running

    // Look up its provider
    const provider = getProvider("local");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("local");

    // Provision (no-op for local)
    await provider!.provision(compute!);

    // Collect metrics -- verify valid snapshot
    const snapshot = await provider!.getMetrics(compute!);
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

    // Destroy and stop throw for local computes
    expect(provider!.destroy(compute!)).rejects.toThrow("Cannot destroy the local compute");
    expect(provider!.stop(compute!)).rejects.toThrow("Cannot stop the local compute");
  }, 30_000);
});

// ── Test 2: Launch and probe a session ───────────────────────────────────────

describe("E2E: Launch and probe a session", () => {
  afterEach(() => {
    cleanupTmux();
    cleanupComputes();
  });

  it("launches a tmux session, probes ports with a live server", async () => {
    // Use the auto-created "local" compute
    const compute = getApp().computes.get("local")!;
    expect(compute).not.toBeNull();

    const provider = getProvider("local")!;
    expect(provider).not.toBeNull();

    // Launch tmux session
    const tmuxName = `ark-e2e-test-${Date.now()}`;
    tmuxSessions.push(tmuxName);

    await provider.launch(compute, fakeSession, {
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
      const probeUp = await provider.probePorts(compute, [{ port, source: "test" }]);
      expect(probeUp).toHaveLength(1);
      expect(probeUp[0].port).toBe(port);
      expect(probeUp[0].listening).toBe(true);

      // Stop the server
      server.stop(true);

      // Give OS a moment to release the port
      await new Promise((r) => setTimeout(r, 500));

      // Probe again -- should not be listening
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

// ── Test 3: arc.json -> port resolution -> probing ───────────────────────────

describe("E2E: arc.json port resolution and probing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ark-e2e-arcjson-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    cleanupComputes();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it("resolves ports from arc.json and devcontainer.json, probes them", async () => {
    // Use high ephemeral ports unlikely to be in use
    const arcPort = 59170;
    const devPort = 59171;

    // Create arc.json declaring a port
    writeFileSync(join(tempDir, "arc.json"), JSON.stringify({ ports: [{ port: arcPort, name: "web" }] }));

    // Create .devcontainer/devcontainer.json with forwardPorts
    const devcontainerDir = join(tempDir, ".devcontainer");
    mkdirSync(devcontainerDir, { recursive: true });
    writeFileSync(join(devcontainerDir, "devcontainer.json"), JSON.stringify({ forwardPorts: [devPort] }));

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
    const compute = getApp().computes.get("local")!;
    expect(compute).not.toBeNull();

    const provider = getProvider("local")!;
    const statuses = await provider.probePorts(compute, portDecls);
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.listening).toBe(false);
    }
  });
});

// ── Test 4: Compute -> provider resolution flow ─────────────────────────────────

describe("E2E: Compute to provider resolution flow", () => {
  afterEach(() => {
    cleanupComputes();
  });

  it("resolves providers for computes with different provider types", () => {
    // Use the auto-created "local" compute and create an ec2 compute
    const localCompute = getApp().computes.get("local")!;
    expect(localCompute).not.toBeNull();
    const ec2Compute = getApp().computes.create({ name: "my-ec2", provider: "ec2" });
    computeNames.push("my-ec2");

    expect(localCompute.provider).toBe("local");
    expect(ec2Compute.provider).toBe("ec2");

    // Verify getProvider("local") returns the local provider
    const localProvider = getProvider("local");
    expect(localProvider).not.toBeNull();
    expect(localProvider!.name).toBe("local");

    // Verify getProvider("docker") returns the Docker provider
    const dockerProvider = getProvider("docker");
    expect(dockerProvider).not.toBeNull();

    // Verify listProviders() contains core providers
    const providerNames = listProviders();
    expect(providerNames).toContain("local");
    expect(providerNames).toContain("docker");

    // Verify computes can be listed
    const computes = getApp().computes.list();
    const testComputes = computes.filter((h) => h.name === "local" || h.name === "my-ec2");
    expect(testComputes.length).toBe(2);

    // Clean up ec2 compute only (local is a singleton)
    getApp().computes.delete("my-ec2");
    computeNames.length = 0;

    expect(getApp().computes.get("my-ec2")).toBeNull();
  });
});
