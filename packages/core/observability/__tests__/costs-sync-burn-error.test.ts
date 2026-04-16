import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { AppContext } from "../../app.js";
import { syncCosts } from "../costs.js";
import * as burnSync from "../burn/sync.js";

describe("syncCosts: burn sync error visibility", () => {
  let app: AppContext;

  beforeAll(async () => {
    app = AppContext.forTest();
    await app.boot();
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  it("logs a warning when syncBurn throws, and syncCosts does not throw", () => {
    // Spy on syncBurn so it throws -- this propagates to the outer catch in syncCosts.
    const syncBurnSpy = spyOn(burnSync, "syncBurn").mockImplementation(() => {
      throw new Error("boom: simulated burn sync failure");
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      let result: { synced: number; skipped: number } | undefined;
      expect(() => { result = syncCosts(app); }).not.toThrow();
      expect(result).toBeDefined();
      const calls = warnSpy.mock.calls.map((args) => String(args[0] ?? ""));
      expect(calls.some((m) => m.startsWith("[burn] sync failed:"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      syncBurnSpy.mockRestore();
    }
  });
});
