# Burn Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new `/burn` page in Ark's web dashboard that mirrors codeburn's 8-panel cost observability dashboard, with classified turn data synced from transcripts into a new `burn_turns` SQL table.

**Architecture:** Port codeburn's classifier + parser (pure TS) into `packages/core/observability/burn/`, store per-turn classified data in a new `burn_turns` table, expose via `burn/summary` RPC handler, render in a new web page with 8 Recharts-based panels following codeburn's layout.

**Tech Stack:** TypeScript, bun:sqlite, Recharts, TanStack Query, Tailwind CSS, shadcn Card primitives, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-04-15-burn-dashboard-design.md`

**Worktree:** `.worktrees/burn-dashboard` on branch `feature/burn-dashboard`

**Parallelism:** Tasks 1-5 can run in parallel. Task 6 depends on 1-3. Task 7 depends on 5-6. Task 8 depends on 7. Tasks 9-10 depend on 8. Task 11 depends on 9-10. Task 12 is final verification.

**codeburn source:** Fetch any codeburn file via `gh api repos/AgentSeal/codeburn/contents/src/<file> -H "Accept: application/vnd.github.raw"`

---

## File Structure

### New Files

```
packages/core/observability/burn/
  types.ts              TaskCategory, ClassifiedTurn, BurnSummaryResponse, SessionSummary
  bash-utils.ts         Extract command names from shell strings
  classifier.ts         13-category turn classifier + retry detection
  parser.ts             JSONL -> ClassifiedTurn[] with dedup + cost calc
  sync.ts               Walk sessions, parse transcripts, upsert burn_turns
  index.ts              Re-exports
  __tests__/
    fixtures/claude-session.jsonl    10-turn synthetic Claude transcript
    classifier.test.ts
    bash-utils.test.ts
    parser.test.ts
    repository.test.ts
    sync.test.ts

packages/core/repositories/burn.ts     BurnRepository (upsert + aggregation)
packages/server/handlers/burn.ts       burn/summary + burn/sync RPC handlers

packages/web/src/
  pages/BurnPage.tsx
  hooks/useBurnQueries.ts
  components/burn/
    BurnView.tsx  BurnPeriodTabs.tsx  BurnSyncButton.tsx  HBar.tsx
    panels/OverviewPanel.tsx  DailyActivityPanel.tsx  ByProjectPanel.tsx
    panels/ByModelPanel.tsx  ByActivityPanel.tsx  CoreToolsPanel.tsx
    panels/ShellCommandsPanel.tsx  McpServersPanel.tsx
```

### Modified Files

```
packages/core/repositories/schema.ts    -- add burn_turns CREATE TABLE
packages/core/observability/pricing.ts  -- add fastMultiplier, webSearchCost
packages/core/observability/costs.ts    -- syncCosts also calls syncBurn
packages/core/observability/index.ts    -- re-export burn
packages/core/app.ts                    -- register BurnRepository as app.burn
packages/server/register.ts             -- register burn handlers
packages/web/src/hooks/useHashRouter.ts -- add "burn" to VALID_VIEWS
packages/web/src/hooks/useApi.ts        -- add burn API methods
packages/web/src/components/Sidebar.tsx -- add Burn nav entry with Flame icon
packages/web/src/App.tsx                -- add BurnPage route
```

---

## Task 1: Types + Test Fixtures

**Files:** Create `packages/core/observability/burn/types.ts`, `burn/index.ts`, `burn/__tests__/fixtures/claude-session.jsonl`

- [ ] **Step 1: Create types.ts** -- Port codeburn's types adapted for Ark. Includes: `TaskCategory` (13 categories), `CATEGORY_LABELS`, `TokenUsageBurn`, `ParsedApiCall`, `ParsedTurn`, `ClassifiedTurn` (with `isOneShot`), `SessionSummary` (with `categoryBreakdown`, `toolBreakdown`, `mcpBreakdown`, `bashBreakdown`), `BurnPeriod`, `BurnSummaryResponse` (overview + daily + byProject + byModel + byCategory + coreTools + mcpServers + bashCommands). Fetch codeburn source: `gh api repos/AgentSeal/codeburn/contents/src/types.ts -H "Accept: application/vnd.github.raw"`. Keep all fields from codeburn but drop Cursor-specific `languages` fields.

- [ ] **Step 2: Create index.ts** -- Re-exports all public symbols. Note: will not compile until all modules exist; that's expected.

- [ ] **Step 3: Create test fixture** -- 10-turn synthetic Claude JSONL at `burn/__tests__/fixtures/claude-session.jsonl`. Must include: 2 coding (one with Edit->Bash->Edit retry), 1 debugging (Bash + error keyword), 1 testing (Bash + pytest), 1 planning (EnterPlanMode + TaskCreate), 1 exploration (Read + Grep), 1 delegation (Agent), 1 git (Bash + git commit), 1 conversation (no tools), 1 feature (Edit + "add" keyword). Each assistant: `{type:"assistant",message:{model:"claude-sonnet-4-6",usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens},content:[{type:"tool_use",name:"...",id:"...",input:{}}]}}`. Each user: `{type:"user",message:{role:"user",content:"..."}}`. Include timestamps and uuid fields.

- [ ] **Step 4: Commit** -- `git commit -m "feat(burn): add burn types and test fixtures"`

---

## Task 2: bash-utils

**Files:** Create `burn/bash-utils.ts`, `burn/__tests__/bash-utils.test.ts`

- [ ] **Step 1: Write failing test** -- 8 test cases: simple command (`pytest tests/` -> `["pytest"]`), cd chain (`cd /tmp && npm test` -> `["npm"]`), pipe (`cat file | grep error` -> `["cat","grep"]`), skip builtins (`cd /tmp` -> `[]`), git subcommands (`git push origin main` -> `["git push"]`), npm subcommands (`npm run build` -> `["npm run build"]`), empty string, semicolons (`make build; make test` -> `["make","make"]`).

- [ ] **Step 2: Verify test fails** -- `make test-file F=packages/core/observability/burn/__tests__/bash-utils.test.ts` -> FAIL

- [ ] **Step 3: Implement** -- Port from codeburn `src/bash-utils.ts`. Export `extractBashCommands(command: string): string[]`. Split on `&&`, `||`, `;`, `|`. Skip builtins (cd, echo, export, source, set, unset, true, false, alias). Collapse git/npm/npx + next word.

- [ ] **Step 4: Verify passes** -- 8 pass

- [ ] **Step 5: Commit** -- `git commit -m "feat(burn): add bash command extraction"`

---

## Task 3: Classifier

**Files:** Create `burn/classifier.ts`, `burn/__tests__/classifier.test.ts`

- [ ] **Step 1: Write failing test** -- 15+ test cases covering all 13 categories + retry detection + one-shot detection. Use a `makeTurn(userMessage, tools, opts?)` helper to construct test turns. Key assertions: Edit -> `coding`, Edit+debug keyword -> `debugging`, Edit+feature keyword -> `feature`, Edit+refactor keyword -> `refactoring`, Bash+pytest -> `testing`, Read+Grep -> `exploration`, EnterPlanMode -> `planning`, Agent -> `delegation`, git push in Bash -> `git`, npm build in Bash -> `build/deploy`, brainstorm keyword -> `brainstorming`, no tools -> `conversation`, Skill tool -> `general`. Retry test: Edit->Bash->Edit sequence has `retries > 0` and `isOneShot === false`. One-shot: single Edit has `retries === 0` and `isOneShot === true`.

- [ ] **Step 2: Verify fails** -- FAIL

- [ ] **Step 3: Implement** -- Port from codeburn `src/classifier.ts`. Export `classifyTurn(turn: ParsedTurn): ClassifiedTurn` and `countRetries(turn: ParsedTurn): number`. Uses same regex patterns and tool sets as codeburn. `classifyByToolPattern` + `refineByKeywords` + `classifyConversation` + `countRetries` functions. Imports from `./types.js`. Keep EDIT_TOOLS, READ_TOOLS, BASH_TOOLS, TASK_TOOLS, SEARCH_TOOLS sets. Add `isOneShot: hasEdits && retries === 0` to ClassifiedTurn.

- [ ] **Step 4: Verify passes** -- 15+ pass

- [ ] **Step 5: Commit** -- `git commit -m "feat(burn): add 13-category classifier with retry detection"`

---

## Task 4: PricingRegistry Augmentation

**Files:** Modify `packages/core/observability/pricing.ts`, `__tests__/pricing.test.ts`

- [ ] **Step 1: Write failing tests** -- Add: `fast mode > applies fast multiplier when speed is fast` (Opus fast > normal), `fast mode > defaults to 1 for models without it`, `web search > adds web search cost when requests > 0` (3 reqs = $0.03 extra).

- [ ] **Step 2: Verify fails** -- calculateCost doesn't accept opts yet

- [ ] **Step 3: Augment** -- Add `fastMultiplier?: number` and `webSearchCostPerRequest?: number` to `ModelPricing`. Update `calculateCost` signature: add optional third arg `opts?: { speed?: string; webSearchRequests?: number }`. Apply: `cost *= p.fastMultiplier ?? 1` when `opts?.speed === "fast"`. Add `(opts?.webSearchRequests ?? 0) * (p.webSearchCostPerRequest ?? 0.01)`. Set `fastMultiplier: 6, webSearchCostPerRequest: 0.01` on Opus 4.6 default. All others: `fastMultiplier: 1`.

- [ ] **Step 4: Verify all pass** -- 15+ existing + 3 new

- [ ] **Step 5: Commit** -- `git commit -m "feat(burn): augment PricingRegistry with fast mode and web search"`

---

## Task 5: Schema + BurnRepository

**Files:** Modify `packages/core/repositories/schema.ts`. Create `packages/core/repositories/burn.ts`, `burn/__tests__/repository.test.ts`

- [ ] **Step 1: Write failing test** -- `BurnRepository > upsertTurns inserts rows` (insert, query, assert fields), `getOverview returns overview`, `getCategoryBreakdown returns category rows with oneshot pct`, `getToolBreakdown aggregates from tools_json`. Use `AppContext.forTest()`.

- [ ] **Step 2: Verify fails**

- [ ] **Step 3: Add burn_turns to schema** -- In `initSchema()`, add `CREATE TABLE IF NOT EXISTS burn_turns (...)` with all columns per spec. Add two indexes: `idx_burn_turns_tenant_timestamp`, `idx_burn_turns_tenant_category`.

- [ ] **Step 4: Implement BurnRepository** -- Constructor takes `IDatabase`. Methods: `upsertTurns(sessionId, rows[])` (DELETE then INSERT batch), `getTurns(sessionId)`, `getOverview(opts)` (SUM cost, tokens, COUNT DISTINCT session_id), `getCategoryBreakdown(opts)` (GROUP BY category, compute oneShotPct), `getModelBreakdown(opts)`, `getProjectBreakdown(opts)`, `getDailyBreakdown(opts)` (GROUP BY DATE(timestamp)), `getToolBreakdown(opts)` / `getMcpBreakdown(opts)` / `getBashBreakdown(opts)` (query rows, JSON.parse columns, aggregate in JS, top 10). All queries parameterized with whitelisted conditions.

- [ ] **Step 5: Verify passes** -- 4 pass

- [ ] **Step 6: Commit** -- `git commit -m "feat(burn): add burn_turns schema and BurnRepository"`

---

## Task 6: Parser

**Files:** Create `burn/parser.ts`, `burn/__tests__/parser.test.ts`

**Depends on:** Tasks 1 (types), 2 (bash-utils), 3 (classifier)

- [ ] **Step 1: Write failing test** -- 5 tests: `parses fixture into classified turns` (>= 8 turns), `deduplicates by message id` (unique keys), `assigns categories` (categories Set has "coding"), `computes session summary` (totalCostUSD > 0, apiCalls >= 8, categoryBreakdown keys >= 3), `detects one-shot turns` (coding.editTurns > 0).

- [ ] **Step 2: Verify fails**

- [ ] **Step 3: Implement** -- Port from codeburn `src/parser.ts`. Keep: `parseJsonlLine`, `extractToolNames`, `extractMcpTools`, `extractBashCommandsFromContent`, `getUserMessageText`, `getMessageId`, `parseApiCall`, `groupIntoTurns`, `buildSessionSummary`. Replace codeburn's `calculateCost` with Ark's `PricingRegistry` (create a local instance). Export: `parseClaudeTranscript(transcriptPath: string, project: string): { turns: ClassifiedTurn[]; summary: SessionSummary }`. Reads file with `readFileSync`, splits lines, parses, groups into turns, classifies each, builds summary.

- [ ] **Step 4: Verify passes** -- 5 pass

- [ ] **Step 5: Commit** -- `git commit -m "feat(burn): add transcript parser with classification"`

---

## Task 7: Sync + AppContext Wiring

**Files:** Create `burn/sync.ts`, `burn/__tests__/sync.test.ts`. Modify `packages/core/app.ts`, `packages/core/observability/costs.ts`.

**Depends on:** Tasks 5 (BurnRepository), 6 (parser)

- [ ] **Step 1: Register BurnRepository on AppContext** -- Import `BurnRepository`, add `burnRepo` property, create in boot after DB ready, expose as `get burn()`. Also works in `forTest()`.

- [ ] **Step 2: Write failing sync test** -- Create session with workdir, copy fixture JSONL to transcript location, call `syncBurn(app)`, assert `synced >= 1`, assert `app.burn.getTurns(session.id).length > 0`. Second call: assert `skipped >= 1`.

- [ ] **Step 3: Implement sync.ts** -- `syncBurn(app, opts?)` walks sessions, resolves transcript via `app.transcriptParsers.get(kind).findForSession()`, checks mtime for skip, calls `parseClaudeTranscript`, maps ClassifiedTurns to DB rows, calls `app.burn.upsertTurns()`. Returns `{ synced, skipped, errors }`.

- [ ] **Step 4: Wire into syncCosts** -- At end of `syncCosts()` in `costs.ts`, call `syncBurn(app)`.

- [ ] **Step 5: Verify passes** -- 2 pass

- [ ] **Step 6: Commit** -- `git commit -m "feat(burn): add sync pipeline and wire into AppContext"`

---

## Task 8: RPC Handler

**Files:** Create `packages/server/handlers/burn.ts`. Modify `packages/server/register.ts`.

**Depends on:** Task 7

- [ ] **Step 1: Implement handler** -- `registerBurnHandlers(router, app)` with two handlers: `burn/summary` (takes `{period}`, computes dateRange, calls all BurnRepository aggregation methods, returns `BurnSummaryResponse`) and `burn/sync` (takes `{force}`, calls `syncBurn(app, {force})`, returns result).

- [ ] **Step 2: Register** -- In `register.ts`, import and call `registerBurnHandlers(router, app)`.

- [ ] **Step 3: Commit** -- `git commit -m "feat(burn): add burn/summary and burn/sync RPC handlers"`

---

## Task 9: Web API + Hooks

**Files:** Modify `useApi.ts`, `useHashRouter.ts`. Create `useBurnQueries.ts`.

- [ ] **Step 1: Add to useApi.ts** -- `getBurnSummary: (period) => rpc("burn/summary", { period })`, `syncBurn: (force?) => rpc("burn/sync", { force })`.

- [ ] **Step 2: Create useBurnQueries.ts** -- `useBurnSummary(period)` via `useQuery`, `useBurnSync()` via `useMutation` that invalidates `["burn"]` queries on success.

- [ ] **Step 3: Add "burn" to VALID_VIEWS** -- In `useHashRouter.ts`.

- [ ] **Step 4: Commit** -- `git commit -m "feat(burn): add web hooks and API bindings"`

---

## Task 10: Panel Components

**Files:** Create all 8 panels + HBar under `packages/web/src/components/burn/`

**Style reference:** Ark uses Tailwind + shadcn `Card` + lucide-react + Recharts. Colors: dark bg, `text-foreground`, `text-muted-foreground`. Existing CostsView uses the same primitives.

**codeburn layout reference:** Fetch `gh api repos/AgentSeal/codeburn/contents/src/dashboard.tsx -H "Accept: application/vnd.github.raw"` for panel structure, color palette, data formatting.

- [ ] **Step 1: HBar.tsx** -- Recharts `<BarChart layout="vertical">` wrapper with gradient fill. Props: `data`, `maxItems`, `valueFormatter`. Blue-to-orange gradient per bar position.

- [ ] **Step 2: OverviewPanel** -- Hero metrics: cost (gold), calls, sessions, cache hit %, token breakdown. Card with `text-orange-400` title.

- [ ] **Step 3: DailyActivityPanel** -- Vertical `<BarChart>` with 14-day series. Card with `text-sky-400` title.

- [ ] **Step 4: ByProjectPanel** -- HBar top 8 projects. Card with `text-emerald-400` title.

- [ ] **Step 5: ByModelPanel** -- HBar by model. Card with `text-fuchsia-400` title.

- [ ] **Step 6: ByActivityPanel** -- HBar + 1-shot % column. Card with `text-amber-400` title. Color-code 1-shot: green >= 80%, amber >= 50%, red < 50%, "--" if no edits.

- [ ] **Step 7: CoreToolsPanel, ShellCommandsPanel, McpServersPanel** -- All HBar top 10. Cards with `text-cyan-400`, `text-orange-300`, `text-pink-400` titles.

- [ ] **Step 8: Commit** -- `git commit -m "feat(burn): add 8 panel components and HBar"`

---

## Task 11: BurnView + BurnPage + Routing + Sidebar

**Files:** Create `BurnView.tsx`, `BurnPeriodTabs.tsx`, `BurnSyncButton.tsx`, `BurnPage.tsx`. Modify `Sidebar.tsx`, `App.tsx`.

**Depends on:** Tasks 9, 10

- [ ] **Step 1: BurnPeriodTabs** -- 4 buttons: Today, 7 Days, 30 Days, Month. Active: `bg-accent text-foreground`. Inactive: `text-muted-foreground`.

- [ ] **Step 2: BurnSyncButton** -- Calls `useBurnSync()`. Shows spinner during mutation, success count after.

- [ ] **Step 3: BurnView** -- Uses `useBurnSummary(period)`. Header: tabs + sync button. Grid: responsive 1/2/3 cols. Panels in order: Overview (full width), Daily+Project, Model+Activity, Tools+Shell+MCP. Empty/loading/error states.

- [ ] **Step 4: BurnPage** -- `<Layout>` wrapper like `CostsPage`. Title "Burn", padded={false}.

- [ ] **Step 5: Sidebar** -- Import `Flame` from lucide-react. Add `{ id: "burn", icon: Flame, label: "Burn" }` to `NAV` after costs.

- [ ] **Step 6: App.tsx** -- Import `BurnPage`. Add: `{view === "burn" && <BurnPage ... />}`

- [ ] **Step 7: Commit** -- `git commit -m "feat(burn): add BurnView page with routing and sidebar"`

---

## Task 12: Verification + Full Suite

**Depends on:** All

- [ ] **Step 1: Run all burn tests** -- Each test file individually via `make test-file`. All must pass.

- [ ] **Step 2: Run regression tests** -- `packages/core/observability/__tests__/pricing.test.ts`, `usage.test.ts`, `costs.test.ts`. Must still pass.

- [ ] **Step 3: Run full suite** -- `make test`. Zero failures.

- [ ] **Step 4: Start dev server** -- `make dev`. Open `http://localhost:5173/#/burn`. Verify: period tabs, sync button, 8 panels render, sidebar Flame icon, `/costs` unaffected.

- [ ] **Step 5: Final commit if needed** -- `git commit -m "chore(burn): final integration adjustments"`
