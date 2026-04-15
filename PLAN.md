# PLAN: Fix Knowledge Graph Pipeline -- Codegraph Indexes

## Summary

The knowledge graph indexing pipeline crashes with `UNIQUE constraint failed: knowledge.id` when indexing any non-trivial codebase. The root cause is twofold: (1) `KnowledgeStore.addNode()` uses plain `INSERT INTO` with no conflict handling, and (2) symbol IDs are constructed as `symbol:${file}::${name}` which is not unique -- codegraph produces many symbols with the same (file, name) pair (e.g., 50 `app` parameters across different functions in `session-orchestration.ts`). The fix makes `addNode` idempotent via `INSERT OR REPLACE` and includes the line number in symbol IDs for uniqueness.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/knowledge/store.ts:38` | Change `INSERT INTO knowledge` to `INSERT OR REPLACE INTO knowledge` in `addNode()` |
| `packages/core/knowledge/indexer.ts:129,145,174-175` | Include line number in nodeIdMap and symbol ID: `symbol:${file}::${name}:${line}` |
| `packages/core/services/session-orchestration.ts:66,77-78` | Include line number in `ingestRemoteIndex` symbol IDs |
| `packages/core/__tests__/integration-wiring.test.ts:217,229,234` | Update symbol ID expectations to include line number |
| `packages/core/knowledge/__tests__/indexer.test.ts:83,90` | Update `getNode` calls to use new symbol ID format |

## Implementation steps

### Step 1: Make `addNode` idempotent (store.ts)

In `packages/core/knowledge/store.ts`, line 38, change:
```sql
INSERT INTO knowledge (id, type, label, content, metadata, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```
to:
```sql
INSERT OR REPLACE INTO knowledge (id, type, label, content, metadata, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

This is the critical crash fix. It makes `addNode` safe to call with an existing ID -- the node gets upserted instead of throwing.

### Step 2: Fix symbol ID uniqueness in indexer (indexer.ts)

In `packages/core/knowledge/indexer.ts`:

**Line 129** -- add `line` to the nodeIdMap value:
```ts
// Before:
nodeIdMap.set(node.id, { kind: node.kind, name: node.name, file: node.file });
// After:
nodeIdMap.set(node.id, { kind: node.kind, name: node.name, file: node.file, line: node.line });
```

**Line 145** -- include line number in symbol ID:
```ts
// Before:
const symbolId = `symbol:${node.file}::${node.name}`;
// After:
const symbolId = `symbol:${node.file}::${node.name}:${node.line}`;
```

**Lines 174-175** -- update edge source/target IDs:
```ts
// Before:
const sourceId = `symbol:${src.file}::${src.name}`;
const targetId = `symbol:${tgt.file}::${tgt.name}`;
// After:
const sourceId = `symbol:${src.file}::${src.name}:${src.line}`;
const targetId = `symbol:${tgt.file}::${tgt.name}:${tgt.line}`;
```

### Step 3: Fix symbol ID uniqueness in remote ingestion (session-orchestration.ts)

In `packages/core/services/session-orchestration.ts`, function `ingestRemoteIndex()`:

**Line 66** -- change symbol ID:
```ts
// Before:
id: `symbol:${node.file}::${node.name}`,
// After:
id: `symbol:${node.file}::${node.name}:${node.line}`,
```

**Lines 77-78** -- change edge source/target IDs:
```ts
// Before:
`symbol:${srcNode.file}::${srcNode.name}`,
`symbol:${tgtNode.file}::${tgtNode.name}`,
// After:
`symbol:${srcNode.file}::${srcNode.name}:${srcNode.line}`,
`symbol:${tgtNode.file}::${tgtNode.name}:${tgtNode.line}`,
```

### Step 4: Update tests

**`packages/core/knowledge/__tests__/indexer.test.ts`:**
- Line 83: `store.getNode("symbol:src/app.ts::boot")` -> `store.getNode("symbol:src/app.ts::boot:10")`
- Line 90: `store.getNode("symbol:src/db.ts::Database")` -> `store.getNode("symbol:src/db.ts::Database:5")`

**`packages/core/__tests__/integration-wiring.test.ts`:**
- Line 217: `` id: `symbol:${node.file}::${node.name}` `` -> `` id: `symbol:${node.file}::${node.name}:${node.line}` ``
- Line 229: `store.getNode("symbol:src/app.ts::boot")` -> `store.getNode("symbol:src/app.ts::boot:10")`
- Line 234: `store.getNode("symbol:src/db.ts::Database")` -> `store.getNode("symbol:src/db.ts::Database:5")`

### Step 5: Verify

1. `make test-file F=packages/core/knowledge/__tests__/indexer.test.ts`
2. `make test-file F=packages/core/knowledge/__tests__/store.test.ts`
3. `make test-file F=packages/core/__tests__/integration-wiring.test.ts`
4. Run `ark knowledge index --repo /Users/paytmlabs/Projects/ark` -- must succeed (was crashing before)
5. Run `ark knowledge stats` -- verify nodes and edges are populated
6. Run `ark knowledge index --repo /Users/paytmlabs/Projects/ark` again -- must succeed (re-index upsert path)

## Testing strategy

- **Existing tests**: All 10 indexer tests, 45 store tests, 12 context tests, integration-wiring tests should still pass after updates.
- **New regression test**: Add a test in `indexer.test.ts` that verifies indexing a codegraph DB with duplicate (file, name) pairs does not crash. Insert two mock nodes with the same file and name but different line numbers, verify both appear as separate knowledge nodes.
- **Idempotency test**: Add a test in `store.test.ts` that calls `addNode` twice with the same ID and verifies upsert behavior (no throw, second call updates the node).
- **E2E**: Run `ark knowledge index` on the actual Ark repo (9847 nodes, 738 files) to verify it completes without error.

## Risk assessment

- **Knowledge graph data reset**: Changing the symbol ID format from `symbol:file::name` to `symbol:file::name:line` means existing indexed data becomes orphaned. Since the schema docs say "rm ~/.ark/ark.db" is the migration strategy and knowledge is fully re-indexable, this is acceptable. No production data at risk.
- **Edge mapping correctness**: With line-number-based IDs, edges connect specific symbol instances rather than "any symbol named X in file Y". This is more correct -- an edge from codegraph that says node 42 calls node 87 maps to those specific symbols.
- **INSERT OR REPLACE on addNode**: Safe because all ID-bearing callers use deterministic IDs where upsert is the desired behavior. Random-ID callers (memory/add, knowledge/remember) generate UUIDs that won't collide.
- **No breaking API changes**: MCP tools (`knowledge/search`, `knowledge/context`, etc.) search by label/content, not by ID format. The context builder also searches by label. No external API depends on the symbol ID format.
- **PostgreSQL compatibility**: `INSERT OR REPLACE` is SQLite syntax. The IDatabase abstraction handles this -- check that the Postgres adapter has equivalent behavior. If it uses `ON CONFLICT DO UPDATE`, verify the migration. (Low risk: hosted mode uses DB-backed resource stores, not file-level knowledge indexing.)

## Open questions

None -- the fix is straightforward and all affected code paths are identified.
