import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database-sqlite.js";
import type { IDatabase } from "../../database.js";
import { HistoryService } from "../history.js";
import { SessionRepository } from "../../repositories/session.js";
import { initSchema } from "../../repositories/schema.js";

let db: IDatabase;
let sessionRepo: SessionRepository;
let svc: HistoryService;

beforeEach(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  initSchema(db);
  sessionRepo = new SessionRepository(db);
  svc = new HistoryService(db);
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
});
