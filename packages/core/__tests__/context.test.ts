/**
 * Tests for store context DI — verifies test isolation works.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext, closeDb,
  getDb, listSessions, getSession, deleteSession,
  createCompute, listCompute, getCompute, deleteCompute,
  startSession,
} from "../index.js";
import { createSession } from "../store.js";
import type { TestContext } from "../store.js";

let ctx: TestContext;

beforeEach(() => {
  // Each test gets a fresh context
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

describe("Store context isolation", () => {
  it("creates database in temp directory", () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(ctx.dbPath).toContain("ark-test-");
  });

  it("sessions are isolated between contexts", () => {
    createSession({ summary: "ctx1-session" });
    const sessions1 = listSessions();
    expect(sessions1.length).toBe(1);
    expect(sessions1[0].summary).toBe("ctx1-session");

    // Switch to new context
    const ctx2 = createTestContext();
    setContext(ctx2);

    const sessions2 = listSessions();
    expect(sessions2.length).toBe(0);

    ctx2.cleanup();
    setContext(ctx);
  });

  it("computes are isolated between contexts", () => {
    // Default local compute is auto-created
    const computes = listCompute();
    const localCompute = computes.find(h => h.name === "local");
    expect(localCompute).toBeDefined();
    expect(localCompute!.provider).toBe("local");
  });

  it("CRUD works in isolated context", () => {
    // Create
    const session = createSession({ summary: "test-crud", repo: "/tmp/test" });
    expect(session.id).toBeTruthy();

    // Read
    const fetched = getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.summary).toBe("test-crud");

    // List
    expect(listSessions().length).toBe(1);

    // Delete
    deleteSession(session.id);
    expect(listSessions().length).toBe(0);
  });

  it("compute CRUD works in isolated context", () => {
    createCompute({ name: "test-ec2", provider: "ec2", config: { size: "m" } });
    const compute = getCompute("test-ec2");
    expect(compute).not.toBeNull();
    expect(compute!.provider).toBe("ec2");

    // local + test-ec2
    expect(listCompute().length).toBe(2);

    deleteCompute("test-ec2");
    expect(listCompute().length).toBe(1);
  });

  it("cleanup removes temp directory", () => {
    const tempCtx = createTestContext();
    const dir = tempCtx.arkDir;
    setContext(tempCtx);
    getDb(); // initialize
    tempCtx.cleanup();

    const { existsSync } = require("fs");
    expect(existsSync(dir)).toBe(false);

    setContext(ctx); // restore
  });
});
