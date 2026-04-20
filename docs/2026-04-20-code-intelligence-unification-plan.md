# Code Intelligence Overhaul (2026-04-20, rev 2)

## Direction

Not a router. Not a wrapper. One unified store, many extractors feeding it, one query surface on top. Mirror pi-sage's architecture but **fix its structural flaws** before shipping.

Supersedes the rev-1 router plan. Kills the in-flight Phase 1 router work.

## Critical review of pi-sage's schema

Pi-sage's 15-table schema (`code_chunks`, `endpoints`, `code_graph`, `contributors`, `embeddings`, `ast_nodes`, `test_mappings`, `class_hierarchy`, `dependencies`, `infra_config`, `file_hotspots`, `config_entries`, `repo_docs`, `repo_docs_fts`, `repo_index`) is functional but carries 20+ real design flaws. Copy blindly and we inherit them all.

### Structural flaws

1. **No multi-tenancy.** `repo` is a TEXT primary key. Two tenants with the same repo name collide. Cannot retrofit tenant_id without schema break.
2. **`repo` as a string, not FK.** Every table references `repo` by text; no referential integrity; dropping a repo orphans rows everywhere.
3. **No branch / worktree / commit-at-a-time storage.** `repo_index.active_branch` implies ONE branch in the store. Breaks worktrees, PR previews, historical comparison, dual-branch analysis. Reindex clobbers.
4. **No files table.** `file_path` repeated as TEXT across `code_chunks`, `ast_nodes`, `endpoints`, `contributors`, `config_entries`, `infra_config`, `test_mappings`, `file_hotspots`. Rename = update 8 tables. "Everything about file X" needs 8 joins.
5. **No symbols table.** Symbols live half in `code_chunks.content`, half in `ast_nodes.name`. Duplicated. `code_graph.source_entity` / `target_entity` are free-text strings, not FKs to symbols.
6. **Code graph edges have no referential integrity.** `source_entity TEXT` + `target_entity TEXT`. Rename a symbol, edges break silently. No dangling-edge tracking.
7. **Contributors denormalized per file.** Same person row repeated for every file they touched. Email change = UPDATE millions of rows. No `people` table.
8. **Embeddings hardcoded to one model.** `UNIQUE(source_type, source_id)` prevents storing two embeddings from different models. Can't upgrade model without wiping.
9. **Embeddings only cover chunks + docs.** No embeddings on endpoints, configs, symbols, classes. Semantic search is narrower than it could be.
10. **Free-text JSON in TEXT columns in SQLite** (`code_chunks.metadata`, `infra_config.env_vars`). No JSON path index. SQLite JSON1 exists, not used.
11. **No `indexing_runs` table.** `repo_index.last_indexed_at` is a single scalar. Can't tell which extractor wrote which rows, can't roll back a bad run, can't diff runs.
12. **Auto-increment INTEGER PKs.** Fine local; horrible for cross-tenant federation or database-level sharding. UUIDs make this trivial.
13. **No soft deletes.** File renamed -> hard delete + insert. Concurrent queries see torn state during reindex.
14. **No hierarchical chunks.** A class containing methods containing statements cannot be expressed. Everything is flat.
15. **`chunk_type TEXT` no enum / check.** Free text. Typos don't fail. No canonical list.
16. **No schema version.** Migrations are DROP + CREATE. No rollback path.
17. **FTS triggers on content-rowid sync** are fragile. Direct UPDATEs bypass the trigger in rare code paths.
18. **`endpoints` with no UNIQUE.** Reindex duplicates. Same for `dependencies`, `infra_config`.
19. **`external_refs` concept missing.** Cross-repo call from repo A to repo B where B isn't indexed yet = silent dangling edge in `code_graph`. No status, no resolve-later path.
20. **No TTL / archival.** `code_chunks` grows forever across reindexes unless explicitly pruned. Pi-sage reindex = DELETE WHERE repo=X + INSERT; during that window queries see partial data.
21. **`code_graph.evidence TEXT` is free-form.** Cannot link an edge back to the chunk that proved it. No audit trail.
22. **No observability hooks.** No run duration, no extractor metrics, no error row. Ops are blind.
23. **`repo_docs` UNIQUE(repo, doc_type)** -- locks to one doc of each type per repo. Multiple READMEs in monorepos? Nope.
24. **No namespacing for global vs per-repo config.** Tenant-level defaults (e.g. coding standards) have no home.

None are fatal for pi-sage's single-tenant Paytm install; all are fatal for a multi-tenant control-plane product. We fix them.

## Ark's design principles

1. **Every row has `tenant_id`.** From day one. No retrofits.
2. **UUIDs for primary keys.** Federation + sharding friendly.
3. **Normalized: first-class `files`, `symbols`, `people`, `repos` tables.** Everything else FKs to them.
4. **Edges reference entities by typed FK**, not by free-text `entity` strings. Source and target get `(kind, id)` pairs with check constraints.
5. **`indexing_runs` everywhere.** Every row records the run that produced it. Delta / rollback / audit for free.
6. **Multi-commit, multi-branch storage.** A repo can have chunks from `main@abc` AND `feature/x@def` simultaneously. Active-branch is a pointer, not a filter.
7. **Soft deletes via `deleted_at`.** Reads filter automatically. Concurrency-safe.
8. **Hierarchical chunks** via `parent_chunk_id`. Class -> methods -> statements.
9. **Enum / check constraints on type columns.** `chunk_kind`, `edge_relation`, `symbol_kind` all canonical.
10. **Embeddings are `(subject_kind, subject_id, model, model_version)`.** Multiple models per subject. Embed endpoints, configs, symbols, not just chunks.
11. **Schema version + migrations.** `schema_migrations` table, forward-compatible changes.
12. **External refs as first-class.** Dangling cross-repo edges land in `external_refs` with `resolved=false`, resolved on demand when the target repo is indexed. Queryable status.
13. **Per-dialect DDL from one source.** Single schema definition emitted as SQLite DDL locally and Postgres+pgvector DDL in control-plane. No divergence.
14. **Extractor outputs are typed but extensible.** Canonical columns for known fields (e.g. `endpoints.method`, `endpoints.path`) plus `attrs jsonb` for extractor-specific metadata.
15. **No `.codegraph/graph.db` per repo.** One store. Period.
16. **Every row links back to its indexing_run + evidence chunk.** Audit trail, query explanation, run diffs.

## The schema (first cut)

Twenty tables, roughly half normalized core, half typed extractor outputs. All tenant-scoped. All `indexing_run_id` + `deleted_at` aware where relevant.

### Core (6 tables)

- **`tenants`** `(id UUID PK, name, slug, created_at)` -- single row in local mode.
- **`repos`** `(id UUID PK, tenant_id FK, repo_url, name, default_branch, primary_language, local_path nullable, created_at, deleted_at)` -- `UNIQUE(tenant_id, repo_url)`.
- **`indexing_runs`** `(id UUID PK, tenant_id FK, repo_id FK, branch, commit, started_at, finished_at nullable, status enum(running|ok|error|cancelled), extractor_counts jsonb, error_msg nullable)`.
- **`files`** `(id UUID PK, tenant_id, repo_id, path, sha, mtime, language, size_bytes, indexing_run_id FK, deleted_at)` -- `UNIQUE(tenant_id, repo_id, path, sha)` so multiple commits coexist; active file per repo is a view.
- **`symbols`** `(id UUID PK, tenant_id, file_id FK, kind enum(class|function|method|struct|enum|var|interface|...), name, fqn, signature, line_start, line_end, parent_symbol_id nullable, indexing_run_id, deleted_at)`.
- **`chunks`** `(id UUID PK, tenant_id, file_id FK, symbol_id nullable FK, parent_chunk_id nullable FK, chunk_kind enum, content, line_start, line_end, attrs jsonb, indexing_run_id, deleted_at, fts_tsvector generated stored on PG / virtual FTS5 table on SQLite)`.

### Graph (2 tables)

- **`edges`** `(id UUID PK, tenant_id, source_kind enum, source_id UUID, target_kind enum, target_id UUID, relation enum, evidence_chunk_id nullable FK, weight float, attrs jsonb, indexing_run_id, deleted_at)` -- check constraint that `source_kind` + `target_kind` match valid pairs.
- **`external_refs`** `(id UUID PK, tenant_id, symbol_id FK, external_repo_hint, external_fqn, resolved_symbol_id nullable FK, resolved_at nullable, indexing_run_id)` -- dangling edges with first-class status.

### Embeddings (1 table, multi-model)

- **`embeddings`** `(id UUID PK, tenant_id, subject_kind enum, subject_id UUID, model, model_version, dim, vector vector(N) / blob, indexed_at, indexing_run_id)` -- `UNIQUE(tenant_id, subject_kind, subject_id, model, model_version)`. pgvector in PG, blob in SQLite (cosine done in-app).

### Extractor outputs (7 tables -- one per pi-sage domain, redesigned)

- **`endpoints`** `(id UUID PK, tenant_id, repo_id, file_id, handler_symbol_id nullable FK, framework, method, path, request_type jsonb, response_type jsonb, attrs jsonb, chunk_id FK, indexing_run_id, deleted_at)` -- `UNIQUE(tenant_id, repo_id, method, path, framework)`.
- **`configs`** `(id UUID PK, tenant_id, repo_id, file_id, key_path, value, value_type, scope enum(repo|service|tenant|global), source_chunk_id, indexing_run_id, deleted_at)`.
- **`infra_resources`** `(id UUID PK, tenant_id, repo_id, file_id, kind enum(k8s|terraform|docker-compose|helm|cloudformation), resource_type, name, spec jsonb, depends_on_ids jsonb, indexing_run_id, deleted_at)`.
- **`dependencies`** `(id UUID PK, tenant_id, repo_id, file_id, manifest_kind enum(npm|pip|maven|cargo|go|gem|composer|...), name, version_constraint, resolved_version nullable, dep_type enum(prod|dev|peer|optional), indexing_run_id, deleted_at)` -- `UNIQUE(tenant_id, repo_id, manifest_kind, name, dep_type)`.
- **`test_mappings`** `(id UUID PK, tenant_id, test_file_id FK, source_file_id FK, test_symbol_id nullable, source_symbol_id nullable, confidence, evidence_chunk_id nullable, indexing_run_id, deleted_at)`.
- **`people`** `(id UUID PK, tenant_id, primary_email, name, alt_emails jsonb, alt_names jsonb, created_at)` -- deduped contributors.
- **`contributions`** `(id UUID PK, tenant_id, person_id FK, repo_id FK, file_id nullable, commit_count, loc_added, loc_removed, first_commit, last_commit, indexing_run_id)`.

### Metrics / hotspots (1 table)

- **`file_hotspots`** `(file_id FK PK, tenant_id, change_count_30d, change_count_90d, authors_count, lines_touched, risk_score, computed_at, indexing_run_id)` -- recomputed, not user-written.

### Agent / session graph (reuse existing Ark tables)

- `sessions`, `memories`, `learnings`, `skills`, `recipes`, `agents` -- existing. Connect to code entities via `edges` with appropriate `(session_kind, X_kind, relation)` triples.

### Migration / versioning

- **`schema_migrations`** `(version INTEGER PK, name, applied_at)`.

## Extractor architecture

- **One extractor interface:** `Extractor { name, kindsProduced, run(ctx): AsyncIterable<Row> }`. Each yields rows tagged with their run_id + deleted_at semantics.
- **Ark runs `ops-codegraph` as a subprocess**, streams its output, persists into `files` + `symbols` + `edges` + `chunks`. Drops `.codegraph/graph.db`.
- **Ark runs `codebase-memory-mcp` as a subprocess**, streams its MCP tool calls through a capturing adapter, persists chunks + embeddings into the shared store. Drops its internal DB.
- **Per-domain extractors (configs, endpoints, infra, deps, tests, contributors)** live under `packages/core/code-intel/extractors/<name>/`. Each ships with fixtures + tests.
- **Indexing run lifecycle:** insert `indexing_runs` row status=running -> extractors populate rows tagged with run_id -> finalize: flip previous active rows to `deleted_at`, mark run status=ok. Atomic per repo.

## Query surface

One class `CodeIntel` in `packages/core/code-intel/` with methods:

- **Discovery:** `findFiles`, `findSymbols`, `findContributors`, `findEndpoints`, `findConfigs`, `findDependencies`, `findInfra`, `findTests`, `fileHotspots`.
- **Graph:** `getContext(subject)`, `callers(symbol)`, `callees(symbol)`, `blastRadius(subject, depth)`, `classHierarchy(symbol)`, `crossRepoBlastRadius(subject)`.
- **Search:** `fts(query, filters)`, `semantic(query, model?, filters)`, `auto(query)` (intent router across FTS + semantic + symbol lookup).
- **Audit:** `explainResult(result_id)`, `runDiff(run_a, run_b)`.

Exposed uniformly across CLI, MCP, Web UI, JSON-RPC. Each method accepts `{ tenant_id, repo_id?, branch?, commit?, ...filters }`.

## What to rip out

- `packages/core/knowledge/codegraph-shim.ts` read-path (keep binary-path resolution).
- `packages/core/knowledge/codebase-memory-finder.ts` direct MCP injection in `writeChannelConfig` (replaced by unified MCP once Phase 1 stabilizes).
- `packages/core/knowledge/store.ts` existing KnowledgeStore schema -- SUPERSEDED by the new schema. Migration writes existing `knowledge` + `knowledge_edges` rows into the new `chunks` / `edges` tables keyed to a synthetic `legacy-migration` indexing run.
- Per-repo `.codegraph/graph.db` files -- cleaned up on first index under the new store.
- `ark knowledge *` and `ark knowledge codebase *` CLI trees -- replaced by `ark code-intel *`, old commands print a deprecation redirect.

## Workspaces + Platform Knowledge (derived docs)

Pi-sage ships ~80 auto-generated platform-level documents (ADR Index, API Endpoint Registry, Architecture Critique, Env Var Registry, Kafka Topic Map, Data Flow Map, Service Dependency Graph, Maturity Scorecard, Risk Register, Security Audit, Onboarding Guide, etc.). These are NOT per-file chunks or per-symbol edges -- they are **cross-repo synthesis documents** scoped to a workspace.

Ark needs the same layer, done cleanly.

### Workspace concept

Three-level hierarchy: `tenant -> workspace -> repo`. **Workspace is the unit of dispatch**, not just a query scope.

- **Tenant** -- billing + auth boundary. One per organization.
- **Workspace** -- multi-repo grouping for queries, platform docs, access control, **AND session/flow dispatch**. Examples: "paytm-payments", "paytm-insurance", "paytm-core-platform". A workspace contains N repos (1..many). Small tenants have one default workspace; large orgs have many.
- **Repo** -- indexed source tree. Each repo belongs to exactly one workspace.

Every query / MCP tool / UI tab / **session / flow** accepts an optional `workspace_id`. If omitted, defaults to the caller's active workspace (`ark workspace use <slug>` sets persistent default).

Platform docs are generated per workspace because cross-repo synthesis (e.g. "API Endpoint Registry") makes no sense above that scope and is too coarse below it.

### Workspace as dispatch unit

Today an Ark session is anchored to one repo (`session.repo`, `session.workdir` -> single git worktree). A workspace dispatch broadens that: an agent runs against **all repos in the workspace simultaneously**, with cross-repo edits, queries, and tests as a first-class scenario.

**Session model changes (Wave 2):**
- `sessions` gains `workspace_id` (FK, nullable for back-compat) + keeps `repo_id` (now meaning "primary entry-point repo if any").
- When `workspace_id` is set and `repo_id` is null, the session is workspace-scoped. The agent gets the whole workspace as its working tree.
- When both are set, the session is workspace-aware but anchored to one repo (the agent can navigate to siblings).
- When only `repo_id` is set (legacy), behavior is unchanged.

**Worktree provisioning for workspace sessions:**

Single workspace session = N parallel git worktrees mounted under one parent dir:

```
~/.ark/workspaces/<session_id>/
  paytm-payments/         # worktree of repo A on session branch
  payment-service/        # worktree of repo B on session branch
  fraud-engine/           # worktree of repo C on session branch
  .ark-workspace.yaml     # manifest: which repos, branches, last commits
```

Branch convention per workspace session: `ark/sess-<short-id>` created in each repo. Cross-repo PRs link via the manifest (later: `ark workspace pr` opens parallel PRs in each touched repo, cross-linked in the bodies).

**Sparse mode (default for large workspaces):** the manifest declares ALL workspace repos, but only fetches/clones repos the session actually touches (lazy). First `Read` / `Glob` / `Grep` against repo X triggers its clone. Keeps onboarding fast; full clone on demand via `ark session expand <id> --repo <r>`.

**Compute targets adapt:**
- Local -- straightforward: parallel directories under `~/.ark/workspaces/<sid>/`.
- Docker -- one bind-mount per repo.
- Devcontainer -- multi-folder VS Code workspace file generated.
- Firecracker / EC2 / K8s -- PVCs (one per repo) or init container that clones each repo into the agent volume.
- arkd handles the manifest + sparse cloning; agent runtime sees the unified directory.

**Flow scope:**
- Flow YAML adds `scope: repo | workspace` (default `repo`, back-compat).
- `scope: workspace` flows expect the agent to know about multi-repo work. Stage `task` templates can reference `{workspace.slug}`, `{workspace.repos[]}`, `{workspace.primary_repo}`.
- New built-in flows under `flows/definitions/workspace-*.yaml`: `workspace-platform-tech-debt-review`, `workspace-cross-repo-rename`, `workspace-bump-shared-dep`, `workspace-security-sweep`, etc.

**Trigger routing:**
- Webhook on a single repo (e.g. GitHub PR opened on `payment-service`) can dispatch:
  - a repo-scoped flow on that repo (today's behavior), OR
  - a workspace-scoped flow with `payment-service` set as `primary_repo` and the workspace context attached.
- Trigger config gets `dispatch.scope: repo | workspace` field; matcher knows which workspace the source repo belongs to.

**CLI surface (additive, all back-compat):**
- `ark exec --workspace paytm-payments --flow workspace-tech-debt-review` (workspace flow)
- `ark exec --workspace paytm-payments --repo payment-service --flow fix-bug` (workspace context, single-repo flow)
- `ark exec --repo payment-service --flow fix-bug` (legacy, unchanged)
- `ark workspace dispatch <flow-name> --workspace <slug> [--input task=path.md]`
- `ark workspace sessions [--workspace <slug>]` lists workspace sessions
- `ark workspace pr <session-id>` opens parallel PRs across touched repos with cross-links

**Web UI:**
- New session form: "Workspace" picker (above "Repo"). Picking a workspace exposes the full repo list and a "all repos" toggle for workspace-scoped flows.
- Session view: "Repos in this session" panel showing per-repo branch / commit / changes / open PRs.
- Workspace overview page: members, repos, recent sessions, platform docs link.

**Agent perspective:**
- Env vars set on launch: `ARK_WORKSPACE`, `ARK_WORKSPACE_DIR`, `ARK_WORKSPACE_REPOS` (CSV), `ARK_PRIMARY_REPO` (if set).
- All Read / Write / Bash / Grep / Glob tools naturally work across the workspace dir.
- Code-intel queries default-scoped to the active workspace.
- The MCP server's `code_intel.*` tools accept implicit workspace from `ARK_WORKSPACE`.

### Where workspace-as-dispatch lands

- **Wave 1 (in flight):** unchanged. No workspace concept yet.
- **Wave 2:** `workspaces` + `workspace_id` on `repos` and `sessions`; CLI `ark workspace ...`; sparse multi-repo worktree provisioning for local + docker compute; `flow.scope: workspace` reading; one workspace flow shipped end-to-end as proof.
- **Wave 3:** workspace dispatch on EC2 / firecracker / k8s compute; trigger framework `dispatch.scope` wiring; workspace UI in web.
- **Wave 4-5:** more built-in workspace flows; cross-repo PR helpers; workspace-aware session memory.

### Tables (Wave 2 addition, NOT Wave 1)

- **`workspaces`** `(id UUID PK, tenant_id FK, slug, name, description, config jsonb, created_at, deleted_at)` -- `UNIQUE(tenant_id, slug)`.
- **`repos`** -- add `workspace_id FK NOT NULL` with "default" workspace auto-created per tenant at migration.
- **`platform_docs`** `(id UUID PK, tenant_id, workspace_id FK, doc_type enum, title, content_md, source jsonb, generated_by enum('mechanical'|'llm'|'hybrid'), generated_from_run_id FK, model nullable, generated_at, deleted_at)` -- `UNIQUE(workspace_id, doc_type)` with soft-delete carrying previous versions for diff.
- **`platform_doc_versions`** `(id UUID PK, doc_id FK, version, content_md, generated_at)` -- immutable history for every doc regen.

### Doc catalogue (targeting pi-sage parity)

Three generation flavors:

**Mechanical (pure query + template, cheap, deterministic):**
ADR Index, API Endpoint Registry, API Usage Guide, AWS Credentials Requirements, Config Registry, Contract Interface Catalog, Contributor Expertise Map, Database Migration Registry, Database Schema Map, Dependency Graph (= Service Dependency Graph), Deployment Topology, ECR Image Registry, Env Var Registry, Java Upgrade Matrix, Kafka Topic Map, Port Registry, Quality Gate Registry, Release Cadence Map, Repo Standardization Tasks, Secret Management Audit, Service Dependency Graph, Service Health Registry, Spring Boot Version Matrix, Technology Landscape, Testing Landscape. (~25 docs)

**LLM-synthesized (uses the D1 intent layer + higher-level analysis, regen on schedule):**
Anti Pattern Registry, Architecture Critique, Code Smell Registry, Developer Experience Map, Ideal SaaS Architecture, Incident Patterns, Migration Roadmap, Platform Maturity Scorecard, Platform Risk Register, Platform Summary, Platform Tech Debt, Security Audit Full, Security Posture, Monitoring Landscape, Operational Readiness. (~15 docs)

**Hybrid (template + LLM fill-in the judgement calls):**
Architecture Overview, Auth Architecture, Auth Flow, Concepts Guide, Data Flow Map, Data Lineage Map, Development Workflow Guide, Engineer Onboarding Guide, E2E Test Scenarios, Feature Domain Map, Glossary, Incident Patterns (some), Integration Cookbook, Kafka Integration Guide, Local Dev Prerequisites, Local Dev Standard, Multi-Tenancy Architecture, Platform FAQ, Platform Service Map, Platform Shared Libraries, Repo Boot Standard, Decision Flow Authoring Guide, Chat Completion Usage Guide, Event Process Usage Guide. (~25 docs)

Total target: ~60 distinct doc types (pi-sage has ~80 but several are duplicates and a few are Paytm-specific -- we generalize or drop).

### Generation pipeline

Each doc type is a PlatformDocExtractor that takes a `workspace_id` and emits one `platform_docs` row:

```ts
// packages/core/code-intel/extractors/platform-docs/api-endpoint-registry.ts
export const apiEndpointRegistry: PlatformDocExtractor = {
  doc_type: "api_endpoint_registry",
  flavor: "mechanical",
  cost: "cheap",
  cadence: "on_reindex",                // regenerate on every workspace reindex
  async generate(ctx, workspace_id): Promise<PlatformDoc> {
    const endpoints = await ctx.store.listEndpoints({ workspace_id });
    // group by repo, sort by path, render table
    return { content_md, source: { run_id: ctx.run_id, endpoint_count: endpoints.length } };
  },
}
```

**Cadence rules (settable per tenant + per doc type):**
- `on_reindex` -- regenerate after every successful workspace indexing_run (mechanical default)
- `daily` / `weekly` -- scheduled cadence (via trigger framework, LLM-synthesized default)
- `on_demand` -- user triggers from UI/CLI/MCP
- `off` -- disabled

LLM-synthesized docs run at the lowest tier (Haiku / MiniMax) to keep cost down. A full workspace regen of all 15 LLM docs = ~$5-10 per regen at Paytm scale. Budget cap enforced via the existing LLM router policy.

### Surface

- **CLI:** `ark code-intel docs {list, show, regenerate, diff}` scoped by workspace.
  - `ark code-intel docs list --workspace paytm-payments`
  - `ark code-intel docs show api_endpoint_registry --workspace paytm-payments`
  - `ark code-intel docs regenerate --workspace paytm-payments [--doc <type>] [--all]`
  - `ark code-intel docs diff api_endpoint_registry --workspace paytm-payments --from <v>`
- **MCP tool:** `platform_docs.list`, `platform_docs.get`, `platform_docs.regenerate`. All scope by workspace.
- **Web UI:** "Platform Knowledge" tab on the Code Intelligence page. Grouped by flavor. Each entry is expandable (mirrors pi-sage's UX). Filter by workspace (tenant switcher -> workspace switcher).
- **REST:** `GET /api/workspaces/:slug/docs`, `GET /api/workspaces/:slug/docs/:doc_type`, `POST /api/workspaces/:slug/docs/regenerate`.

### Workspace management

New CLI verbs:
- `ark workspace create <slug> --tenant <t> --name <n>`
- `ark workspace list [--tenant <t>]`
- `ark workspace add-repo <workspace-slug> <repo-url-or-path>`
- `ark workspace remove-repo <workspace-slug> <repo>`
- `ark workspace use <slug>` -- sets active workspace for subsequent commands (stored in `~/.ark/config.yaml`)

Web UI adds a workspace switcher in the header (below the tenant switcher in control-plane mode). Default workspace created on repo-add when none exists.

### Where this lands in the phase plan

- **Wave 1 (current sprint):** NOT in scope. Schema only has `tenant_id`; `workspace_id` added as a Wave 2 migration with default-workspace seeding.
- **Wave 2 (Parity Sprint continuation):** workspaces table + `platform_docs` + 10-15 mechanical doc extractors + CLI + Web UI "Platform Knowledge" tab.
- **Wave 4 (differentiators):** LLM-synthesized doc extractors (D1 intent layer prerequisite).
- **Wave 5 (hybrid docs + polish):** remaining hybrid doc extractors.

Acceptance metric: a Paytm workspace can produce all 25 mechanical docs within 60 seconds of a workspace reindex; LLM-synthesized docs regen nightly under $10 total budget per workspace.

## Deployment modes: vendored (local) vs provisioned (control-plane)

The code-intelligence stack runs in two fundamentally different modes. Every subsystem below (extractors, store, embeddings, MCP pool) must work cleanly in both without code forks.

### Local mode -- everything vendored, zero-network indexing

Ark installs carry every binary, grammar, and model they need. A freshly installed Ark on a developer laptop can index a repo with no internet connectivity after the first install.

**Vendored artifacts, shipped in `dist/vendor/<tool>/<platform>/`:**

| Artifact | Size (approx, per platform) | How | Already done? |
|---|---|---|---|
| `codebase-memory-mcp` (static C binary, 66 tree-sitter grammars inside) | ~30-60 MB | `scripts/vendor-codebase-memory-mcp.sh <platform>` pulls v0.6.0 from GitHub releases | Yes, script exists, binary present locally |
| `ops-codegraph` (Rust binary, 33 grammars) | ~40 MB | Optional now that codebase-memory-mcp covers 66 langs; keep as fallback or deprecate in Phase 4 | Yes, binary exists |
| `syft` (Go binary, SBOM) | ~70 MB | `scripts/vendor-syft.sh <platform>` pulls from anchore/syft releases, checksum-verified | **New -- sprint scope** |
| `kubeconform` (Go binary, k8s manifest validator) | ~8 MB | `scripts/vendor-kubeconform.sh <platform>` pulls from yannh/kubeconform releases | **New -- sprint scope** |
| `terraform-config-inspect` (Go binary) | ~20 MB | Build from source or pull release | **New -- sprint scope** |
| ONNX embedding model (`bge-small-en-v1.5` int8-quantized) | ~33 MB | `scripts/vendor-embedding-model.sh` pulls from HuggingFace mirror | **New -- Phase 5 scope** |
| Tree-sitter `.scm` query files (endpoint frameworks, etc.) | <1 MB | In-tree at `packages/core/code-intel/extractors/endpoints/frameworks/*.scm` | **New -- sprint scope** |

**Binary resolver** at `packages/core/code-intel/vendor.ts`:
```ts
export interface VendorResolver {
  locateBinary(name: string): string;        // throws if missing
  locateModel(name: string): string;         // ONNX model paths
  verifyChecksum(name: string): boolean;     // SHA256 against vendored manifest
  listInstalled(): { name, version, ok }[];  // powers `ark doctor`
}
```

Lookup order:
1. `$ARK_VENDOR_DIR/<tool>/<platform>/<bin>` (override for dev)
2. `<exec-dir>/../vendor/<tool>/<platform>/<bin>` (installed layout)
3. `<repo>/dist/vendor/<tool>/<platform>/<bin>` (source-tree layout)
4. `$PATH` (final fallback for user-installed tools -- warn, don't fail)

**Install-time flow:**
- `make install` runs `make vendor-all` which iterates over every tool in `vendor/versions.yaml` and pulls the correct platform binary.
- Checksums pinned in `vendor/versions.yaml` + `vendor/checksums.yaml`, CI verifies.
- `ark doctor` reports present vs missing vendored tools with suggested fix commands.
- Size budget: full vendored install < 300 MB per platform. Provide `make install-minimal` that skips embedding model + syft for bandwidth-constrained environments (semantic search + deps extractor degrade gracefully).

**Data:** SQLite at `~/.ark/ark.db` (already). Embeddings stored inline as BLOB (no pgvector locally). In-app cosine search sufficient up to ~500K vectors per tenant.

**User experience:**
- `ark code-intel repo add <path>` -> indexes immediately using vendored tools.
- No network connection required after install.
- `ark doctor --vendor` shows tool status; `ark code-intel health` rolls it up.

### Control-plane mode -- provisioned external services

When `ark server --hosted` runs, the code-intelligence stack uses provisioned infrastructure. Binaries run inside arkd worker pods; storage is Postgres; embeddings can go through the LLM router. Per-tenant isolation is a first-class concern.

**Provisioned components (Helm chart / Terraform modules at `.infra/helm/ark/`):**

| Component | Provisioning | Scaling | Per-tenant isolation |
|---|---|---|---|
| Postgres + pgvector 0.6+ | Managed DB (RDS / Cloud SQL / self-hosted via chart) | Vertical for writer; read replicas for hot queries | Row-level security keyed by `tenant_id`; schema-per-tenant as opt-in for top-10 tenants |
| arkd worker pool | StatefulSet / Deployment with autoscaling by queue depth | HPA based on `code_intel.pending_runs` + CPU | One worker can serve N tenants; per-tenant work queue + concurrency cap |
| Tool binaries | Baked into the arkd container image (`.infra/Dockerfile.arkd`). Same `vendor/` structure but inside the image | Image size budget < 2 GB | N/A (shared) |
| Embedding service | Either (a) shared ONNX pool inside arkd workers, (b) LLM router to external provider (OpenAI, Voyage, Cohere), (c) per-tenant choice via `tenant_config.embedding_provider` | Autoscales | Per-tenant model + dim |
| Object storage (optional) | S3 / GCS for large artifacts (exported indexing runs, codegraph DB snapshots for cold tenants) | Managed | Bucket-per-tenant or prefix-per-tenant |
| LLM router | Already in Ark (`packages/router/`) | Already scales | Already per-tenant |
| Secrets | Vault / cloud KMS. Existing `packages/core/auth/` layer wraps access | N/A | Per-tenant namespaces |

**Tenant provisioning flow (`ark tenant create <slug>`):**
1. Insert tenant row in the control-plane DB.
2. Create Postgres schema `code_intel_<tenant_slug>` with the full DDL (or row-level on shared schema for small tenants -- configurable per tenant).
3. Initialize indexing quota config (runs/day, concurrent queries, storage cap).
4. Issue signing keys for trigger webhooks (via existing secrets layer).
5. Seed default per-tenant policies (D12).
6. Enqueue an `onboarding` indexing_run with user-specified repos.
7. Provision a per-tenant Grafana dashboard and OTLP stream.

**Indexing path in control-plane:**
1. Web UI / CLI / webhook / schedule triggers `code_intel.reindex` RPC.
2. Control-plane server enqueues a job in the tenant's queue.
3. arkd worker pool picks up the job; runs extractors using in-image binaries.
4. Writes rows into the tenant's Postgres schema/rows.
5. Emits OTLP spans for observability.
6. On completion, fires `code-intel.reindex.complete` on the internal event bus -> any matching triggers fire.

**Embedding provisioning decision tree:**
- Small / dev tenants -> shared ONNX arkd pool (cheap, offline).
- Regulated tenants -> shared ONNX arkd pool with tenant-scoped vector storage (no data leaves control-plane).
- High-throughput tenants -> LLM router to VoyageCode / Cohere (fast, paid).

**Observability + quotas:**
- Per-tenant Prometheus counters: `code_intel_query_count`, `code_intel_indexing_duration_seconds`, `code_intel_vector_bytes`, `code_intel_rate_limit_hits`.
- Per-tenant rate limit middleware at the RPC layer.
- `ark tenant usage <slug>` CLI + UI dashboard.

**Upgrades:**
- Schema migrations (`packages/core/code-intel/migrations/`) run per-tenant on connection. Rolling upgrade safe: new DDL is additive first, then deprecations ship N+1.
- Vendor upgrades (new codebase-memory-mcp version, etc.) rebuild the arkd image; rolling restart.

### Shared abstractions (one code path for both modes)

Neither mode forks the core code. Mode-specific behavior is hidden behind:

```ts
// packages/core/code-intel/deployment.ts
export interface Deployment {
  mode: "local" | "control-plane";
  vendorResolver: VendorResolver;                    // local: file paths; control-plane: arkd RPC handles
  storeBackend: "sqlite" | "postgres";
  embeddingProvider: EmbeddingProvider;              // local ONNX | router | arkd pool
  policyEngine: PolicyEngine;                        // local: allow-all stub; control-plane: real RLS
  observability: Observability;                      // local: stderr; control-plane: OTLP
}
```

Phase 1 wires `Deployment` from `app.config.profile`. Every extractor + store + query method takes a `Deployment` parameter (or reads it from `AppContext`). This is the ONE place where "local vs hosted" diverges; the extractor logic, schema, and query semantics are identical.

## Sequencing: sprint to parity first, differentiate later

Addendum, 2026-04-20: we ship a "dumb" port of pi-sage's capabilities into the unified store before any differentiator. Three reasons:

1. **Users get something usable in 1-2 weeks.** Differentiators are worth nothing until parity ships; users can't compare.
2. **Parity is the stable contract.** Once every pi-sage query works identically in Ark (same inputs, same outputs, possibly broader coverage), we can migrate a real pi-sage install and start collecting production data. Differentiators land on live data.
3. **Modular seams defined during the sprint survive every later phase.** The interfaces we freeze here are the plug-in points for D1-D14.

### Parity Sprint scope (Phase 2 in the revised order)

Lands on top of the Phase 1 foundation (schema + store). Ships all of pi-sage's capabilities into the new store via **one extractor per pi-sage extractor**, **one query method per pi-sage query method**, exposed on CLI + MCP + UI.

| Pi-sage asset | Port target | Port strategy |
|---|---|---|
| 18 extractors (java, python, ts, ast, graph, config, endpoint, contributor, doc_importer, doc_graph, deps, infra, openapi, test_mapper, embedding, class_hierarchy, hotspot, scanner) | `packages/core/code-intel/extractors/<name>.ts`, one file per | For each: pick the upstream tool from the verified tier matrix above, capture its output, shape into the unified-store row format. |
| 15 tables (code_chunks, endpoints, code_graph, ...) | already absorbed by the 17-table unified schema (normalized, tenant-scoped) | Mapping table already in plan. |
| 12 SageIndex query methods (search, semantic_search, graph_query, blast_radius, endpoint_search, contributor_search, test_mapping_search, dependency_search, infra_config_search, file_hotspots_search, config_search, auto) | `packages/core/code-intel/queries/<method>.ts`, one file per | Ports each behavior 1:1 against the unified store. |
| FastAPI routes | JSON-RPC handlers at `packages/server/handlers/code-intel.ts` | One RPC per query method. |
| MCP server | `packages/core/code-intel/mcp.ts` | One tool per query method. |
| CLI | `packages/cli/commands/code-intel.ts` | One subcommand per query method. |
| Web UI | Code Intelligence page tabs (Search / Browse / Graph / Extractors / ...) | Minimal functional UI per query method. |

**Acceptance (parity defined):** on a chosen Paytm repo indexed by both pi-sage and Ark, every pi-sage query returns results within a regression-tolerance bound against Ark's equivalent, verified by fixtures. One diff report auto-generated and tracked.

### Modular seams frozen during the sprint

These interfaces define the plug-in surface for D1-D14 and any future extension. **Once shipped in the sprint, they do not break.**

```ts
// packages/core/code-intel/extractor.ts
export interface Extractor {
  readonly name: string;
  readonly produces: ReadonlyArray<
    "files" | "symbols" | "chunks" | "edges" | "endpoints" | "configs"
    | "infra_resources" | "dependencies" | "test_mappings"
    | "people" | "contributions" | "file_hotspots" | "external_refs"
    | "embeddings" | "semantic_annotations" | "contracts" | "test_assertions"
  >;
  supports(repo: Repo): boolean;                           // fast check: languages, tools present
  run(ctx: ExtractorContext): AsyncIterable<ExtractorRow>; // streaming rows
}
// D1 (LLM intent annotations) adds an Extractor producing "semantic_annotations".
// D4 (contracts) adds one producing "contracts".
// D5 (test intent graph) adds one producing "test_assertions".
// New frameworks = new .scm files; the framework-endpoint Extractor itself stays one file.
```

```ts
// packages/core/code-intel/query.ts
export interface QueryMethod<Args, Result> {
  readonly name: string;                 // "blast_radius", "semantic_search", etc.
  readonly scope: "read" | "admin";      // policy gate
  readonly cost: "cheap" | "moderate" | "heavy";
  run(ctx: QueryContext, args: Args): Promise<Result>;
  explain?(ctx: QueryContext, args: Args): Promise<QueryExplanation>; // D9 hook
}
// Every query method auto-registers into CLI + MCP + UI via a single registry.
// D10 (store-as-MCP scoped SQL) is one more QueryMethod with scope='admin'.
```

```ts
// packages/core/code-intel/ranker.ts
export interface Ranker {
  readonly name: string;
  rank(ctx: QueryContext, candidates: Candidate[]): Promise<Ranked[]>;
}
// Default: blended FTS + semantic + recency.
// D3 (session-as-oracle) = new Ranker implementation registered at runtime;
// tenant chooses which ranker(s) apply per QueryMethod.
```

```ts
// packages/core/code-intel/store.ts (Phase 1)
export interface CodeIntelStore {
  // per-table CRUD, transactions, indexing_runs lifecycle, soft-delete, tenant scoping
  // New tables in D1/D4/D5/D13 are just new CRUD methods on the same store.
}
```

```ts
// packages/core/code-intel/policy.ts (D12 hook, stubbed in Phase 2)
export interface Policy {
  allowRead(ctx, subject): PolicyResult;
  allowWrite(ctx, subject): PolicyResult;
  redact(ctx, subject, row): Row;
}
// Stub returns allow-everything in Phase 2. D12 supplies a real one.
```

```ts
// packages/core/code-intel/pipeline.ts
export interface Pipeline {
  runFullIndex(tenant_id, repo_id): Promise<IndexingRun>;
  runIncremental(tenant_id, repo_id, since_commit): Promise<IndexingRun>;
  runSubset(tenant_id, repo_id, extractor_names): Promise<IndexingRun>;
}
// D8 (agent-as-extractor) adds a new Extractor; pipeline picks it up automatically.
// D11 (speculative pre-warm) is a hook into runFullIndex's completion event.
```

### What the sprint ignores (intentionally)

- No LLM-based enrichment (D1 / D2 / D4 / D5 / D8). Port without intelligence layer.
- No session-aware ranking (D3). Default blended ranker only.
- No federation (D6). Single store.
- No temporal queries (D7). Active-commit-per-repo is the default; multi-commit is in the schema but not exposed in queries.
- No policy layer (D12) beyond allow-all stub.
- No pre-warm (D11). Synchronous query path.
- No cross-language interop (D13). Standard edges only.
- No drift monitor (D14). No scheduled diffs.
- No store-as-MCP SQL (D10). Only canned queries.

All of the above become additive patches after parity is proven.

### Parity Sprint timeline (realistic)

- Day 1-3: extractor interface + pipeline + 6 extractors (files, symbols, chunks via tree-sitter driver; deps via syft; contributors via git; hotspots via Bun git-log parser)
- Day 4-6: 6 more extractors (endpoints via `.scm` queries, configs, infra, openapi, test_mappings, class_hierarchy)
- Day 7-8: 12 query methods
- Day 9: JSON-RPC + MCP surface
- Day 10: CLI + Web UI tabs (minimal)
- Day 11-12: end-to-end fixture on a Paytm repo; diff report vs pi-sage; fix regressions
- Day 13-14: docs + benchmark + acceptance sign-off

Two weeks, one agent per 3-4 day chunk.

## Phases

Each phase: ship CLI + control-plane path + local path + Web UI + tests + docs + benchmark (where relevant).

### Phase 0 -- cancel + decide (today)
- Abandon the in-flight router agent.
- Lock the schema + design doc (this doc).
- Pick a feature flag namespace: `code-intel.v2` replaces all old paths when enabled.

### Phase 1 -- unified store + schema + store class (~1 week)
- Ship the new DDL (SQLite + Postgres per-dialect emitters from one source).
- New `CodeIntelStore` class with CRUD for every table, multi-tenant.
- `schema_migrations` + migration runner.
- Migration from old `KnowledgeStore` tables.
- Test surface: ~50 store-level tests per table (CRUD + tenant isolation + soft-delete + run_id lifecycle).
- CLI: `ark code-intel db migrate`, `ark code-intel db status`.
- No extractors, no queries yet -- pure storage foundation.

### Phase 2 -- ingest via existing + new extractors (~2 weeks)
- Extractor interface + registry.
- `ops-codegraph` runner writes into the new store.
- `codebase-memory-mcp` runner writes into the new store.
- Native Ark extractors for: files, symbols (via tree-sitter or ops-codegraph output), contributors (git).
- `ark code-intel reindex [--repo] [--incremental]` full pipeline.
- Full `indexing_runs` lifecycle.
- 5-10 Paytm repos indexed end-to-end as acceptance.

### Phase 3 -- query surface + MCP + CLI + Web UI (~2 weeks)
- `CodeIntel` query class.
- Canonical MCP server at `packages/core/code-intel/mcp.ts`; auto-injected, replaces direct `codebase-memory-mcp` injection.
- CLI: `ark code-intel {search, blast-radius, callers, callees, find-refs, find-endpoint, find-config, semantic, hotspots, contributors, tests, status, health, explain, run diff}`.
- JSON-RPC methods.
- Web UI: "Code Intelligence" page merging `CodebaseMemoryPanel`, new tabs for each query domain.
- Query `explain` returns the run, the extractor, the evidence chunks.

### Phase 4 -- pi-sage parity extractors (~2 weeks, parallel sub-agents)
- endpoints, configs, infra, dependencies, test_mappings, hotspots, external_refs resolver.
- Each extractor ships with fixtures + regression tests vs pi-sage output on a shared repo.

### Phase 5 -- semantic search + embeddings (~1 week)
- Multi-model embeddings table.
- Local ONNX embedder in arkd.
- pgvector ivfflat index in control-plane Postgres.
- Embed symbols, chunks, endpoints, configs, docs (not just chunks).
- `ark code-intel semantic` + MCP tool + UI.

### Phase 6 -- control-plane scale + benchmark (~2 weeks)
- Postgres backend for 36+ Paytm repos, multi-tenant.
- MCP pool per `(tenant, repo)` in arkd.
- Head-to-head benchmark vs pi-sage: recall@10, latency p50/p95/p99, memory per tenant. Published doc.

### Phase 7 -- leap ahead (~3 weeks)
- Session-weighted ranking (join through `edges`).
- Cross-repo blast radius resolving `external_refs`.
- Query explanation in every response.
- Versioned / branch-parameterized queries (index multiple branches concurrently).
- Dangling-edge health dashboard per tenant.

## Surface parity rule

Every phase that touches user-facing behavior ships:
- CLI verb(s) with `--tenant` flag in control-plane mode
- JSON-RPC methods with auth scope check
- Web UI page / panel
- MCP tool(s) auto-injected
- Tests covering tenant isolation
- Docs

Non-negotiable.

## Success definition

At Phase 6 completion, for any shared Paytm repo:
- Zero pi-sage capabilities missing.
- Ark beats pi-sage on: language coverage, token efficiency, multi-tenant, multi-runtime, multi-compute, session-aware ranking, cross-repo resolution, query explainability.
- Migration story from pi-sage documented and one real pi-sage install moved to Ark (pilot).

## External tools strategy -- wrap, don't rewrite (revised 2026-04-20)

The extractors should NOT be handcrafted code in Ark. Every domain has a mature external tool. Ark's job is to drive them, capture their output, and persist into the unified store. Rule: we own the schema, the store, and the query surface; we do NOT own parsing logic.

**Verified via web research (April 2026).** Honest tiering replaces the earlier optimistic matrix.

### Tier 1 -- backbone (every language, every repo)

| Domain | Tool | Status | Notes |
|---|---|---|---|
| Multi-language AST + chunks | `tree-sitter` via `codebase-memory-mcp` + `ops-codegraph` | Shipping in Ark | 66 + 33 langs, production |
| Dependency manifests | **syft** (Anchore, v1.42 Feb 2026, 219 contributors) | Verified production | npm / pip / maven / gradle / cargo / go / gem / composer / nuget + 15 more. Offline. SPDX/CycloneDX output. |
| Git history / blame / churn | `git` CLI + a tiny Bun parser over `git log --numstat` | Native | ~50-80 LOC. Drop `code-maat` (heavy JAR). |
| Local embeddings | `@xenova/transformers` + ONNX Runtime | Mature | Runs in Bun. bge-small-en-v1.5 384-dim. |
| Control-plane embeddings | Ark's LLM router (OpenAI-compatible) OR arkd-hosted ONNX pool | Already routable | Per-tenant model choice. |
| Vector similarity | `pgvector` (control-plane) / BLOB + in-app cosine (SQLite) | Industry standard | IVFFlat index for speed. |

### Tier 2 -- rich symbol resolution (top ~6 languages)

| Tool | Languages production-ready | Languages in flight | Use |
|---|---|---|---|
| **SCIP** indexers (Sourcegraph) | `scip-python`, `scip-typescript`, `scip-java`, `scip-go` | `scip-rust`, `scip-ruby`, `scip-kotlin`, `scip-scala`, `scip-dotnet` | Call-graph, find-references, cross-file symbol resolution for the flagship langs. SCIP protobuf -> `edges` + `symbols`. |
| **stack-graphs** (GitHub) | TypeScript, JavaScript, Python | C++ WIP | Name resolution with scopes. Opt-in precision layer. |

**Explicitly dropped:** LSP servers as extractors. LSPs are stateful, IDE-oriented, memory-heavy. Driving 6+ LSPs per repo quadruples ops complexity for marginal gain over SCIP. Keep LSP on the roadmap ONLY if a specific query emerges that SCIP and stack-graphs cannot answer.

### Tier 3 -- domain extractors

| Domain | Tool | Notes |
|---|---|---|
| OpenAPI | `@redocly/openapi-core` or `@apidevtools/swagger-parser` | JS, no subprocess |
| Terraform | `terraform-config-inspect` (Go binary, small) | Subprocess, JSON output |
| Kubernetes | **`kubeconform`** (replaces deprecated `kubeval`) | JSON output |
| Helm | `helm template` then kubeconform | Subprocess chain |
| Docker Compose | `docker-compose config` | Subprocess, JSON output |
| Test mapping | `pytest --collect-only` / `jest --listTests --listFilesImported` / framework-specific | Import-graph heuristic + exact imports; confidence score |
| Doc chunks | `remark` (Markdown AST) + per-language docstring parsers (tsdoc, javadoc, pydoc) | Feed into `chunks` with `chunk_kind='doc'` |

### Tier 4 -- Ark-owned (unavoidable)

Per-framework endpoint detection has no universal tool. Ship as **declarative `tree-sitter` queries** (`.scm` files) not imperative parsers. Adding a new framework = add a new `.scm` file, no code change. File lives at `packages/core/code-intel/extractors/endpoints/frameworks/<name>.scm`.

Known starter frameworks: Spring (Java/Kotlin), Flask / FastAPI / Django (Python), Express / Fastify / NestJS (TS/JS), Rails (Ruby), Gin / Echo / Chi (Go), Axum / Actix (Rust), ASP.NET (C#), Laravel (PHP).

**Principle:** if a tool is MIT / Apache / BSD, actively maintained (commit within the last 90 days), and covers ≥80% of the domain, we wrap it. For the last 20% we use declarative queries when possible and only drop to imperative code as a last resort. Ark's engineering time goes into:
- the schema + store + query surface (unified substrate)
- subprocess drivers / MCP capture / SCIP protobuf deserialization
- per-dialect DDL emitters
- UI / UX
- observability + multi-tenancy
- **the differentiation layer (next section)** -- this is where we leap ahead

## Differentiation -- things pi-sage structurally cannot do

Parity is table stakes. These are the moats. Each is practical, each leverages something Ark already has (session graph / multi-runtime / multi-compute / LLM router / agent orchestration) that pi-sage does not, and most are achievable without inventing new ML.

### D1 -- LLM-extracted intent annotations

Every chunk / symbol / endpoint gets an auto-generated natural-language summary via a cheap model (Haiku / MiniMax via SambaNova, 1/25th Claude cost per session memory). Stored in `semantic_annotations (subject_kind, subject_id, summary, purpose, risk_tags, generated_model, generated_at)`. Runs as a post-extraction stage of the indexing pipeline, batched for cost.

Enables: semantic search over *intent* not raw code, domain tagging (PII / billing / auth / pricing), risk scoring, natural-language navigation ("find the thing that validates KYC documents"). No AST-based tool can do this.

Cost envelope: at 65K chunks x ~500 input tokens x Haiku rate (~$0.25/M input) = ~$8 for a full Paytm-scale reindex. Run weekly.

### D2 -- Intent embeddings (not code embeddings)

Embed the LLM-generated summary from D1, NOT the raw code. Natural-language queries match natural-language summaries, which is what they actually want. Raw-code embeddings struggle because natural queries and source syntax live in different spaces. Stored in the existing `embeddings` table with `model='summary-v1'` so it co-exists with raw-code embeddings and A/B testing is trivial.

### D3 -- Session-as-oracle ranking

Ark knows what every session touched and whether it succeeded. Feed that into ranking: "files that successfully resolved bugs similar to this ticket", "symbols that, when modified, led to clean PRs". Implemented as a scorer that joins `edges` (`session_id -> file_id`, relation `modified_by` / `tested_by`) with session outcome + ticket-embedding similarity. No pi-sage, no Sourcegraph, no AST tool has this signal.

### D4 -- Code-contract extraction

Extract function contracts from doc + types + tests combined: inputs, outputs, invariants, thrown exceptions, side effects. Stored in `contracts (symbol_id, inputs jsonb, outputs jsonb, raises jsonb, effects jsonb, invariants jsonb, confidence, evidence)`. LLM-assisted (D1 pipeline) with structural extraction for typed languages.

Enables queries like "find functions that claim to be idempotent", "find endpoints that never return 4xx", "functions that mutate global state".

### D5 -- Test intent graph

Parse what each test ASSERTS about, not just which file it covers. New table `test_assertions (test_symbol_id, target_kind, target_id, assertion_type, evidence_chunk_id)`. Assertion types: `equals | raises | invariant | side_effect | performance`. When a symbol changes, we can tell you WHICH assertion about it is at risk, not just "this test covers this file".

### D6 -- Query-time federation (via Agent D's connector framework)

One query hits Ark's store + pi-sage MCP + Sourcegraph + any connector configured for the tenant. Results merged + deduped + reranked. Makes migration painless (pi-sage and Ark coexist), lets tenants keep existing investments, and compounds capabilities (Ark adds session ranking to pi-sage's richer per-Paytm extractors).

### D7 -- Temporal / versioned queries

Schema supports multi-commit, multi-branch storage. Enable queries like "who called this function 3 months ago vs today", "symbols added in the last 30 days", "blast radius as of commit X". Standard data-warehouse trick (slowly changing dimensions), never applied to code.

### D8 -- Agent-as-extractor

Use a runtime-agnostic Ark agent as an extractor. Specific use cases: generate missing docstrings, reconcile stale docs, infer intent tags, detect duplicated patterns across repos. The agent writes into the store via the same Extractor interface as our subprocess drivers. Leverages Ark's 4-runtime + 11-compute orchestration: run enrichment jobs on cheap compute on cheap models, not inline.

### D9 -- Explainable + cost-aware ranking

Every result returns its scoring breakdown: `fts_score`, `semantic_score`, `session_success_prior`, `contributor_expertise`, `recency`, `staleness_penalty`, final blended rank. Also returns `{ query_cost_ms, bytes_scanned, llm_tokens_used }` so callers can budget. Tunable weights per tenant.

### D10 -- Store-as-MCP with scoped SQL

Expose the store itself as an MCP tool: `code_intel.sql(query, params)` with per-role scope. Admin agents can write arbitrary queries; regular agents get canned tools only. Unlocks ad-hoc analysis no canned tool anticipated. Dangerous; gate behind the existing auth layer and reject any query touching `tenant_id != <current>` via a SQL parser guard.

### D11 -- Speculative pre-warm

Session dispatch-time hook predicts likely queries from ticket text + affected-file hints + session history. Pre-warms those queries into cache. Latency win without changing the query model.

### D12 -- Policy-aware queries (multi-tenant hardening)

Per-tenant policies on top of the store: "tenant X cannot search files matching `*payments/secrets*`", "tenant Y gets only redacted symbol names". Implemented as row-level security in Postgres + a consistency check for SQLite. Table-stakes for control-plane; nobody else offers it as a first-class knob.

### D13 -- Cross-language interop edges

Detect when a Python service calls a Go binary via FFI / subprocess, when a TS frontend calls a Java API via OpenAPI, when a Kafka producer in repo A feeds a consumer in repo B. Store as `edges` with `relation='interop'` and sub-kinds `ffi | rpc | rest | grpc | queue | shared-db`. pi-sage doesn't track these; Ark's cross-repo knowledge graph is the only place they naturally land.

### D14 -- Drift monitor

Daily diff of active symbols / endpoints / configs vs last known-good. Flag unexpected changes ("endpoint `/admin/users` appeared without a spec update"). Fires via the trigger framework (from Agent D) into a Slack / PagerDuty connector.

## Phase schedule for differentiators

| Differentiator | Lands in | Depends on |
|---|---|---|
| D3 session-as-oracle ranking | Phase 3 (query surface) | existing session graph |
| D6 query-time federation | Phase 3 | Agent D's connector framework (landed) |
| D7 temporal queries | Phase 3 | schema already multi-commit |
| D9 explainable + cost-aware ranking | Phase 3 | core |
| D1 LLM intent annotations | Phase 4 | LLM router, D1 runs as a post-extractor |
| D2 intent embeddings | Phase 5 | depends on D1 |
| D4 contracts | Phase 4 | depends on D1 |
| D5 test intent graph | Phase 4 | basic test_mappings in Phase 4 |
| D8 agent-as-extractor | Phase 4 | agent orchestration |
| D11 speculative pre-warm | Phase 7 | session hook already in place |
| D12 policy-aware queries | Phase 6 (control-plane) | Postgres RLS |
| D13 cross-language interop | Phase 7 | D1 + domain-specific detectors |
| D10 store-as-MCP scoped SQL | Phase 7 | auth scope |
| D14 drift monitor | Phase 7 | triggers (landed) + connectors (landed) |

## Indexing lifecycle -- five modes, one pipeline

Indexing must work in every mode a user (human or agent) can trigger. One pipeline, five entry points.

| Mode | Who triggers | How | Scope | Freshness target |
|---|---|---|---|---|
| **In advance (onboarding)** | User, once per tenant/repo | `ark code-intel add-repo <url>` (CLI) / "Add Repo" button (UI) / API | Full index, all extractors | Available when done (~minutes) |
| **Periodic (scheduled)** | Trigger framework `kind: schedule` | cron entry per tenant/repo, configurable cadence. Default: nightly full at 02:00 local, hourly incremental | Incremental (only changed files via `files.sha` diff) or full on weekly cadence | <24h staleness |
| **Push-driven (webhook)** | Trigger framework `kind: webhook` from GitHub / Bitbucket push event | Affected-repo incremental index | Only touched files + their dependents | Minutes after commit lands |
| **While agents run (on-session)** | Session dispatch hook in `packages/core/services/dispatch-context.ts` | Before agent starts: check `(repo, branch, HEAD)` vs latest `indexing_runs`. If stale > N minutes, kick an incremental run (blocking with max-wait, or async if user opts in). | Incremental per session's branch | Always ≤N min stale for queries the agent will make |
| **On demand** | User, any time | `ark code-intel reindex` (CLI) / "Reindex" button on UI / MCP `code_intel.reindex` tool | Full or incremental | Immediate |
| **Flow stage (explicit)** | Flow YAML includes `- name: index-repos` stage using the `code-intel-indexer` agent | Fires as a stage of autonomous-sdlc or similar, with `gate: auto`. Output feeds downstream stages via `inputs.params.last_run_id`. | As declared | Part of flow lifecycle |

### One pipeline, orchestrated

```
reindex(repo, branch, scope) ->
  create indexing_runs row (status=running)
  -> drive extractors in parallel (tree-sitter / SCIP / codebase-memory-mcp / syft / git / framework / infra)
  -> persist rows tagged with run_id + file_id
  -> resolve external_refs where the target now exists
  -> finalize: soft-delete previous active rows (diff by (file_id, kind, content_hash)), flip indexing_runs.status=ok
  -> emit observability: rows_inserted, rows_soft_deleted, duration_ms, extractor_counts
  -> emit EventBus: "code-intel.reindex.complete" (triggers any event-kind triggers)
```

Soft-delete + run_id means: during reindex, queries still see the last-good state. After finalize, queries see the new state. Atomic.

### Configurable per repo

Each repo has a `config jsonb` column specifying:
- Which extractors to run (default: all).
- Embedding model choice + whether to embed each subject kind.
- Incremental cadence.
- Webhook enabled (y/n).
- Pre-session auto-reindex threshold.

Settable via CLI (`ark code-intel repo set <repo> --config <yaml-file>`) or UI (Repo Settings pane).

## UI / UX

One page, `/code-intel`, with tabs. Respects tenant scope (control-plane mode shows a tenant switcher in the header).

### Landing tab ("Overview")
- **Repo picker** (multi-select in control-plane).
- **Health card**: per repo, last run status / timestamp / staleness / extractor pass-fail chips / external_refs unresolved count.
- **"Reindex all"** button + **"Reindex selected"**.
- **Indexing rate sparkline** (runs per 24h).

### Search tab
- **Unified query bar** with an auto / fts / semantic / symbol / graph mode toggle.
- Result list with per-result provenance: which extractor, which run, evidence chunk inline-expandable, "open in repo" link.
- Facets: language, chunk_kind, repo, file, symbol_kind, deleted (excluded by default).

### Browse tab
- Tree view: repo -> files -> symbols.
- Click a symbol -> side panel with signature, callers, callees, blast radius, contributors, tests, similar symbols (semantic), "open in editor" deep link.

### Graph tab
- Interactive force-directed or hierarchical view of edges near a selected entity.
- Depth slider (1-5 hops).
- Filter by `relation` (calls / imports / depends_on / modified_by / tested_by / deployed_via).

### Extractors tab
- Matrix: rows = extractors, columns = repos. Cells show last_run status + duration + rows_produced.
- "Run now" per cell.

### Runs tab
- List of recent `indexing_runs` with diff between consecutive runs ("47 new symbols, 3 files deleted, 2 endpoints added").
- "Roll back" action (advanced; marks current active as deleted, flips previous to active).

### Settings tab (per tenant / per repo)
- Indexing cadence (cron expression).
- Webhook token + URL to paste into GitHub / Bitbucket.
- Embedding model choice (per subject kind if needed).
- Storage backend indicator (SQLite local / Postgres control-plane).
- Retention policy (how many runs kept before hard delete).

### External Refs tab
- Table of dangling cross-repo references.
- "Index target repo" action if the other repo URL is known.

### Contributors tab
- Per file: top N contributors with commit counts + last touch + recency heatmap.
- Per symbol: who originally wrote it, who last changed it, who reviews similar.

### Existing `CodebaseMemoryPanel`
- Folded into the Search tab as one query mode. Route stays reachable for back-compat until code-intel.v2 is the default.

## CLI surface (`ark code-intel ...`)

Symmetric to the UI. Every UI action is a CLI verb.

```
ark code-intel status                              # landing overview
ark code-intel repo add <url> [--tenant X] [--default-branch main]
ark code-intel repo list [--tenant X]
ark code-intel repo set <repo> --config <yaml-file>
ark code-intel repo remove <repo> [--hard]

ark code-intel reindex [--repo R] [--incremental] [--extractors a,b,c]
ark code-intel reindex-all [--tenant X] [--scope changed|stale|all]

ark code-intel runs list [--repo R] [--limit N]
ark code-intel runs show <run-id>
ark code-intel runs diff <run-a> <run-b>
ark code-intel runs rollback <run-id>

ark code-intel search <query> [--mode auto|fts|semantic|symbol|graph] [--repo R] [--format yaml|text]
ark code-intel find symbols|endpoints|configs|deps|infra|tests|contributors [...filters]
ark code-intel graph callers <symbol> [--depth N]
ark code-intel graph callees <symbol> [--depth N]
ark code-intel graph blast-radius <subject> [--depth N] [--cross-repo]
ark code-intel graph class-hierarchy <symbol>
ark code-intel semantic <query> [--model M] [--k N]

ark code-intel external-refs list [--unresolved]
ark code-intel external-refs resolve <id>

ark code-intel extractors list
ark code-intel extractors run <name> --repo R

ark code-intel explain <result-id>
ark code-intel health
ark code-intel db migrate [--to version]
```

All verbs accept `--tenant` in control-plane mode. `--format yaml` for machine consumers (matches Ark convention; YAML everywhere we author, JSON only for protocol/tool boundaries we don't own like JSON-RPC and external tool stdout).

## Flow stage integration

A reusable stage agent `agents/code-intel-indexer.yaml`:

```yaml
name: code-intel-indexer
runtime: internal    # runs in-process, no LLM
max_turns: 1
task: |
  Indexes {inputs.params.repo} on branch {branch} scope={inputs.params.scope|incremental}.
  Emits the resulting run_id into stage output.
```

Flow authors drop this stage into any flow before a query-dependent stage:

```yaml
stages:
  - name: reindex
    agent: code-intel-indexer
    params: { scope: incremental }
  - name: analyse
    agent: worker
    depends_on: [reindex]
```

The `code-intel.reindex.complete` event on `app.eventBus` can also trigger downstream flows via the event-kind trigger (post Agent D's framework extension).

## Observability

Every code-intel operation emits:
- **Structured logs** via `packages/core/observability/structured-log.ts` -- per extractor, per run, per query.
- **Metrics** (counts, durations, error rates) consumable by Prometheus / OTLP.
- **Tenant-scoped** dashboards in Grafana (control-plane).
- **A `code-intel.run.*` event** on the internal event bus for triggers and UI live-updates.

## Non-goals

- Neo4j / Memgraph. SQLite + pgvector covers observed queries; graph DB only if cross-repo Cypher workloads dominate (revisit after 6 months of production data).
- Absorbing `codebase-memory-mcp` source. We stay on its MIT binary.
- Replacing pi-sage as an analysis product. Pi-sage generates analyses; Ark is the code-intel store + orchestrator. Both coexist via connectors.
- Writing our own AST parsers, LSP clients, or SBOM generators. We wrap upstream tools.
