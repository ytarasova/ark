import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { CodeIntelStore, DEFAULT_TENANT_ID } from "../store.js";
import { getContextQuery } from "../queries/get-context.js";

let db: BunSqliteAdapter;
let store: CodeIntelStore;
let repoId: string;
let fileId: string;
let symbolId: string;
let personId: string;

beforeAll(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  store = new CodeIntelStore(db);
  await store.migrate();
  const repo = await store.createRepo({ tenant_id: DEFAULT_TENANT_ID, repo_url: "file:///ctx", name: "ctx" });
  repoId = repo.id;
  const run = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
  const f = await store.insertFile({
    tenant_id: DEFAULT_TENANT_ID,
    repo_id: repoId,
    path: "lib/auth.ts",
    sha: "1",
    language: "typescript",
    indexing_run_id: run.id,
  });
  fileId = f.id;
  const sym = await store.insertSymbol({
    tenant_id: DEFAULT_TENANT_ID,
    file_id: fileId,
    kind: "function",
    name: "authenticate",
    indexing_run_id: run.id,
  });
  symbolId = sym.id;
  const person = await store.upsertPerson({
    tenant_id: DEFAULT_TENANT_ID,
    primary_email: "ada@example.com",
    name: "Ada",
  });
  personId = person.id;
  await store.insertContribution({
    tenant_id: DEFAULT_TENANT_ID,
    person_id: personId,
    repo_id: repoId,
    file_id: fileId,
    commit_count: 12,
    loc_added: 200,
    loc_removed: 30,
    indexing_run_id: run.id,
  });
});

afterAll(async () => {
  await db.close();
});

describe("getContextQuery", async () => {
  it("resolves by file id and returns symbols + contributors", async () => {
    const result = await getContextQuery.run({ tenant_id: DEFAULT_TENANT_ID, store }, { subject: fileId });
    expect(result.file?.path).toBe("lib/auth.ts");
    expect(result.symbols_in_file.length).toBe(1);
    expect(result.symbols_in_file[0].name).toBe("authenticate");
    expect(result.top_contributors.length).toBe(1);
    expect(result.top_contributors[0].commit_count).toBe(12);
  });

  it("resolves by file path when repo_id is supplied", async () => {
    const result = await getContextQuery.run(
      { tenant_id: DEFAULT_TENANT_ID, store },
      { subject: "lib/auth.ts", repo_id: repoId },
    );
    expect(result.file?.id).toBe(fileId);
  });

  it("resolves by symbol name", async () => {
    const result = await getContextQuery.run({ tenant_id: DEFAULT_TENANT_ID, store }, { subject: "authenticate" });
    expect(result.file?.id).toBe(fileId);
  });

  it("returns empty result when no match", async () => {
    const result = await getContextQuery.run(
      { tenant_id: DEFAULT_TENANT_ID, store },
      { subject: "nonexistent-symbol-or-path" },
    );
    expect(result.file).toBeNull();
    expect(result.symbols_in_file.length).toBe(0);
  });

  it("includes dependents_count from inbound edges", async () => {
    // Add an inbound edge to a symbol; expect dependents_count >= 1.
    const run2 = await store.beginIndexingRun({ tenant_id: DEFAULT_TENANT_ID, repo_id: repoId, branch: "main" });
    const callerSym = await store.insertSymbol({
      tenant_id: DEFAULT_TENANT_ID,
      file_id: fileId,
      kind: "function",
      name: "caller",
      indexing_run_id: run2.id,
    });
    await store.insertEdge({
      tenant_id: DEFAULT_TENANT_ID,
      source_kind: "symbol",
      source_id: callerSym.id,
      target_kind: "symbol",
      target_id: symbolId,
      relation: "calls",
      indexing_run_id: run2.id,
    });
    const result = await getContextQuery.run({ tenant_id: DEFAULT_TENANT_ID, store }, { subject: fileId });
    expect(result.dependents_count).toBeGreaterThanOrEqual(1);
  });
});
