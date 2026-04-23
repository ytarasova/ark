/**
 * Tests for store context DI -- verifies test isolation works via AppContext.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
});

describe("Store context isolation", async () => {
  it("creates database in temp directory", () => {
    const db = getApp().db;
    expect(db).toBeDefined();
    expect(app.config.dbPath).toContain("ark-test-");
  });

  it("sessions are isolated between contexts", async () => {
    await getApp().sessions.create({ summary: "ctx1-session" });
    const sessions1 = await getApp().sessions.list();
    expect(sessions1.length).toBe(1);
    expect(sessions1[0].summary).toBe("ctx1-session");

    // Each AppContext has its own DB -- sessions do not bleed across.
    const app2 = await AppContext.forTestAsync();
    await app2.boot();

    const sessions2 = await app2.sessions.list();
    expect(sessions2.length).toBe(0);

    await app2.shutdown();
  });

  it("computes are isolated between contexts", async () => {
    // Default local compute is auto-created
    const computes = await getApp().computes.list();
    const localCompute = computes.find((h) => h.name === "local");
    expect(localCompute).toBeDefined();
    expect(localCompute!.provider).toBe("local");
  });

  it("CRUD works in isolated context", async () => {
    // Create
    const session = await getApp().sessions.create({ summary: "test-crud", repo: "/tmp/test" });
    expect(session.id).toBeTruthy();

    // Read
    const fetched = await getApp().sessions.get(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.summary).toBe("test-crud");

    // List
    expect((await getApp().sessions.list()).length).toBe(1);

    // Delete
    await getApp().sessions.delete(session.id);
    expect((await getApp().sessions.list()).length).toBe(0);
  });

  it("compute CRUD works in isolated context", async () => {
    await getApp().computeService.create({ name: "test-ec2", provider: "ec2", config: { size: "m" } });
    const compute = await getApp().computes.get("test-ec2");
    expect(compute).not.toBeNull();
    expect(compute!.provider).toBe("ec2");

    // local + test-ec2
    expect((await getApp().computes.list()).length).toBe(2);

    await getApp().computes.delete("test-ec2");
    expect((await getApp().computes.list()).length).toBe(1);
  });

  it("cleanup removes temp directory", async () => {
    const tempApp = await AppContext.forTestAsync();
    await tempApp.boot();
    const dir = tempApp.config.dirs.ark;
    await tempApp.shutdown();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require("fs");
    expect(existsSync(dir)).toBe(false);
  });
});
