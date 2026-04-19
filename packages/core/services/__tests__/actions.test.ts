/**
 * Unit tests for the action registry at `services/actions/`.
 *
 * Covers the registry dispatch surface -- lookup by name + alias, unknown
 * action handling, and the short-circuit path for `create_pr` when a PR is
 * already tracked. Heavy-IO actions (merge_pr, auto_merge) are exercised end
 * to end by `__tests__/action-stage-chaining.test.ts`; we only verify here
 * that the registry resolves them to the right handler.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppContext, clearApp, setApp } from "../../app.js";
import { executeAction, getAction, listActions } from "../actions/index.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("action registry", () => {
  it("listActions exposes canonical names (no aliases)", () => {
    const names = listActions();
    expect(names).toEqual(expect.arrayContaining(["create_pr", "merge_pr", "auto_merge", "close_ticket"]));
    // aliases must NOT appear in listActions
    expect(names).not.toContain("merge");
    expect(names).not.toContain("close");
  });

  it("getAction resolves aliases to the same handler", () => {
    expect(getAction("merge")).toBe(getAction("merge_pr"));
    expect(getAction("close")).toBe(getAction("close_ticket"));
  });

  it("getAction returns undefined for unknown names", () => {
    expect(getAction("does-not-exist")).toBeUndefined();
  });

  it("executeAction returns not-found when session is missing", async () => {
    const res = await executeAction(app, "no-such-session", "close");
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Session not found");
  });

  it("executeAction logs a skipped event for unknown actions and returns ok", async () => {
    const s = app.sessions.create({ summary: "unknown-action test", flow: "default" });
    const res = await executeAction(app, s.id, "invented_action");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("unknown");
    const events = app.events.list(s.id);
    const skipped = events.find((e) => e.type === "action_skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.data?.action).toBe("invented_action");
  });

  it("close action logs action_executed and returns ok", async () => {
    const s = app.sessions.create({ summary: "close test", flow: "default" });
    const res = await executeAction(app, s.id, "close");
    expect(res.ok).toBe(true);
    const events = app.events.list(s.id);
    const executed = events.find((e) => e.type === "action_executed" && e.data?.action === "close");
    expect(executed).toBeDefined();
  });

  it("close_ticket (canonical) logs action_executed and returns ok", async () => {
    const s = app.sessions.create({ summary: "close-canonical test", flow: "default" });
    const res = await executeAction(app, s.id, "close_ticket");
    expect(res.ok).toBe(true);
    const events = app.events.list(s.id);
    const executed = events.find((e) => e.type === "action_executed" && e.data?.action === "close_ticket");
    expect(executed).toBeDefined();
  });

  it("create_pr short-circuits when session already tracks a pr_url", async () => {
    const s = app.sessions.create({ summary: "pr-already test", flow: "default" });
    app.sessions.update(s.id, { pr_url: "https://github.com/owner/repo/pull/42" });
    const res = await executeAction(app, s.id, "create_pr");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("PR already exists");
    const events = app.events.list(s.id);
    const executed = events.find((e) => e.type === "action_executed" && e.data?.action === "create_pr");
    expect(executed?.data?.skipped).toBe("pr_already_exists");
    expect(executed?.data?.pr_url).toBe("https://github.com/owner/repo/pull/42");
  });
});
