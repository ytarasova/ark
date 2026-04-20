/**
 * AgentRegistry + TmuxAgentHandle unit tests.
 *
 * The goals here:
 *   1. Registry register/deregister/get/size/stopAll semantics hold.
 *   2. TmuxAgentHandle detects sentinel writes + pane death.
 *   3. onExit fires exactly once, even when stop() and sentinel race.
 *   4. After stop(), the handle stays terminal -- no late ticks resurrect it.
 *
 * These tests use real tmux sessions (sync, fast to create/kill). They do
 * NOT use AppContext -- the registry is deliberately zero-dependency so
 * this file doesn't need a booted AppContext to run.
 */

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

import { AgentRegistry } from "../services/agent-registry.js";
import { TmuxAgentHandle } from "../services/tmux-agent-handle.js";
import * as tmux from "../infra/tmux.js";

const testTmuxSessions: string[] = [];
const testDirs: string[] = [];

function uniq(): string {
  return `ark-s-reg${Math.random().toString(36).slice(2, 10)}`;
}

function mkTestDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ark-agent-registry-"));
  testDirs.push(d);
  return d;
}

afterEach(() => {
  for (const s of testTmuxSessions.splice(0)) {
    try {
      tmux.killSession(s);
    } catch {
      /* best effort */
    }
  }
  for (const d of testDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

beforeAll(() => {
  if (!tmux.hasTmux()) {
    throw new Error("tmux not available -- required for agent-registry tests");
  }
});

// ── AgentRegistry ─────────────────────────────────────────────────────────────

describe("AgentRegistry", () => {
  it("is empty on construction", () => {
    const reg = new AgentRegistry();
    expect(reg.size()).toBe(0);
    expect(reg.sessionIds()).toEqual([]);
    expect(reg.get("anything")).toBeNull();
  });

  it("register() + get() + size() round-trip", async () => {
    const reg = new AgentRegistry();
    const name = uniq();
    testTmuxSessions.push(name);
    const sessionDir = mkTestDir();
    await tmux.createSessionAsync(name, "sleep 30", { arkDir: sessionDir });
    const handle = new TmuxAgentHandle({
      sessionId: "s-test1",
      tmuxName: name,
      workdir: "/tmp",
      sessionDir,
      autoStart: false,
    });
    reg.register(handle);
    expect(reg.size()).toBe(1);
    expect(reg.get("s-test1")).toBe(handle);
    expect(reg.sessionIds()).toEqual(["s-test1"]);

    await handle.stop();
    // After stop -> onExit fires -> registry drops it. Give microtask a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.size()).toBe(0);
  });

  it("stopAll() stops every live handle and clears the registry", async () => {
    const reg = new AgentRegistry();
    const names = [uniq(), uniq(), uniq()];
    for (const n of names) testTmuxSessions.push(n);
    const sessionDir = mkTestDir();

    for (let i = 0; i < names.length; i++) {
      await tmux.createSessionAsync(names[i], "sleep 30", { arkDir: sessionDir });
      const h = new TmuxAgentHandle({
        sessionId: `s-s${i}`,
        tmuxName: names[i],
        workdir: "/tmp",
        sessionDir,
        autoStart: false,
      });
      reg.register(h);
    }
    expect(reg.size()).toBe(3);

    await reg.stopAll();
    expect(reg.size()).toBe(0);
    for (const n of names) {
      expect(tmux.sessionExists(n)).toBe(false);
    }
  });

  it("replacing a handle for the same session id stops the previous one", async () => {
    const reg = new AgentRegistry();
    const nameA = uniq();
    const nameB = uniq();
    testTmuxSessions.push(nameA, nameB);
    const sessionDir = mkTestDir();
    await tmux.createSessionAsync(nameA, "sleep 30", { arkDir: sessionDir });
    await tmux.createSessionAsync(nameB, "sleep 30", { arkDir: sessionDir });

    const handleA = new TmuxAgentHandle({
      sessionId: "s-dup",
      tmuxName: nameA,
      workdir: "/tmp",
      sessionDir,
      autoStart: false,
    });
    const handleB = new TmuxAgentHandle({
      sessionId: "s-dup",
      tmuxName: nameB,
      workdir: "/tmp",
      sessionDir,
      autoStart: false,
    });

    reg.register(handleA);
    reg.register(handleB);
    // Give the async stop from register() time to tear A down.
    await new Promise((r) => setTimeout(r, 100));

    expect(reg.get("s-dup")).toBe(handleB);
    expect(tmux.sessionExists(nameA)).toBe(false);
    expect(tmux.sessionExists(nameB)).toBe(true);

    await handleB.stop();
  });
});

// ── TmuxAgentHandle: exit paths ───────────────────────────────────────────────

describe("TmuxAgentHandle", () => {
  it("fires waitForExit with `sentinel` when exit-code file appears", async () => {
    const name = uniq();
    testTmuxSessions.push(name);
    const sessionDir = mkTestDir();
    mkdirSync(sessionDir, { recursive: true });
    await tmux.createSessionAsync(name, "sleep 30", { arkDir: sessionDir });

    const handle = new TmuxAgentHandle({
      sessionId: "s-sentinel",
      tmuxName: name,
      workdir: "/tmp",
      sessionDir,
      pollIntervalMs: 50,
    });

    // Write sentinel after a short delay.
    setTimeout(() => {
      writeFileSync(join(sessionDir, "exit-code"), "7\n");
    }, 100);

    const info = await handle.waitForExit();
    expect(info.via).toBe("sentinel");
    expect(info.code).toBe(7);
    // The handle should also have killed the tmux session (idempotent).
    expect(tmux.sessionExists(name)).toBe(false);
  });

  it("fires waitForExit with `pane-death` when tmux session disappears", async () => {
    const name = uniq();
    testTmuxSessions.push(name);
    const sessionDir = mkTestDir();
    // Short-lived tmux: sleeps briefly, then exits.
    await tmux.createSessionAsync(name, "sleep 0.1", { arkDir: sessionDir });

    const handle = new TmuxAgentHandle({
      sessionId: "s-panedeath",
      tmuxName: name,
      workdir: "/tmp",
      sessionDir,
      pollIntervalMs: 50,
    });

    const info = await handle.waitForExit();
    expect(info.via).toBe("pane-death");
    expect(info.code).toBe(0);
  });

  it("fires waitForExit with `signal` when stop() is called", async () => {
    const name = uniq();
    testTmuxSessions.push(name);
    const sessionDir = mkTestDir();
    await tmux.createSessionAsync(name, "sleep 30", { arkDir: sessionDir });

    const handle = new TmuxAgentHandle({
      sessionId: "s-signal",
      tmuxName: name,
      workdir: "/tmp",
      sessionDir,
      pollIntervalMs: 50,
    });

    setTimeout(() => {
      handle.stop();
    }, 50);

    const info = await handle.waitForExit();
    expect(info.via).toBe("signal");
    expect(tmux.sessionExists(name)).toBe(false);
  });

  it("onExit fires exactly once even when called after exit", async () => {
    const name = uniq();
    testTmuxSessions.push(name);
    const sessionDir = mkTestDir();
    await tmux.createSessionAsync(name, "sleep 0.1", { arkDir: sessionDir });

    const handle = new TmuxAgentHandle({
      sessionId: "s-late",
      tmuxName: name,
      workdir: "/tmp",
      sessionDir,
      pollIntervalMs: 50,
    });

    let count = 0;
    handle.onExit(() => count++);
    await handle.waitForExit();
    // Subscriber added AFTER exit must still fire, exactly once.
    handle.onExit(() => count++);
    // Give the sync callback path a moment.
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(2);
  });

  it("stop() is idempotent", async () => {
    const name = uniq();
    testTmuxSessions.push(name);
    const sessionDir = mkTestDir();
    await tmux.createSessionAsync(name, "sleep 30", { arkDir: sessionDir });

    const handle = new TmuxAgentHandle({
      sessionId: "s-idem",
      tmuxName: name,
      workdir: "/tmp",
      sessionDir,
      pollIntervalMs: 50,
    });

    await handle.stop();
    await handle.stop();
    await handle.stop();
    expect(tmux.sessionExists(name)).toBe(false);
  });
});

// ── Anti-regression: shutdown reaps every handle, zero orphans. ───────────────

describe("anti-regression: shutdown reaps handles", () => {
  it("20 parallel handles + stopAll -> 0 live ark-s- tmux sessions", async () => {
    const reg = new AgentRegistry();
    const sessionDir = mkTestDir();
    const names: string[] = [];

    for (let i = 0; i < 20; i++) {
      const n = uniq();
      names.push(n);
      testTmuxSessions.push(n);
      await tmux.createSessionAsync(n, "sleep 60", { arkDir: sessionDir });
      reg.register(
        new TmuxAgentHandle({
          sessionId: `s-stress${i}`,
          tmuxName: n,
          workdir: "/tmp",
          sessionDir,
          autoStart: false,
        }),
      );
    }

    expect(reg.size()).toBe(20);

    await reg.stopAll();

    // Not a single tmux session we launched should be alive.
    for (const n of names) {
      expect(tmux.sessionExists(n)).toBe(false);
    }
    expect(reg.size()).toBe(0);

    // And if someone scans the tmux server for our prefix, none appear.
    const liveForThisTest = names.filter((n) => tmux.sessionExists(n));
    expect(liveForThisTest).toEqual([]);
  });
});
