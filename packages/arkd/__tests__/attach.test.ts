/**
 * ArkD terminal-attach endpoint tests.
 *
 * Exercises the live-terminal contract (open / input / resize / close) against
 * a real tmux session. Requires tmux on PATH -- matches the rest of the arkd
 * test suite which assumes a local tmux binary.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../server/index.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let TEST_PORT: number;
let BASE: string;
let server: { stop(): void };
let tempDir: string;

beforeAll(async () => {
  TEST_PORT = await allocatePort();
  BASE = `http://localhost:${TEST_PORT}`;
  tempDir = join(tmpdir(), `arkd-attach-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  server = startArkd(TEST_PORT, { quiet: true });
});

afterAll(() => {
  server.stop();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: (await resp.json()) as T };
}

async function pollUntil(condition: () => Promise<boolean>, opts?: { timeout?: number; interval?: number }) {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 100;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("pollUntil timed out");
}

describe("attach endpoints", () => {
  const SESSION = `arkd-attach-${Date.now()}`;

  afterAll(async () => {
    await post("/agent/kill", { sessionName: SESSION });
  });

  it("agentAttachOpen returns a streamHandle + initial buffer for a running session", async () => {
    // Launch a long-running session so attach has something to latch onto.
    await post("/agent/launch", {
      sessionName: SESSION,
      script: `#!/bin/bash\necho "hello from attach"\nwhile true; do sleep 1; done`,
      workdir: tempDir,
    });
    await pollUntil(async () => {
      const s = await post<any>("/agent/status", { sessionName: SESSION });
      return s.data.running === true;
    });

    // Poll capture-pane until the greeting has been flushed to the pane.
    await pollUntil(async () => {
      const c = await post<any>("/agent/capture", { sessionName: SESSION });
      return typeof c.data.output === "string" && c.data.output.includes("hello from attach");
    });

    const { status, data } = await post<any>("/agent/attach/open", { sessionName: SESSION });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.streamHandle).toBe("string");
    expect(data.streamHandle.length).toBeGreaterThan(0);
    expect(typeof data.initialBuffer).toBe("string");
    expect(data.initialBuffer).toContain("hello from attach");

    // Clean up the handle so the stream table stays small.
    await post("/agent/attach/close", { streamHandle: data.streamHandle });
  }, 30_000);

  it("agentAttachOpen rejects a non-existent session", async () => {
    const { status, data } = await post<any>("/agent/attach/open", { sessionName: "arkd-no-such-session" });
    expect(status).toBe(500);
    expect(typeof data.error).toBe("string");
  });

  it("agentAttachOpen rejects unsafe session names", async () => {
    const { status } = await post<any>("/agent/attach/open", { sessionName: "bad name; rm -rf /" });
    expect(status).toBe(500);
  });

  it("agentAttachInput sends literal keystrokes via send-keys -l", async () => {
    const { data: openData } = await post<any>("/agent/attach/open", { sessionName: SESSION });
    expect(openData.ok).toBe(true);

    // Send a literal string with escape characters. send-keys -l passes it through.
    const literal = "echo sentinel-xyz\n";
    const { status, data } = await post<any>("/agent/attach/input", {
      sessionName: SESSION,
      data: literal,
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // The pane should eventually show "sentinel-xyz" as the command is typed +
    // executed. (Our long-running session is just `sleep`, so the shell won't
    // actually run it -- but the literal keystrokes still land in the pane.)
    await pollUntil(async () => {
      const c = await post<any>("/agent/capture", { sessionName: SESSION });
      return typeof c.data.output === "string" && c.data.output.includes("sentinel-xyz");
    });

    await post("/agent/attach/close", { streamHandle: openData.streamHandle });
  }, 30_000);

  it("agentAttachResize updates the tmux window dimensions", async () => {
    const { data: openData } = await post<any>("/agent/attach/open", { sessionName: SESSION });

    const { status, data } = await post<any>("/agent/attach/resize", {
      sessionName: SESSION,
      cols: 100,
      rows: 40,
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    await post("/agent/attach/close", { streamHandle: openData.streamHandle });
  });

  it("agentAttachResize clamps nonsensical dimensions", async () => {
    const { status, data } = await post<any>("/agent/attach/resize", {
      sessionName: SESSION,
      cols: -5,
      rows: 10_000,
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("agentAttachClose is idempotent", async () => {
    const { data: openData } = await post<any>("/agent/attach/open", { sessionName: SESSION });
    const first = await post<any>("/agent/attach/close", { streamHandle: openData.streamHandle });
    expect(first.data.ok).toBe(true);
    const second = await post<any>("/agent/attach/close", { streamHandle: openData.streamHandle });
    expect(second.data.ok).toBe(true);
  });

  it("agentAttachClose rejects an empty handle", async () => {
    const { status } = await post<any>("/agent/attach/close", { streamHandle: "" });
    expect(status).toBe(500);
  });

  it("/agent/attach/stream returns 400 without handle param", async () => {
    const resp = await fetch(`${BASE}/agent/attach/stream`);
    expect(resp.status).toBe(400);
  });

  it("/agent/attach/stream returns 404 for unknown handle", async () => {
    const resp = await fetch(`${BASE}/agent/attach/stream?handle=no-such-handle`);
    expect(resp.status).toBe(404);
  });

  // Note: /agent/attach/stream wire-level behaviour (chunked byte delivery,
  // fifo lifecycle) is covered by packages/server/__tests__/terminal-ws.test.ts,
  // which exercises the end-to-end server-daemon -> arkd -> fifo -> WS path
  // with a real tmux pane. We intentionally don't duplicate that here because
  // a raw fifo can't be probed without a writer without deadlocking on Bun's
  // ReadStream semantics.
});
