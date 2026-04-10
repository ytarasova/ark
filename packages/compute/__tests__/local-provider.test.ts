import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { LocalProvider } from "../providers/local/index.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import type { Compute, Session } from "../../types/index.js";

let app: AppContext;
const provider = new LocalProvider();
beforeEach(async () => { if (app) { await app.shutdown(); clearApp(); } app = AppContext.forTest(); setApp(app); await app.boot(); provider.setApp(app); });
afterEach(async () => { if (app) { await app.shutdown(); clearApp(); } });

const fakeCompute: Compute = {
  name: "local",
  provider: "local",
  status: "running",
  config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const fakeSession: Session = {
  id: "test-session-id",
  ticket: null,
  summary: null,
  repo: null,
  branch: null,
  compute_name: null,
  session_id: null,
  claude_session_id: null,
  stage: null,
  status: "running",
  flow: "test",
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

describe("LocalProvider", () => {
  it("has name 'local'", () => {
    expect(provider.name).toBe("local");
  });

  it("provision is a no-op", async () => {
    await provider.provision(fakeCompute);
  });

  it("destroy throws", async () => {
    expect(provider.destroy(fakeCompute)).rejects.toThrow("Cannot destroy the local compute");
  });

  it("start is a no-op", async () => {
    await provider.start(fakeCompute);
  });

  it("stop throws", async () => {
    expect(provider.stop(fakeCompute)).rejects.toThrow("Cannot stop the local compute");
  });

  it("attach is a no-op", async () => {
    await provider.attach(fakeCompute, fakeSession);
    // Should resolve without throwing
  });

  it("getMetrics returns a valid snapshot", async () => {
    const snap = await provider.getMetrics(fakeCompute);
    expect(snap.metrics.cpu).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
    expect(Array.isArray(snap.sessions)).toBe(true);
  }, 30_000);

  it("probePorts returns status for each port", async () => {
    const result = await provider.probePorts(fakeCompute, [
      { port: 99999, source: "test" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(99999);
    expect(result[0].listening).toBe(false);
  });

  it("probePorts detects a listening port", async () => {
    const server = Bun.serve({
      port: 0, // random available port
      fetch() {
        return new Response("ok");
      },
    });
    try {
      const port = server.port;
      const result = await provider.probePorts(fakeCompute, [
        { port, source: "test" },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].port).toBe(port);
      expect(result[0].listening).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("probePorts handles multiple ports", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    try {
      const listeningPort = server.port;
      const closedPort1 = 19111;
      const closedPort2 = 19222;
      const result = await provider.probePorts(fakeCompute, [
        { port: listeningPort, source: "server" },
        { port: closedPort1, source: "closed1" },
        { port: closedPort2, source: "closed2" },
      ]);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ port: listeningPort, source: "server", listening: true });
      expect(result[1]).toEqual({ port: closedPort1, source: "closed1", listening: false });
      expect(result[2]).toEqual({ port: closedPort2, source: "closed2", listening: false });
    } finally {
      server.stop(true);
    }
  });

  it("launch creates a tmux session", async () => {
    const tmuxName = `ark-test-${Date.now()}`;
    try {
      const returnedName = await provider.launch(fakeCompute, fakeSession, {
        tmuxName,
        workdir: "/tmp",
        launcherContent: "#!/bin/bash\necho hello && sleep 10",
        ports: [],
      });
      expect(returnedName).toBe(tmuxName);
      // Wait for tmux session to be registered
      await new Promise(r => setTimeout(r, 500));
      execFileSync("tmux", ["has-session", "-t", tmuxName], { stdio: "pipe" });
    } finally {
      try { execFileSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "pipe" }); } catch { /* cleanup */ }
    }
  }, 10_000);

  it("syncEnvironment is a no-op", async () => {
    await provider.syncEnvironment(fakeCompute, { direction: "push" });
  });
});
