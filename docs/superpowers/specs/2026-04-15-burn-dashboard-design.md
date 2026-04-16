# Burn Dashboard — codeburn-inspired cost observability page

**Date:** 2026-04-15
**Status:** Approved for implementation
**Branch:** `feature/burn-dashboard`
**Worktree:** `.worktrees/burn-dashboard`
**Source inspiration:** [AgentSeal/codeburn](https://github.com/AgentSeal/codeburn) v0.5.2 (MIT)

## Problem

Ark's current `/costs` page (`packages/web/src/components/CostsView.tsx`) exposes only two dimensions of cost data:

1. A pie chart of cost by model.
2. A bar chart of top 10 sessions by cost.

Ark already records rich per-API-call data into `usage_records` (model, provider, runtime, agent_role, token breakdowns, cost_usd, cost_mode), but the visualization layer surfaces almost none of it. Autonomous agent operators who need to answer questions like *"where is my Opus spend actually going?"* or *"how often does the implementer agent get it right the first try?"* have no way to do so inside Ark.

codeburn is a terminal dashboard that answers exactly these questions for Claude Code / Codex / Cursor / OpenCode users by reading session transcripts from disk. Its classifier, retry detection, and breakdown logic are well-tuned pure TypeScript that maps cleanly onto Ark's existing transcript parser abstraction. codeburn itself is a terminal (Ink React) tool so its UI layer cannot be reused, but its logic core can be ported and driven from Ark's backend into a new web page.

## Goal

Ship a new `/burn` page in Ark's web dashboard that mirrors codeburn's 8-panel observability dashboard, driven by classified turn data synced from Claude / Codex / Gemini transcripts into a new SQL table.

### Non-goals

- No TUI, menubar widget, or SwiftBar integration.
- No currency conversion (USD only; can extend later).
- No CSV / JSON export of burn data (existing `/cost/export` remains untouched).
- No Cursor or OpenCode provider parsers (Ark has no Cursor / OpenCode runtimes; defer until those land).
- Not a replacement for `/costs`. The existing page stays; the new page lives alongside it.
- Not a replacement for `usage_records`. Billing data remains the source of truth for budgets and invoicing.

## Architecture

```
┌─ Transcripts on disk ─────────┐
│ ~/.claude/projects/*.jsonl    │
│ ~/.codex/sessions/**/*.jsonl  │
│ ~/.gemini/... (future)        │
└────────┬──────────────────────┘
         │
         ▼  parse + classify + dedupe (ported from codeburn)
┌─ packages/core/observability/burn/ ─┐
│  types.ts       classifier.ts       │
│  bash-utils.ts  parser.ts           │
│  sync.ts                            │
└────────┬────────────────────────────┘
         │  upsert keyed on (session_id, turn_index)
         ▼
┌─ SQL: burn_turns table ───────┐
│ per-turn: category, retries,  │
│ 1-shot flag, tools_json,      │
│ bash_cmds_json, mcp_tools_json│
└────────┬──────────────────────┘
         │  aggregate
         ▼
┌─ packages/server/handlers/burn.ts ─┐
│  burn/summary?period=... RPC       │
│  burn/sync RPC (manual trigger)    │
└────────┬───────────────────────────┘
         │  JSON-RPC over existing WS / HTTP
         ▼
┌─ packages/web/src/ ──────────────────┐
│  pages/BurnPage.tsx                  │
│  components/burn/BurnView.tsx        │
│  components/burn/panels/*.tsx (x8)   │
│  hooks/useBurnQueries.ts             │
└──────────────────────────────────────┘
```

### Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `core/observability/burn/types.ts` | `TaskCategory`, `ClassifiedTurn`, `SessionSummary`, `ProjectSummary`, `BurnPeriod`, `BurnSummaryResponse` | — |
| `core/observability/burn/bash-utils.ts` | Extract command names from shell strings (e.g. `"pytest tests/"` → `["pytest"]`) | — |
| `core/observability/burn/classifier.ts` | Pure functions: classify a `ParsedTurn` into one of 13 categories, count edit-cycle retries, derive 1-shot flag | types |
| `core/observability/burn/parser.ts` | Given a runtime + transcript path, emit `ClassifiedTurn[]` with full breakdowns (tools, MCP, bash, cost) | types, classifier, bash-utils, `PricingRegistry` |
| `core/observability/burn/sync.ts` | Walk sessions, resolve transcript via existing `TranscriptParser.findForSession()`, upsert `burn_turns` rows | parser, `AppContext` |
| `core/repositories/burn.ts` | `BurnRepository` — CRUD + aggregation queries against `burn_turns` | `IDatabase` |
| `server/handlers/burn.ts` | RPC handlers: `burn/summary`, `burn/sync` | `AppContext`, `BurnRepository` |
| `web/hooks/useBurnQueries.ts` | TanStack Query hooks: `useBurnSummary(period)`, `useBurnSync()` | `useApi` |
| `web/components/burn/panels/*.tsx` | One component per panel: pure presentation, no data fetching | Recharts, `Card` |
| `web/components/burn/BurnView.tsx` | Period selector + grid layout of the 8 panels | `useBurnSummary`, panels |
| `web/pages/BurnPage.tsx` | Route wrapper + `<Layout>` + sidebar integration | `BurnView` |

Each module has one clear purpose, communicates via typed interfaces, and can be tested independently.

## Data layer

### New table: `burn_turns`

Added to `packages/core/repositories/schema.ts` as `CREATE TABLE IF NOT EXISTS`. Per Ark's no-migrations rule, schema changes compatible with the existing DB will pick up transparently; schema-breaking changes require `rm ~/.ark/ark.db`.

```sql
CREATE TABLE IF NOT EXISTS burn_turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  tenant_id         TEXT NOT NULL DEFAULT 'default',
  turn_index        INTEGER NOT NULL,
  project           TEXT,
  timestamp         TEXT NOT NULL,
  user_message_preview TEXT,
  category          TEXT NOT NULL,
  model             TEXT,
  provider          TEXT,
  runtime           TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  api_calls         INTEGER NOT NULL DEFAULT 0,
  has_edits         INTEGER NOT NULL DEFAULT 0,
  retries           INTEGER NOT NULL DEFAULT 0,
  is_one_shot       INTEGER NOT NULL DEFAULT 0,
  tools_json        TEXT NOT NULL DEFAULT '[]',
  mcp_tools_json    TEXT NOT NULL DEFAULT '[]',
  bash_cmds_json    TEXT NOT NULL DEFAULT '[]',
  speed             TEXT NOT NULL DEFAULT 'standard',
  transcript_mtime  INTEGER,
  UNIQUE(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_burn_turns_tenant_timestamp
  ON burn_turns(tenant_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_burn_turns_tenant_category_timestamp
  ON burn_turns(tenant_id, category, timestamp);
```

**Rationale for a separate table vs extending `usage_records`:**

- `usage_records` has one row per API call. `burn_turns` has one row per turn (user message + all its assistant API calls). Different granularity.
- `usage_records` is the authoritative billing table; pollution with display-only fields (category, tool lists) would couple billing to observability.
- Drop-and-rebuild: `burn_turns` is fully derivable from transcripts, so changing classifier logic is safe — drop the table and re-sync. `usage_records` rows are often irreplaceable (transcripts get rotated, subscription mode records zero cost).

### Schema addition (one column on `usage_records`)

`usage_records` already has a `cost_mode` column per `observability/usage.ts`. No further columns needed there. `burn_turns` is purely additive.

### Rebuildable by design

`burn_turns` is treated as a cache. Any time classifier rules change, bump a `BURN_SCHEMA_VERSION` constant in `sync.ts`; on boot, if the stored version differs, the sync job truncates `burn_turns` and re-syncs from transcripts. First-boot cost is one classified parse per session; transcripts live on disk so this is bounded by I/O.

## Backend pipeline

### Port list from codeburn

| codeburn file | Ark destination | Transformation |
|---|---|---|
| `src/types.ts` | `core/observability/burn/types.ts` | Drop Cursor-only fields (`languages`), keep `TaskCategory`, `ClassifiedTurn`, `SessionSummary`, `ProjectSummary`. |
| `src/classifier.ts` | `core/observability/burn/classifier.ts` | Import-path rewrite only. Pure logic preserved. |
| `src/bash-utils.ts` | `core/observability/burn/bash-utils.ts` | Verbatim port. |
| `src/parser.ts` (Claude section) | `core/observability/burn/parser.ts` | Replace codeburn's `discoverAllSessions()` with `app.transcriptParsers.get(kind).findForSession()`. Keep `groupIntoTurns`, `parseApiCall`, `buildSessionSummary` verbatim (adapted to Ark's `PricingRegistry`). |
| `src/providers/codex.ts` decoding | `core/runtimes/codex/parser.ts` (augment) | Extend Ark's existing Codex parser with the tool/token decoding logic needed for classification. |
| `src/models.ts` pricing | `core/observability/pricing.ts` (augment) | Add `fastMultiplier`, `webSearchCostPerRequest`, disk cache at `~/.ark/cache/litellm-pricing.json` with 24h TTL. |
| `src/providers/claude.ts` | — | **Skipped.** Ark's `ClaudeTranscriptParser.findForSession()` uses the explicit `--session-id` handoff Ark already maintains, which is more reliable than codeburn's latest-mtime guess. |
| `src/dashboard.tsx` | `web/components/burn/*` (rewritten) | Ink → Recharts + Tailwind. Layout, panel titles, color palette, period tabs come from the codeburn spec. |
| `src/cli.ts`, `src/menubar.ts`, `src/currency.ts`, `src/export.ts`, `src/config.ts`, `src/cursor-cache.ts`, `src/sqlite.ts`, `src/providers/{cursor,opencode}.ts` | — | **Out of scope.** |

### `PricingRegistry` augmentation

Three additions to `packages/core/observability/pricing.ts`, backwards compatible:

1. `fastMultiplier?: number` on `ModelPricing`, defaulting to 1. Applied when `calculateCost(model, usage, { speed: 'fast' })` is called.
2. `webSearchCostPerRequest?: number` on `ModelPricing`. Added to cost when `usage.web_search_requests > 0`.
3. Disk cache: on construction, try reading `~/.ark/cache/litellm-pricing.json`; if present and fresh (<24h), populate from it. `refreshFromRemote()` writes to the same file on success. Falls back to in-memory defaults on any error.

No existing call sites break; all additions are optional.

### `burn/sync.ts`

```
syncBurn(app: AppContext, opts?: { sessionIds?: string[]; force?: boolean }): SyncResult
  walk sessions (all, or specified subset)
  for each session:
    resolve runtime via existing session.config.runtime
    get transcript parser from app.transcriptParsers
    find transcript path via parser.findForSession({ workdir, startTime })
    if no path: skip
    stat transcript mtime
    if not force and burn_turns.max(transcript_mtime) for session >= mtime: skip
    parse + classify via burn/parser.ts
    upsert turns into burn_turns (DELETE WHERE session_id=? then INSERT)
  return { synced, skipped, errors }
```

Upsert uses delete-then-insert because turn indices can shift if the classifier version changes. Safer than trying to reconcile diffs.

### `syncCosts` integration

`syncCosts()` in `packages/core/observability/costs.ts` is extended to additionally call `syncBurn(app)` at the end of its existing loop. Ark users who already run `ark sync` or hit the existing sync handler get burn data for free, without a second command.

### RPC handlers

New file `packages/server/handlers/burn.ts` registered in the existing handler boot path:

```
burn/summary
  params: { period: 'today' | 'week' | '30days' | 'month'; tenantId?: string }
  returns: BurnSummaryResponse {
    period: Period
    dateRange: { start: string; end: string }
    overview: {
      totalCostUsd: number
      totalApiCalls: number
      totalSessions: number
      totalInputTokens: number
      totalOutputTokens: number
      totalCacheReadTokens: number
      totalCacheWriteTokens: number
      cacheHitPct: number
    }
    daily: Array<{ date: string; cost: number; calls: number }>
    byProject: Array<{ project: string; cost: number; sessions: number }>
    byModel: Array<{ model: string; cost: number; calls: number; inputTokens: number; outputTokens: number }>
    byCategory: Array<{ category: TaskCategory; cost: number; turns: number; oneShotPct: number | null; editTurns: number }>
    coreTools: Array<{ tool: string; calls: number }>
    mcpServers: Array<{ tool: string; calls: number }>
    bashCommands: Array<{ cmd: string; calls: number }>
  }

burn/sync
  params: { force?: boolean }
  returns: { synced: number; skipped: number; errors: Array<{sessionId: string; error: string}> }
  triggers: a fresh syncBurn(app) pass, used by the "Sync" button in the UI
```

All queries use parameterized SQL; group columns are whitelisted to prevent injection (same pattern as `usage.ts`).

## Frontend

### Route + sidebar

- **Route:** `/burn` added to the existing hash router (`useHashRouter.ts`).
- **Sidebar:** new entry in `Sidebar.tsx`, below the existing **Costs** entry, labeled **Burn** with a `Flame` icon from `lucide-react`. Badge optional later.

### Component tree

```
BurnPage
└── Layout (existing)
    └── BurnView
        ├── BurnPeriodTabs        (Today | 7 Days | 30 Days | Month)
        ├── BurnSyncButton        (manual sync trigger, optimistic toast)
        ├── Grid (responsive: 1col narrow, 2col medium, 3col wide)
        │   ├── OverviewPanel         (hero: total cost, calls, sessions, cache hit)
        │   ├── DailyActivityPanel    (14-day bar chart via Recharts)
        │   ├── ByProjectPanel        (horizontal bars, top 8)
        │   ├── ByModelPanel          (horizontal bars)
        │   ├── ByActivityPanel       (horizontal bars + 1-shot % column)
        │   ├── CoreToolsPanel        (horizontal bars, top 10)
        │   ├── ShellCommandsPanel    (horizontal bars, top 10)
        │   └── McpServersPanel       (horizontal bars, top 10)
        └── (empty state + loading state + error state)
```

Each panel component is pure presentation: it receives its slice of `BurnSummaryResponse` via props, never fetches its own data, and has no hidden dependency on global state. This makes them trivially testable with synthetic data.

### Styling

- Tailwind CSS with Ark's existing tokens: `bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`, `hover:bg-accent/50`. No new colors in the global theme — dark mode works automatically.
- shadcn `Card` primitive from `./ui/card.js` (same import path already used in `CostsView`).
- Panel accent colors match codeburn's palette but mapped through CSS variables so theme swaps cascade:
  - Overview: `text-orange-400` (matches codeburn's CodeBurn orange)
  - Daily: `text-sky-400`
  - Project: `text-emerald-400`
  - Model: `text-fuchsia-400`
  - Activity: `text-amber-400`
  - Tools: `text-cyan-400`
  - MCP: `text-pink-400`
  - Shell: `text-orange-300`
- Charts use **Recharts** (already a dep; CostsView uses it). `HBar` is a thin Recharts `<BarChart layout="vertical">` wrapper with a gradient fill replicating codeburn's blue-to-orange gradient.
- `fmtCost` reused from `web/src/util.ts` for consistent formatting with the existing `/costs` page.

### Data hook

```
useBurnSummary(period: BurnPeriod)
  → useQuery({ queryKey: ['burn','summary', period], queryFn: () => rpc('burn/summary', { period }) })
useBurnSync()
  → useMutation({ mutationFn: (force) => rpc('burn/sync', { force }),
                  onSuccess: () => queryClient.invalidateQueries(['burn']) })
```

Default period: **7 Days**. Period state is URL-hash-backed so refresh preserves it.

## Error handling

| Failure point | Behavior |
|---|---|
| `burn_turns` empty | Panels render empty states with "Run sync to populate" CTA; clicking triggers `burn/sync`. |
| Transcript missing for a session | Skip silently in `syncBurn`; log to structured log at `debug` level. |
| Classifier throws on a turn | Catch per-turn, assign category `'general'`, log warning, continue. |
| LiteLLM pricing fetch fails | Fall back to in-memory defaults + disk cache; never crash the sync job. |
| RPC handler throws | Standard Ark error response; TanStack Query shows error state in the view. |
| Schema-version mismatch on boot | Log info, truncate `burn_turns`, re-sync in background. |
| User opens page before any sync has run | Empty state with Sync button; same path as post-truncation recovery. |

No feature flags, no fallback behaviors beyond what's listed. Burn sync is side-effect-free on existing tables, so a complete burn failure cannot break Ark.

## Testing strategy

Per `CLAUDE.md`:

- `bun:test` for backend unit and integration tests, run sequentially via `make test` / `make test-file`.
- `vitest` + `@testing-library/react` + `user-event` for web tests, **integration-only** (no shallow, no implementation details).
- `AppContext.forTest()` for backend tests that need a DB.
- Real data fixtures (no mocking of internal logic). Fixture transcripts live under `packages/core/observability/burn/__tests__/fixtures/`.
- Coverage target: >= 80% on new modules.

### Backend tests

1. **`burn/__tests__/classifier.test.ts`** (unit, ~15 cases)
   - Each of the 13 categories has at least one passing assertion.
   - Edge: empty turn, turn with only thinking blocks, turn with Agent spawn, turn with EnterPlanMode, turn with bash-only + debug keywords.
   - Assertion discipline: validate returned category AND retry count AND `hasEdits` flag.

2. **`burn/__tests__/bash-utils.test.ts`** (unit, ~8 cases)
   - `cd path && pytest` → `["pytest"]`
   - `npm run build && npm test` → `["npm","npm"]`
   - Heredoc, pipes, `$()` substitution.

3. **`burn/__tests__/parser.test.ts`** (integration)
   - Feed a real Claude JSONL fixture (10-turn synthetic session) through the parser.
   - Assert: turn count, dedup by message id works, `SessionSummary.categoryBreakdown` keys, `oneShotTurns` count, cost totals match a hand-computed expected value.

4. **`burn/__tests__/sync.test.ts`** (end-to-end via `AppContext.forTest()`)
   - Seed a session row, copy fixture JSONL to a temp `~/.claude/projects/...` location, invoke `syncBurn(app)`, query `burn_turns`, assert row counts and field values.
   - Second run with same mtime: assert `skipped === 1`.
   - `force: true`: assert re-sync happens.

5. **`server/handlers/__tests__/burn-handler.test.ts`** (end-to-end)
   - Seed `burn_turns` directly via `BurnRepository`, call `burn/summary`, assert response shape matches `BurnSummaryResponse`, including non-null `oneShotPct` for categories with edit turns and null for categories without.

### Frontend tests

1. **`burn/__tests__/BurnView.test.tsx`** (integration, vitest + React Testing Library)
   - Render `BurnView` with a TanStack Query client and MSW handlers returning a full fixture `BurnSummaryResponse`.
   - Assert: all 8 panel titles rendered, total cost visible in Overview, daily chart contains 14 bars, period tabs switch and trigger a second RPC call, Sync button calls mutation.
   - Empty state: MSW returns empty summary, view shows "Run sync" CTA, clicking triggers the sync mutation.
   - No assertions on component internals, refs, or state.

2. **Per-panel smoke tests** are skipped by design — the user's CLAUDE.md requires integration over unit. If a panel breaks, `BurnView.test.tsx` catches it.

## Implementation order

The build sequence is chosen so every intermediate commit compiles and tests stay green.

1. **Types + fixtures** — `burn/types.ts`, test fixture JSONL files. No runtime behavior yet.
2. **bash-utils + classifier** — pure logic + tests. Independently verifiable.
3. **Parser** — wraps 1 and 2, consumes Claude JSONL, emits `SessionSummary`. Test with fixtures.
4. **PricingRegistry augmentation** — fast mode + web search + disk cache. Extend existing tests.
5. **Schema + repository** — `burn_turns` table, `BurnRepository`, upsert + aggregation queries. Unit-test with in-memory SQLite.
6. **Sync** — wires parser + repository + session walk. End-to-end tested with a seeded session and fixture JSONL.
7. **RPC handler** — `burn/summary` + `burn/sync`. End-to-end tested via the server router.
8. **Web hook + types** — `useBurnQueries.ts` + shared types package wiring.
9. **Panel components** — 8 isolated presentation components with synthetic data stories (Storybook-style but inline in tests).
10. **BurnView + BurnPage + routing** — full integration test.
11. **Sidebar entry + icon** — final wiring.
12. **Full test suite** — `make test` sequentially on the worktree; all tests green before push.

## Open questions resolved during design

| Question | Resolution |
|---|---|
| Reuse codeburn's `dashboard.tsx`? | No — Ink is terminal-only. Rebuild UI in web React. |
| Store classification in `usage_records`? | No — different granularity, separation of concerns. New `burn_turns` table. |
| Support Cursor / OpenCode? | Not in v1 — Ark has no runtime for them. Defer. |
| Currency conversion? | No — USD only. Can extend via `fmtCost` later. |
| TUI command? | No — web-only per user directive. |
| Full-parity panels or minimal? | Full parity — user directive "exactly follow the codeburn". |
| Replace `/costs` or coexist? | Coexist — `/costs` stays for billing, `/burn` adds observability. |
| Sync trigger? | On existing `syncCosts` path + manual button in UI. No cron — matches Ark's current model. |

## Appendix — file manifest

### New files
- `packages/core/observability/burn/types.ts`
- `packages/core/observability/burn/bash-utils.ts`
- `packages/core/observability/burn/classifier.ts`
- `packages/core/observability/burn/parser.ts`
- `packages/core/observability/burn/sync.ts`
- `packages/core/observability/burn/index.ts`
- `packages/core/observability/burn/__tests__/fixtures/claude-session.jsonl`
- `packages/core/observability/burn/__tests__/classifier.test.ts`
- `packages/core/observability/burn/__tests__/bash-utils.test.ts`
- `packages/core/observability/burn/__tests__/parser.test.ts`
- `packages/core/observability/burn/__tests__/sync.test.ts`
- `packages/core/repositories/burn.ts`
- `packages/server/handlers/burn.ts`
- `packages/server/handlers/__tests__/burn-handler.test.ts`
- `packages/web/src/hooks/useBurnQueries.ts`
- `packages/web/src/pages/BurnPage.tsx`
- `packages/web/src/components/burn/BurnView.tsx`
- `packages/web/src/components/burn/BurnPeriodTabs.tsx`
- `packages/web/src/components/burn/BurnSyncButton.tsx`
- `packages/web/src/components/burn/HBar.tsx`
- `packages/web/src/components/burn/panels/OverviewPanel.tsx`
- `packages/web/src/components/burn/panels/DailyActivityPanel.tsx`
- `packages/web/src/components/burn/panels/ByProjectPanel.tsx`
- `packages/web/src/components/burn/panels/ByModelPanel.tsx`
- `packages/web/src/components/burn/panels/ByActivityPanel.tsx`
- `packages/web/src/components/burn/panels/CoreToolsPanel.tsx`
- `packages/web/src/components/burn/panels/ShellCommandsPanel.tsx`
- `packages/web/src/components/burn/panels/McpServersPanel.tsx`
- `packages/web/__tests__/BurnView.test.tsx`

### Modified files
- `packages/core/repositories/schema.ts` — add `burn_turns` table
- `packages/core/observability/pricing.ts` — augment with fast mode, web search, disk cache
- `packages/core/observability/costs.ts` — `syncCosts` also calls `syncBurn`
- `packages/core/app.ts` — register `BurnRepository` on `AppContext`
- `packages/server/router.ts` (or wherever handlers are registered) — register burn handlers
- `packages/web/src/App.tsx` — new `/burn` route
- `packages/web/src/components/Sidebar.tsx` — new Burn entry with Flame icon
- `packages/web/src/hooks/useHashRouter.ts` — add `burn` as a known view
- `packages/web/src/hooks/useApi.ts` — add `getBurnSummary`, `syncBurn` helpers (optional; can inline in useBurnQueries)

### License

codeburn is MIT. The ported files keep their original copyright header referencing AgentSeal and the codeburn commit hash they were derived from, in compliance with MIT attribution.
