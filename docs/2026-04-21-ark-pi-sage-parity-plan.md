# Ark → Pi-Sage Parity Plan (2026-04-21)

**Status:** in-progress; this plan reconciles the 40+ open GH issues, the in-flight agent wave, and what I verified by reading pi-sage's source end-to-end on 2026-04-21.

**Governing principle:** Ark owns everything. Zero runtime dependency on pi-sage. The `sage/analyze` RPC stays only as a cooperation escape hatch — Ark is self-sufficient.

---

## 1. What I actually verified in pi-sage

Source read end-to-end (file paths from `/tmp/pi-sage`):

- **Schema** (`schema_index.py`) — 14 tables, FTS5 triggers on chunks + repo_docs, pgvector(384) for Postgres, BLOB for SQLite
- **Indexer** (`indexer/*.py`) — 21 files; regex + brace-counting, NOT tree-sitter
- **Query layer** (`sage_index.py`) — 16 methods including recursive-CTE blast radius + `auto()` router
- **Embeddings** (`indexer/embedding_indexer.py`) — FastEmbed BGE-small, batch 1024, ONNX single-session lock
- **Analysis engine** (`analysis_engine.py`, `analysis_passes.py`, `analysis_claude.py`, `analysis_system_prompt.py`) — 5-pass, tool-use Claude investigation, 400-LOC system prompt
- **Plan executor** (`plan_executor.py`, `plan_exec_helpers.py`, `plan_recipe.py`) — worktree + preflight + drift + TDD task prompt
- **Chat pipeline** (`chat_search.py`) — intent routing + Haiku query expansion + multi-strategy search with 13-factor scoring
- **MCP server** (`mcp/server.py`, `mcp_tools.py`) — 6 tools: sage-ask, sage-analyse, sage-status, sage-gaps, sage-plan, sage-checklist

Critical insight I had wrong earlier: **pi-sage Pass 4 uses Claude with tool use**, not just pre-fetched evidence. `KB_TOOLS` = kb_search / kb_semantic_search / kb_graph / kb_blast_radius / kb_file_read / kb_similar. Claude calls these in a bounded loop, forced to summarise when the tool-call budget is hit.

---

## 2. Libraries we reuse (no rolling our own)

| Concern | Library | Rationale |
|---|---|---|
| Schema + migrations | `drizzle-orm` + `drizzle-kit` | Already landed Phase A. Bun-compatible; `postgres-js` = the `postgres` package we already use. |
| SQL | `drizzle-orm` query builder + `sql\`…\`` escape hatch | Drizzle for common cases; raw SQL for FTS triggers, recursive CTEs, partial unique indexes, UPSERT-with-WHERE. |
| Postgres driver | `postgres` (existing) | No change. |
| SQLite driver | `bun:sqlite` (built-in) | No change. |
| FTS (Postgres) | Built-in `TSVECTOR` + GIN | No lib; generated column + GIN index via drizzle migration. |
| FTS (SQLite) | Built-in `FTS5` virtual table | No lib; mirror table + INSERT/UPDATE/DELETE triggers. |
| Vector similarity (Postgres) | `pgvector` extension | Standard Paytm infra already has it. |
| Vector similarity (SQLite) | BLOB + in-app cosine in TS | Matches pi-sage's approach. No lib needed. |
| ONNX inference (embeddings) | **`@xenova/transformers`** | Bun-compatible, ships BGE-small model from HF. First choice. Fallback: subprocess to a vendored `fastembed` binary. |
| Embeddings model | `BAAI/bge-small-en-v1.5` | 384-dim, 33MB quantized. Same as pi-sage. |
| Tree-sitter | `web-tree-sitter` (WASM) — **Phase 2 only** | Phase 1 = regex; pi-sage proves 36-repo production scale works on regex. |
| Markdown / MDX | `mdast-util-from-markdown` + `mdast-util-to-markdown` + `mdast-util-gfm-table` | Already landed in `packages/core/tickets/richtext/`. Reuse. |
| ADF ↔ MDX | Hand-rolled in tickets (`packages/core/tickets/richtext/adf.ts`) | Skipped `@atlaskit/adf-schema` to avoid React baggage. |
| Anthropic SDK | `@anthropic-ai/sdk` | Bun-compatible; already in use for claude executor. |
| Jira REST | Bare `fetch()` | Three endpoints; no lib worth the weight. Already landed in #330 agent work. |
| GitHub REST | Bare `fetch()` or `@octokit/rest` | `fetch()` is enough. #331 agent used fetch. |
| Linear GraphQL | `graphql-request` | 10KB lib, typed GraphQL client. |
| Bitbucket REST | Bare `fetch()` | Similar to Jira. |
| Confluence | Bare `fetch()` + ADF converter | Reuses our MDX↔ADF work. |
| Notion | `@notionhq/client` | Official, Bun-compatible. |
| git operations | `Bun.spawnSync(["git", ...])` | Matches pi-sage's `subprocess.run`. No libgit2 lib needed. |
| k8s client | `@kubernetes/client-node` | Already in use. |
| Scheduler (Celery-equivalent) | `node-cron` or `Bun.sleep` in a loop | Phase 1: in-process `setInterval`. Phase 2 when we scale: BullMQ on Redis (existing infra). |
| AST walker (audit tool) | `ts-morph` | Already landed via `scripts/audit-codebase.ts`. |
| MCP | Bare stdio JSON-RPC loop | Pi-sage's `mcp/server.py` is 97 lines of stdin/stdout. Same in Bun. |
| HTTP server | `Bun.serve()` | Already in use. |
| Zod validation | `zod` | Existing; roll out across remaining RPCs (#276). |
| OS keyring (for #269 follow-up) | `@napi-rs/keyring` | NAPI v3, Bun-compatible. |

**Nothing we roll ourselves if a mature library exists.** Exceptions: ADF converter (React baggage in Atlaskit lib), MCP server (trivially small), git wrapper (subprocess is cleaner).

---

## 3. What's already on disk (verified)

| Item | Status | Source |
|---|---|---|
| Multi-tenant control plane (tenants / teams / users / memberships / policies / api-keys) | Shipped | Earlier this session |
| Secrets backend (file + SSM, blob support) | Shipped | Earlier this session |
| Tenant claude auth binding (api-key + subscription-blob) | Shipped | Earlier this session |
| K8s E2E test with per-session Secret mount | Shipped | Earlier this session |
| K8s Secret owner-refs + boot reconciler (leak recovery) | Shipped | Earlier this session |
| Drizzle Phase A: 25-table schema, client, baseline migrations, runner hardening, 009 cutover | Shipped | Today |
| Audit tool: `make audit` + `make audit-check` CI drift gate | Shipped | Today (#338 agent) |
| Tickets framework: types + registry + 4 richtext converters + lossy escape hatch + tests | Shipped | Today (#329) |
| Jira adapter (full 2-way + JWT/HMAC webhook + rate limit) | Shipped | Today (#330 agent) |
| Stubs: Shortcut / ClickUp / Asana / PagerDuty | Shipped | Today (#332) |
| GitHub Issues + Linear + Bitbucket adapters | In-flight verify | Today (#331 agent, dispatched for finish) |
| Drizzle Phase B: 11/13 repos on query builder; call-site async cascade | In-flight | Today (dispatched for finish) |

---

## 4. Work remaining, ordered by dependency

### Wave 1 — Foundation (blocks on drizzle Phase B landing)

**1.1 Rip legacy `app.knowledge`** (#318)
- Delete `packages/core/knowledge/store.ts` KnowledgeStore
- Delete `packages/core/knowledge/codegraph-shim.ts` read-path (keep binary resolution in `vendor.ts`)
- Delete `packages/core/knowledge/codebase-memory-finder.ts`
- Delete handlers: `knowledge.ts`, `knowledge-local.ts`, `knowledge-rpc.ts`, `memory.ts`
- Delete CLI: `ark knowledge`, `ark memory`
- Delete `packages/core/services/dispatch-context.ts`
- Delete `conductor.ts:987` `indexSessionCompletion` call
- Delete `claude.ts:311-327` `codebase-memory-mcp` injection
- Delete `claude.ts:329-339` `void existing;` stub
- Add minimal `memories` table in drizzle schema (separate from code-intel)
- Re-ship `memory/add|recall|forget` RPCs against the new table

**1.2 Ship `ark-code-intel` MCP server shell** (#318)
- New `packages/core/code-intel/mcp.ts` — stdio transport, JSON-RPC loop like pi-sage's 97-line `server.py`
- New `packages/core/code-intel/mcp-http.ts` — Streamable HTTP at `/ark/mcp`
- 6 tools wired to empty query layer (returns empty until extractors ship)
- Auto-inject into every session's `.mcp.json` — no flag gate
- Basic tests: tool listing, tool call round-trip

### Wave 2 — Extractors (regex-first per pi-sage's pattern)

**2.1 Language extractors** (#319)
- **Python** (port of `python_extractor.py` to TS, regex + indentation):
  - `_CLASS_RE = /^class\s+(\w+)\s*(\([^)]*\))?\s*:/`
  - `_FUNC_RE = /^(async\s+def|def)\s+(\w+)\s*\(/`
  - Block end by indentation comparison
  - Decorators collected, metadata tags: `pydantic` (if `BaseModel` in bases), `dataclass`, `async`
- **Java** (port, regex + brace-counting): annotations, access modifiers, extends/implements, generics
- **TypeScript** (port): `export function`, arrow functions, class/interface/enum, React FC
- **Go** (new, matches TS pattern): package + func/method/struct/interface regex
- Output: `symbols` + `chunks` rows in `app.codeIntel` tagged with `indexing_run_id`
- Tests against fixture repos per language

**2.2 Domain extractors** (#321)
- **Endpoints** per-framework: Spring `@RequestMapping` + method-level; FastAPI `@app.get`; Express/Fastify `app.get(path, handler)`; Gin `r.GET`; Chi/Fiber/Echo similar
  - Pattern: regex per framework → `endpoints` row with `method`, `path`, `handler_symbol_id FK`, `framework`
- **Configs**: `.env` / `.yaml` / `.properties` / `.toml` / `.hcl` → `configs` rows
- **Infra**: docker-compose / Dockerfile / k8s manifests (optional validation via vendored `kubeconform`) / Terraform → `infra_resources`
- **Dependencies**: `package.json`+lockfile, `pom.xml`, `build.gradle`, `go.mod`+sum, `Cargo.toml`+lock, `requirements.txt`+`pyproject.toml`+`poetry.lock`, `Gemfile`, `composer.json` → `dependencies` rows

**2.3 Secondary extractors** (#325)
- **Test-mappings** (heuristic): Python `test_X.py` ↔ `X.py` / `X_test.py` ↔ `X.py`; Java `XTest.java` in `src/test/java` mirror of `src/main/java`; Go `X_test.go` ↔ `X.go`; TS `X.test.ts` ↔ `X.ts`. Confidence 0-100.
- **Class hierarchy** (extends/implements/embeds): emits `edges` with `source_kind=symbol, target_kind=symbol, relation ∈ {extends, implements, embeds}`
- **Hotspot analyzer**: per-file `commit_count_30d`, `commit_count_90d`, `authors_count`, `lines_touched`, `risk_score = churn × author_spread × file_size_factor`
- **Contributors** upgrade: dedupe via `people` table (primary_email + alt_emails jsonb); emit `people` + `contributions` rows per file
- **Doc-graph**: parse markdown/rst/adoc for references to code entities; emit `edges` with `relation='documents'`

### Wave 3 — Indexing infrastructure

**3.1 Embeddings** (#322) — **copy pi-sage's constants verbatim**
- Library: `@xenova/transformers` with `BAAI/bge-small-en-v1.5` (384-dim)
- `packages/core/code-intel/embeddings.ts`:
  ```ts
  export async function embedBatch(texts: string[]): Promise<Float32Array[]>
  export async function embedQuery(query: string): Promise<Float32Array>
  ```
- Single-instance pattern with double-checked lock
- Batch size 1024 (vs transformers default 256)
- Text format: chunks `{chunk_type}: {name}\n{content[:800]}`, docs `{doc_type}\n{content[:1500]}`
- Whitelist: `class, method, function, interface, enum, test_*, doc, sql, migration, openapi_spec`
- Skip list: `config, k8s_manifest, dockerfile, docker_compose, build_dependency, import`
- Postgres: pgvector `vector(384)` column with IVFFlat (`lists=100`), batch INSERT via `postgres` driver's COPY
- SQLite: `BLOB` column, cosine done in-app
- Incremental: `LEFT JOIN embeddings e ON e.source_id = c.id WHERE e.id IS NULL`
- Orphan cleanup: `EXISTS`-based DELETE after extractor reruns
- Graceful fallback to FTS when `COUNT(*) FROM embeddings == 0`

**3.2 FTS setup** (#323)
- Postgres: `search_vec TSVECTOR GENERATED ALWAYS AS (setweight(to_tsvector('english', COALESCE(name, '')), 'A') || setweight(to_tsvector('english', COALESCE(content, '')), 'B')) STORED` + GIN index
- SQLite: FTS5 virtual table with `content=code_chunks, content_rowid=id` + AFTER INSERT/UPDATE/DELETE triggers
- Dialect sidecars in the drizzle-kit emitted SQL (hand-edit the 010 migration)

**3.3 Background reindexer** (#327)
- `packages/core/code-intel/reindexer.ts`
- In-process scheduler (Bun.sleep loop, no node-cron for Phase 1; keeps daemon self-contained)
- Every 10 min (configurable `ARK_REINDEX_INTERVAL`), walk registered repos
- Per repo: `git fetch` + `git diff --name-status <last_indexed>..HEAD`
- A/M → re-extract + soft-delete prior rows with same path; D → soft-delete all rows; R → soft-delete old + re-extract new
- One reindex per repo at a time (advisory lock via drizzle raw SQL)
- Every row tagged with `indexing_run_id` for rollback: `UPDATE … SET deleted_at = now() WHERE indexing_run_id = X`

**3.4 Daemon-side git clone** (#287)
- On `code-intel/repo/add` with `repoUrl` and no `localPath`: clone into `<arkDir>/code-intel/clones/<tenantId>/<repoId>`
- Use `Bun.spawnSync(["git", "clone", "--depth=1", repoUrl, path])` with optional `GIT_SSH_COMMAND` for key-based auth
- Private repos: fetch token/key from secrets backend (tenant-scoped), construct `https://x-access-token:<pat>@github.com/...` or SSH

**3.5 Session-completion hook**
- Rewrite `dispatch-context.ts` logic to write `chunks` rows with `chunk_kind='session_summary'` + `attrs` jsonb (session_id, flow, duration, summary) to `app.codeIntel`
- Session-level learnings → new `memories` table rows

### Wave 4 — Query surface + MCP tools

**4.1 Port SageIndex** (#326)
- `packages/core/code-intel/queries/` — 16 methods mirroring pi-sage:
  - `search(query, {repo?, doc_type?, limit?, branch?})` — FTS5 MATCH / Postgres `websearch_to_tsquery` with OR-expansion for multi-word recall
  - `semantic(query, {repo?, doc_type?, limit?, include_docs?})` — cosine similarity; fallback to FTS if embeddings table empty
  - `graphQuery(entity, {direction: 'outgoing' | 'incoming' | 'both'})` — direct edge lookup
  - `blastRadius(entity, {maxHops=3})` — **recursive CTE**:
    ```sql
    WITH RECURSIVE deps AS (
      SELECT source_kind, source_id, target_kind, target_id, relation, 1 AS hops
      FROM edges WHERE target_id = $1 AND target_kind = $2
      UNION
      SELECT e.*, d.hops + 1
      FROM edges e JOIN deps d ON e.target_id = d.source_id
      WHERE d.hops < $3
    )
    SELECT * FROM deps ORDER BY hops
    ```
    Returns `Map<hops, edges[]>`
  - `endpointSearch({pathPattern?, method?, framework?, repo?})`
  - `configSearch(pattern, {repo?})`
  - `contributorSearch({email?, name?, repo?})`
  - `dependencySearch({repo?, depType?})`
  - `infraSearch({repo?, kind?})`
  - `testMappingSearch(repoId)`
  - `fileHotspotsSearch({repo?, minRisk?})`
  - `getRepoDoc(repoId, docType)`
  - `getRepoState(repoId)`
  - `auto(query, limit=15)` — **pi-sage's router copied verbatim**: FTS on chunks → FTS on docs → config ILIKE; dedup by `(base_repo, file_path, chunk_type)`; sort by `(source_order: code=0, doc=1, config=2, -rank)`

**4.2 MCP tools** (#326)
- `ark-ask` → `auto(query)`
- `ark-find-files` → `findFiles(query)`
- `ark-find-symbols` → symbol search with FTS
- `ark-find-endpoints` → `endpointSearch`
- `ark-find-configs` → `configSearch`
- `ark-graph` → `graphQuery`
- `ark-blast-radius` → `blastRadius`
- `ark-get-context` → structured multi-source context for a subject (files + symbols + tests + hotspots + deps)
- Both stdio + Streamable HTTP transports
- RPC parity: `code-intel/search/*`, `code-intel/graph/*`, `code-intel/blast-radius`, `code-intel/auto`

### Wave 5 — Analysis pipeline (pi-sage 5-pass, Ark-native)

**5.1 Analysis engine** (#334)
- `packages/core/analysis/engine.ts` — orchestrator (~1200 LOC target)
- `packages/core/analysis/passes/{collect,distill,deep,analyse,save}.ts` — one per pass
- `packages/core/analysis/system-prompt.ts` — adapted from pi-sage's 400-LOC prompt (tone + output schema + KB tool usage + gap rules + confidence scoring + path sanitization)
- `packages/core/analysis/tools.ts` — KB_TOOLS for Claude tool-use (kb_search, kb_semantic_search, kb_graph, kb_blast_radius, kb_file_read, kb_similar)
- Models: Sonnet 4.6 full, Haiku 4.5 distill/light
- **Pass 1 (Collect)** — search terms from Jira data: top-6 keywords + next-6 + class/method names + API endpoints + components + labels + remaining keywords >4 chars. FTS + semantic + graph + endpoints + configs + contributors. Persist every result to `kb_searches` + `kb_evidence` tables for audit trail. Use `_prefetchRepoEvidence` aggregate-query pattern (5 queries, not 5×N).
- **Pass 2 (Distill)** — `haikuScoreBatch` with 20 chunks per batch, format `[i] repo/name (doc_type): text[:400]`, output `INDEX|SCORE`. Threshold ≥5.
- **Pass 3 (Deep Evidence)** — for repos passing distill, targeted queries.
- **Pass 4 (Analyse)** — Claude with tool use + bounded tool-call budget. Forced summary fallback on limit hit (see `_handle_investigation_limit` pattern).
- **Pass 5 (Save+Learn)** — persist, carry-forward resolved gaps, detect ticket deps by shared repos/files.

**5.2 Output types** (`packages/core/analysis/types.ts`)
- Port pi-sage's `AnalysisOutput` Pydantic model to Zod. Fields: summary, business_value, request_type (8 kinds), effort_estimate (human_days / ai_assisted_days / reasoning), confidence_score, complexity_score, methodology, dependency_graph, complexity_notes, blast_radius (service/impact/severity), rollback_strategy, deployment_order, pre_conditions, domain_experts, gaps (question/why/severity/audience/owners), checklist, e2e_scenarios, uat_checks, affected_repos, files_affected_count, repos_touched_count.

**5.3 RPC + CLI**
- `analysis/start {ticket_ref, mode: 'full' | 'light'}`
- `analysis/get {id}`, `analysis/list`, `analysis/versions {ticket_ref}`
- `ark analyze <ticket-ref> [--light]`

**5.4 Cost tracking** — reuse existing `packages/core/observability/usage.ts`

### Wave 6 — Chat pipeline (pi-sage multi-strategy)

**6.1 Chat engine** (#335)
- `packages/core/chat/engine.ts` — orchestrator with SSE streaming
- `packages/core/chat/intent.ts` — regex-based: `impact`, `similarity`, `exact_lookup`, `general`
- `packages/core/chat/query-expansion.ts` — Haiku system prompt: *"You generate search queries for a codebase search engine. Given a user question, output 3-4 alternative keyword queries. Focus on: class names, method names, config keys, service names, technical terms."* Cached 1h, LRU 512, key = normalized lowercase + single-spaced.
- `packages/core/chat/search.ts` — parallel: FTS via `auto(q)` for each expanded query + `semantic(q)` + repo-name fuzzy match + exact-name CamelCase lookup + blast-radius for impact queries
- `packages/core/chat/focus.ts` — when scoped to an analysis, prepend purpose/architecture/contracts docs, higher `limit=30`, repo-scoped semantic, structured extractor chunks (hotspots minRisk=40, test_mappings, dependencies)
- `packages/core/chat/scoring.ts` — scoring formula:
  - +100 for `doc_type ∈ {purpose, architecture, contracts}`
  - +70 focus repos
  - +50 priority repos (name-matched)
  - +25 default-branch (no `@suffix`)
  - +20 `source.endswith('_focus')`
  - +15 recently-indexed (`<7d`)
  - +10 analysis-branch match
  - −30 test files
- `packages/core/chat/dedup.ts` — cross-branch dedup by `(base_repo, file_path)`; prefer default-branch unless user explicitly mentions branch via regex
- `packages/core/chat/diversity.ts` — one result per base repo first, then fill remainder
- `packages/core/chat/neighbors.ts` — top 20 → single query with `(repo, file_path) IN (VALUES …)` tuple clause to pull sibling chunks in one round-trip
- `packages/core/chat/synthesis.ts` — Claude Sonnet with conversation history
- `packages/core/chat/storage.ts` — persist conversations to new `chat_conversations` + `chat_messages` tables

**6.2 RPC + CLI**
- `chat/start {ticket_ref?}` → `conversation_id`
- `chat/post {conv_id, text}` → SSE stream of tokens
- `ark chat [--ticket <ref>]`

### Wave 7 — Platform docs framework (#337)

- `packages/core/platform-docs/framework.ts` — generator interface:
  ```ts
  interface DocGenerator {
    kind: string;
    generate(workspace: Workspace, ctx: GenCtx): Promise<GeneratedDoc>;
  }
  ```
- Generators (first 10):
  - `generators/adr-index.ts` — walk repos for ADR files, produce index with status + title
  - `generators/api-endpoint-registry.ts` — aggregate `endpoints` rows across workspace
  - `generators/architecture-critique.ts` — Claude Sonnet reviews the workspace's structure
  - `generators/env-var-registry.ts` — aggregate `configs` with `value_type ∈ {env, secret_ref}`
  - `generators/kafka-topic-map.ts` — scan configs for Kafka topic patterns, cross-link producers/consumers
  - `generators/data-flow-map.ts` — trace edges from API endpoints → services → databases
  - `generators/service-dependency-graph.ts` — `edges` where `source_kind='repo'` and `target_kind='repo'`
  - `generators/maturity-scorecard.ts` — per-repo: test coverage, doc presence, hotspot density, endpoint documentation
  - `generators/risk-register.ts` — high-risk hotspots, dangling external_refs, services with no contributors in 30 days
  - `generators/onboarding-guide.ts` — Claude-synthesized from purpose.md + architecture.md per repo
- Scheduler: regenerate weekly + on-demand. Persist to `platform_docs` (per workspace, per doc_type, versioned).
- RPC + CLI + Web UI tab on workspace page.

### Wave 8 — Wiki ingest (#339)

- `packages/core/wiki/types.ts` — `WikiProvider` interface + `NormalizedWikiPage`
- `packages/core/wiki/providers/`:
  - `confluence/` — REST v2 API, Storage Format ↔ MDX (reuse existing ADF ↔ MDX work)
  - `notion/` — `@notionhq/client`, block-based API ↔ MDX
  - `wikijs/` — GraphQL client (`graphql-request`)
- Ingested pages persist as `platform_docs` rows with `doc_type='wiki'` + `attrs.source_provider`

### Wave 9 — Cross-ticket + admin polish

- **Cross-ticket dep detection** (#333) — `ticket_dependencies` table; computed post-analysis from shared repos + shared files
- **Admin UI wording** (#274) — "Archive" not "Delete"; add "Show archived" toggle; add `ark {tenant,team,user,apikey} restore` CLI
- **Tenant-scoping unification** (#275) — audit every handler; prefer `ctx.tenantId` over `app.tenantId`
- **Zod schemas** (#276) — cover admin/* + secret/* + cluster/* + code-intel/* + analysis/* + chat/* + platform-docs/*

### Wave 10 — Infrastructure gaps (strategic, from Slack)

- **MCP gateway evaluation** (#354) — evaluate `IBM mcp-context-forge` vs build-our-own. Policy engine, OAuth brokerage, tenant/role-scoped ACLs, tool audit log.
- **Canonical flow nodes + BU overlays + 4 execution modes** (#355) — `flows/nodes/*.yaml` library; `flows/overlays/<bu>.yaml` to pick mode+model+tools per node; modes: `manual`, `agentic`, `co-paired`, `conversational`.
- **Workflow UI primitives** (#356) — chat file upload, diff review, terminal attach, container logs, summary panel, in-app browser.
- **Release fix** (#357) — proper GH releases with platform tarballs; fix `install.sh` 404 on v0.12.0.
- **Worktree .ark.yml** (#358) — verify + document `worktree.copy: [globs]` + `worktree.setup: ./setup.sh`.
- **Zoekt evaluation** (#359) — benchmark zoekt vs tsvector on exact/regex code search. If not 5x faster, close without implementing.
- **External team tool adapters** (#360) — `WorkflowTool { kind, invoke, stream }` adapter pattern; first three: Mehul PRD, Shreyas discovery, Rahul design.
- **Cost-aware routing** (#361) — SambaNova (MiniMax + DeepSeek), OpenRouter, Kimi, GLM backends. Per-job-type defaults. Spend caps per tenant/session.
- **MCP router + boot resilience** (#362) — single stdio entry that fans out to upstream MCPs; lazy + parallel boot; crash in one doesn't kill session.
- **Adesh claude-farm KT** (#363) — comparison doc with 1Code / Symphony / Dorothy.

### Wave 11 — Hardening follow-ups (can ship any time)

- #269 Blob encryption at rest (OS keyring + envelope encryption)
- #270 Arkd janitor (sweep orphan session Secrets >24h)
- #271 Phase 2 cluster auth (exec plugins + OIDC/WIF)
- #272 Cross-VPC / private-endpoint docs
- #273 Tarball upload path for caller-local indexing
- #277 Soft-delete cascade-restore flag
- #278 runAsNonRoot hardening docs + defaults
- #288 (folds into #322) — knowledge daemon indexing

---

## 5. Sequencing — concrete dispatch order

```
Step 1: Wait for in-flight drizzle Phase B + GH/Linear/BB finish agents.
Step 2: Commit batch. Verify `make test` green + `bunx tsc --noEmit` clean.
Step 3: Dispatch Wave 1 (rip legacy + MCP shell) as ONE agent.
Step 4: After Wave 1 lands, dispatch Waves 2 + 3 in parallel (non-overlapping territories):
  - Agent A: Language extractors (Python + Java + TS + Go in one)
  - Agent B: Domain extractors (endpoints + configs + infra + deps)
  - Agent C: Embeddings + FTS (shared infra, depends on schema not extractors)
Step 5: After Waves 2+3 land, dispatch Wave 2.3 (secondary extractors).
Step 6: After all extractors + embeddings land, dispatch Wave 4 (queries + MCP tools) — ONE agent.
Step 7: Dispatch Wave 5 (analysis engine) — ONE agent (large scope).
Step 8: Dispatch Wave 6 (chat) + Wave 7 (platform docs) + Wave 8 (wiki) in parallel.
Step 9: Dispatch Wave 9 (cross-ticket + admin polish) as one small agent.
Step 10: Dispatch Wave 10 strategic items as capacity allows.
```

Agent parallelism limit: 5 concurrent. Always commit a clean green tree between major waves.

---

## 6. Design divergences from pi-sage (we're stricter)

These are deliberate — pi-sage built for one tenant in one org. Ark is multi-tenant product:

| pi-sage | Ark |
|---|---|
| `repo` as text PK across 10+ tables | `repos` table with UUID PK, `tenant_id` FK |
| No `indexing_runs` table | First-class with per-run audit + rollback |
| DELETE+INSERT on reindex (torn reads) | `deleted_at` soft-delete + partial unique indexes |
| Free-text `source_entity` / `target_entity` in code_graph | Typed `(kind, id)` tuples with check constraints |
| No `external_refs` (silent dangling edges) | First-class with `resolved=false` + resolve-on-index |
| Embeddings hardcoded to one model | `UNIQUE(subject_kind, subject_id, model, model_version)` |
| Flat chunks | `parent_chunk_id` hierarchy (class → method → statement) |
| Auto-increment INTEGER PKs | UUIDs throughout (federation + sharding friendly) |
| `repo_docs UNIQUE(repo, doc_type)` (one doc per type) | `platform_docs UNIQUE(workspace_id, doc_type, version)` |
| No schema version | `ark_schema_migrations` + drizzle-kit drift check |

These are the 20+ flaws the earlier unification plan called out. They stay fixed.

---

## 7. What this plan leaves for later (explicit)

- Browser extension or IDE plugin (pi-sage has neither; we can decide separately)
- OAuth token refresh for Jira Cloud / Bitbucket Cloud (Phase 2 in each provider's follow-up)
- Workload Identity Federation + exec-plugin k8s auth (#271; daemon image rebuild)
- BullMQ scaling for the reindexer (in-process setInterval is enough for Phase 1)
- Sharding the embeddings table (single pgvector index handles ~1M rows easily)

---

## 8. CLAUDE.md updates that must land with this plan

Replace the "No migrations. `repositories/schema.ts` is the authoritative schema. Column changes = `rm ~/.ark/ark.db`." section with:

> **Schema + migrations via drizzle.** Schema-as-code in `packages/core/drizzle/schema/{sqlite,postgres}.ts`. `drizzle-kit generate` after any schema change → new SQL migration in `drizzle/{sqlite,postgres}/`. `make drift` (CI) fails if committed migrations disagree with the schema files. Runtime: `MigrationRunner` applies migrations in order under a transaction per migration; Postgres boot takes `pg_advisory_lock(hashtext('ark_migrations'))`.

Add sections:
- **Code-intel extractor pattern** — interface, regex-first convention, `indexing_run_id` tagging, file size rule (350 LOC)
- **Ticket provider pattern** — `TicketProvider` interface + per-provider adapter + fixture-driven tests
- **Platform docs generator pattern** — workspace-scoped, queries `app.codeIntel`, persists to `platform_docs`
- **Wiki provider pattern** — same shape as ticket providers, persists to `platform_docs` with `doc_type='wiki'`
- **Analysis prompt conventions** — pi-sage's tone rules (friendly/direct, never alarmist, gap-questions-not-assertions), path sanitization, JSON-only output for machine-parseable passes

This update is #340 (filed earlier).

---

## 9. Open questions to resolve before Wave 5

- **Analysis system prompt — Ark context vs Paytm-specific.** Pi-sage's prompt hardcodes Paytm platform context (pi-rule-engine, pi-event-gateway, Keycloak, etc.). Our version must be tenant-templated: the tenant provides a `platform_context.yaml` that gets inlined into the prompt. Need to design that tenant-config shape.
- **Tool-use budget for Pass 4.** Pi-sage bounds tool calls in the investigation loop. What's the right budget for Ark? Probably match pi-sage (tool call count limit + zero-result-streak circuit breaker), but this affects cost per analysis.
- **Model pinning per pass.** Pi-sage uses `claude-sonnet-4-6` and `claude-haiku-4-5-20251001` — match these. Cost-aware routing (#361) can override later, but default must be Claude for consistency with pi-sage's reference output.

---

This plan is the authoritative dispatch sequence going forward. Every GH issue referenced above has been annotated with the relevant pi-sage-source excerpts so the dispatching agents have concrete implementation guidance.
