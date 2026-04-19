# Code Intelligence Design -- 2026-04-18

> **Companion to** `2026-04-18-REQUIREMENTS_RECONCILIATION.md` + `2026-04-18-UNIFIED_SUMMARY.md`.
> **Status:** design proposal, no code changes.
> **Goal:** minimize tokens consumed by agent queries while giving accurate code understanding. Deliver via hybrid (system-prompt repo-map + pooled MCP drilldown) routed through conductor/arkd.

## 1. Decision summary

- **Delivery mechanism:** **hybrid** -- repo-map in the system prompt (cached) + precise drilldown via MCP tools. Neither exclusively-system-prompt nor exclusively-MCP is acceptable.
- **Pooling:** MCP servers hosted by **arkd** (per-repo), routed by **conductor** (per-tenant). One MCP process per `(tenant, repo, tool)`, shared across all sessions touching that repo. No per-session MCP spawning.
- **Tool choice (staged):** keep Ark's `ops-codegraph` as the base, add repo-map generation + pooled MCP hosting. Pilot `codebase-memory-mcp` for token efficiency. Add `GitNexus` (subject to license) for cross-repo Cypher. Skip `Understand-Anything`, `Serena`, `graphify`, `Bloop` -- see §6 for reasoning.

## 2. Why hybrid (not exclusive either way)

Per the token-efficiency research conducted in this review:

| Delivery mode | Typical tokens per question | When it's the right tool |
|---|---|---|
| Raw Grep dump (baseline) | 15,000-25,000 | Never -- baseline only |
| Aider repo-map in system prompt | 1,000-8,000 (cached: effective ~100-800) | Overview "what's in this codebase" -- upfront |
| Tree-sitter symbol graph via MCP | 500-1,500 | Precise: "find references to X", "blast radius" |
| LSP (Serena-style) via MCP | 800-2,000 | Most accurate but heaviest to run |
| Embedding RAG top-k | 3,000-6,000 | Only if keyword/symbol search misses > 10% of relevant code |

Prompt caching (Anthropic's 5-min / 1-hr TTL) changes the economics. After the first write, cached context is 0.10× cost. This **favors bigger upfront context** -- IF it doesn't go stale. A repo-map is mostly stable across a session; precise callsite lookups are not. Hence:

- **System prompt** = stable context (repo-map)
- **MCP** = dynamic drilldown (callers, impact, blast radius)

### What goes where

| Artifact | Location | Rationale |
|---|---|---|
| Ranked class / method signatures (no bodies) across repo | System prompt | Stable, cached, gives agent the shape |
| Top-level package structure + key entry points | System prompt | Navigation without asking |
| Language + framework markers (Spring, Maven, package.json) | System prompt | Tells agent what it's working with |
| `find_references(symbol)` | MCP | Exact list, per query |
| `get_definition(symbol)` | MCP | Body on demand |
| `blast_radius(file)` | MCP | Dependency walk |
| `call_graph(method)` | MCP | Caller/callee graph |
| `co_change_history(file)` | MCP | Git-based coupling |
| `search(query, type, repo)` | MCP | Filtered symbol/file search |
| `get_context(file)` | MCP | Neighbors by edge type |

Target budget per agent session:
- One system-prompt injection: ~1,500-2,500 tokens
- 10-30 MCP queries over session: ~500-1,500 tokens each
- **Total: ~10-50K tokens on code intelligence** vs 100-500K for pure-Grep baselines. 5-10× reduction.

## 3. Pooling architecture (conductor + arkd)

### Current state

- `packages/core/mcp-pool.ts` exists -- pools MCP processes via Unix sockets on same host
- Per-session `.mcp.json` written at dispatch (`packages/core/claude/claude.ts:132-186` writeChannelConfig)
- arkd at `:19300` handles channel relay + codegraph indexing but does NOT host MCP servers
- Conductor at `:19100` handles status + report routing, no MCP role

### Proposed state

```
    Session A (claude)       Session B (goose)       Session C (codex)
          │                        │                        │
          │ MCP client calls       │                        │
          ▼                        ▼                        ▼
    ┌───────────────────────────────────────────────────────────────┐
    │         Conductor MCP router (:19100/mcp/*)                   │
    │   - Route by (tenant_id, repo_id, tool_namespace)             │
    │   - Enforce auth + rate limits + per-tenant MCP policy        │
    │   - Proxy to right arkd instance                              │
    └───────────────────────────┬───────────────────────────────────┘
                                │
                ┌───────────────┼───────────────────┐
                ▼               ▼                   ▼
        ┌───────────────┐ ┌──────────────┐ ┌──────────────┐
        │  arkd @       │ │  arkd @      │ │  arkd @      │
        │  repo-A       │ │  repo-B      │ │  repo-C      │
        │  :19300       │ │  :19300      │ │  :19300      │
        │               │ │              │ │              │
        │  codegraph    │ │  codegraph   │ │  codegraph   │
        │  knowledge    │ │  knowledge   │ │  knowledge   │
        │  sage-kb-proxy│ │              │ │              │
        │  (pooled per  │ │ (pooled per  │ │ (pooled per  │
        │   repo)       │ │  repo)       │ │  repo)       │
        └───────────────┘ └──────────────┘ └──────────────┘
```

### Invariants

1. **One MCP instance per (tenant, repo, tool)**, not per session. 10 sessions on `pi-event-registry` share a single `codegraph-mcp` process.
2. **arkd owns MCP process lifecycle** -- spawns on first session needing it, idles after no-request-for-N-minutes, respawns on demand. Already per-compute; knowledge indexing is already there -- this extends scope without new infra.
3. **Conductor is the single MCP ingress for agents** -- agents' MCP clients connect only to conductor. Conductor forwards based on `(session.tenant_id, session.repo_id)`.
4. **Per-tenant auth at conductor boundary** -- existing `Authorization: Bearer ark_<tid>_*` extraction (already done for channel route per `docs/ROADMAP.md:85`) reused for MCP routes.
5. **Repo-map served as a file, not a tool** -- arkd exposes `GET /repo-map/<repo_id>` returning the cached markdown. Conductor injects this into task prompt at dispatch. Cached at source; no per-dispatch regeneration.
6. **Incremental refresh on file change** -- arkd watches worktrees, updates repo-map + codegraph DB incrementally. Session start gets the most recent map.

### What this solves (reconciliation cross-refs)

- **#4 MCP Router** (reconciliation §2) -- from ❌ GAP to ✅ real router, not socket pool.
- **O8 Knowledge graph auto-index on dispatch** -- from 🟡 PARTIAL to ✅: if arkd owns the MCP, it owns refresh.
- **F4 Sage-KB integration** -- conductor can proxy Rohit's `sage-kb` MCP at `http://localhost:8300/sage/mcp` alongside Ark-native MCPs, agents see one surface.
- **#8 Credentials vault** -- per-tenant MCP credentials resolved at conductor before forwarding to arkd (no MCP creds on agent side at all).

## 4. The repo-map generator (the piece Ark doesn't have today)

Aider's repo-map is the reference. Algorithm:

1. Tree-sitter extracts **every class signature + every method signature** (no bodies) across all source files.
2. Builds a graph of imports, references, definitions.
3. Runs **PageRank** over that graph (references count as votes).
4. Truncates to token budget (default 1K when files present in chat, 8K empty).
5. Emits ranked signatures as markdown tree.

Ark's `ops-codegraph` already has steps 1-2. Missing: PageRank + ranked-signatures emitter + markdown formatter.

### Concrete delta to add to Ark

| Change | File(s) | LOC |
|---|---|---|
| PageRank over existing codegraph edges | `packages/core/knowledge/repomap.ts` (new) | ~150 |
| Markdown emitter (Aider-format compatible) | same file | ~80 |
| Token-budget truncation (keep top-N by PageRank within budget) | same file | ~40 |
| arkd endpoint `GET /repo-map/<repo_id>` | `packages/arkd/routes.ts` | ~30 |
| Conductor fetches repo-map + injects into task prompt at dispatch | `packages/core/services/session-orchestration.ts` | ~40 |
| Unit test using a small fixture repo | `packages/core/knowledge/__tests__/repomap.test.ts` | ~100 |

**~440 LOC, ~2 days.** Uses existing codegraph graph; no new indexer.

## 5. Pooling delta

| Change | File(s) | LOC |
|---|---|---|
| arkd route `POST /mcp/:tool/:method` routing to local MCP processes | `packages/arkd/mcp-host.ts` (new) | ~200 |
| arkd MCP process manager (spawn-on-demand, idle-timeout, health) | `packages/arkd/mcp-manager.ts` (new) | ~150 |
| Conductor proxy route `POST /mcp/:tenant/:repo/:tool/:method` | `packages/core/conductor/mcp-router.ts` (new) | ~180 |
| Agent-side MCP client pointed at conductor (single URL per session) | `packages/core/claude/claude.ts` writeChannelConfig change | ~60 |
| Per-tenant MCP policy (which tools, rate limits) | `packages/core/auth/tenant-policy.ts` extension | ~40 |
| Migration: remove per-session `.mcp.json` writes for pooled tools | `packages/core/claude/claude.ts` | ~30 |
| Tests: 2 sessions share MCP, conductor routes correctly | new test file | ~120 |

**~780 LOC, ~4-5 days.** Independent of tool choice.

## 6a. Concrete vendoring plan for codebase-memory-mcp

Ark already vendors 5 external binaries (goose, codex, tmux, tensorzero, codegraph) via `vendor/versions.yaml` + `scripts/vendor-<name>.sh`. codebase-memory-mcp fits the same pattern.

**Prereqs verified:**
- **Repo:** `DeusData/codebase-memory-mcp`
- **License:** MIT (redistributable in Ark binary)
- **Form factor:** single static C binary, zero runtime deps, tree-sitter grammars vendored in (`internal/cbm/`)
- **Platforms published in v0.6.0 release:** `darwin-arm64`, `darwin-amd64`, `linux-arm64`, `linux-amd64`, `windows-amd64`. Covers everything Ark needs (skip Windows per TUI-retirement decision)
- **Current release:** v0.6.0 (2026-04-06), active project (4 releases in ~2 weeks)
- **Safety:** SLSA 3 signed releases, SHA256SUMS ship with each release, 0/72 VirusTotal engines flag it, OpenSSF Scorecard visible

### Language coverage (critical -- required minimums met)

Required at Paytm: **Python, JavaScript, TypeScript, Java** (+ Kotlin for Android surface).

| Language | Upstream tier | Notes |
|---|---|---|
| Kotlin | **Excellent** (≥90%) | Best-supported JVM lang |
| Java | Good (75-89%) | tree-sitter AST only -- NO LSP type resolution |
| TypeScript | Good (75-89%) | TSX also "Good" |
| JavaScript | Good (75-89%) | Best coverage of the dynamic langs |
| Python | Good (75-89%) | Decorators + dynamic dispatch partially resolved |

**Caveat worth calling out:** upstream README states *"LSP-style hybrid type resolution for Go, C, and C++"* explicitly. The other 63 languages (including Java, TypeScript, Python, Kotlin) rely on tree-sitter AST parsing only. Consequences:

- Java: generics, interface/abstract-class resolution, method overload disambiguation, Lombok-generated methods → partial
- TypeScript: conditional types, inference-based types, declaration merging → partial
- Python: dynamic typing, decorators, metaclasses, `__getattr__` → partial
- JavaScript: dynamic, so tree-sitter is about as good as any static analyzer gets

Upstream says "more languages coming soon" for hybrid type resolution but no timeline.

**Practical impact:** for fast structural queries (find-references, call-graph, blast-radius, find-definition) across typical Java/TS/Python code, tree-sitter is accurate enough -- the arxiv paper measured 83% answer quality across 31 repos. For deep type queries ("what types implement this interface including through generics?"), it will miss cases. We should either:
- (a) accept the limitation for the cost/speed win
- (b) pair with **Serena** (LSP-backed) as a *second* pooled MCP for deep type queries on demand -- NOT the primary, because LSP cold-start is slow per-repo, but fine as a drilldown tool when agents explicitly need it
- (c) wait for upstream to add Java/TS/Python to hybrid type resolution

**Recommendation:** start with (a); add (b) as a pooled secondary MCP if the pilot benchmark shows Java type queries missing too often.

### Custom extension mapping

Supports `.codebase-memory.json` at repo root (or global) to map extra file extensions to base languages:
```json
{"extra_extensions": {".blade.php": "php", ".mjs": "javascript", ".jte": "java"}}
```
Useful for Paytm's Spring ecosystem where some framework files (e.g. FreeMarker `.ftl`, Thymeleaf `.html`, Spring `.factories`) may need routing.

### Full MCP tool inventory (14 tools)

Per upstream README (useful for designing what Ark exposes to agents):
- `get_architecture` -- one-shot codebase overview: languages, packages, entry points, routes, hotspots, boundaries, layers, clusters (Louvain)
- `get_code_snippet` -- read source by qualified name (structured, not file-path-based)
- `search_code` -- grep-like text search across indexed files
- `manage_adr` -- Architecture Decision Records CRUD (persistent across sessions)
- ... plus 10 more for structural queries (callers/callees/references/definitions/impact/etc.)

Benchmark claim: "**120× fewer tokens** -- 5 structural queries: ~3,400 tokens vs ~412,000 via file-by-file search." Matches the arxiv 10× claim on per-query basis (file-by-file needs multiple grep+read cycles per query).

### Six concrete deltas to embed

**1. `vendor/versions.yaml` -- new entry:**

```yaml
codebase-memory-mcp:
  repo: DeusData/codebase-memory-mcp
  version: v0.6.0
  env: CODEBASE_MEMORY_MCP_VERSION
  platforms: [darwin-arm64, darwin-amd64, linux-arm64, linux-amd64]
  notes: "Static C binary. MIT. 66 languages via tree-sitter (Python/JS/TS/Java Good tier; Kotlin Excellent). 14 MCP tools over stdio. arXiv:2603.27277 claims 10x fewer tokens, 2.1x fewer tool calls. LSP-style hybrid type resolution only for Go/C/C++ currently."
```

**2. `scripts/vendor-codebase-memory-mcp.sh` -- new script (~40 LOC):**

Mirrors `scripts/vendor-codex.sh`. Uses `gh release download` with `SHA256SUMS` verification:

```bash
#!/usr/bin/env bash
set -euo pipefail
VERSION="${CODEBASE_MEMORY_MCP_VERSION:-v0.6.0}"
PLATFORM="${1:?usage: $0 <platform>}"
OUT="${2:-bin/codebase-memory-mcp}"

case "$PLATFORM" in
  darwin-arm64) ASSET="codebase-memory-mcp-darwin-arm64.tar.gz" ;;
  darwin-amd64) ASSET="codebase-memory-mcp-darwin-amd64.tar.gz" ;;
  linux-arm64)  ASSET="codebase-memory-mcp-linux-arm64.tar.gz"  ;;
  linux-amd64)  ASSET="codebase-memory-mcp-linux-amd64.tar.gz"  ;;
  *) echo "unknown platform: $PLATFORM" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$OUT")"
gh release download "$VERSION" --repo DeusData/codebase-memory-mcp \
  --pattern "$ASSET" --output - | tar -xzO > "$OUT"
chmod +x "$OUT"

# Verify signed checksum
gh release download "$VERSION" --repo DeusData/codebase-memory-mcp --pattern "SHA256SUMS" --output - \
  | grep "$ASSET" | awk '{print $1}' \
  | xargs -I{} bash -c "echo \"{}  $OUT\" | shasum -a 256 -c -"
```

**Before finalizing:** run `gh release view v0.6.0 --repo DeusData/codebase-memory-mcp` to confirm the exact asset naming convention -- upstream may use a different pattern than the placeholder (e.g. `.zip` on Windows, no `.tar.gz`).

**3. `packages/core/knowledge/codebase-memory-finder.ts` -- new (~15 LOC):**

```ts
import { existsSync } from "fs";
import { dirname, join } from "path";

export function findCodebaseMemoryBinary(): string {
  const arkBin = process.argv[0];
  if (arkBin) {
    const vendored = join(dirname(arkBin), "codebase-memory-mcp");
    if (existsSync(vendored)) return vendored;
  }
  return "codebase-memory-mcp"; // fall back to PATH
}
```

Mirrors the `findCodegraphBinary()` lookup order from `packages/core/knowledge/indexer.ts:25-40`.

**4. `Makefile` -- new targets:**

```make
vendor-codebase-memory-mcp:
	bash scripts/vendor-codebase-memory-mcp.sh "$$(bun run scripts/detect-platform.ts)" bin/codebase-memory-mcp

vendor-all: vendor-goose vendor-codex vendor-tmux vendor-tensorzero vendor-codebase-memory-mcp
```

**5. arkd MCP host (already sketched in §5):**

```ts
// packages/arkd/mcp-host.ts (new)
const bin = findCodebaseMemoryBinary();
const proc = Bun.spawn([bin, "mcp", "--repo", repoPath], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
// agents' MCP clients -> conductor -> arkd -> this proc via stdio framing
```

Verify the exact invocation flag (`mcp`, `--mcp`, or default mode) against the binary's `--help` -- README says "plug and play across 10 coding agents," so there's a documented MCP entrypoint.

**6. `install.sh` + release bundler:**

Ark's `install.sh` currently downloads `ark-<platform>.tar.gz` with codegraph + tmux + tensorzero bundled. With the `vendor-all` change above, `codebase-memory-mcp` lands in the same tarball automatically -- no install-side changes needed. Archive grows by ~20-50 MB per platform (static C + 66 tree-sitter grammars compile in).

`.github/workflows/vendor-freshness.yml` already polls repos from `versions.yaml` -- adding the entry auto-enrolls it in weekly bump PRs. Decide pinning strategy: exact version for stability, or track minor/patch bumps.

### Compliance

- **MIT license** -- redistribute freely in Ark binary. Add to `NOTICE` / `THIRD_PARTY_LICENSES` if such a file is introduced.
- **Checksum verification** -- step 2's `SHA256SUMS` verification is non-negotiable for security.
- **Signature verification** (SLSA 3) -- optional hardening: validate release provenance via `gh attestation verify` before accepting bumps.

### Size and timeline

- Per-platform binary: ~15-40 MB (confirm via `gh release view`)
- Combined addition to `ark-<platform>.tar.gz`: ~20-50 MB per platform
- Time to implement (vendor script + finder + Makefile + test): ~0.5 day
- Time to wire through arkd pooling (per §5): ~4-5 days additional
- Total to have codebase-memory-mcp pooled in arkd: ~1 week

### Before coding -- verification items

1. `gh release view v0.6.0 --repo DeusData/codebase-memory-mcp` -- confirm asset naming pattern for all 4 platforms + SHA256SUMS file presence
2. Download one platform binary, run `--help` and `mcp --help`, confirm stdio MCP invocation
3. Index `pi-event-registry` (Rohit's repo, ~30K LOC Java) -- measure index time + query latency + response token size
4. Inventory the 14 MCP tools it exposes -- confirm overlap with Sage-KB's 5 tools + Ark's 6 knowledge tools
5. Check default state-file paths (the README mentions LZ4 cache in `~/.cache/...`); arkd must override to an ark-owned tenant-scoped directory
6. Verify stdio framing compatibility with Ark's MCP client (same JSON-RPC-over-stdio the channel MCP uses)

## 6c. Integration with Ark's existing KB + KG

Ark already has TWO knowledge surfaces -- we're not bolting codebase-memory-mcp onto a bare system. The integration must preserve what Ark does uniquely and not fragment the agent-facing API.

### What Ark has today

| Surface | Storage | Owned by | Scope |
|---|---|---|---|
| **ops-codegraph** (structural code graph) | `.codegraph/graph.db` per repo (SQLite) | Ark's knowledge indexer | Per-repo, 34 langs, tree-sitter AST |
| **KnowledgeStore** (multi-domain KG) | `~/.ark/ark.db` (SQLite/WAL) | Ark core (tenant-scoped) | Memories + learnings + sessions + skills + codebase-nodes + git co-change edges |
| **Knowledge MCP (6 tools)** | stdio subprocess per session | `packages/core/knowledge/mcp.ts` | Public surface to agents |

### Principle: one agent-facing surface, two backends behind it

Do NOT expose codebase-memory-mcp's 14 tools alongside Ark's 6 tools -- agents would see 20 tools with overlapping semantics and pick wrong ones. Instead: **Ark's 6 knowledge tools become a facade.** The MCP router in conductor dispatches each call to the right backend.

### Tool mapping (facade routing)

| Ark tool (agent-facing) | Primary backend | Fallback / augments |
|---|---|---|
| `knowledge/search` | codebase-memory-mcp `search_code` (for code queries) | Ark native for `type=memory\|learning\|session` filtering |
| `knowledge/context` | codebase-memory-mcp `get_architecture` + `get_code_snippet` (structured) | Ark native for session events + skills |
| `knowledge/impact` | codebase-memory-mcp call-graph + references | Ark native git co-change edges (augment, not replace) |
| `knowledge/history` | Ark native (sessions that modified a file) | codebase-memory has no session concept |
| `knowledge/remember` | Ark native (memory write to ark.db) | -- |
| `knowledge/recall` | Ark native (memory + learning read) | -- |

**One new surface tool worth adding** (since upstream ships it):
- `knowledge/adr` → codebase-memory-mcp `manage_adr`. ADRs persist across sessions, align with Ark's "workflow history" requirement.

The agent still learns 6-7 tool names. Behind each, Ark chooses the backend.

### Storage layout under Ark umbrella

```
~/.ark/                                    # Ark root
  ├── ark.db                               # Ark KG (memories, learnings, sessions, skills)
  └── tenants/<tid>/
       └── repos/<rid>/
            ├── codegraph/graph.db         # ops-codegraph (if still active)
            └── codebase-memory/           # codebase-memory-mcp cache (LZ4 SQLite)
                 └── <its files>
```

codebase-memory-mcp by default writes under `~/.cache/...`. arkd overrides this via env var or `--cache-dir` flag (confirm via `--help`) so it writes under Ark's tenant-scoped path. **This is the multi-tenant isolation mechanism**: one process per `(tenant, repo)`, separate cache dirs, no cross-tenant bleed.

### Repo-map generation: use codebase-memory-mcp instead of porting Aider

Earlier in this doc (§4) I proposed porting Aider's PageRank repo-map algorithm (~440 LOC). **Revise:** codebase-memory-mcp's `get_architecture` tool already produces a structured overview (languages, packages, entry points, routes, hotspots, Louvain clusters). We can emit our system-prompt repo-map from `get_architecture` output:

- **Savings:** ~300 LOC not written (only need the markdown formatter + token budget, not the indexer or PageRank)
- **Richer output:** Louvain community detection is better than pure PageRank for large codebases -- surfaces functional modules
- **Caveat:** we're now dependent on upstream for repo-map semantics. If upstream changes output schema, our prompt shape changes. Pin versions tightly in `vendor/versions.yaml`.

### Migration path (staged, reversible)

**Stage 1: coexist (Week 1)**
- Embed codebase-memory-mcp as vendored binary (§6a)
- Pool both ops-codegraph AND codebase-memory MCPs through arkd (§5)
- Ark's 6 tools route to BOTH backends, return merged results
- Agent sees no API change

**Stage 2: benchmark (Week 2)**
- Run same agent sessions twice: once routing to ops-codegraph, once to codebase-memory-mcp
- Measure: tokens per query, precision, latency, index time, correctness on Paytm Java repos
- Specifically test Java type queries -- this is where codebase-memory-mcp's non-LSP limitation might bite

**Stage 3: pick a primary (Week 3)**
- If codebase-memory-mcp wins: route all structural queries there, keep ops-codegraph as fallback
- If ops-codegraph wins or ties: keep codebase-memory as opt-in, revisit when it adds Java/TS/Python to hybrid type resolution
- Either way, `knowledge/history` + `knowledge/remember` + `knowledge/recall` stay on Ark native KG -- nothing in codebase-memory-mcp covers those

**Stage 4: sunset decision (Week 4+)**
- If codebase-memory-mcp clearly wins AND the pilot confirms it on 2+ real Paytm repos, deprecate ops-codegraph
- Ark keeps only: `KnowledgeStore` (memories/learnings/sessions -- Ark native) + codebase-memory-mcp (structural code -- vendored)
- Saves maintenance overhead on the codegraph-shim.ts layer + tests

### What the agent sees end-to-end (updated trace)

1. **Dispatch**: conductor fetches cached repo-map (produced from codebase-memory's `get_architecture`) → injects into system prompt (~1.5-2.5K tokens, cached)
2. **Agent calls `knowledge/search("Action.setStatus")`** → conductor routes to codebase-memory-mcp on arkd → tree-sitter structural result, ~400 tokens
3. **Agent calls `knowledge/impact("KafkaProducer.java")`** → conductor routes to codebase-memory → call-graph dependents, ~700 tokens → Ark native augments with git co-change edges (~200 tokens extra)
4. **Agent calls `knowledge/recall("auth middleware patterns")`** → conductor routes to Ark native KG → returns prior session learnings about auth → ~300 tokens
5. **Agent calls `knowledge/remember("Kafka SASL setup requires...")`** → conductor routes to Ark native → writes to ark.db → memory persists across sessions
6. **Agent calls `knowledge/adr/create(...)`** (new) → conductor routes to codebase-memory-mcp's `manage_adr` → persists ADR under `~/.ark/tenants/<tid>/repos/<rid>/codebase-memory/`

Agent sees one `knowledge/*` namespace. Ark routes per tool. Best tool for each query.

### Open integration questions

1. **Tool name conflict resolution:** if codebase-memory-mcp's MCP schema names its tools `search_code`, `get_architecture`, etc. and we want to present them as `knowledge/search`, `knowledge/context`, we need a name-translation layer in conductor's MCP router. Small code (~50 LOC) but must be tested.
2. **Merged results shape:** when `knowledge/impact` asks codebase-memory AND Ark native, merged output must be deduplicated + ranked consistently. Define a merge function (prefer codebase-memory for structural dependents, Ark for git-coupling).
3. **Cache invalidation on file change:** codebase-memory-mcp's cache + ops-codegraph's cache + Ark's context injection cache -- all three need coherent invalidation when agents edit code. arkd's file watcher should signal all three.
4. **MCP tool set evolution:** codebase-memory-mcp ships 14 tools; we surface 7 via facade. Later tools (upstream v0.7.0+) may warrant exposing directly -- have a policy for when to add new `knowledge/*` tools vs leaving them embedded.
5. **When agent asks `search` without saying "code" or "memory":** routing heuristic needed. Default: try codebase-memory first (cheaper); if zero hits, fall back to Ark native KG.
6. **Cost attribution:** structural queries hitting codebase-memory run in arkd's local process -- zero LLM token cost for the query itself, but the response tokens count against agent's context. Ark's UsageRecorder should tag these as `provider: codebase-memory-mcp` for observability.

## 6b. Tool selection given this architecture

From the research:

| Tool | Token efficiency | MCP-native? | Pool-friendly? | Java quality | Self-host | License | Verdict |
|---|---|---|---|---|---|---|---|
| **Ark ops-codegraph** (current) | 🟡 (no repo-map yet) | 6 tools exist | ✅ native binary, easy to pool | ✅ tree-sitter Java | ✅ | Apache-2.0 | **Keep as base** |
| **codebase-memory-mcp** | ✅✅ 99.2% reduction | ✅ native | ✅ static C binary | ✅ "Excellent tier" | ✅ | OSS | **Pilot alongside** |
| **jCodeMunch-MCP** | ✅ 95% reduction | ✅ native | ✅ in-memory | ✅ | ✅ paid commercial tier | ✅ paid | **Evaluate for commercial terms** |
| **GitNexus** | ✅ structured tool outputs, 14 MCP tools incl. Cypher | ✅ native | 🟡 LadybugDB embedded, heavier | ✅ | ✅ | ⚠️ PolyForm NC (non-commercial) | **Consider for cross-repo IF license solvable** |
| **graphify** | ✅ 71.5× | ✅ native MCP | 🟡 Python subprocess | ✅ | ✅ | MIT | **Skip -- multimodal overhead we don't need** |
| **Serena (LSP-backed)** | ✅ high | ✅ native | ❌ LSP per repo is heavy; Java LSP cold-start = seconds | ✅✅ (most accurate) | ✅ | MIT | **Skip for pool -- can't amortize LSP cost** |
| **Understand-Anything** | 🟡 JSON + Fuse.js, not structured | ❌ Claude Code Skills only, no MCP server | ❌ | 🟡 | ✅ | MIT | **Skip** |
| **Sourcegraph src-cli** | 🟡 | ❌ | 🟡 requires Sourcegraph server | ✅ | ⚠️ Cloud preferred | ⚠️ | **Skip for on-prem pilot** |
| **Aider repo-map** | ✅ reference implementation | ❌ embedded in Aider, not MCP | N/A | ✅ | N/A (we port the algorithm) | Apache-2.0 | **Port the algorithm** -- see §4 |
| **Bloop** | 🟡 vector + keyword | ❌ desktop app | ❌ | 🟡 Rust/TS first | ✅ | Apache-2.0 | **Skip -- stale + no MCP** |

### Staged plan

**Phase 1 (this pilot) -- ~6-7 days:**
- Port Aider's PageRank repo-map on top of Ark's existing codegraph (§4)
- Pool existing 6 knowledge MCP tools via conductor + arkd (§5)
- Repo-map in system prompt + MCP drilldown is now Ark-native

**Phase 2 (token benchmark, after Phase 1 works) -- ~3 days:**
- Wire `codebase-memory-mcp` as a parallel pooled MCP
- Run the same agent sessions twice: once through Ark-native, once through codebase-memory
- Measure: tokens per query, result precision, latency. Keep the winner, retire the loser.

**Phase 3 (multi-repo + cross-repo queries) -- blocked on Camp 11:**
- Evaluate GitNexus if we have solid cross-repo Cypher requirements. License blocker first (contact akonlabs.com for commercial terms).
- Alternative: extend ops-codegraph with `repo_id` on nodes (the Camp 11 item already scoped in ROADMAP).

## 6d. Storage location and multi-repo -- local vs control-plane

### Principle: code-graph data is a derived artifact, never in the repo

The codebase-memory-mcp cache is **not** stored inside the repo itself. Like `.codegraph/graph.db` today, it's gitignored / arkd-managed. Reasons:

- Rebuilt from source; checking it in invites drift
- Per-developer staleness if committed (one dev reindexes, others get stale graph)
- Size (20-50+ MB per large repo) pollutes git history
- Tenant-scoping requires it to live outside repo boundaries

### Local mode: per-machine, Ark-scoped

```
~/.ark/                                     # user's Ark root
  ├── ark.db                                # Ark KG (tenant-scoped)
  └── tenants/<tid>/
       └── repos/<rid>/
            └── codebase-memory/            # arkd-owned cache (via --cache-dir override)
                 └── <sqlite + lz4 files>
```

- One arkd process per `(tenant, repo)` on the local machine
- Cache survives across sessions on the same machine
- Each developer laptop maintains its own index (redundant but simple)
- Refresh triggers: file-watcher on worktree, session completion, explicit `ark knowledge reindex <repo>`

### Control-plane mode: central, per-repo shared across users

This is where the user's question lands hardest. In hosted mode we want:

1. **One authoritative index per repo** -- not N copies across N developer laptops
2. **Git-push-triggered refresh** -- webhook fires, arkd reindexes in background, new commits visible to all tenant users within seconds
3. **Networked MCP endpoint** -- agents connect through conductor, which routes to the arkd worker owning that repo's index
4. **Persistent + durable** -- survives arkd restarts, ideally HA across workers

```
Control plane (hosted.ts mode):

                    ┌─────────────────────────────────────────┐
                    │      Conductor (:19100)                  │
                    │   - Routes by (tenant, repo, tool)       │
                    │   - Tenant auth, rate limits             │
                    └───────┬───────────────┬──────────────────┘
                            │               │
                ┌───────────▼────┐  ┌───────▼────────┐
                │ arkd worker 1  │  │ arkd worker 2  │
                │ owns repos:    │  │ owns repos:    │
                │  pi-event-reg  │  │  pi-action-exe │
                │  repo-A        │  │  repo-B        │
                └───────┬────────┘  └───────┬────────┘
                        │                   │
                ┌───────▼───────────────────▼──────────┐
                │  Shared storage (one of):             │
                │   - Shared volume (EFS/NFS)           │
                │   - S3 + local SQLite read-replica    │
                │   - Postgres-backed codebase-memory   │
                │     (if upstream supports; needs check)│
                └───────────────────────────────────────┘
```

Key design decisions for control-plane mode:

- **Repo → worker mapping** persisted in control-plane DB (add a `repo_workers` table). Conductor consults this mapping for routing. Rebalancing on worker add/remove.
- **Webhook-triggered reindex** -- GitHub/Bitbucket push events hit conductor `/api/webhook/git`, which resolves to the owning arkd and dispatches an incremental reindex. Matches the existing webhook + scheduler infrastructure in `hosted.ts`.
- **Storage backend** -- three options, ranked:
  1. **Shared volume (EFS/NFS)** -- simplest, codebase-memory's SQLite works as-is. Multiple arkd workers mount the same volume. Locking via SQLite WAL. OK for small deployments.
  2. **S3 + local SSD cache** -- worker pulls latest snapshot from S3 at boot, keeps local SSD hot, pushes snapshots after each reindex. Best for HA. Needs a periodic snapshot job.
  3. **Postgres-backed** -- only if upstream codebase-memory-mcp supports Postgres as a backend. Check upstream; if yes, best fit for hosted mode since we already use Postgres via `DATABASE_URL`.
- **Per-repo TTL + LRU eviction** -- worker has finite disk; if not all tenant repos fit locally, evict the least-recently-queried repos. Conductor tracks access frequency.

### Multi-repo sessions (Camp 11 intersection)

When a session spans N repos (like Rohit's PAI-31080 across 3 repos), the agent needs to query across all 3 code graphs. Three models:

**A. Agent specifies repo per query**
```
knowledge/search(query="KafkaProducer", repo="pi-event-registry")
```
Simple. Conductor routes to the right arkd. Agent must know which repo to target.

**B. Federated query, merged results (recommended)**
```
knowledge/search(query="KafkaProducer")  // no repo -> search all session repos
```
Conductor fans out to N arkds in parallel, merges results, tags each with `repo_id`, ranks globally. Best UX. More conductor work.

**C. Single MCP instance indexing all session repos together**
Breaks tenant scoping if repos are cross-tenant. Skip.

**Recommendation: (B) for queries, (A) for writes.** Writes (remember, ADR create) need explicit repo targeting; reads benefit from fan-out.

Conductor's federated query logic:
```
1. Look up session's repos: session.repos[] (from Camp 11 schema)
2. For each repo_id, look up arkd worker
3. Fan out knowledge/search to each, with 2s timeout each
4. Merge results, tag with repo_id
5. Rank combined set (simple: preserve per-repo rank + repo_id as secondary key)
6. Return top-N to agent
```

~150 LOC in conductor's MCP router. Cached since repo-list rarely changes mid-session.

### Cross-repo edges (the longer-term win)

codebase-memory-mcp indexes one repo at a time. **Cross-repo calls** (e.g. pi-action-executor calls pi-event-registry via HTTP/Kafka) won't show up as graph edges unless we add a layer.

Ark's existing knowledge graph has `cross_repo_dep` edge type (`packages/core/knowledge/types.ts`, if I recall correctly -- verify). Wire it by:
1. arkd runs codebase-memory-mcp per repo, extracts HTTP routes + Kafka topics + service-call patterns via its `get_architecture` output
2. Ark synthesizes cross-repo edges from those: "repo A's `/api/event` endpoint is called by repo B's `EventClient.kt`"
3. Stored in Ark's central KG (ark.db / hosted Postgres), not in individual codebase-memory caches
4. `knowledge/impact(file=X, repo=Y)` in control-plane mode returns both local call-graph (from codebase-memory) AND cross-repo dependents (from Ark's central KG)

This is what Sage-KB's `kb_blast_radius` likely does under the hood -- they said it's "cross-service links." Matching that capability in Ark requires this synthesis layer. ~1-2 days of work on top of the basic integration.

### Summary: storage decisions per deployment mode

| Concern | Local mode | Control-plane mode |
|---|---|---|
| Where codebase-memory cache lives | `~/.ark/tenants/<tid>/repos/<rid>/codebase-memory/` | S3 or Postgres (whichever fits -- both are approved backends; pick per workload after pilot) |
| Who owns refresh | Local arkd, file-watcher | Central arkd workers, git-push webhooks |
| Multi-repo query | Fan out to local arkds | Fan out to arkd workers via conductor |
| Cross-repo edges | Synthesized in local ark.db | Synthesized in central Postgres |
| Per-tenant isolation | Process + FS path | Process + volume path + DB tenant_id |
| Freshness SLA | Seconds (file-watcher) | Seconds (webhook) |
| Cost model | Redundant per-dev indexing | Shared per-repo indexing, N× savings |

### Open questions (for decision / investigation)

1. **Storage backend choice: S3 or Postgres** -- the team has approved both as acceptable (2026-04-18). Pick per workload after pilot:
   - Postgres fits if upstream codebase-memory-mcp supports it natively (check `--storage-backend` or similar flag); aligns with existing `DATABASE_URL` infrastructure
   - S3 fits otherwise: worker pulls latest snapshot at boot, local SSD hot-cache, pushes after reindex. Decouples storage from worker lifecycle, good for HA
   - Hybrid possible: Postgres for metadata + cross-repo edges, S3 for the per-repo SQLite blobs
2. **Snapshot cadence for S3 option** -- every commit? Every N minutes? On-demand? Trade-off between recovery time and S3 cost.
3. **Cross-repo edge synthesis** -- do we do it in Phase 1 (embedding step) or Phase 3 (after Camp 11)? Leaning Phase 3 -- without multi-repo sessions there's nothing to query against.
4. **Webhook source of truth for push events** -- GitHub App? Bitbucket? Gitea? The existing SP3 integrations roadmap already scopes this.
5. **What happens to `.codegraph/graph.db` (ops-codegraph)?** In control-plane mode we want centralized, so ops-codegraph's per-repo file falls away naturally if we migrate to codebase-memory. In local mode it can coexist until Stage 4 sunset.

## 7. What the agent actually experiences (end-to-end trace)

A session dispatches against `pi-event-registry`. The full trace:

1. **Dispatch time**: conductor fetches cached repo-map from arkd (`GET /repo-map/pi-event-registry`). Injects it into task prompt under `## Repository Map` section.
2. **Agent starts**: system prompt now contains the repo-map (~1.5K tokens). Prompt cached by Anthropic for subsequent turns.
3. **Agent asks "who calls Action.setStatus?"** -- MCP tool call `knowledge/search` with query "Action.setStatus" → goes to conductor → conductor authenticates session's tenant → forwards to arkd for `pi-event-registry` → arkd's `codegraph-mcp` subprocess responds. ~600 tokens back.
4. **Agent asks "what's the blast radius of changing KafkaProducer.publish?"** -- MCP tool call `knowledge/impact` → same path → arkd returns ranked dependents list. ~800 tokens.
5. **Agent edits a file**. arkd's file watcher notes the change. Repo-map incremental refresh queued.
6. **Agent continues working**. Cached repo-map still valid for the session (refresh happens in background; next session gets the fresh one).
7. **Session ends**. MCP subprocess stays warm in arkd for 5 min in case another session on same repo starts. Then idles out.

Total code-intel token spend: ~1.5K (cached system prompt, 0.15K after first turn) + ~10 × 700 (MCP calls) = ~8.5K for a 30-turn session. Pure-Grep baseline for the same work: 50-100K. **6-12× reduction.**

## 8. Open decisions

1. **Commit to hybrid delivery** -- yes/no. If no, fall back to either "system prompt only" (simpler but misses dynamic drilldown) or "MCP only" (simpler but higher per-session cost). Recommendation: yes, hybrid.
2. **Conductor becomes the MCP router for agent-facing tools** -- yes/no. If no, we stay with per-session `.mcp.json` and give up pooling benefits.
3. **Pilot `codebase-memory-mcp` alongside ops-codegraph?** -- decides Phase 2. Recommendation: yes, after Phase 1 is stable.
4. **License pursuit for GitNexus** -- reach out to akonlabs.com for commercial terms, or skip to stay OSS-only?
5. **Repo-map budget** -- 1,500 tokens (Aider default with files in chat)? 2,500 (richer overview)? Trade-off: larger budget hits prompt caching bucket better but bumps the uncached first-write cost.
6. **Staleness policy for repo-map** -- seconds-to-stale after edits, or per-session snapshot? Recommendation: per-session snapshot, since cache invalidation mid-session defeats caching.
7. **Which repo-map emitter format** -- Aider-format (markdown tree), LSP-like (JSON symbol outline), or custom? Recommendation: Aider-format -- proven to work with Claude + GPT + Gemini.

## 9. Items I did not verify in this pass

- Actual invocation of `codebase-memory-mcp` against a real Paytm repo -- only read their docs + benchmarks, didn't run it.
- GitNexus commercial license terms -- need direct conversation with akonlabs.com.
- How sage-kb handles network boundaries (http://localhost:8300/sage/mcp from docker compute) -- may need port mapping or overlay network.
- arkd's current process-supervision capabilities -- I assumed it can host long-lived subprocesses; didn't read `packages/arkd/` in detail for this design.
- Exact prompt-caching behavior for dynamically-regenerated repo-maps across sessions -- Anthropic's cache key is prefix-sensitive, small differences bust the cache.
- Whether Ark's `mcp-pool.ts` can be extended to this model or needs replacement.

## 10. Cross-references

- **`2026-04-18-REQUIREMENTS_RECONCILIATION.md` §2 #4 (MCP Router)** -- this design closes that gap.
- **`2026-04-18-REQUIREMENTS_RECONCILIATION.md` §8 bucket O8 (Knowledge graph auto-index)** -- pooled MCP owns the refresh, upgrades O8 from 🟡 to ✅.
- **`2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` §7 (MCP credentials sharp edge)** -- conductor-side cred resolution is the natural fit; pooled MCP means creds never leave conductor.
- **Camp 11 multi-repo** (`docs/ROADMAP.md`) -- `repo_id` on nodes is the prerequisite for cross-repo GitNexus Cypher queries in Phase 3.
- **ACP adoption plan** (`docs/ROADMAP.md` §10a) -- compatible. Pooled MCP is a Layer-7 change; ACP is a Layer-2 transport change. Orthogonal.
