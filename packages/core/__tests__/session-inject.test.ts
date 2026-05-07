/**
 * Tests for the session/inject and session/interrupt RPC handlers.
 *
 * Exercises:
 *  - inject on a running session writes to <sessionDir>/interventions.jsonl
 *  - inject on a non-running session returns { ok: false }
 *  - inject on an unknown session throws SESSION_NOT_FOUND
 *  - session_injected event is logged with a truncated content_preview
 *  - interrupt on an agent-sdk running session writes control:"interrupt" line
 *  - interrupt on a non-running session returns { ok: false }
 *  - interrupt on an unknown session throws SESSION_NOT_FOUND
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppContext } from "../app.js";
import { registerSessionHandlers } from "../../conductor/handlers/session.js";
import { Router } from "../../conductor/router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

describe("session/inject", () => {
  it("writes the intervention line to <sessionDir>/interventions.jsonl for a running session", async () => {
    // Create a session and force it into running status.
    const session = await app.sessions.create({
      summary: "inject test",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running" });

    // Ensure sessionDir exists (normally created at dispatch; we do it here for the test).
    const sessionDir = join(app.config.dirs.tracks, session.id);
    mkdirSync(sessionDir, { recursive: true });

    const req = createRequest(1, "session/inject", { sessionId: session.id, content: "please also fix the typo" });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;

    expect(result.ok).toBe(true);

    const interventionPath = join(sessionDir, "interventions.jsonl");
    expect(existsSync(interventionPath)).toBe(true);

    const line = JSON.parse(readFileSync(interventionPath, "utf8").trim());
    expect(line.role).toBe("user");
    expect(line.content).toBe("please also fix the typo");
    expect(typeof line.ts).toBe("number");
  });

  it("returns { ok: false } for a completed session", async () => {
    const session = await app.sessions.create({
      summary: "inject completed",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, { status: "completed" });

    const req = createRequest(2, "session/inject", { sessionId: session.id, content: "too late" });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.message as string).toContain("not running");
    expect(result.message as string).toContain("completed");
  });

  it("returns { ok: false } for a failed session", async () => {
    const session = await app.sessions.create({
      summary: "inject failed",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, { status: "failed" });

    const req = createRequest(3, "session/inject", { sessionId: session.id, content: "too late" });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.message as string).toContain("not running");
  });

  it("throws SESSION_NOT_FOUND for an unknown sessionId", async () => {
    const req = createRequest(4, "session/inject", { sessionId: "s-nonexistent-xyz", content: "hello" });
    const res = await router.dispatch(req);
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    // SESSION_NOT_FOUND = -32002
    expect(err.code).toBe(-32002);
  });

  it("logs a session_injected event with a truncated content_preview", async () => {
    const session = await app.sessions.create({
      summary: "inject event test",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running" });

    const sessionDir = join(app.config.dirs.tracks, session.id);
    mkdirSync(sessionDir, { recursive: true });

    const longContent = "A".repeat(200);
    const req = createRequest(5, "session/inject", { sessionId: session.id, content: longContent });
    await router.dispatch(req);

    const events = await app.events.list(session.id);
    const injectedEvent = events.find((e: any) => e.type === "session_injected");
    expect(injectedEvent).toBeDefined();

    const preview = (injectedEvent as any).data?.content_preview;
    expect(typeof preview).toBe("string");
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview).toBe("A".repeat(80));
  });
});

describe("session/interrupt", () => {
  it("writes a control:interrupt line to interventions.jsonl for an agent-sdk running session", async () => {
    const session = await app.sessions.create({
      summary: "interrupt test",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      config: { launch_executor: "claude-agent" },
    } as any);

    const sessionDir = join(app.config.dirs.tracks, session.id);
    mkdirSync(sessionDir, { recursive: true });

    const req = createRequest(10, "session/interrupt", {
      sessionId: session.id,
      content: "stop, do X instead",
    });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;

    expect(result.ok).toBe(true);

    const interventionPath = join(sessionDir, "interventions.jsonl");
    const raw = readFileSync(interventionPath, "utf8").trim();
    const line = JSON.parse(raw);
    expect(line.role).toBe("user");
    expect(line.content).toBe("stop, do X instead");
    expect(line.control).toBe("interrupt");
    expect(typeof line.ts).toBe("number");
  });

  it("logs a session_interrupted event", async () => {
    const session = await app.sessions.create({
      summary: "interrupt event test",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      config: { launch_executor: "claude-agent" },
    } as any);

    const sessionDir = join(app.config.dirs.tracks, session.id);
    mkdirSync(sessionDir, { recursive: true });

    const req = createRequest(11, "session/interrupt", {
      sessionId: session.id,
      content: "B".repeat(200),
    });
    await router.dispatch(req);

    const events = await app.events.list(session.id);
    const ev = events.find((e: any) => e.type === "session_interrupted");
    expect(ev).toBeDefined();
    const preview = (ev as any).data?.content_preview;
    expect(typeof preview).toBe("string");
    expect(preview.length).toBeLessThanOrEqual(80);
  });

  it("returns { ok: false } when session is not running", async () => {
    const session = await app.sessions.create({
      summary: "interrupt not-running",
      workdir: app.config.dirs.ark,
      flow: "bare",
    });
    await app.sessions.update(session.id, { status: "completed" });

    const req = createRequest(12, "session/interrupt", {
      sessionId: session.id,
      content: "too late",
    });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.message as string).toContain("not running");
  });

  it("throws SESSION_NOT_FOUND for an unknown sessionId", async () => {
    const req = createRequest(13, "session/interrupt", {
      sessionId: "s-unknown-xyz",
      content: "hello",
    });
    const res = await router.dispatch(req);
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(-32002);
  });
});
