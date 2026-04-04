# Ark v0.5 Gaps — Design Spec

> CLI create/delete, OTEL observability, auto-rollback pipeline, hybrid search with LLM re-ranking.

**Date:** 2026-04-04

---

## A: CLI Skill/Recipe Create & Delete

### New Subcommands

```
ark skill create <name> --description "..." --prompt "..." [--scope global|project] [--tags t1,t2]
ark skill create --from ./skill.yaml [--scope global|project]
ark skill delete <name> [--scope global|project]

ark recipe create --from ./recipe.yaml [--scope global|project]
ark recipe create --from-session <session-id> [--scope global|project]
ark recipe delete <name> [--scope global|project]
```

### Behavior

- `--scope` defaults to `global`.
- `skill create` with flags: `--name` and `--prompt` required, `--description` optional (defaults to empty string).
- `skill create --from` reads a YAML file and writes it to the scope directory via `saveSkill()`.
- `recipe create --from-session` calls existing `sessionToRecipe()`, writes result to scope directory.
- `delete` refuses builtins — exit with error message. Only global/project scope is deletable.
- `delete` is silent (no confirmation prompt) for user-created skills/recipes.

### Files

- **Modify:** `packages/cli/index.ts` — add `create` and `delete` subcommands under existing `skillCmd` and `recipeCmd`.
- **No new core code** — `saveSkill()`, `deleteSkill()`, `sessionToRecipe()`, `saveRecipe()` all exist.

### Testing

- E2e test: create a skill via flags, verify `ark skill list` includes it, delete it, verify gone.
- E2e test: create a skill from YAML file, verify loaded correctly.
- E2e test: create recipe from session, verify recipe YAML written.
- E2e test: attempt to delete a builtin, verify error.

---

## B: OTEL Observability

### Overview

Minimal OTLP JSON exporter (~200 lines). No OpenTelemetry SDK dependency. Exports session and stage spans to any OTLP HTTP collector.

### Span Hierarchy

```
Session span (root)
  ├── Stage span: "plan"
  ├── Stage span: "implement"
  └── Stage span: "review"
```

### Span Attributes

**Session span:**
- `session.id`, `session.flow`, `session.repo`, `session.agent`, `session.status`
- `tokens.input`, `tokens.output`, `tokens.cache`
- `cost.usd`, `turns`

**Stage span:**
- `stage.name`, `stage.agent`, `stage.gate`, `stage.status`, `stage.retries`

### Config

```yaml
# ~/.ark/config.yaml
otlp:
  endpoint: http://localhost:4318/v1/traces
  headers:
    Authorization: "Bearer ..."
  enabled: true
```

### Export Mechanics

- Spans buffered in-memory, flushed on session complete/fail or every 30 seconds.
- Single `POST` to endpoint with `Content-Type: application/json`.
- OTLP JSON format (not protobuf) — universally accepted by Grafana Tempo, Datadog, Honeycomb, Jaeger.
- Fire-and-forget — export failure logged, never blocks session lifecycle.

### Integration Points

| Lifecycle Event | Action |
|----------------|--------|
| `startSession()` | Create root session span |
| `advance()` | End current stage span, start next |
| `completeSession()` / fail | End root span, flush all |
| `app.ts boot()` | Read config, initialize exporter |

### Files

- **Create:** `packages/core/otlp.ts` — span builder, buffer, OTLP JSON formatter, HTTP sender.
- **Modify:** `packages/core/session.ts` — emit span events at session/stage boundaries.
- **Modify:** `packages/core/app.ts` — initialize exporter from config at boot.
- **Modify:** `packages/core/config.ts` — add `otlp` config schema.

### Testing

- Unit test: span builder produces valid OTLP JSON structure.
- Unit test: buffer flushes at 30s interval and on session end.
- Unit test: export failure is swallowed (no throw).
- Integration test: start session → advance through stages → verify spans emitted with correct parent-child relationships and attributes.

---

## C: Auto-Rollback Pipeline

### Overview

Monitors merged PRs from Ark sessions. Polls CI status. On failure, creates a revert PR, stops the session, and notifies.

### Trigger

Extend existing `/hooks/github` webhook handler in `conductor.ts` to handle `pull_request.closed` events where `merged: true`. When a PR from an Ark session gets merged, start the health check sequence.

### Health Check Sequence

1. PR merged → extract `head_sha` and originating session ID.
2. Poll `GET /repos/{owner}/{repo}/commits/{sha}/check-suites` every 30 seconds, up to configurable timeout (default 10 minutes).
3. All check suites `conclusion: "success"` → done, no action.
4. Any check suite `conclusion: "failure"` → trigger rollback.
5. If `rollback.health_url` configured, also `GET` that URL and require 2xx.
6. Timeout with no conclusion → behavior controlled by `on_timeout` (default: `ignore`).

### Rollback Action

1. Create revert branch: `revert-{original-branch}`.
2. Create revert commit via GitHub GraphQL `revertPullRequest` mutation (cleanest path — handles merge commits correctly).
3. Create PR via GitHub API:
   - Title: `"Revert: {original PR title}"`
   - Body: links to failed checks, references original PR.
4. If `auto_merge: true` in config, merge the revert PR immediately.
5. Stop the originating Ark session via `stopSession()`.
6. Emit event: `{ type: "rollback", sessionId, prUrl, revertPrUrl, reason }`.

### No Autonomy Demotion

Session stops on rollback. Human decides next steps. No automatic demotion to lower autonomy tiers — a rollback means the agent shipped broken code and should not silently continue.

### Config

```yaml
# ~/.ark/config.yaml
rollback:
  enabled: false              # opt-in
  timeout: 600                # seconds to wait for CI
  on_timeout: ignore          # rollback | ignore
  auto_merge: false           # auto-merge the revert PR
  health_url: null            # optional custom health endpoint
```

### Files

- **Create:** `packages/core/rollback.ts` — health polling loop, revert PR creation, session stop, event emission.
- **Modify:** `packages/core/conductor.ts` — extend GitHub webhook handler for merge events, delegate to rollback.ts.
- **Modify:** `packages/core/config.ts` — add `rollback` config schema.

### Testing

- Unit test: health check polling with mock GitHub API — success path (no rollback).
- Unit test: health check polling — failure triggers rollback sequence.
- Unit test: timeout behavior for both `rollback` and `ignore` modes.
- Unit test: revert PR creation with correct title/body.
- Unit test: `auto_merge: true` merges the revert PR.
- Integration test: mock webhook → poll → failure → revert PR created → session stopped.

---

## D: Hybrid Search with LLM Re-ranking

### Overview

Unified `hybridSearch(query)` that searches memories, knowledge chunks, and transcripts. Merges results, deduplicates, then re-ranks the top candidates via Claude Haiku for semantic relevance.

### Search Pipeline

```
query
  ├── recall(query)              → top 20 memories
  ├── queryKnowledge(query)      → top 20 knowledge chunks
  └── searchTranscripts(query)   → top 20 transcript matches
  │
  merge + deduplicate (by content hash)
  │
  take top 40 candidates
  │
  Claude Haiku re-rank
  │
  return top K results (default 10)
```

### Re-ranking

Send the query + 40 candidate snippets to Claude Haiku. Prompt asks for indices sorted by relevance with a 0-1 score. Single API call, ~2K tokens input, ~200 tokens output. Cost: ~$0.001 per search.

**Fallback:** If Claude API call fails (no key, network error, timeout), return the pre-rerank results sorted by their original source scores. Never block on a failed re-rank.

### API

```typescript
interface SearchResult {
  source: "memory" | "knowledge" | "transcript";
  content: string;
  score: number;          // 0-1 from re-ranker (or source score if rerank failed)
  metadata: {
    id?: string;
    sessionId?: string;
    tags?: string[];
    timestamp?: string;
  };
}

async function hybridSearch(
  query: string,
  opts?: {
    limit?: number;                                          // default 10
    sources?: Array<"memory" | "knowledge" | "transcript">;  // default all
    rerank?: boolean;                                        // default true
  }
): Promise<SearchResult[]>
```

### Integration Points

- `recall()` in memory.ts stays as-is — `hybridSearch` calls it as a source.
- `queryKnowledge()` in knowledge.ts stays as-is — called as a source.
- `searchTranscripts()` in search.ts stays as-is — called as a source.
- Agents call `hybridSearch()` when they need context (replaces direct `recall()` calls in agent dispatch).
- CLI: `ark search <query>` gains `--hybrid` flag to use this pipeline.
- Export from `packages/core/index.ts`.

### Files

- **Create:** `packages/core/hybrid-search.ts` — orchestrates retrieval from all three sources, dedup, re-rank via Claude, return.
- **Modify:** `packages/core/agent.ts` — use `hybridSearch()` for context injection at dispatch.
- **Modify:** `packages/cli/index.ts` — add `--hybrid` flag to `ark search`.
- **Modify:** `packages/core/index.ts` — export `hybridSearch` and `SearchResult`.

### Testing

- Unit test: merges results from all three sources correctly.
- Unit test: deduplication by content hash removes duplicates across sources.
- Unit test: re-rank call formats prompt correctly and parses response.
- Unit test: fallback returns un-reranked results when API fails.
- Unit test: `sources` filter restricts which backends are queried.
- Unit test: `rerank: false` skips the Claude call.
- Integration test: end-to-end with real memory/knowledge/transcript data, verify ranked results.
