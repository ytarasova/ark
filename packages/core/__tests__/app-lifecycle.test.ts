/**
 * Tests for AppContext lifecycle -- singleton clearing on shutdown,
 * accessor guards before boot, accessor availability after boot.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { AppContext, getApp, setApp, clearApp } from "../app.js";

describe("AppContext lifecycle", () => {
  let app: AppContext | null = null;

  afterEach(async () => {
    if (app) {
      await app.shutdown();
      clearApp();
      app = null;
    }
  });

  it("getApp() throws after shutdown() clears the singleton", async () => {
    app = await AppContext.forTestAsync();
    setApp(app);
    await app.boot();

    // Verify it works before shutdown
    expect(() => getApp()).not.toThrow();

    await app.shutdown();

    // After shutdown, getApp() should throw because _app was cleared
    expect(() => getApp()).toThrow("AppContext not initialized");
    app = null; // prevent afterEach double-shutdown
  });

  it("todos accessor throws before boot()", async () => {
    app = await AppContext.forTestAsync();
    setApp(app);
    // Not booted yet -- todos should throw
    expect(() => app!.todos).toThrow("AppContext not booted");
  });

  it("todos accessor works after boot()", async () => {
    app = await AppContext.forTestAsync();
    setApp(app);
    await app.boot();

    // Should not throw -- todos initialized during boot
    expect(() => app!.todos).not.toThrow();
    expect(app!.todos).toBeDefined();
  });

  it("other accessors throw before boot()", async () => {
    app = await AppContext.forTestAsync();
    setApp(app);
    expect(() => app!.sessions).toThrow("AppContext not booted");
    expect(() => app!.events).toThrow("AppContext not booted");
    expect(() => app!.messages).toThrow("AppContext not booted");
    expect(() => app!.computes).toThrow("AppContext not booted");
    expect(() => app!.db).toThrow("AppContext not booted");
  });

  it("shutdown only clears singleton when it matches the current app", async () => {
    // Boot app1
    const app1 = await AppContext.forTestAsync();
    setApp(app1);
    await app1.boot();

    // Boot app2 and make it the global singleton
    const app2 = await AppContext.forTestAsync();
    setApp(app2);
    await app2.boot();

    // Shutdown app1 -- should NOT clear the singleton since app2 is current
    await app1.shutdown();

    // getApp() should still return app2
    expect(() => getApp()).not.toThrow();
    expect(getApp()).toBe(app2);

    // Cleanup
    await app2.shutdown();
    clearApp();
    app = null; // prevent afterEach double-shutdown
  });
});
