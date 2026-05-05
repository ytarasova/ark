/**
 * Tests that `registerAllHandlers` honors the AppMode capability contract:
 *   - In local mode, every local-only handler is registered.
 *   - In hosted mode, none of the local-only handlers are registered.
 *
 * The individual handler bodies never inspect a mode flag -- the contract is
 * enforced at mount time.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerAllHandlers } from "../register.js";
import { buildHostedAppMode, buildLocalAppMode } from "../../core/modes/app-mode.js";

const LOCAL_ONLY_METHODS = [
  "fs/list-dir",
  "repo-map/get",
  "knowledge/ingest",
  "knowledge/index",
  "knowledge/export",
  "knowledge/import",
  "compute/kill-process",
  "compute/docker-logs",
  "compute/docker-action",
];

const SHARED_METHODS = [
  "status/get",
  "config/get",
  "knowledge/search",
  "knowledge/stats",
  "costs/summary",
  "costs/record",
];

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("registerAllHandlers / AppMode gating", () => {
  it("registers every local-only handler in local mode", () => {
    const router = new Router();
    registerAllHandlers(router, app);
    for (const method of LOCAL_ONLY_METHODS) {
      expect(router.hasHandler(method), `missing ${method} in local mode`).toBe(true);
    }
    for (const method of SHARED_METHODS) {
      expect(router.hasHandler(method), `missing shared ${method} in local mode`).toBe(true);
    }
  });

  it("omits every local-only handler in hosted mode", () => {
    // Force-swap the container's `mode` registration to hosted. DI composes
    // the mode once; tests that need the other branch build a hosted-mode
    // stub and re-register.
    app.container.register({ mode: asValue(buildHostedAppMode()) });
    try {
      const router = new Router();
      registerAllHandlers(router, app);
      for (const method of LOCAL_ONLY_METHODS) {
        expect(router.hasHandler(method), `unexpected ${method} in hosted mode`).toBe(false);
      }
      for (const method of SHARED_METHODS) {
        expect(router.hasHandler(method), `missing shared ${method} in hosted mode`).toBe(true);
      }
    } finally {
      // Restore local mode for subsequent tests in the same worker.
      app.container.register({ mode: asValue(buildLocalAppMode(app)) });
    }
  });
});
