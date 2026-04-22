# Unified Knowledge Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify codebase structure, session history, memories, learnings, and skills into a single queryable knowledge graph. Agents get full context at dispatch -- code dependencies, past sessions, team knowledge -- without grep-ing.

**Architecture:** Two SQL tables (`knowledge` nodes + `knowledge_edges`) in the existing DB via DatabaseAdapter. Axon (subprocess) indexes codebases. Memories and learnings migrate from flat files into the graph. MCP server exposes query tools to agents. Context package injected at dispatch time.

**Tech Stack:** TypeScript, Bun, SQLite/Postgres (via DatabaseAdapter), Axon (pip install axoniq), tree-sitter (via Axon)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/core/knowledge/store.ts` | Create | KnowledgeStore class -- CRUD for nodes + edges, search, traversal |
| `packages/core/knowledge/indexer.ts` | Create | Codebase indexer -- calls Axon, parses output, adds git co-change |
| `packages/core/knowledge/mcp.ts` | Create | MCP server tools for agent queries |
| `packages/core/knowledge/migration.ts` | Create | Migrate memories.json + LEARNINGS.md into knowledge table |
| `packages/core/knowledge/context.ts` | Create | buildContext() -- creates ContextPackage for dispatch injection |
| `packages/core/knowledge/types.ts` | Create | KnowledgeNode, KnowledgeEdge, ContextPackage types |
| `packages/core/knowledge/index.ts` | Create | Barrel exports |
| `packages/core/knowledge/__tests__/store.test.ts` | Create | Store CRUD + search + traversal tests |
| `packages/core/knowledge/__tests__/indexer.test.ts` | Create | Indexer tests (mock Axon output) |
| `packages/core/knowledge/__tests__/migration.test.ts` | Create | Migration tests |
| `packages/core/knowledge/__tests__/context.test.ts` | Create | Context building tests |
| `packages/core/app.ts` | Modify | Register KnowledgeStore on AppContext |
| `packages/core/container.ts` | Modify | Add knowledge to Cradle |
| `packages/core/repositories/schema.ts` | Modify | Add knowledge + knowledge_edges tables |
| `packages/core/services/session-orchestration.ts` | Modify | Inject context at dispatch, index on completion |
| `packages/core/prereqs.ts` | Modify | Add Axon to prerequisite checks |

---

### Task 1: Types

**Files:**
- Create: `packages/core/knowledge/types.ts`

- [ ] **Step 1: Create types file**

```ts
// packages/core/knowledge/types.ts

export interface KnowledgeNode {
  id: string;
  type: "file" | "symbol" | "session" | "memory" | "learning" | "skill" | "recipe" | "agent";
  label: string;
  content: string | null;
  metadata: Record<string, unknown>;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEdge {
  source_id: string;
  target_id: string;
  relation: "depends_on" | "imports" | "modified_by" | "learned_from" | "relates_to" | "uses" | "extracted_from" | "co_changes";
  weight: number;
  metadata: Record<string, unknown>;
  tenant_id: string;
  created_at: string;
}

export interface ContextPackage {
  files: Array<{
    path: string;
    language: string;
    dependents: number;
    recent_sessions: Array<{ id: string; summary: string; date: string }>;
  }>;
  memories: Array<{
    content: string;
    importance: number;
    scope: string;
  }>;
  sessions: Array<{
    id: string;
    summary: string;
    outcome: string;
    files_changed: string[];
    date: string;
  }>;
  learnings: Array<{
    title: string;
    description: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
  }>;
}

export type NodeType = KnowledgeNode["type"];
export type EdgeRelation = KnowledgeEdge["relation"];
```

- [ ] **Step 2: Create barrel export**

```ts
// packages/core/knowledge/index.ts
export * from "./types.js";
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/knowledge/
git commit -m "feat(knowledge): add types for unified knowledge store"
```

---

### Task 2: Schema

**Files:**
- Modify: `packages/core/repositories/schema.ts`

- [ ] **Step 1: Add knowledge tables to schema**

Add to `initSchema()` (or a new `initKnowledgeSchema()` called from it):

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_knowledge_label ON knowledge(tenant_id, label);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(tenant_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(relation);
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/repositories/schema.ts
git commit -m "feat(knowledge): add knowledge + knowledge_edges tables to schema"
```

---

### Task 3: KnowledgeStore

**Files:**
- Create: `packages/core/knowledge/store.ts`
- Create: `packages/core/knowledge/__tests__/store.test.ts`

- [ ] **Step 1: Write store tests**

Test: add/get/remove nodes, add/remove edges, neighbors traversal, search.

- [ ] **Step 2: Implement KnowledgeStore**

```ts
// packages/core/knowledge/store.ts
import type { DatabaseAdapter } from "../database.js";
import type { KnowledgeNode, KnowledgeEdge, NodeType, EdgeRelation } from "./types.js";

export class KnowledgeStore {
  constructor(private db: DatabaseAdapter, private tenantId: string = "default") {}

  setTenant(tenantId: string): void { this.tenantId = tenantId; }

  // Node CRUD
  addNode(opts: { id?: string; type: NodeType; label: string; content?: string; metadata?: Record<string, unknown> }): string;
  getNode(id: string): KnowledgeNode | null;
  updateNode(id: string, fields: Partial<Pick<KnowledgeNode, "label" | "content" | "metadata">>): void;
  removeNode(id: string): void;
  listNodes(opts?: { type?: NodeType; limit?: number }): KnowledgeNode[];

  // Edge CRUD
  addEdge(sourceId: string, targetId: string, relation: EdgeRelation, weight?: number, metadata?: Record<string, unknown>): void;
  removeEdge(sourceId: string, targetId: string, relation?: EdgeRelation): void;
  getEdges(nodeId: string, opts?: { relation?: EdgeRelation; direction?: "out" | "in" | "both" }): KnowledgeEdge[];

  // Traversal
  neighbors(id: string, opts?: {
    relation?: EdgeRelation;
    direction?: "out" | "in" | "both";
    maxDepth?: number;
    types?: NodeType[];
  }): KnowledgeNode[];

  // Search (LIKE-based for SQLite, tsvector for Postgres)
  search(query: string, opts?: {
    types?: NodeType[];
    limit?: number;
  }): Array<KnowledgeNode & { score: number }>;

  // Bulk operations
  clear(opts?: { type?: NodeType }): void;
  nodeCount(type?: NodeType): number;
  edgeCount(relation?: EdgeRelation): number;
}
```

Neighbors traversal uses iterative BFS up to `maxDepth` (default 2), not recursive CTE (simpler, works across SQLite and Postgres).

- [ ] **Step 3: Run tests**

Run: `make test-file F=packages/core/knowledge/__tests__/store.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/core/knowledge/
git commit -m "feat(knowledge): KnowledgeStore with CRUD, traversal, search"
```

---

### Task 4: Register on AppContext

**Files:**
- Modify: `packages/core/container.ts`
- Modify: `packages/core/app.ts`

- [ ] **Step 1: Add to Cradle**

In `packages/core/container.ts`, add `knowledge: KnowledgeStore` to the Cradle interface.

- [ ] **Step 2: Register in boot()**

In `packages/core/app.ts` boot(), after DB is open and schema initialized:
```ts
import { KnowledgeStore } from "./knowledge/store.js";
// ...
this._container.register({
  knowledge: asValue(new KnowledgeStore(db)),
});
```

Add accessor:
```ts
get knowledge(): KnowledgeStore { return this._resolve("knowledge"); }
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/container.ts packages/core/app.ts
git commit -m "feat(knowledge): register KnowledgeStore on AppContext"
```

---

### Task 5: Codebase Indexer

**Files:**
- Create: `packages/core/knowledge/indexer.ts`
- Create: `packages/core/knowledge/__tests__/indexer.test.ts`

- [ ] **Step 1: Write indexer**

```ts
// packages/core/knowledge/indexer.ts
import { execFileSync } from "child_process";
import type { KnowledgeStore } from "./store.js";

export interface IndexResult {
  files: number;
  symbols: number;
  edges: number;
  duration_ms: number;
}

/**
 * Index a codebase using Axon (required) + git co-change analysis.
 * Populates file and symbol nodes + dependency edges in the knowledge store.
 */
export async function indexCodebase(
  repoPath: string,
  store: KnowledgeStore,
  opts?: { incremental?: boolean; changedFiles?: string[] },
): Promise<IndexResult>;

/**
 * Check if Axon is installed.
 */
export function isAxonInstalled(): boolean;

/**
 * Index git co-change history. Files that change together get co_changes edges.
 */
export function indexCoChanges(repoPath: string, store: KnowledgeStore, opts?: { limit?: number }): number;

/**
 * After a session completes, create session node + modified_by edges.
 */
export function indexSessionCompletion(
  store: KnowledgeStore,
  sessionId: string,
  summary: string,
  outcome: string,
  changedFiles: string[],
): void;
```

The `indexCodebase` function:
1. Calls `axon analyze --json --project-root <repoPath>`
2. Parses JSON output (nodes + edges)
3. Maps Axon's schema to our KnowledgeNode/KnowledgeEdge types
4. If incremental: remove old nodes for changed files first, then re-add
5. Calls `indexCoChanges` to add co-change edges from git log

- [ ] **Step 2: Write tests (mock Axon output)**

Test with a mock Axon JSON response (don't require real Axon in tests).

- [ ] **Step 3: Run tests**

Run: `make test-file F=packages/core/knowledge/__tests__/indexer.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/core/knowledge/
git commit -m "feat(knowledge): codebase indexer with Axon + git co-change"
```

---

### Task 6: Memory/Learning Migration

**Files:**
- Create: `packages/core/knowledge/migration.ts`
- Create: `packages/core/knowledge/__tests__/migration.test.ts`

- [ ] **Step 1: Write migration**

```ts
// packages/core/knowledge/migration.ts
import type { KnowledgeStore } from "./store.js";

/**
 * Migrate memories.json into knowledge table.
 * Each memory becomes a type=memory node.
 * Tag-based relationships create relates_to edges.
 */
export function migrateMemories(store: KnowledgeStore, memoriesPath: string): { migrated: number };

/**
 * Migrate LEARNINGS.md + POLICY.md into knowledge table.
 * Each learning/policy becomes a type=learning node.
 */
export function migrateLearnings(store: KnowledgeStore, conductorDir: string): { migrated: number };

/**
 * Run all migrations. Called once on first boot with knowledge store.
 * Idempotent -- checks if migration already ran.
 */
export function runMigrations(store: KnowledgeStore, arkDir: string): void;
```

- [ ] **Step 2: Write tests**

- [ ] **Step 3: Run tests, commit**

---

### Task 7: Context Builder

**Files:**
- Create: `packages/core/knowledge/context.ts`
- Create: `packages/core/knowledge/__tests__/context.test.ts`

- [ ] **Step 1: Write context builder**

```ts
// packages/core/knowledge/context.ts
import type { KnowledgeStore } from "./store.js";
import type { ContextPackage } from "./types.js";

/**
 * Build a context package for an agent about to work on a task.
 * Queries the knowledge graph for relevant files, memories, sessions, learnings, skills.
 */
export function buildContext(
  store: KnowledgeStore,
  task: string,
  opts?: {
    repo?: string;
    files?: string[];
    sessionId?: string;  // exclude current session
    limit?: number;      // max items per category (default 10)
  },
): ContextPackage;

/**
 * Format a ContextPackage as markdown for injection into agent prompts.
 */
export function formatContextAsMarkdown(ctx: ContextPackage): string;
```

The `buildContext` function:
1. Text search on task keywords across all node types
2. If `files` provided, get their neighbors (deps, sessions, memories)
3. Rank by: edge weight x recency x relevance score
4. Group into ContextPackage categories
5. Limit each category

- [ ] **Step 2: Write tests, run, commit**

---

### Task 8: MCP Server

**Files:**
- Create: `packages/core/knowledge/mcp.ts`

- [ ] **Step 1: Write MCP tools**

Expose these tools for agents:
- `knowledge/search` -- full-text search across all types
- `knowledge/context` -- everything about a file (deps, sessions, memories)
- `knowledge/impact` -- blast radius of changing a file
- `knowledge/history` -- past sessions that modified a file
- `knowledge/remember` -- store a new memory
- `knowledge/recall` -- search memories and learnings

- [ ] **Step 2: Register MCP server in channel config**

When dispatching, include the knowledge MCP server in the agent's MCP config.

- [ ] **Step 3: Commit**

---

### Task 9: Wire into Dispatch

**Files:**
- Modify: `packages/core/services/session-orchestration.ts`

- [ ] **Step 1: Inject context at dispatch**

In `dispatch()`, after resolving the agent but before launching:
```ts
// Index codebase if stale
if (app.knowledge && session.workdir) {
  const { indexCodebase, isAxonInstalled } = await import("../knowledge/indexer.js");
  if (isAxonInstalled()) {
    await indexCodebase(session.workdir, app.knowledge);
  }
}

// Build context package
if (app.knowledge) {
  const { buildContext, formatContextAsMarkdown } = await import("../knowledge/context.js");
  const ctx = buildContext(app.knowledge, task, { repo: session.repo, files: worktreeFiles });
  const contextMd = formatContextAsMarkdown(ctx);
  task = contextMd + "\n\n" + task;
}
```

- [ ] **Step 2: Index on session completion**

After a session completes (in `applyReport` or completion handler):
```ts
if (app.knowledge && session.workdir) {
  const { indexSessionCompletion } = await import("../knowledge/indexer.js");
  const changedFiles = getChangedFiles(session.workdir);
  indexSessionCompletion(app.knowledge, session.id, session.summary, "completed", changedFiles);
}
```

- [ ] **Step 3: Commit**

---

### Task 10: CLI + Prerequisite Check

**Files:**
- Modify: `packages/core/prereqs.ts`
- Create: `packages/cli/commands/knowledge.ts`

- [ ] **Step 1: Add Axon to doctor**

```ts
// Check for Axon
try {
  execFileSync("axon", ["--version"], { stdio: "pipe" });
  console.log("+ Axon (codebase indexer)");
} catch {
  console.log("- Axon not found. Install: pip install axoniq");
}
```

- [ ] **Step 2: Add CLI commands**

```bash
ark knowledge search <query>          # search across all knowledge
ark knowledge index [--repo <path>]   # index/re-index codebase
ark knowledge stats                   # node/edge counts by type
ark knowledge remember <content>      # add a memory
ark knowledge recall <query>          # search memories
```

- [ ] **Step 3: Commit**

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Types + barrel export | -- |
| 2 | Schema (knowledge + knowledge_edges tables) | -- |
| 3 | KnowledgeStore (CRUD, traversal, search) | Yes |
| 4 | Register on AppContext | -- |
| 5 | Codebase indexer (Axon + git co-change) | Yes |
| 6 | Memory/learning migration | Yes |
| 7 | Context builder | Yes |
| 8 | MCP server for agents | -- |
| 9 | Wire into dispatch + completion | -- |
| 10 | CLI + Axon prerequisite | -- |
