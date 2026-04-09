/**
 * Tests for GitHub Issues polling (issue-poller.ts).
 *
 * Mocks gh CLI via setGhExec. Uses real store with test isolation.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import { getApp } from "../app.js";
import {
  fetchLabeledIssues,
  issueAlreadyTracked,
  createSessionFromIssue,
  pollIssues,
  startIssuePoller,
  setGhExec,
  type GhIssue,
} from "../issue-poller.js";
import { withTestContext } from "./test-helpers.js";

// ── Test setup ───────────────────────────────────────────────────────────────

withTestContext();

function makeIssue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 42,
    title: "Fix the widget",
    body: "The widget is broken.\n\nSteps to reproduce...",
    url: "https://github.com/org/repo/issues/42",
    labels: [{ name: "ark" }],
    ...overrides,
  };
}

function makeGhOutput(issues: GhIssue[]): string {
  return JSON.stringify(issues);
}

let ghOutput: string;
let ghShouldThrow: boolean;

beforeEach(() => {
  ghOutput = makeGhOutput([]);
  ghShouldThrow = false;

  setGhExec(async (_args: string[]) => {
    if (ghShouldThrow) throw new Error("gh CLI error");
    return { stdout: ghOutput };
  });
});

// ── fetchLabeledIssues ──────────────────────────────────────────────────────

describe("fetchLabeledIssues", () => {
  it("parses issue list from gh output", async () => {
    const issues = [makeIssue(), makeIssue({ number: 43, title: "Another bug" })];
    ghOutput = makeGhOutput(issues);

    const result = await fetchLabeledIssues("ark");
    expect(result).toHaveLength(2);
    expect(result![0].number).toBe(42);
    expect(result![0].title).toBe("Fix the widget");
    expect(result![0].body).toContain("widget is broken");
    expect(result![0].url).toBe("https://github.com/org/repo/issues/42");
    expect(result![1].number).toBe(43);
  });

  it("returns null on gh CLI error", async () => {
    ghShouldThrow = true;
    const result = await fetchLabeledIssues("ark");
    expect(result).toBeNull();
  });

  it("returns empty array for no issues", async () => {
    ghOutput = "[]";
    const result = await fetchLabeledIssues("ark");
    expect(result).toEqual([]);
  });
});

// ── issueAlreadyTracked ─────────────────────────────────────────────────────

describe("issueAlreadyTracked", () => {
  it("returns false when no matching session exists", () => {
    expect(issueAlreadyTracked(getApp(), "#42")).toBe(false);
  });

  it("returns true when session with same ticket exists", () => {
    getApp().sessions.create({ ticket: "#42", summary: "existing" });
    expect(issueAlreadyTracked(getApp(), "#42")).toBe(true);
  });

  it("does not match different ticket numbers", () => {
    getApp().sessions.create({ ticket: "#99", summary: "other issue" });
    expect(issueAlreadyTracked(getApp(), "#42")).toBe(false);
  });
});

// ── createSessionFromIssue ──────────────────────────────────────────────────

describe("createSessionFromIssue", () => {
  it("creates session with correct ticket and summary", async () => {
    const issue = makeIssue();
    const session = await createSessionFromIssue(getApp(), issue);

    expect(session).not.toBeNull();
    expect(session!.ticket).toBe("#42");
    expect(session!.summary).toBe("Fix the widget");
  });

  it("stores issue URL and body in config", async () => {
    const issue = makeIssue();
    const session = await createSessionFromIssue(getApp(), issue);

    const config = session!.config as Record<string, any>;
    expect(config.issue_url).toBe("https://github.com/org/repo/issues/42");
    expect(config.issue_body).toContain("widget is broken");
    expect(config.issue_labels).toContain("ark");
  });

  it("logs issue_imported event", async () => {
    const issue = makeIssue();
    const session = await createSessionFromIssue(getApp(), issue);

    const events = getApp().events.list(session!.id);
    const imported = events.filter(e => e.type === "issue_imported");
    expect(imported).toHaveLength(1);

    const data = imported[0].data as Record<string, any>;
    expect(data.issue_number).toBe(42);
    expect(data.issue_url).toBe("https://github.com/org/repo/issues/42");
  });

  it("skips duplicate issues (session with same ticket exists)", async () => {
    getApp().sessions.create({ ticket: "#42", summary: "already tracked" });

    const issue = makeIssue();
    const session = await createSessionFromIssue(getApp(), issue);
    expect(session).toBeNull();
  });
});

// ── pollIssues ──────────────────────────────────────────────────────────────

describe("pollIssues", () => {
  it("creates sessions for new issues", async () => {
    ghOutput = makeGhOutput([
      makeIssue({ number: 10, title: "Bug A" }),
      makeIssue({ number: 11, title: "Bug B" }),
    ]);

    await pollIssues(getApp(), { label: "ark" });

    const sessions = getApp().sessions.list();
    const tickets = sessions.map(s => s.ticket);
    expect(tickets).toContain("#10");
    expect(tickets).toContain("#11");
  });

  it("skips issues that already have sessions", async () => {
    getApp().sessions.create({ ticket: "#10", summary: "existing" });

    ghOutput = makeGhOutput([
      makeIssue({ number: 10, title: "Bug A" }),
      makeIssue({ number: 11, title: "Bug B" }),
    ]);

    await pollIssues(getApp(), { label: "ark" });

    const sessions = getApp().sessions.list();
    const ticket11 = sessions.filter(s => s.ticket === "#11");
    const ticket10 = sessions.filter(s => s.ticket === "#10");
    expect(ticket11).toHaveLength(1);
    // Original + no duplicate
    expect(ticket10).toHaveLength(1);
  });

  it("handles gh CLI failure gracefully", async () => {
    ghShouldThrow = true;

    // Should not throw
    await pollIssues(getApp(), { label: "ark" });

    const sessions = getApp().sessions.list();
    expect(sessions).toHaveLength(0);
  });

  it("uses custom label", async () => {
    let capturedArgs: string[] = [];
    setGhExec(async (args) => {
      capturedArgs = args;
      return { stdout: "[]" };
    });

    await pollIssues(getApp(), { label: "agent" });

    expect(capturedArgs).toContain("agent");
  });
});

// ── startIssuePoller ──────────────────────────────────────────────────────

describe("startIssuePoller", () => {
  it("returns a handle with a stop function", () => {
    setGhExec(async () => ({ stdout: "[]" }));

    const handle = startIssuePoller(getApp(), { intervalMs: 60_000 });
    expect(typeof handle.stop).toBe("function");

    // Clean up the interval immediately
    handle.stop();
  });

  it("stop() cleans up the interval", () => {
    setGhExec(async () => ({ stdout: "[]" }));

    const handle = startIssuePoller(getApp(), { intervalMs: 100_000 });
    // Should not throw on stop
    handle.stop();
  });
});
