/**
 * Tests for store context DI — verifies test isolation works via AppContext.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext, getApp, setApp, clearApp } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  if (app) { await app.shutdown(); clearApp(); }
});

describe("Store context isolation", () => {
  it("creates database in temp directory", () => {
    const db = getApp().db;
    expect(db).toBeDefined();
    expect(app.config.dbPath).toContain("ark-test-");
  });

  it("sessions are isolated between contexts", async () => {
    getApp().sessions.create({ summary: "ctx1-session" });
    const sessions1 = getApp().sessions.list();
    expect(sessions1.length).toBe(1);
    expect(sessions1[0].summary).toBe("ctx1-session");

    // Switch to new context
    const app2 = AppContext.forTest();
    await app2.boot();
    setApp(app2);

    const sessions2 = getApp().sessions.list();
    expect(sessions2.length).toBe(0);

    await app2.shutdown();
    setApp(app);
  });

  it("computes are isolated between contexts", () => {
    // Default local compute is auto-created
    const computes = getApp().computes.list();
    const localCompute = computes.find(h => h.name === "local");
    expect(localCompute).toBeDefined();
    expect(localCompute!.provider).toBe("local");
  });

  it("CRUD works in isolated context", () => {
    // Create
    const session = getApp().sessions.create({ summary: "test-crud", repo: "/tmp/test" });
    expect(session.id).toBeTruthy();

    // Read
    const fetched = getApp().sessions.get(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.summary).toBe("test-crud");

    // List
    expect(getApp().sessions.list().length).toBe(1);

    // Delete
    getApp().sessions.delete(session.id);
    expect(getApp().sessions.list().length).toBe(0);
  });

  it("compute CRUD works in isolated context", () => {
    getApp().computes.create({ name: "test-ec2", provider: "ec2", config: { size: "m" } });
    const compute = getApp().computes.get("test-ec2");
    expect(compute).not.toBeNull();
    expect(compute!.provider).toBe("ec2");

    // local + test-ec2
    expect(getApp().computes.list().length).toBe(2);

    getApp().computes.delete("test-ec2");
    expect(getApp().computes.list().length).toBe(1);
  });

  it("cleanup removes temp directory", async () => {
    const tempApp = AppContext.forTest();
    await tempApp.boot();
    const dir = tempApp.config.arkDir;
    await tempApp.shutdown();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require("fs");
    expect(existsSync(dir)).toBe(false);
  });
});
