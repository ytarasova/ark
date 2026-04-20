/**
 * Anti-regression stress test for the agent lifecycle.
 *
 * The original bug: 142 orphaned tmux sessions accumulated across a single
 * `make test` run because `buildLauncher` ended with `exec bash`, so tmux
 * panes outlived the claude process and production code had no path to
 * reap them.
 *
 * This test is the canary. It:
 *   1. Boots an AppContext
 *   2. Launches N short-lived tmux-backed agent handles (via the same
 *      TmuxAgentHandle the executors use) and registers them.
 *   3. Calls `app.shutdown()` -- which drains pending dispatches, stops all
 *      sessions, and finally drains the AgentRegistry.
 *   4. Asserts that NOT ONE of the ark-s-* tmux sessions we created is
 *      still alive afterwards.
 *
 * Run under `--concurrency 4` like the rest of the suite. If this test
 * ever starts leaving orphans again, the lifecycle contract is broken.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AppContext } from "../app.js";
import { TmuxAgentHandle } from "../services/tmux-agent-handle.js";
import * as tmux from "../infra/tmux.js";

const N_SESSIONS = 20;

let app: AppContext;
const createdTmuxNames: string[] = [];
const createdDirs: string[] = [];

beforeAll(async () => {
  if (!tmux.hasTmux()) throw new Error("tmux required");
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  // Safety net outside the assertion under test.
  for (const n of createdTmuxNames) {
    try {
      tmux.killSession(n);
    } catch {
      /* best effort */
    }
  }
  for (const d of createdDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (app) await app.shutdown();
});

describe("agent lifecycle anti-regression: zero orphans", () => {
  it(`launches ${N_SESSIONS} tmux-backed handles + shutdown -> 0 live ark-s- tmux sessions`, async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "ark-stress-"));
    createdDirs.push(sessionDir);

    const names: string[] = [];
    for (let i = 0; i < N_SESSIONS; i++) {
      const name = `ark-s-stress${process.pid}${i}${Math.random().toString(36).slice(2, 6)}`;
      names.push(name);
      createdTmuxNames.push(name);
      // Long-running command so the session won't self-exit during the test.
      await tmux.createSessionAsync(name, "sleep 60", { arkDir: sessionDir });
      const handle = new TmuxAgentHandle({
        sessionId: `s-stress${i}`,
        tmuxName: name,
        workdir: "/tmp",
        sessionDir,
        // Keep polling fast so shutdown drains without extra delay.
        pollIntervalMs: 50,
        autoStart: false,
      });
      app.agentRegistry.register(handle);
    }

    expect(app.agentRegistry.size()).toBe(N_SESSIONS);
    for (const n of names) expect(tmux.sessionExists(n)).toBe(true);

    // The production teardown path: shutdown drains the registry.
    await app.shutdown();

    // Every tmux session we created must be gone.
    const stillAlive = names.filter((n) => tmux.sessionExists(n));
    expect(stillAlive).toEqual([]);

    // Reboot the AppContext so afterAll.shutdown() doesn't crash.
    app = await AppContext.forTestAsync();
    await app.boot();
  });
});
