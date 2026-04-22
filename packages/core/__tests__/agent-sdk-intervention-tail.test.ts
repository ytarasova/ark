/**
 * Unit tests for the intervention-tail file watcher.
 *
 * All tests use real temp files so the fs.watch + poll logic is exercised
 * against actual disk I/O (no mocking). Each test gets its own tmp dir.
 */

import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInterventionTail } from "../runtimes/agent-sdk/intervention-tail.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "intervention-tail-"));
}

/** Wait up to `timeoutMs` ms for `fn` to return true, polling every 20 ms. */
async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await Bun.sleep(20);
  }
  return false;
}

test("delivers lines written before tail starts", async () => {
  const dir = makeTmpDir();
  const path = join(dir, "interventions.jsonl");

  // Write two lines BEFORE starting the tail.
  writeFileSync(
    path,
    JSON.stringify({ role: "user", content: "msg1", ts: 1 }) +
      "\n" +
      JSON.stringify({ role: "user", content: "msg2", ts: 2 }) +
      "\n",
  );

  const received: string[] = [];
  const stop = startInterventionTail({ path, onMessage: (c) => received.push(c) });

  const ok = await waitUntil(() => received.length >= 2);
  stop();

  expect(ok).toBe(true);
  expect(received).toEqual(["msg1", "msg2"]);
});

test("delivers a line written after starting the tail", async () => {
  const dir = makeTmpDir();
  const path = join(dir, "interventions.jsonl");

  // File doesn't exist yet -- tail must tolerate that.
  const received: string[] = [];
  const stop = startInterventionTail({ path, onMessage: (c) => received.push(c) });

  // Give the poll loop a moment to start, then write.
  await Bun.sleep(50);
  appendFileSync(path, JSON.stringify({ role: "user", content: "late msg", ts: 3 }) + "\n");

  const ok = await waitUntil(() => received.length >= 1);
  stop();

  expect(ok).toBe(true);
  expect(received[0]).toBe("late msg");
});

test("skips malformed lines and delivers valid lines after them", async () => {
  const dir = makeTmpDir();
  const path = join(dir, "interventions.jsonl");

  const errors: string[] = [];
  writeFileSync(path, "this is not json\n" + JSON.stringify({ role: "user", content: "good", ts: 4 }) + "\n");

  const received: string[] = [];
  const stop = startInterventionTail({
    path,
    onMessage: (c) => received.push(c),
    onError: (err) => errors.push(err.message),
  });

  const ok = await waitUntil(() => received.length >= 1);
  stop();

  expect(ok).toBe(true);
  expect(received).toEqual(["good"]);
  // At least one parse error was reported.
  expect(errors.length).toBeGreaterThan(0);
});

test("stop() prevents further delivery", async () => {
  const dir = makeTmpDir();
  const path = join(dir, "interventions.jsonl");
  writeFileSync(path, JSON.stringify({ role: "user", content: "first", ts: 5 }) + "\n");

  const received: string[] = [];
  const stop = startInterventionTail({ path, onMessage: (c) => received.push(c) });

  // Wait for the first message.
  await waitUntil(() => received.length >= 1);

  // Stop the tail before writing more.
  stop();
  await Bun.sleep(50);
  appendFileSync(path, JSON.stringify({ role: "user", content: "after-stop", ts: 6 }) + "\n");
  await Bun.sleep(300);

  expect(received).toEqual(["first"]);
});
