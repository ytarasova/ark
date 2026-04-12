/**
 * Tests for the initial-prompt delivery helper used in autonomous --dispatch.
 *
 * We don't want to spin up a real tmux/Claude here -- the interesting logic
 * is the idempotency guard and the "send the message via sendReliable" wiring.
 * We spy on tmux.capturePaneAsync (to return the "working" marker immediately)
 * and tmux.sendTextAsync / sendKeysAsync (to capture what was sent).
 *
 * Uses spyOn instead of mock.module to avoid poisoning the tmux module for
 * other test files in the same bun test run (see auto-accept-channel-prompt
 * for the same pattern).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  buildAutonomousPrompt,
  deliverInitialPrompt,
  __resetDeliveryState,
} from "../services/deliver-task.js";
import * as tmux from "../infra/tmux.js";
import type { Session } from "../../types/index.js";

// ── tmux spies (installed in beforeAll / restored in afterAll) ────────────
//
// Using beforeAll rather than top-level spyOn so other test files that
// depend on real tmux.sendTextAsync are not poisoned by this file at
// import time. The spies are active only while this file's tests run.
//
// We filter sent messages by an expected-target allowlist per test to
// exclude stray fire-and-forget delivery attempts from async tasks that
// other test files may have started (e.g. dispatch-fan-out leaves
// claude-code launch side-effects polling tmux in the background).

const allSentMessages: { target: string; text: string }[] = [];
let expectedTarget: string | null = null;
function sentMessagesForTest(): { target: string; text: string }[] {
  if (!expectedTarget) return allSentMessages.slice();
  return allSentMessages.filter(m => m.target === expectedTarget);
}

let captureSpy: ReturnType<typeof spyOn> | null = null;
let sendTextSpy: ReturnType<typeof spyOn> | null = null;
let sendKeysSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
  captureSpy = spyOn(tmux, "capturePaneAsync").mockImplementation(
    async (_name: string, _opts?: any): Promise<string> => {
      return "Some Claude output\nesc to interrupt - ctrl+o to expand";
    }
  );
  sendTextSpy = spyOn(tmux, "sendTextAsync").mockImplementation(
    async (name: string, text: string): Promise<void> => {
      allSentMessages.push({ target: name, text });
    }
  );
  sendKeysSpy = spyOn(tmux, "sendKeysAsync").mockImplementation(
    async (_name: string, ..._keys: string[]): Promise<void> => {
      // no-op
    }
  );
});

afterAll(() => {
  captureSpy?.mockRestore();
  sendTextSpy?.mockRestore();
  sendKeysSpy?.mockRestore();
});

// ── App fixture ────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  __resetDeliveryState();
  allSentMessages.length = 0;
  expectedTarget = null;
});

afterEach(async () => {
  expectedTarget = null;
  await app?.shutdown();
  clearApp();
});

// ── buildAutonomousPrompt ──────────────────────────────────────────────────

describe("buildAutonomousPrompt", () => {
  it("embeds the task summary in the prompt", () => {
    const session = {
      id: "s-test01",
      summary: "fix the desktop .dmg release pipeline",
      workdir: "/tmp/ark-wt",
      repo: "/tmp/ark",
      branch: "main",
      ticket: null,
    } as unknown as Session;

    const prompt = buildAutonomousPrompt(session);
    expect(prompt).toContain("fix the desktop .dmg release pipeline");
    expect(prompt).toContain("Workdir: /tmp/ark-wt");
    expect(prompt).toContain("Begin working on the following task immediately");
    expect(prompt).toContain("report");
  });

  it("falls back to ticket when summary is missing", () => {
    const session = {
      id: "s-test02",
      summary: null,
      ticket: "PROJ-123",
      workdir: "/tmp/wt",
      repo: "/tmp/repo",
    } as unknown as Session;
    const prompt = buildAutonomousPrompt(session);
    expect(prompt).toContain("PROJ-123");
  });

  it("handles missing workdir gracefully", () => {
    const session = {
      id: "s-test03",
      summary: "do the thing",
      workdir: null,
      repo: null,
    } as unknown as Session;
    const prompt = buildAutonomousPrompt(session);
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("Workdir: (unknown)");
  });
});

// ── deliverInitialPrompt ───────────────────────────────────────────────────

describe("deliverInitialPrompt", () => {
  it("sends the prompt to the session tmux handle", async () => {
    const dbSession = app.sessions.create({ summary: "fix the .dmg pipeline", repo: "/tmp/fake" });
    const tmuxName = `ark-${dbSession.id}`;
    expectedTarget = tmuxName;
    const session = { ...dbSession, session_id: tmuxName } as Session;

    const result = await deliverInitialPrompt(app, session, "Begin work. Task: fix the .dmg pipeline");

    expect(result.ok).toBe(true);
    const sent = sentMessagesForTest();
    expect(sent.length).toBe(1);
    expect(sent[0].target).toBe(tmuxName);
    expect(sent[0].text).toContain("Task: fix the .dmg pipeline");
  });

  it("embeds the summary via buildAutonomousPrompt integration", async () => {
    const dbSession = app.sessions.create({ summary: "add a regression test", repo: "/tmp/fake" });
    const tmuxName = `ark-${dbSession.id}`;
    expectedTarget = tmuxName;
    const session = { ...dbSession, session_id: tmuxName } as Session;

    const prompt = buildAutonomousPrompt(session);
    const result = await deliverInitialPrompt(app, session, prompt);

    expect(result.ok).toBe(true);
    const sent = sentMessagesForTest();
    expect(sent[0].text).toContain("add a regression test");
    expect(sent[0].text).toContain("Begin working on the following task immediately");
  });

  it("is idempotent -- a second call does not re-send", async () => {
    const dbSession = app.sessions.create({ summary: "task A", repo: "/tmp/fake" });
    const tmuxName = `ark-${dbSession.id}`;
    expectedTarget = tmuxName;
    const session = { ...dbSession, session_id: tmuxName } as Session;

    const first = await deliverInitialPrompt(app, session, "first message");
    expect(first.ok).toBe(true);
    expect(sentMessagesForTest().length).toBe(1);

    const second = await deliverInitialPrompt(app, session, "second message (should not be sent)");
    expect(second.ok).toBe(true);
    expect(second.message).toContain("already");
    const sent = sentMessagesForTest();
    expect(sent.length).toBe(1); // still one -- not re-sent
    expect(sent[0].text).toBe("first message");
  });

  it("returns error when the session has no tmux handle", async () => {
    const dbSession = app.sessions.create({ summary: "no handle test", repo: "/tmp/fake" });
    // No tmux handle means no target -- nothing should be sent for this session.
    expectedTarget = `ark-${dbSession.id}`;
    const result = await deliverInitialPrompt(app, dbSession as Session, "test");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no tmux handle");
    expect(sentMessagesForTest().length).toBe(0);
  });

  it("logs an event on successful delivery", async () => {
    const dbSession = app.sessions.create({ summary: "event log test", repo: "/tmp/fake" });
    const tmuxName = `ark-${dbSession.id}`;
    expectedTarget = tmuxName;
    const session = { ...dbSession, session_id: tmuxName } as Session;

    await deliverInitialPrompt(app, session, "event log message");
    const events = app.events.list(dbSession.id);
    const delivered = events.find(e => e.type === "initial_prompt_delivered");
    expect(delivered).toBeDefined();
    expect(delivered?.data?.length).toBeGreaterThan(0);
  });
});
