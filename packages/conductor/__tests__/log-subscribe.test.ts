/**
 * Tests for log/subscribe JSON-RPC handler (B10).
 *
 * Covers:
 *   1. Returns initial content + exists=false when the file does not exist.
 *   2. Returns the current file contents as `initial` when the file exists.
 *   3. Pushes `log/chunk` notifications for bytes appended after subscribe.
 *   4. Stops pushing notifications after the subscription is flushed (close).
 *   5. Returns SESSION_NOT_FOUND for an unknown session id.
 *   6. Returns INVALID_PARAMS for an invalid `file` value.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router, Subscription } from "../router.js";
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

async function writeTrackFile(sessionId: string, fileName: string, content: string): Promise<void> {
  const sessionDir = join(app.config.dirs.tracks, sessionId);
  await fsPromises.mkdir(sessionDir, { recursive: true });
  await fsPromises.writeFile(join(sessionDir, fileName), content, "utf8");
}

async function appendTrackFile(sessionId: string, fileName: string, content: string): Promise<void> {
  const filePath = join(app.config.dirs.tracks, sessionId, fileName);
  await fsPromises.appendFile(filePath, content, "utf8");
}

// ── log/subscribe ────────────────────────────────────────────────────────────

describe("log/subscribe", () => {
  it("returns exists=false and empty initial when the file does not exist", async () => {
    const session = await app.sessions.create({ summary: "log-sub-missing" });
    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(1, "log/subscribe", { sessionId: session.id, file: "stdio" }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const result = ok(res);
    expect(result.exists).toBe(false);
    expect(result.initial).toBe("");
    expect(result.size).toBe(0);
    sub.flush();
  });

  it("returns current file contents as `initial` when the file exists", async () => {
    const session = await app.sessions.create({ summary: "log-sub-initial" });
    const content = "existing content\n";
    await writeTrackFile(session.id, "stdio.log", content);

    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(2, "log/subscribe", { sessionId: session.id, file: "stdio" }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const result = ok(res);
    expect(result.exists).toBe(true);
    expect(result.initial).toBe(content);
    expect(result.size).toBe(Buffer.byteLength(content, "utf8"));
    sub.flush();
  });

  it("pushes log/chunk notifications when new bytes are appended", async () => {
    const session = await app.sessions.create({ summary: "log-sub-push" });
    const initialContent = "initial line\n";
    await writeTrackFile(session.id, "stdio.log", initialContent);

    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notify = (method: string, params: Record<string, unknown>) => {
      notifications.push({ method, params });
    };

    const sub = new Subscription();
    await router.dispatch(
      createRequest(3, "log/subscribe", { sessionId: session.id, file: "stdio" }),
      notify as any,
      localAdminContext(null),
      sub,
    );

    // Append new bytes -- the watcher should pick this up.
    const newBytes = "appended line\n";
    await appendTrackFile(session.id, "stdio.log", newBytes);

    // Wait for the fs.watch event to fire and the async push to complete.
    await Bun.sleep(300);

    const chunks = notifications.filter((n) => n.method === "log/chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Concatenate all received chunks (in case the watcher fires multiple times).
    const received = chunks.map((n) => Buffer.from(n.params.bytes as string, "base64").toString("utf8")).join("");
    expect(received).toContain("appended line");
    expect(chunks[0]!.params.sessionId).toBe(session.id);
    expect(chunks[0]!.params.file).toBe("stdio");

    sub.flush();
  });

  it("stops pushing notifications after the subscription is flushed", async () => {
    const session = await app.sessions.create({ summary: "log-sub-stop" });
    const initialContent = "initial\n";
    await writeTrackFile(session.id, "stdio.log", initialContent);

    const notifications: Array<{ method: string }> = [];
    const notify = (method: string) => {
      notifications.push({ method });
    };

    const sub = new Subscription();
    await router.dispatch(
      createRequest(4, "log/subscribe", { sessionId: session.id, file: "stdio" }),
      notify as any,
      localAdminContext(null),
      sub,
    );

    // Flush before appending -- no chunks should arrive.
    sub.flush();

    await appendTrackFile(session.id, "stdio.log", "after-close\n");
    await Bun.sleep(300);

    const chunks = notifications.filter((n) => n.method === "log/chunk");
    expect(chunks.length).toBe(0);
  });

  it("works with the transcript file type", async () => {
    const session = await app.sessions.create({ summary: "log-sub-transcript" });
    const content = '{"role":"user","content":"hello"}\n';
    await writeTrackFile(session.id, "transcript.jsonl", content);

    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(5, "log/subscribe", { sessionId: session.id, file: "transcript" }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const result = ok(res);
    expect(result.exists).toBe(true);
    expect(result.initial).toBe(content);
    sub.flush();
  });

  it("returns SESSION_NOT_FOUND for an unknown session id", async () => {
    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(6, "log/subscribe", { sessionId: "s-unknown-xyz", file: "stdio" }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const e = err(res);
    expect(e).toBeDefined();
    expect(e.code).toBe(-32002); // SESSION_NOT_FOUND
    sub.flush();
  });

  it("returns INVALID_PARAMS for an invalid file value", async () => {
    const session = await app.sessions.create({ summary: "log-sub-badfile" });
    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(7, "log/subscribe", { sessionId: session.id, file: "bad-file" }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const e = err(res);
    expect(e).toBeDefined();
    expect(e.code).toBe(-32602); // INVALID_PARAMS
    sub.flush();
  });
});
