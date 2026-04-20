/**
 * Tests for PR merge polling (pr-merge-poller.ts).
 *
 * Mocks gh CLI via setGhExec to simulate `gh pr view` output.
 * Uses real store with test isolation for session/event verification.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { fetchPRState, pollPRMerges, checkSessionMerge, setGhExec } from "../integrations/pr-merge-poller.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

let ghOutput: string = "{}";
let ghShouldThrow = false;

function createMergeSession(
  opts: {
    pr_url?: string;
    status?: string;
    stage?: string;
    config?: Record<string, any>;
  } = {},
) {
  const session = getApp().sessions.create({
    summary: "test merge poller",
    flow: "autonomous-sdlc",
  });
  getApp().sessions.update(session.id, {
    pr_url: opts.pr_url ?? "https://github.com/org/repo/pull/42",
    status: opts.status ?? "waiting",
    stage: opts.stage ?? "merge",
    config: opts.config ?? { merge_queued_at: "2026-04-13T12:00:00Z" },
  });
  return getApp().sessions.get(session.id)!;
}

beforeEach(() => {
  ghOutput = JSON.stringify({ state: "OPEN" });
  ghShouldThrow = false;

  setGhExec(async (_args: string[]) => {
    if (ghShouldThrow) throw new Error("gh CLI error");
    return { stdout: ghOutput };
  });
});

// ── fetchPRState ──────────────────────────────────────────────────────────

describe("fetchPRState", () => {
  it("parses OPEN state", async () => {
    const mockExec = async () => ({
      stdout: JSON.stringify({ state: "OPEN" }),
    });
    const result = await fetchPRState("https://github.com/org/repo/pull/42", mockExec);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("OPEN");
  });

  it("parses MERGED state with mergedAt", async () => {
    const mockExec = async () => ({
      stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-04-13T14:00:00Z" }),
    });
    const result = await fetchPRState("https://github.com/org/repo/pull/42", mockExec);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("MERGED");
    expect(result!.mergedAt).toBe("2026-04-13T14:00:00Z");
  });

  it("parses CLOSED state", async () => {
    const mockExec = async () => ({
      stdout: JSON.stringify({ state: "CLOSED" }),
    });
    const result = await fetchPRState("https://github.com/org/repo/pull/42", mockExec);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("CLOSED");
  });

  it("returns null on gh CLI failure", async () => {
    const mockExec = async () => {
      throw new Error("not found");
    };
    const result = await fetchPRState("https://github.com/org/repo/pull/404", mockExec);
    expect(result).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const mockExec = async () => ({ stdout: "not json" });
    const result = await fetchPRState("https://github.com/org/repo/pull/1", mockExec);
    expect(result).toBeNull();
  });
});

// ── pollPRMerges ────────────────────────────────────────────────────────

describe("pollPRMerges", () => {
  it("skips sessions without pr_url", async () => {
    const session = getApp().sessions.create({ summary: "no pr" });
    getApp().sessions.update(session.id, {
      status: "waiting",
      stage: "merge",
      config: { merge_queued_at: "2026-04-13T12:00:00Z" },
    });
    // No pr_url set

    await pollPRMerges(getApp());

    const events = getApp().events.list(session.id);
    const mergeEvents = events.filter((e) => e.type.startsWith("pr_merge"));
    expect(mergeEvents).toHaveLength(0);
  });

  it("skips non-waiting sessions", async () => {
    const session = createMergeSession({ status: "running" });

    ghOutput = JSON.stringify({ state: "MERGED", mergedAt: "2026-04-13T14:00:00Z" });

    await pollPRMerges(getApp());

    // Should not have processed -- session not in waiting status
    const events = getApp().events.list(session.id);
    const mergeEvents = events.filter((e) => e.type === "pr_merged_confirmed");
    expect(mergeEvents).toHaveLength(0);
  });

  it("skips sessions without merge_queued_at", async () => {
    const session = createMergeSession({ config: {} }); // no merge_queued_at

    ghOutput = JSON.stringify({ state: "MERGED", mergedAt: "2026-04-13T14:00:00Z" });

    await pollPRMerges(getApp());

    const events = getApp().events.list(session.id);
    const mergeEvents = events.filter((e) => e.type === "pr_merged_confirmed");
    expect(mergeEvents).toHaveLength(0);
  });

  it("respects cooldown", async () => {
    const session = createMergeSession({
      config: {
        merge_queued_at: "2026-04-13T12:00:00Z",
        last_merge_check: new Date().toISOString(), // just checked
      },
    });

    ghOutput = JSON.stringify({ state: "MERGED", mergedAt: "2026-04-13T14:00:00Z" });

    await pollPRMerges(getApp());

    // Should have been skipped due to cooldown
    const events = getApp().events.list(session.id);
    const mergeEvents = events.filter((e) => e.type === "pr_merged_confirmed");
    expect(mergeEvents).toHaveLength(0);
  });

  it("processes eligible sessions", async () => {
    const session = createMergeSession();

    ghOutput = JSON.stringify({ state: "OPEN" });

    await pollPRMerges(getApp());

    // Should have updated last_merge_check
    const updated = getApp().sessions.get(session.id)!;
    const config = updated.config as Record<string, any>;
    expect(config.last_merge_check).toBeDefined();
  });
});

// ── checkSessionMerge ───────────────────────────────────────────────────

describe("checkSessionMerge", () => {
  it("advances session when PR is MERGED", async () => {
    const session = createMergeSession();

    ghOutput = JSON.stringify({ state: "MERGED", mergedAt: "2026-04-13T14:00:00Z" });

    await checkSessionMerge(getApp(), session);

    // Should have logged pr_merged_confirmed event
    const events = getApp().events.list(session.id);
    const confirmed = events.filter((e) => e.type === "pr_merged_confirmed");
    expect(confirmed).toHaveLength(1);

    const eventData = confirmed[0].data as Record<string, any>;
    expect(eventData.merged_at).toBe("2026-04-13T14:00:00Z");
  });

  it("fails session when PR is CLOSED", async () => {
    const session = createMergeSession();

    ghOutput = JSON.stringify({ state: "CLOSED" });

    await checkSessionMerge(getApp(), session);

    // Should have logged pr_merge_failed event
    const events = getApp().events.list(session.id);
    const failed = events.filter((e) => e.type === "pr_merge_failed");
    expect(failed).toHaveLength(1);

    // Session should be failed
    const updated = getApp().sessions.get(session.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toContain("closed without merging");
  });

  it("keeps polling when PR is OPEN", async () => {
    const session = createMergeSession();

    ghOutput = JSON.stringify({ state: "OPEN" });

    await checkSessionMerge(getApp(), session);

    // Session should still be waiting
    const updated = getApp().sessions.get(session.id)!;
    expect(updated.status).toBe("waiting");

    // last_merge_check should be updated
    const config = updated.config as Record<string, any>;
    expect(config.last_merge_check).toBeDefined();
  });

  it("handles gh CLI errors gracefully", async () => {
    const session = createMergeSession();
    ghShouldThrow = true;

    // Should not throw
    await checkSessionMerge(getApp(), session);

    // Session should still be waiting (no state change)
    const updated = getApp().sessions.get(session.id)!;
    expect(updated.status).toBe("waiting");

    // last_merge_check should be updated even on error (to respect cooldown)
    const config = updated.config as Record<string, any>;
    expect(config.last_merge_check).toBeDefined();
  });
});
