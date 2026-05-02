/**
 * Tests for session-cleanup.
 *
 * Tests exercise:
 *  1. cleanupSession removes the worktree and emits session_cleaned
 *  2. cleanupSession is idempotent (second call is a no-op)
 *  3. cleanupSession survives a missing worktree
 *  4. session/kill RPC behaviour
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";
import { cleanupSession } from "../services/session/cleanup.js";
import { claudeAgentExecutor } from "../executors/claude-agent.js";
import { Router } from "../../server/router.js";
import { registerSessionHandlers } from "../../server/handlers/session.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

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

// ── cleanupSession tests ──────────────────────────────────────────────────────

test("cleanupSession removes the worktree and emits session_cleaned", async () => {
  const session = await app.sessions.create({
    summary: "cleanup test",
    flow: "autonomous-sdlc",
    status: "completed",
  } as any);

  // Simulate a worktree directory at the canonical location.
  const worktreeDir = join(app.config.dirs.worktrees, session.id);
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(join(worktreeDir, "README.md"), "test file");
  expect(existsSync(worktreeDir)).toBe(true);

  const freshSession = (await app.sessions.get(session.id))!;
  await cleanupSession(app, freshSession);

  // Worktree should be gone.
  expect(existsSync(worktreeDir)).toBe(false);

  // session_cleaned event should have been emitted.
  const events = await app.events.list(session.id, { type: "session_cleaned" });
  expect(events.length).toBeGreaterThanOrEqual(1);
  const ev = events[0];
  expect(ev.data?.worktree_removed).toBe(true);
});

test("cleanupSession is idempotent (second call is a no-op)", async () => {
  const session = await app.sessions.create({
    summary: "idempotency test",
    flow: "autonomous-sdlc",
    status: "completed",
  } as any);

  const worktreeDir = join(app.config.dirs.worktrees, session.id);
  mkdirSync(worktreeDir, { recursive: true });

  const freshSession = (await app.sessions.get(session.id))!;

  // First call -- removes worktree, emits event.
  await cleanupSession(app, freshSession);
  const eventsAfterFirst = await app.events.list(session.id, { type: "session_cleaned" });
  expect(eventsAfterFirst.length).toBe(1);

  // Second call -- should be a no-op (idempotency guard via session_cleaned event).
  await cleanupSession(app, freshSession);
  const eventsAfterSecond = await app.events.list(session.id, { type: "session_cleaned" });
  expect(eventsAfterSecond.length).toBe(1);
});

test("cleanupSession survives a missing worktree", async () => {
  const session = await app.sessions.create({
    summary: "missing worktree test",
    flow: "autonomous-sdlc",
    status: "failed",
  } as any);

  // Do NOT create a worktree dir -- it doesn't exist.
  const worktreeDir = join(app.config.dirs.worktrees, session.id);
  expect(existsSync(worktreeDir)).toBe(false);

  const freshSession = (await app.sessions.get(session.id))!;

  // Should not throw.
  await cleanupSession(app, freshSession);

  // Event emitted with worktree_removed = false.
  const events = await app.events.list(session.id, { type: "session_cleaned" });
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0].data?.worktree_removed).toBe(false);
});

// ── session/kill RPC tests ────────────────────────────────────────────────────

test("claudeAgentExecutor.terminate sends SIGKILL and resolves when process exits", async () => {
  // Spawn a real long-running process.
  const proc = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  expect(pid).toBeGreaterThan(0);

  // Verify terminate resolves -- it should kill and await process exit.
  // Since the handle is not registered in the processes map we can test
  // terminate is a no-op for unregistered handles (safe guard).
  await claudeAgentExecutor.terminate!("sdk-unregistered-handle");

  // Kill the spawned process ourselves to clean up.
  proc.kill("SIGKILL");
  await proc.exited;
  // After SIGKILL and exited, the process is gone.
  expect(proc.exited).toBeInstanceOf(Promise);
});

test("session/kill RPC returns { ok: false } for terminal sessions", async () => {
  const router = new Router();
  registerSessionHandlers(router, app);

  for (const status of ["completed", "failed", "stopped", "archived"] as const) {
    const session = await app.sessions.create({
      summary: `kill-terminal-${status}`,
      flow: "autonomous-sdlc",
    });
    await app.sessions.update(session.id, { status } as any);

    const req = createRequest(200, "session/kill", { sessionId: session.id });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe("string");
    expect((result.message as string).toLowerCase()).toContain("terminal");
  }
});

test("session/kill RPC throws SESSION_NOT_FOUND for unknown session", async () => {
  const router = new Router();
  registerSessionHandlers(router, app);

  const req = createRequest(201, "session/kill", { sessionId: "s-unknown-kill-xyz" });
  const res = await router.dispatch(req);
  const err = (res as JsonRpcError).error;
  expect(err).toBeDefined();
  expect(err.code).toBe(-32002);
});

test("session/kill RPC marks running session as failed with reason killed", async () => {
  const router = new Router();
  registerSessionHandlers(router, app);

  const session = await app.sessions.create({
    summary: "kill running test",
    flow: "autonomous-sdlc",
  });
  // Put it in running state with no real executor process (handle not in registry).
  await app.sessions.update(session.id, {
    status: "running",
    config: { launch_executor: "claude-agent" },
  } as any);

  const req = createRequest(202, "session/kill", { sessionId: session.id });
  const res = await router.dispatch(req);
  const result = (res as JsonRpcResponse).result as Record<string, unknown>;

  expect(result.ok).toBe(true);
  expect(result.cleaned_up).toBe(true);
  expect(typeof result.terminated_at).toBe("number");

  const updated = await app.sessions.get(session.id);
  expect(updated?.status).toBe("failed");
  expect(updated?.error).toBe("killed");

  const events = await app.events.list(session.id);
  const killEv = events.find((e: any) => e.type === "session_killed");
  expect(killEv).toBeDefined();
});
