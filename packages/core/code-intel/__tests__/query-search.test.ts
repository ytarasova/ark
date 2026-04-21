import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";
import { searchQuery } from "../queries/search.js";

let db: BunSqliteAdapter;
let store: CodeIntelStore;
let runId: string;
let fileId: string;

beforeAll(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  await store.migrate();
  const repo = await store.createRepo({
    tenant_id: DEFAULT_TENANT_ID,
    repo_url: "file:///search",
    name: "search",
  });
  const run = await store.beginIndexingRun({
    tenant_id: DEFAULT_TENANT_ID,
    repo_id: repo.id,
    branch: "main",
  });
  runId = run.id;
  const f = await store.insertFile({
    tenant_id: DEFAULT_TENANT_ID,
    repo_id: repo.id,
    path: "src/cool.ts",
    sha: "1",
    indexing_run_id: runId,
  });
  fileId = f.id;
  await store.insertChunk({
    tenant_id: DEFAULT_TENANT_ID,
    file_id: fileId,
    content: "function authenticateUser(username, password) {}",
    indexing_run_id: runId,
    path_hint: "src/cool.ts",
    symbol_name: "authenticateUser",
  });
  await store.insertChunk({
    tenant_id: DEFAULT_TENANT_ID,
    file_id: fileId,
    content: "const PI = 3.14159;",
    indexing_run_id: runId,
    path_hint: "src/cool.ts",
    symbol_name: "PI",
  });
});

afterAll(async () => {
  await db.close();
});

describe("searchQuery", async () => {
  it("matches a known token", async () => {
    const hits = await searchQuery.run({ tenant_id: DEFAULT_TENANT_ID, store }, { query: "authenticateUser" });
    expect(hits.length).toBe(1);
    expect(hits[0].content_preview).toContain("authenticateUser");
  });

  it("returns empty for nonsense", async () => {
    const hits = await searchQuery.run({ tenant_id: DEFAULT_TENANT_ID, store }, { query: "xyzzy_no_match_here" });
    expect(hits.length).toBe(0);
  });

  it("respects the limit option", async () => {
    const hits = await searchQuery.run({ tenant_id: DEFAULT_TENANT_ID, store }, { query: "function", limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("declares query metadata", () => {
    expect(searchQuery.name).toBe("search");
    expect(searchQuery.scope).toBe("read");
    expect(searchQuery.cost).toBe("cheap");
  });
});
