/**
 * Tests for TmuxLauncher and the SessionLauncher abstraction.
 *
 * Tests the interface contract, AppContext integration, and that orchestration
 * functions delegate to app.launcher correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import { TmuxLauncher } from "../../launchers/tmux.js";
import { ContainerLauncher } from "../../launchers/container.js";
import { ArkdLauncher } from "../../launchers/arkd.js";
import type { SessionLauncher } from "../../session-launcher.js";

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ── TmuxLauncher interface compliance ──────────────────────────────────────

describe("TmuxLauncher", () => {
  it("implements SessionLauncher interface", () => {
    const launcher = new TmuxLauncher();

    expect(typeof launcher.launch).toBe("function");
    expect(typeof launcher.kill).toBe("function");
    expect(typeof launcher.status).toBe("function");
    expect(typeof launcher.send).toBe("function");
    expect(typeof launcher.sendKeys).toBe("function");
    expect(typeof launcher.capture).toBe("function");
  });

  it("is the default launcher on AppContext", () => {
    expect(app.launcher).toBeInstanceOf(TmuxLauncher);
  });

  it("status returns 'stopped' for non-existent tmux session", async () => {
    const launcher = new TmuxLauncher();
    // This handle does not exist in tmux
    const result = await launcher.status("ark-s-definitely-not-running-12345");
    expect(result).toBe("stopped");
  });

  it("capture returns empty string for non-existent session", async () => {
    const launcher = new TmuxLauncher();
    const result = await launcher.capture("ark-s-definitely-not-running-12345");
    expect(result).toBe("");
  });
});

// ── ContainerLauncher interface compliance ─────────────────────────────────

describe("ContainerLauncher", () => {
  it("implements SessionLauncher interface", () => {
    const launcher = new ContainerLauncher("http://localhost:19300");

    expect(typeof launcher.launch).toBe("function");
    expect(typeof launcher.kill).toBe("function");
    expect(typeof launcher.status).toBe("function");
    expect(typeof launcher.send).toBe("function");
    expect(typeof launcher.sendKeys).toBe("function");
    expect(typeof launcher.capture).toBe("function");
  });

  it("status returns 'unknown' when arkd is unreachable", async () => {
    // Port 19399 -- nothing listening
    const launcher = new ContainerLauncher("http://localhost:19399");
    const result = await launcher.status("ark-s-test");
    expect(result).toBe("unknown");
  });
});

// ── ArkdLauncher interface compliance ──────────────────────────────────────

describe("ArkdLauncher", () => {
  it("implements SessionLauncher interface", () => {
    const launcher = new ArkdLauncher("http://localhost:19300");

    expect(typeof launcher.launch).toBe("function");
    expect(typeof launcher.kill).toBe("function");
    expect(typeof launcher.status).toBe("function");
    expect(typeof launcher.send).toBe("function");
    expect(typeof launcher.sendKeys).toBe("function");
    expect(typeof launcher.capture).toBe("function");
  });

  it("accepts ArkdClient instance in constructor", () => {
    const { ArkdClient } = require("../../../arkd/client.js");
    const client = new ArkdClient("http://localhost:19300");
    const launcher = new ArkdLauncher(client);

    expect(typeof launcher.launch).toBe("function");
  });

  it("status returns 'unknown' when arkd is unreachable", async () => {
    const launcher = new ArkdLauncher("http://localhost:19399");
    const result = await launcher.status("ark-s-test");
    expect(result).toBe("unknown");
  });
});

// ── AppContext launcher swap ───────────────────────────────────────────────

describe("AppContext launcher", () => {
  it("can be replaced via setLauncher", () => {
    const mockLauncher: SessionLauncher = {
      launch: async () => ({ handle: "mock-handle" }),
      kill: async () => {},
      status: async () => "running",
      send: async () => {},
      sendKeys: async () => {},
      capture: async () => "mock output",
    };

    const original = app.launcher;
    app.setLauncher(mockLauncher);
    expect(app.launcher).toBe(mockLauncher);

    // Restore
    app.setLauncher(original);
    expect(app.launcher).toBeInstanceOf(TmuxLauncher);
  });
});

// ── Orchestration integration ──────────────────────────────────────────────

describe("orchestration uses app.launcher", () => {
  it("interrupt sends keys via app.launcher", async () => {
    let sendKeysCalled = false;
    let receivedKeys: string[] = [];
    const mockLauncher: SessionLauncher = {
      launch: async () => ({ handle: "mock" }),
      kill: async () => {},
      status: async () => "running",
      send: async () => {},
      sendKeys: async (_handle, ...keys) => {
        sendKeysCalled = true;
        receivedKeys = keys;
      },
      capture: async () => "",
    };

    app.setLauncher(mockLauncher);

    try {
      const session = app.sessions.create({ summary: "interrupt-test" });
      app.sessions.update(session.id, { status: "running", session_id: "ark-int-test" });

      const { interrupt } = await import("../../services/session-orchestration.js");
      const result = await interrupt(app, session.id);

      expect(result.ok).toBe(true);
      expect(sendKeysCalled).toBe(true);
      expect(receivedKeys).toEqual(["C-c"]);
    } finally {
      app.setLauncher(new TmuxLauncher());
    }
  });

  it("archive kills via app.launcher when session has session_id", async () => {
    let killCalled = false;
    let killedHandle: string | null = null;
    const mockLauncher: SessionLauncher = {
      launch: async () => ({ handle: "mock" }),
      kill: async (handle) => { killCalled = true; killedHandle = handle; },
      status: async () => "running",
      send: async () => {},
      sendKeys: async () => {},
      capture: async () => "",
    };

    app.setLauncher(mockLauncher);

    try {
      const session = app.sessions.create({ summary: "archive-kill-test" });
      app.sessions.update(session.id, { status: "running", session_id: "ark-archive-kill" });

      const { archive } = await import("../../services/session-orchestration.js");
      const result = await archive(app, session.id);

      expect(result.ok).toBe(true);
      expect(killCalled).toBe(true);
      expect(killedHandle).toBe("ark-archive-kill");
    } finally {
      app.setLauncher(new TmuxLauncher());
    }
  });

  it("delete kills via app.launcher when provider is unavailable", async () => {
    let killCalled = false;
    let killedHandle: string | null = null;
    const mockLauncher: SessionLauncher = {
      launch: async () => ({ handle: "mock" }),
      kill: async (handle) => { killCalled = true; killedHandle = handle; },
      status: async () => "running",
      send: async () => {},
      sendKeys: async () => {},
      capture: async () => "",
    };

    app.setLauncher(mockLauncher);

    try {
      const session = app.sessions.create({ summary: "delete-kill-test", compute_name: "nonexistent-compute-xyz" });
      // Set session_id with unknown compute -- so withProvider returns false
      app.sessions.update(session.id, { status: "running", session_id: "ark-delete-kill" });

      const { deleteSessionAsync } = await import("../../services/session-orchestration.js");
      const result = await deleteSessionAsync(app, session.id);

      expect(result.ok).toBe(true);
      expect(killCalled).toBe(true);
      expect(killedHandle).toBe("ark-delete-kill");
    } finally {
      app.setLauncher(new TmuxLauncher());
    }
  });

  it("stop kills via app.launcher when provider is unavailable", async () => {
    let killCalled = false;
    let killedHandle: string | null = null;
    const mockLauncher: SessionLauncher = {
      launch: async () => ({ handle: "mock" }),
      kill: async (handle) => { killCalled = true; killedHandle = handle; },
      status: async () => "running",
      send: async () => {},
      sendKeys: async () => {},
      capture: async () => "",
    };

    app.setLauncher(mockLauncher);

    try {
      const session = app.sessions.create({ summary: "stop-kill-test", compute_name: "nonexistent-compute-xyz" });
      // Set session_id with unknown compute -- so withProvider returns false
      app.sessions.update(session.id, { status: "running", session_id: "ark-stop-kill" });

      const { stop } = await import("../../services/session-orchestration.js");
      const result = await stop(app, session.id);

      expect(result.ok).toBe(true);
      expect(killCalled).toBe(true);
      expect(killedHandle).toBe("ark-stop-kill");
    } finally {
      app.setLauncher(new TmuxLauncher());
    }
  });

  it("resume kills via app.launcher before re-dispatching", async () => {
    let killCalled = false;
    const mockLauncher: SessionLauncher = {
      launch: async () => ({ handle: "mock" }),
      kill: async () => { killCalled = true; },
      status: async () => "running",
      send: async () => {},
      sendKeys: async () => {},
      capture: async () => "",
    };

    app.setLauncher(mockLauncher);

    try {
      const session = app.sessions.create({ summary: "resume-kill-test" });
      app.sessions.update(session.id, {
        status: "stopped",
        session_id: "ark-resume-old",
        stage: "work",
      });

      const { resume } = await import("../../services/session-orchestration.js");
      // Resume will try to kill the old session, then re-dispatch
      // Re-dispatch may fail (no agent configured), but kill should happen first
      await resume(app, session.id);

      expect(killCalled).toBe(true);
    } finally {
      app.setLauncher(new TmuxLauncher());
    }
  });
});
