/**
 * HistoryService tests.
 *
 * Uses the DI container (awilix) to wire the service. Demonstrates how to
 * swap the underlying database with an in-memory fake via
 * `container.register({ db: asValue(fakeDb) })` -- see the "container
 * overrides" block at the bottom.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { asValue } from "awilix";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database.js";
import { AppContext } from "../../app.js";
import { HistoryService } from "../history.js";
import { SessionRepository } from "../../repositories/session.js";
import { initSchema } from "../../repositories/schema.js";

let app: AppContext;
let sessionRepo: SessionRepository;
let svc: HistoryService;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  sessionRepo = app.sessions;
  svc = app.historyService;
});

afterEach(async () => {
  await app?.shutdown();
});

describe("HistoryService", async () => {
  it("search returns empty for no matches", async () => {
    const results = await svc.search("nonexistent");
    expect(results).toEqual([]);
  });

  it("search finds sessions by summary", async () => {
    await sessionRepo.create({ summary: "Fix authentication bug" });
    await sessionRepo.create({ summary: "Add feature X" });
    const results = await svc.search("authentication");
    expect(results.length).toBe(1);
    expect(results[0].match).toBe("Fix authentication bug");
    expect(results[0].source).toBe("metadata");
  });

  it("search finds sessions by ticket", async () => {
    await sessionRepo.create({ ticket: "PROJ-999", summary: "Some work" });
    const results = await svc.search("PROJ-999");
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBeTruthy();
  });

  it("search finds sessions by repo", async () => {
    await sessionRepo.create({ repo: "/home/user/my-cool-project" });
    const results = await svc.search("my-cool-project");
    expect(results.length).toBe(1);
  });

  it("search finds sessions by id", async () => {
    const s = await sessionRepo.create({});
    const results = await svc.search(s.id);
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe(s.id);
  });

  it("search respects limit", async () => {
    await sessionRepo.create({ summary: "match A" });
    await sessionRepo.create({ summary: "match B" });
    await sessionRepo.create({ summary: "match C" });
    const results = await svc.search("match", { limit: 2 });
    expect(results.length).toBe(2);
  });

  it("search excludes deleting sessions", async () => {
    const s = await sessionRepo.create({ summary: "Searchable" });
    await sessionRepo.softDelete(s.id);
    const results = await svc.search("Searchable");
    expect(results.length).toBe(0);
  });

  it("search is case-insensitive", async () => {
    await sessionRepo.create({ summary: "Fix Authentication Bug" });
    const results = await svc.search("fix authentication");
    expect(results.length).toBe(1);
  });

  // ── DI container overrides ────────────────────────────────────────────
  //
  // HistoryService takes an DatabaseAdapter directly. This shows how to swap it
  // with a completely separate in-memory DB without affecting the rest of
  // the container.

  describe("container overrides", async () => {
    it("swapping the db with a separate in-memory instance isolates search results", async () => {
      // Seed the real DB and capture the real service up-front.
      await sessionRepo.create({ summary: "pre-override-row" });
      const realSvc = svc; // hold a reference before we override

      // Build an isolated in-memory DB with its own data.
      const fakeDb = new BunSqliteAdapter(new Database(":memory:"));
      await initSchema(fakeDb);
      const fakeSessions = new SessionRepository(fakeDb);
      await fakeSessions.create({ summary: "isolated-via-container-override" });

      app.container.register({
        historyService: asValue(new HistoryService(fakeDb)),
      });

      // Freshly resolved service sees only the fake DB.
      const freshSvc = app.container.resolve("historyService");
      expect((await freshSvc.search("isolated-via-container-override")).length).toBe(1);
      expect((await freshSvc.search("pre-override-row")).length).toBe(0);

      // The previously-captured service still sees the real DB.
      expect((await realSvc.search("pre-override-row")).length).toBe(1);

      // Cleanup fake db
      fakeDb.close();
    });
  });

  // ── Pure-unit construction (legacy, still supported) ──────────────────

  describe("pure unit construction (no container)", () => {
    let pureDb: DatabaseAdapter;
    let pureSvc: HistoryService;

    beforeEach(async () => {
      pureDb = new BunSqliteAdapter(new Database(":memory:"));
      await initSchema(pureDb);
      pureSvc = new HistoryService(pureDb);
    });

    it("search() works without an AppContext", async () => {
      const pureRepo = new SessionRepository(pureDb);
      await pureRepo.create({ summary: "pure-unit-search" });
      const results = await pureSvc.search("pure-unit-search");
      expect(results.length).toBe(1);
    });
  });
});
