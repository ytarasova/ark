# Unified Knowledge Graph

**Goal:** Converge sessions, memories, codebase structure, and learnings into a single queryable knowledge graph. Agents get full context -- code architecture, past sessions, team knowledge -- without grep-ing and praying.

---

## Current State (fragmented)

| Knowledge type | Where it lives | How agents access it |
|---------------|---------------|---------------------|
| Codebase structure | Nowhere | grep/read files blindly |
| Past sessions | SQLite events table | Not accessible to agents |
| Memories | memories.json | Keyword matching at dispatch |
| Transcripts | JSONL files + FTS5 | ark search (manual) |
| Learnings | conductor file | Injected after 3 occurrences |
| Skills | YAML files | Injected into system prompt |

## Target: Unified Graph

All knowledge in one graph. Agents query it via MCP tools.

```
┌─────────────────────────────────────────────────┐
│                Knowledge Graph                   │
│                                                 │
│  Code Nodes        Session Nodes    Memory Nodes│
│  ├── file           ├── session      ├── fact   │
│  ├── symbol         ├── event        ├── pattern│
│  ├── dependency     ├── outcome      └── rule   │
│  └── module         └── diff                    │
│                                                 │
│  Edges:                                         │
│  session → modified → file                      │
│  memory → relates_to → symbol                   │
│  session → learned → memory                     │
│  file → depends_on → file                       │
│  session → child_of → session (fan-out)         │
└─────────────────────────────────────────────────┘
         ↕ MCP Tools
    Agent queries graph
```

## Implementation Plan

### Phase 1: Axon MCP Integration (immediate -- 1 day)

Use Axon (MIT licensed) as the codebase graph engine. It already has MCP tools.

**`mcp-configs/axon.json`**
```json
{
  "mcpServers": {
    "axon": {
      "command": "uvx",
      "args": ["axoniq"],
      "env": {
        "AXON_PROJECT_ROOT": "${REPO_ROOT}"
      }
    }
  }
}
```

**Add to SDLC flow** as a pre-dispatch step:
```yaml
stages:
  - name: index
    action: index_codebase     # runs axon index
    gate: auto
  - name: plan
    agent: planner
    mcp_servers: [axon]        # planner queries the graph
```

**Agent can now ask:**
- "What files are affected if I change UserService?"
- "Show me all callers of processPayment()"
- "What changed in the last 5 sessions on this repo?"

### Phase 2: Session Knowledge Nodes (2-3 days)

Connect session history to the graph. After each session completes, index:
- Files changed (from git diff)
- Symbols modified
- Test results (pass/fail)
- PR URL
- Duration, cost

**`packages/core/knowledge-graph.ts`**
```ts
export interface KnowledgeNode {
  id: string;
  type: "file" | "symbol" | "session" | "memory" | "skill" | "learning";
  label: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeEdge {
  source: string;
  target: string;
  relation: "modified" | "depends_on" | "relates_to" | "learned" | "child_of" | "extracted_from";
  metadata?: Record<string, unknown>;
}

export class KnowledgeGraph {
  constructor(private db: DatabaseAdapter) {}

  addNode(node: KnowledgeNode): void;
  addEdge(edge: KnowledgeEdge): void;
  query(pattern: { type?: string; label?: string; related_to?: string }): KnowledgeNode[];
  neighbors(nodeId: string, relation?: string): KnowledgeNode[];
  path(fromId: string, toId: string): KnowledgeNode[];

  // Convenience methods
  getFileHistory(filePath: string): Array<{ session: Session; diff: string; timestamp: string }>;
  getRelatedMemories(filePath: string): Memory[];
  getSessionImpact(sessionId: string): Array<{ file: string; symbols: string[] }>;
}
```

**Schema:**
```sql
CREATE TABLE knowledge_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL REFERENCES knowledge_nodes(id),
  target TEXT NOT NULL REFERENCES knowledge_nodes(id),
  relation TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_edges_source ON knowledge_edges(source);
CREATE INDEX idx_edges_target ON knowledge_edges(target);
CREATE INDEX idx_nodes_type ON knowledge_nodes(type);
CREATE INDEX idx_nodes_tenant ON knowledge_nodes(tenant_id);
```

### Phase 3: Memory → Graph Migration (1-2 days)

Move memories from flat JSON to graph nodes. Each memory becomes a node, linked to:
- Sessions it was created from
- Files/symbols it relates to
- Other memories in the same scope

**Replace:** `~/.ark/memories.json` → `knowledge_nodes` table with type="memory"

**Recall becomes graph traversal:**
```ts
// Old: keyword matching
const relevant = memories.filter(m => m.content.includes(keyword));

// New: graph query -- find memories related to files being touched
const filesTouched = getModifiedFiles(session);
const related = graph.query({
  type: "memory",
  related_to: filesTouched.map(f => `file:${f}`),
});
```

### Phase 4: MCP Server for Knowledge Graph (1-2 days)

Expose the unified graph as an MCP server so agents can query it.

**Tools:**
- `knowledge/search` -- full-text search across all node types
- `knowledge/file-history` -- what sessions touched this file
- `knowledge/impact-analysis` -- what would break if I change X
- `knowledge/related-memories` -- memories related to the current task
- `knowledge/session-context` -- what happened in a prior session

**This replaces:** the current `ark search`, `ark memory recall`, and ad-hoc transcript searching with a single unified query interface.

### Phase 5: Auto-Indexing Pipeline (ongoing)

After every session completes:
1. Extract changed files (git diff)
2. Extract modified symbols (tree-sitter parse)
3. Create session node + file nodes + edges
4. Extract learnings → memory nodes
5. Link to codebase graph (Axon)

This runs automatically via the conductor's completion hook -- no manual indexing needed.

## How it changes agent behavior

**Before (grep and pray):**
```
Agent: I need to fix the login bug
→ grep -r "login" . (reads 50 files)
→ reads 5 files that look relevant
→ misses the auth middleware dependency
→ fix breaks because it didn't know about the session validator
```

**After (knowledge-aware):**
```
Agent: I need to fix the login bug
→ knowledge/search "login"
  → file:auth/login.ts (PageRank: high, 12 dependents)
  → file:middleware/session.ts (co-changes with login.ts 80% of the time)
  → memory: "login flow was refactored in session s-abc123, moved to JWT"
  → session:s-abc123 touched login.ts, session.ts, added JWT deps
→ Agent reads exactly the right files with full context
→ Fix works because it understood the dependency chain
```
