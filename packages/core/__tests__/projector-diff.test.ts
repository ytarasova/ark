import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";
import { diffProjections } from "../temporal/projector/diff.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

test("diffProjections returns empty when session does not exist", async () => {
  const diffs = await diffProjections(app.db, "nonexistent-session-id");
  expect(diffs).toEqual([]);
});

test("diffProjections returns empty when shadow row is absent", async () => {
  // Create a real session row; no corresponding shadow row exists yet.
  const session = await app.sessionService.start({ summary: "diff-test" });
  const diffs = await diffProjections(app.db, session.id);
  // No shadow row -- should be empty, not an error
  expect(diffs).toEqual([]);
  expect(Array.isArray(diffs)).toBe(true);
});
