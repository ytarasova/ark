/**
 * Tests for SessionService.start() Temporal routing (RF-7).
 *
 * The test profile has temporalOrchestration=false by default, so the
 * Temporal client is never instantiated -- this only verifies that the
 * orchestrator stamp is written correctly for the non-Temporal path.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";

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

test("SessionService.start() stamps orchestrator=custom when temporal flag is off", async () => {
  // The test profile has temporalOrchestration=false (default), so the
  // custom engine path is taken regardless of mode.kind.
  const session = await app.sessionService.start({ summary: "routing-test" });
  expect(session.orchestrator).toBe("custom");
});

test("SessionService.start() leaves workflow_id null when temporal flag is off", async () => {
  const session = await app.sessionService.start({ summary: "routing-test-wfid" });
  expect(session.workflow_id).toBeNull();
});
