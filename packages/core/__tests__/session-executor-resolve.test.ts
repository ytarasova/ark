/**
 * resolveSessionExecutor: single source of truth for "which runtime owns
 * this session". Replaces ad-hoc lookups that sometimes default to
 * "claude-code" -- a mix-of-concerns bug that put claude-agent sessions
 * on the tmux probe path (#435).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { resolveSessionExecutor } from "../executors/resolve.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

describe("resolveSessionExecutor", () => {
  it("reads launch_executor when set on session.config", async () => {
    const session = await app.sessions.create({ summary: "test", flow: "quick" });
    await app.sessions.mergeConfig(session.id, { launch_executor: "claude-agent" });
    const refreshed = await app.sessions.get(session.id);

    const result = await resolveSessionExecutor(app, refreshed!);
    expect(result).toBe("claude-agent");
  });

  it("falls back to agent definition's runtime when launch_executor is absent", async () => {
    // Use a known builtin agent. `implementer` ships with runtime: claude-code.
    const session = await app.sessions.create({ summary: "test", flow: "quick" });
    await app.sessions.update(session.id, { agent: "implementer" });
    const refreshed = await app.sessions.get(session.id);

    const result = await resolveSessionExecutor(app, refreshed!);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("returns null when neither launch_executor nor agent runtime is resolvable", async () => {
    const session = await app.sessions.create({ summary: "test", flow: "quick" });
    // No launch_executor, no agent set.
    const refreshed = await app.sessions.get(session.id);

    const result = await resolveSessionExecutor(app, refreshed!);
    expect(result).toBeNull();
  });

  it("launch_executor takes precedence over agent definition", async () => {
    // Sanity: even if the agent says one runtime, an explicit
    // launch_executor wins. Lets ad-hoc / one-off dispatches override
    // without rewriting the agent YAML.
    const session = await app.sessions.create({ summary: "test", flow: "quick" });
    await app.sessions.update(session.id, { agent: "implementer" });
    await app.sessions.mergeConfig(session.id, { launch_executor: "claude-agent" });
    const refreshed = await app.sessions.get(session.id);

    const result = await resolveSessionExecutor(app, refreshed!);
    expect(result).toBe("claude-agent");
  });

  it("ignores empty-string launch_executor and falls through to agent runtime", async () => {
    const session = await app.sessions.create({ summary: "test", flow: "quick" });
    await app.sessions.update(session.id, { agent: "implementer" });
    await app.sessions.mergeConfig(session.id, { launch_executor: "" });
    const refreshed = await app.sessions.get(session.id);

    const result = await resolveSessionExecutor(app, refreshed!);
    // implementer runtime, not "" -- empty-string launch_executor must
    // not block the agent-runtime fallback.
    expect(result).toBeTruthy();
    expect(result).not.toBe("");
  });
});
