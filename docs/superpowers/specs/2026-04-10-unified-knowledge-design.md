# Unified Knowledge Store -- Design Spec

## Problem

Ark has 7 disconnected knowledge systems (memories, transcripts, events, learnings, skills, claude session cache, codebase). Agents start each session blind -- they grep and pray instead of understanding the codebase, past work, and team knowledge. Information that exists in the system is invisible to the agent.

## Solution

One unified knowledge store where codebase structure, session history, memories, learnings, and skills are all nodes in the same graph. Agents query one interface and get everything relevant -- code dependencies, past sessions that touched the same files, team knowledge, and applicable skills -- without context switching.

## Data Model

### Nodes

```sql
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_knowledge_type ON knowledge(tenant_id, type);
CREATE INDEX idx_knowledge_label ON knowledge(tenant_id, label);
```

Node types:

| Type | What it represents | Source |
|------|--------------------|--------|
| `file` | A source file in the repo | Codebase indexer (tree-sitter) |
| `symbol` | A function, class, or export | Codebase indexer |
| `session` | A past Ark session | SessionRepository (reference) |
| `memory` | A persistent fact or decision | Migrated from memories.json |
| `learning` | A recurring pattern | Migrated from LEARNINGS.md |
| `skill` | A reusable procedure | SkillStore (reference) |
| `recipe` | A session template | RecipeStore (reference) |
| `agent` | An agent role definition | AgentStore (reference) |

### Edges

```sql
CREATE TABLE knowledge_edges (
  source_id TEXT NOT NULL REFERENCES knowledge(id),
  target_id TEXT NOT NULL REFERENCES knowledge(id),
  relation TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation)
);

CREATE INDEX idx_edges_source ON knowledge_edges(tenant_id, source_id);
CREATE INDEX idx_edges_target ON knowledge_edges(tenant_id, target_id);
CREATE INDEX idx_edges_relation ON knowledge_edges(relation);
```

Edge types:

| Relation | Meaning | Example |
|----------|---------|---------|
| `depends_on` | Code dependency | file:login.ts depends_on file:jwt.ts |
| `imports` | Symbol import | symbol:validateToken imports symbol:decodeJWT |
| `modified_by` | Session changed this file | file:login.ts modified_by session:s-abc |
| `learned_from` | Knowledge from a session | memory:"use JWT" learned_from session:s-abc |
| `relates_to` | Semantic relationship | memory:"auth needs review" relates_to file:login.ts |
| `uses` | Agent/session uses skill | agent:implementer uses skill:security-scan |
| `extracted_from` | Skill came from session | skill:auth-review extracted_from session:s-abc |
| `co_changes` | Files that change together | file:login.ts co_changes file:session.ts (weight=0.8) |

## Codebase Indexing

### Indexer: Axon as subprocess

Axon (MIT licensed) handles the heavy lifting of parsing 33+ languages via tree-sitter. We call it as a subprocess and pipe its output into our knowledge table. Axon is the parser, we own the storage.

If Axon isn't installed, we fall back to basic file-level indexing (no symbol extraction -- just file nodes with import regex patterns).

```ts
async function indexCodebase(repoPath: string, store: KnowledgeStore) {
  // Axon is required -- 33+ language support via tree-sitter
  const axonPath = await which("axon");
  if (!axonPath) {
    throw new Error("Axon is required for codebase indexing. Install: pip install axoniq");
  }
  const result = execFileSync("axon", ["analyze", "--json", "--project-root", repoPath]);
  const graph = JSON.parse(result);
  for (const node of graph.nodes) store.addNode(mapAxonNode(node));
  for (const edge of graph.edges) store.addEdge(mapAxonEdge(edge));
}
```

### When it runs

1. **At dispatch time** -- if the repo hasn't been indexed yet, or index is stale (>1 hour old)
2. **On session completion** -- re-index changed files to update the graph
3. **Manual** -- `ark index --codebase` command
4. **Prerequisite check** -- `ark doctor` verifies Axon is installed

### What gets indexed

**Via Axon (required):**
- Files: path, size, language, last modified
- Symbols: functions, classes, interfaces, exports -- name, kind, line range
- Dependencies: import/require/from statements -- full dependency chain
- Call graphs: which functions call which
- 33+ languages via tree-sitter

**Additionally (Ark adds on top of Axon output):**
- Co-change history: `git log --format="%H" --name-only` analysis -- files that change together get `co_changes` edges with frequency-based weight

### How it stores

Each file becomes a `type=file` node. Each exported symbol becomes a `type=symbol` node. Import relationships become `depends_on` or `imports` edges.

```
file:src/auth/login.ts
  metadata: { language: "typescript", lines: 150, last_modified: "2026-04-09" }
  
symbol:src/auth/login.ts::validateToken
  metadata: { kind: "function", line_start: 45, line_end: 72, exported: true }

edge: file:src/auth/login.ts --depends_on--> file:src/lib/jwt.ts
edge: symbol:login.ts::validateToken --imports--> symbol:jwt.ts::decodeJWT
```

### Incremental updates

After a session completes:
1. Get changed files from `git diff`
2. Re-index only those files (delete old nodes/edges for those files, create new)
3. Add `modified_by` edges linking changed files to the session node

## Session Knowledge

When a session completes, the system automatically:

1. Creates a `type=session` node with summary, outcome, duration, cost
2. Creates `modified_by` edges from each changed file to the session
3. Extracts learnings (via skill-extractor pattern) -> `type=learning` nodes with `learned_from` edges
4. If skills were extracted -> `type=skill` nodes with `extracted_from` edges

This means the graph naturally accumulates project history. After 100 sessions, the graph knows which files are hot (many `modified_by` edges), which areas are problematic (sessions with `failed` outcomes), and what the team has learned.

## Memory Migration

On first boot with the unified store:

1. Read `memories.json` (if exists)
2. For each memory entry, create a `type=memory` node
3. Tag-based relationships: if memory has tags matching file paths, create `relates_to` edges
4. Delete `memories.json` (data now in DB)

Same for `LEARNINGS.md` -> `type=learning` nodes.

## Skill/Recipe/Agent References

Skills, recipes, and agents stay as YAML files (SkillStore, RecipeStore, AgentStore). The knowledge graph stores lightweight reference nodes that link them to the rest of the graph.

When a skill is used in a session, a `uses` edge connects them. When a recipe produces a session, a `created_from` edge connects them. This builds up a usage graph over time -- showing which skills are effective, which recipes produce successful sessions.

## Query Interface

### KnowledgeStore (on AppContext)

```ts
interface KnowledgeStore {
  // Node CRUD
  addNode(node: { type: string; label: string; content?: string; metadata?: Record<string, unknown> }): string;
  getNode(id: string): KnowledgeNode | null;
  removeNode(id: string): void;

  // Edge CRUD
  addEdge(sourceId: string, targetId: string, relation: string, weight?: number): void;
  removeEdge(sourceId: string, targetId: string, relation?: string): void;

  // Traversal
  neighbors(id: string, opts?: {
    relation?: string;
    direction?: "out" | "in" | "both";
    maxDepth?: number;
    types?: string[];
  }): KnowledgeNode[];

  // Search (full-text across all node types)
  search(query: string, opts?: {
    types?: string[];
    limit?: number;
  }): Array<KnowledgeNode & { score: number }>;

  // Context building (the main entry point for agents)
  buildContext(task: string, opts?: {
    repo?: string;
    files?: string[];       // specific files being worked on
    sessionId?: string;     // current session (to exclude from results)
    limit?: number;
  }): ContextPackage;
}

interface ContextPackage {
  files: Array<{ path: string; dependents: number; recentSessions: string[] }>;
  memories: Array<{ content: string; importance: number }>;
  sessions: Array<{ id: string; summary: string; outcome: string; filesChanged: string[] }>;
  learnings: Array<{ title: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
}
```

### MCP Server Tools (for agents)

```
knowledge/search <query>
  Full-text search across all knowledge types.
  Returns: nodes with scores, grouped by type.

knowledge/context <file_path>
  Everything known about a file: dependencies, past sessions, memories, learnings.
  Returns: node + 2-hop neighborhood.

knowledge/impact <file_path>
  What breaks if this file changes. Walks depends_on edges outward.
  Returns: list of dependent files with impact scores.

knowledge/history <file_path>
  Past sessions that modified this file. What changed, what was the outcome.
  Returns: session nodes linked by modified_by edges.

knowledge/remember <content> [tags...]
  Store a new memory. Optionally link to files via tags.
  Returns: memory node id.

knowledge/recall <query>
  Search memories and learnings specifically.
  Returns: ranked memory/learning nodes.
```

## Context Injection at Dispatch

When `dispatch()` runs:

1. Check if codebase is indexed (if not, run indexer)
2. Call `knowledgeStore.buildContext(task, { repo, files: worktreeFiles })`
3. Format the ContextPackage into markdown
4. Prepend to the agent's task prompt

The agent starts with full context -- no grep needed for orientation.

## What Gets Replaced

| Old system | Replaced by | Migration |
|-----------|-------------|-----------|
| `memories.json` | `knowledge` table (type=memory) | Auto-migrate on boot |
| `LEARNINGS.md` / `POLICY.md` | `knowledge` table (type=learning) | Auto-migrate on boot |
| `recall()` in memory.ts | `KnowledgeStore.search({types: ["memory"]})` | Same API, new backend |
| `queryKnowledge()` | `KnowledgeStore.search({types: ["memory"]})` with scope | Merged |
| `hybridSearch()` | `KnowledgeStore.search()` (all types) | One system, not three |
| `knowledge.ts` ingestion | `KnowledgeStore.addNode(type=memory)` | Simplified |
| Codebase awareness | `file` + `symbol` nodes from indexer | New capability |
| Session-to-file tracking | `modified_by` edges | New capability |
| Skill-to-session tracking | `extracted_from` edges | New capability |

## What Stays

| System | Why it stays |
|--------|-------------|
| `sessions` table | Source of truth for session state. Knowledge node is a reference. |
| `events` table | Transaction log for orchestration. Not duplicated. |
| `transcript_index` (FTS5) | Fast full-text search of Claude transcripts. Feeds into knowledge search. |
| `claude_sessions_cache` | Metadata cache for `.claude/projects/`. Feeds indexer. |
| Skill/Recipe/Agent YAML files | Source of truth for definitions. Knowledge nodes are references. |

## Scale

| Deployment | Storage | Expected size | Query speed |
|-----------|---------|--------------|-------------|
| Local (1 dev) | SQLite | ~50K nodes | <5ms |
| Small team (10) | SQLite | ~200K nodes | <10ms |
| Hosted (100 tenants) | Postgres | ~8.5M nodes | <15ms (indexed) |
| Enterprise (1000 tenants) | Postgres partitioned | ~100M nodes | <20ms (partitioned) |

Graph traversal (2-3 hops) uses recursive CTEs, depth-limited. Full-text search uses FTS5 (SQLite) or tsvector (Postgres).

## Prerequisites & Provisioning

### Local mode
`ark doctor` checks for Axon and reports if missing:
```
+ Bun 1.3+
+ tmux
+ git
+ Claude CLI
+ Axon (codebase indexer)    <-- NEW
```

Install: `pip install axoniq` or `uvx axoniq`

### Control plane (Docker/K8s)
Axon must be pre-installed in the Docker image:
```dockerfile
# In Dockerfile
RUN pip install axoniq
```

The Helm chart values should include Axon as a required tool:
```yaml
# values.yaml
prerequisites:
  axon: true    # install axoniq in the image
```

### Worker nodes
Workers that run agent sessions also need Axon (agents may call `ark index --codebase` during execution). The worker Docker image inherits from the same base image.

## File Structure

```
packages/core/
  knowledge-store.ts          -- KnowledgeStore interface + SQLite implementation
  knowledge-indexer.ts        -- Codebase indexer (calls Axon + git log)
  knowledge-mcp.ts            -- MCP server exposing knowledge tools
  knowledge-migration.ts      -- Migrate memories.json + LEARNINGS.md
  __tests__/
    knowledge-store.test.ts
    knowledge-indexer.test.ts
```

## Success Criteria

1. Agent working on a bug gets relevant past sessions, memories, and file dependencies in its initial prompt -- without asking
2. `ark knowledge search "auth"` returns files, memories, sessions, learnings in one result set
3. Memories and learnings are stored in the DB, not flat files
4. Codebase is indexed at dispatch time, not on every file read
5. Session completion auto-creates knowledge edges (file→session, session→learning)
6. Works with both SQLite (local) and Postgres (hosted)
