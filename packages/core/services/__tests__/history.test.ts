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
import type { IDatabase } from "../../database.js";
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

describe("HistoryService", () => {
  it("search returns empty for no matches", () => {
    const results = svc.search("nonexistent");
    expect(results).toEqual([]);
  });

  it("search finds sessions by summary", () => {
    sessionRepo.create({ summary: "Fix authentication bug" });
    sessionRepo.create({ summary: "Add feature X" });
    const results = svc.search("authentication");
    expect(results.length).toBe(1);
    expect(results[0].match).toBe("Fix authentication bug");
    expect(results[0].source).toBe("metadata");
  });

  it("search finds sessions by ticket", () => {
    sessionRepo.create({ ticket: "PROJ-999", summary: "Some work" });
    const results = svc.search("PROJ-999");
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBeTruthy();
  });

  it("search finds sessions by repo", () => {
    sessionRepo.create({ repo: "/home/user/my-cool-project" });
    const results = svc.search("my-cool-project");
    expect(results.length).toBe(1);
  });

  it("search finds sessions by id", () => {
    const s = sessionRepo.create({});
    const results = svc.search(s.id);
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe(s.id);
  });

  it("search respects limit", () => {
    sessionRepo.create({ summary: "match A" });
    sessionRepo.create({ summary: "match B" });
    sessionRepo.create({ summary: "match C" });
    const results = svc.search("match", { limit: 2 });
    expect(results.length).toBe(2);
  });

  it("search excludes deleting sessions", () => {
    const s = sessionRepo.create({ summary: "Searchable" });
    sessionRepo.softDelete(s.id);
    const results = svc.search("Searchable");
    expect(results.length).toBe(0);
  });

  it("search is case-insensitive", () => {
    sessionRepo.create({ summary: "Fix Authentication Bug" });
    const results = svc.search("fix authentication");
    expect(results.length).toBe(1);
  });

  // ── DI container overrides ────────────────────────────────────────────
  //
  // HistoryService takes an IDatabase directly. This shows how to swap it
  // with a completely separate in-memory DB without affecting the rest of
  // the container.

  describe("container overrides", () => {
    it("swapping the db with a separate in-memory instance isolates search results", () => {
      // Seed the real DB and capture the real service up-front.
      sessionRepo.create({ summary: "pre-override-row" });
      const realSvc = svc; // hold a reference before we override

      // Build an isolated in-memory DB with its own data.
      const fakeDb = new BunSqliteAdapter(new Database(":memory:"));
      initSchema(fakeDb);
      const fakeSessions = new SessionRepository(fakeDb);
      fakeSessions.create({ summary: "isolated-via-container-override" });

      app.container.register({
        historyService: asValue(new HistoryService(fakeDb)),
      });

      // Freshly resolved service sees only the fake DB.
      const freshSvc = app.container.resolve("historyService");
      expect(freshSvc.search("isolated-via-container-override").length).toBe(1);
      expect(freshSvc.search("pre-override-row").length).toBe(0);

      // The previously-captured service still sees the real DB.
      expect(realSvc.search("pre-override-row").length).toBe(1);

      // Cleanup fake db
      fakeDb.close();
    });
  });

  // ── Pure-unit construction (legacy, still supported) ──────────────────

  describe("pure unit construction (no container)", () => {
    let pureDb: IDatabase;
    let pureSvc: HistoryService;

    beforeEach(() => {
      pureDb = new BunSqliteAdapter(new Database(":memory:"));
      initSchema(pureDb);
      pureSvc = new HistoryService(pureDb);
    });

    it("search() works without an AppContext", () => {
      const pureRepo = new SessionRepository(pureDb);
      pureRepo.create({ summary: "pure-unit-search" });
      const results = pureSvc.search("pure-unit-search");
      expect(results.length).toBe(1);
    });
  });
});
