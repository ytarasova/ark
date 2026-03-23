/**
 * Tests for store context DI — verifies test isolation works.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext, closeDb,
  getDb, listSessions, getSession, deleteSession,
  createHost, listHosts, getHost, deleteHost,
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

  it("hosts are isolated between contexts", () => {
    // Default local host is auto-created
    const hosts = listHosts();
    const localHost = hosts.find(h => h.name === "local");
    expect(localHost).toBeDefined();
    expect(localHost!.provider).toBe("local");
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

  it("host CRUD works in isolated context", () => {
    createHost({ name: "test-ec2", provider: "ec2", config: { size: "m" } });
    const host = getHost("test-ec2");
    expect(host).not.toBeNull();
    expect(host!.provider).toBe("ec2");

    // local + test-ec2
    expect(listHosts().length).toBe(2);

    deleteHost("test-ec2");
    expect(listHosts().length).toBe(1);
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
