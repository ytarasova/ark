import { describe, it, expect, afterEach } from "bun:test";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { existsSync } from "fs";

let app: AppContext | null = null;
afterEach(async () => {
  if (app) await app.shutdown();
  app = null;
});

describe("AppContext", () => {
  it("starts in created phase", () => {
    app = AppContext.forTest();
    expect(app.phase).toBe("created");
  });

  it("boots to ready phase", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(app.phase).toBe("ready");
  });

  it("creates directories on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(existsSync(app.config.arkDir)).toBe(true);
    expect(existsSync(app.config.tracksDir)).toBe(true);
    expect(existsSync(app.config.worktreesDir)).toBe(true);
    expect(existsSync(app.config.logDir)).toBe(true);
  });

  it("initializes database with schema on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    const row = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("sessions");
  });

  it("seeds local compute row on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    const row = app.db.prepare("SELECT name FROM compute WHERE name='local'").get() as { name: string } | undefined;
    expect(row?.name).toBe("local");
  });

  it("shuts down to stopped phase", async () => {
    app = AppContext.forTest();
    await app.boot();
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  });

  it("shutdown is idempotent", async () => {
    app = AppContext.forTest();
    await app.boot();
    await app.shutdown();
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  });

  it("boot throws if called twice", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(app.boot()).rejects.toThrow();
  });

  it("forTest cleans up temp dir on shutdown", async () => {
    app = AppContext.forTest();
    await app.boot();
    const dir = app.config.arkDir;
    expect(existsSync(dir)).toBe(true);
    await app.shutdown();
    expect(existsSync(dir)).toBe(false);
  });

  it("creates event bus on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(app.eventBus).toBeDefined();
    expect(typeof app.eventBus.emit).toBe("function");
  });
});

describe("getApp / setApp / clearApp", () => {
  afterEach(() => {
    clearApp();
  });

  it("getApp throws when no app is set", () => {
    clearApp();
    expect(() => getApp()).toThrow("AppContext not initialized");
  });

  it("setApp + getApp returns the same instance", async () => {
    const testApp = AppContext.forTest();
    setApp(testApp);
    expect(getApp()).toBe(testApp);
    await testApp.shutdown();
  });

  it("clearApp resets the singleton", async () => {
    const testApp = AppContext.forTest();
    setApp(testApp);
    clearApp();
    expect(() => getApp()).toThrow();
    await testApp.shutdown();
  });
});
