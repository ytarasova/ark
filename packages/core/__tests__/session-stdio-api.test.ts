/**
 * Session forensic-file API tests.
 *
 * Covers:
 *   - REST: GET /api/sessions/:id/stdio (+ ?tail=)
 *   - REST: GET /api/sessions/:id/transcript
 *   - RPC:  session/stdio  + session/transcript
 *
 * The tests seed real files under `<arkDir>/tracks/<sessionId>/` (the same
 * path the dispatcher / agent-sdk launch.ts writes to) and then hit both
 * surfaces to verify shapes, 404 / empty-body semantics, the 2MB size cap,
 * and the `tail` parameter.
 *
 * Runs in-process via the server Router for the RPC side and via a real
 * Bun.serve conductor for the HTTP side, so we exercise the actual route
 * matcher rather than a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppContext } from "../app.js";
import { startConductor } from "../conductor/conductor.js";
import { allocatePort } from "../config/port-allocator.js";
import { Router } from "../../server/router.js";
import { registerSessionHandlers } from "../../server/handlers/session.js";
import { clearApp, setApp } from "./test-helpers.js";

let app: AppContext;
let server: { stop(): void };
let port: number;
let base: string;

async function boot(): Promise<void> {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
  port = await allocatePort();
  base = `http://localhost:${port}`;
  server = startConductor(app, port, { quiet: true });
}

function seedTracks(sessionId: string, files: { name: string; body: string }[]): void {
  const dir = join(app.config.tracksDir, sessionId);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f.name), f.body);
  }
}

function makeRpcRouter(): Router {
  const r = new Router();
  registerSessionHandlers(r, app);
  return r;
}

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const router = makeRpcRouter();
  const res = await router.dispatch({ jsonrpc: "2.0", id: 1, method, params });
  return res;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  try {
    server?.stop();
  } catch {
    /* ignore */
  }
  if (app) await app.shutdown();
  clearApp();
});

describe("GET /api/sessions/:id/stdio", async () => {
  it("returns the full file body as text/plain when present", async () => {
    const s = await app.sessions.create({ summary: "has stdio" });
    seedTracks(s.id, [{ name: "stdio.log", body: "[exec bash]\nline1\nline2\n" }]);

    const resp = await fetch(`${base}/api/sessions/${s.id}/stdio`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("text/plain");
    const body = await resp.text();
    expect(body).toBe("[exec bash]\nline1\nline2\n");
  });

  it("returns 200 with an empty body when the session exists but stdio.log is missing", async () => {
    const s = await app.sessions.create({ summary: "no stdio" });
    const resp = await fetch(`${base}/api/sessions/${s.id}/stdio`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("");
  });

  it("returns 404 when the session does not exist", async () => {
    const resp = await fetch(`${base}/api/sessions/s-nope/stdio`);
    expect(resp.status).toBe(404);
  });

  it("honours ?tail=<N> and returns only the last N lines", async () => {
    const s = await app.sessions.create({ summary: "tail me" });
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    seedTracks(s.id, [{ name: "stdio.log", body: lines.join("\n") + "\n" }]);

    const resp = await fetch(`${base}/api/sessions/${s.id}/stdio?tail=5`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    const trimmed = body.replace(/\n$/, "");
    expect(trimmed.split("\n")).toEqual(["line-46", "line-47", "line-48", "line-49", "line-50"]);
  });

  it("returns 413 when the file is larger than 2MB and no tail is supplied", async () => {
    const s = await app.sessions.create({ summary: "too big" });
    const big = "x".repeat(2 * 1024 * 1024 + 1024); // ~2MB + 1KB
    seedTracks(s.id, [{ name: "stdio.log", body: big }]);

    const resp = await fetch(`${base}/api/sessions/${s.id}/stdio`);
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/tail/i);
  });

  it("allows reading the tail of an oversized file when tail is supplied", async () => {
    const s = await app.sessions.create({ summary: "big with tail" });
    const head = "x".repeat(2 * 1024 * 1024);
    const body = head + "\nlast-line\n";
    seedTracks(s.id, [{ name: "stdio.log", body }]);

    const resp = await fetch(`${base}/api/sessions/${s.id}/stdio?tail=1`);
    expect(resp.status).toBe(200);
    expect((await resp.text()).replace(/\n$/, "")).toBe("last-line");
  });
});

describe("GET /api/sessions/:id/transcript", async () => {
  it("returns the raw JSONL as application/x-ndjson when present", async () => {
    const s = await app.sessions.create({ summary: "has transcript" });
    const msg1 = { type: "system", subtype: "init", cwd: "/tmp", model: "sonnet" };
    const msg2 = { type: "assistant", content: [{ type: "text", text: "hello" }] };
    const jsonl = JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n";
    seedTracks(s.id, [{ name: "transcript.jsonl", body: jsonl }]);

    const resp = await fetch(`${base}/api/sessions/${s.id}/transcript`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("application/x-ndjson");
    expect(await resp.text()).toBe(jsonl);
  });

  it("returns 200 empty body when transcript.jsonl is missing", async () => {
    const s = await app.sessions.create({ summary: "no transcript" });
    const resp = await fetch(`${base}/api/sessions/${s.id}/transcript`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("");
  });

  it("returns 404 when the session does not exist", async () => {
    const resp = await fetch(`${base}/api/sessions/s-missing/transcript`);
    expect(resp.status).toBe(404);
  });
});

describe("RPC session/stdio + session/transcript", async () => {
  it("session/stdio returns {content, size, exists} for a seeded file", async () => {
    const s = await app.sessions.create({ summary: "rpc stdio" });
    seedTracks(s.id, [{ name: "stdio.log", body: "rpc body\n" }]);

    const res = (await rpc("session/stdio", { sessionId: s.id })) as { result: any };
    expect(res.result.content).toBe("rpc body\n");
    expect(res.result.size).toBe("rpc body\n".length);
    expect(res.result.exists).toBe(true);
  });

  it("session/stdio returns empty content when the file is missing but session exists", async () => {
    const s = await app.sessions.create({ summary: "rpc stdio missing" });
    const res = (await rpc("session/stdio", { sessionId: s.id })) as { result: any };
    expect(res.result.content).toBe("");
    expect(res.result.exists).toBe(false);
  });

  it("session/stdio errors when the session does not exist", async () => {
    const res = (await rpc("session/stdio", { sessionId: "s-gone" })) as { error?: { message: string } };
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/not found/i);
  });

  it("session/stdio honours the tail parameter", async () => {
    const s = await app.sessions.create({ summary: "rpc stdio tail" });
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    seedTracks(s.id, [{ name: "stdio.log", body: lines.join("\n") + "\n" }]);

    const res = (await rpc("session/stdio", { sessionId: s.id, tail: 3 })) as { result: any };
    expect(res.result.content.replace(/\n$/, "").split("\n")).toEqual(["l17", "l18", "l19"]);
  });

  it("session/transcript parses JSONL into a messages array", async () => {
    const s = await app.sessions.create({ summary: "rpc transcript" });
    const a = { type: "system", subtype: "init" };
    const b = { type: "assistant" };
    const body = JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n\nnot-json\n";
    seedTracks(s.id, [{ name: "transcript.jsonl", body }]);

    const res = (await rpc("session/transcript", { sessionId: s.id })) as { result: any };
    // Corrupt lines are dropped, blanks skipped.
    expect(res.result.messages).toEqual([a, b]);
    expect(res.result.exists).toBe(true);
  });

  it("session/transcript returns empty messages when the file is missing", async () => {
    const s = await app.sessions.create({ summary: "no rpc transcript" });
    const res = (await rpc("session/transcript", { sessionId: s.id })) as { result: any };
    expect(res.result.messages).toEqual([]);
    expect(res.result.exists).toBe(false);
  });
});
