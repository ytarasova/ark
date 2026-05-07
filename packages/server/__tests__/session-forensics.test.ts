/**
 * Tests for session/stdio and session/transcript JSON-RPC handlers (B8).
 *
 * Covers:
 *   1. session/stdio returns empty content + exists=false when no log exists.
 *   2. session/stdio returns file contents when the log exists.
 *   3. session/stdio honours the `tail` param (returns last N lines).
 *   4. session/stdio returns SESSION_NOT_FOUND for an unknown session id.
 *   5. session/transcript returns empty + exists=false when no file exists.
 *   6. session/transcript parses JSONL into an array of messages.
 *   7. session/transcript returns SESSION_NOT_FOUND for an unknown session id.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";
import { localAdminContext } from "../../core/auth/context.js";
import { promises as fsPromises } from "fs";
import { join } from "path";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerSessionHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

function ok(res: unknown): Record<string, unknown> {
  const r = res as JsonRpcResponse;
  if (!r.result) throw new Error(`Expected result, got: ${JSON.stringify(r)}`);
  return r.result as Record<string, unknown>;
}

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

/** Write a file under the tracks dir for a session. */
async function writeTrackFile(sessionId: string, fileName: string, content: string): Promise<void> {
  const sessionDir = join(app.config.dirs.tracks, sessionId);
  await fsPromises.mkdir(sessionDir, { recursive: true });
  await fsPromises.writeFile(join(sessionDir, fileName), content, "utf8");
}

// ── session/stdio ────────────────────────────────────────────────────────────

describe("session/stdio", () => {
  it("returns exists=false and empty content when no stdio.log exists", async () => {
    const session = await app.sessions.create({ summary: "stdio-missing" });
    const res = await router.dispatch(
      createRequest(1, "session/stdio", { sessionId: session.id }),
      () => {},
      localAdminContext(null),
    );
    const result = ok(res);
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
    expect(result.size).toBe(0);
  });

  it("returns file contents when stdio.log exists", async () => {
    const session = await app.sessions.create({ summary: "stdio-exists" });
    const content = "line 1\nline 2\nline 3\n";
    await writeTrackFile(session.id, "stdio.log", content);

    const res = await router.dispatch(
      createRequest(2, "session/stdio", { sessionId: session.id }),
      () => {},
      localAdminContext(null),
    );
    const result = ok(res);
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.size).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("honours the tail param and returns the last N lines", async () => {
    const session = await app.sessions.create({ summary: "stdio-tail" });
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n") + "\n";
    await writeTrackFile(session.id, "stdio.log", content);

    const res = await router.dispatch(
      createRequest(3, "session/stdio", { sessionId: session.id, tail: 5 }),
      () => {},
      localAdminContext(null),
    );
    const result = ok(res);
    expect(result.exists).toBe(true);
    const returned = (result.content as string).split("\n").filter(Boolean);
    expect(returned.length).toBe(5);
    expect(returned[0]).toBe("line 16");
    expect(returned[4]).toBe("line 20");
  });

  it("returns SESSION_NOT_FOUND for an unknown session id", async () => {
    const res = await router.dispatch(
      createRequest(4, "session/stdio", { sessionId: "s-does-not-exist-xyz" }),
      () => {},
      localAdminContext(null),
    );
    const e = err(res);
    expect(e).toBeDefined();
    expect(e.code).toBe(-32002); // SESSION_NOT_FOUND
  });
});

// ── session/transcript ───────────────────────────────────────────────────────

describe("session/transcript", () => {
  it("returns exists=false and empty messages array when no transcript exists", async () => {
    const session = await app.sessions.create({ summary: "transcript-missing" });
    const res = await router.dispatch(
      createRequest(5, "session/transcript", { sessionId: session.id }),
      () => {},
      localAdminContext(null),
    );
    const result = ok(res);
    expect(result.exists).toBe(false);
    expect(Array.isArray(result.messages)).toBe(true);
    expect((result.messages as unknown[]).length).toBe(0);
  });

  it("parses JSONL transcript into an array of message objects", async () => {
    const session = await app.sessions.create({ summary: "transcript-parse" });
    const records = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeTrackFile(session.id, "transcript.jsonl", jsonl);

    const res = await router.dispatch(
      createRequest(6, "session/transcript", { sessionId: session.id }),
      () => {},
      localAdminContext(null),
    );
    const result = ok(res);
    expect(result.exists).toBe(true);
    const messages = result.messages as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("hello");
    expect(messages[1]!.role).toBe("assistant");
  });

  it("skips blank and malformed lines in JSONL", async () => {
    const session = await app.sessions.create({ summary: "transcript-malformed" });
    const content = '{"role":"user","content":"ok"}\n\nnot-json\n{"role":"assistant","content":"done"}\n';
    await writeTrackFile(session.id, "transcript.jsonl", content);

    const res = await router.dispatch(
      createRequest(7, "session/transcript", { sessionId: session.id }),
      () => {},
      localAdminContext(null),
    );
    const result = ok(res);
    const messages = result.messages as Array<{ role: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
  });

  it("returns SESSION_NOT_FOUND for an unknown session id", async () => {
    const res = await router.dispatch(
      createRequest(8, "session/transcript", { sessionId: "s-does-not-exist-xyz" }),
      () => {},
      localAdminContext(null),
    );
    const e = err(res);
    expect(e).toBeDefined();
    expect(e.code).toBe(-32002); // SESSION_NOT_FOUND
  });
});
