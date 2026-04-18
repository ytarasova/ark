# Agent 6 — Build vs Buy + Performance Budgets

## Summary

Ark reinvents several wheels inside the web layer (markdown, diff, terminal fit) where mature, well-maintained libraries would reduce XSS surface, cover edge cases, and improve maintainability. Backend code is more disciplined: `p-retry`/`p-wait-for` are already in use (`packages/compute/util.ts:1-70`), Commander is the only CLI parser, and tmux/SSH wrappers are thin shell-outs that don't warrant replacement. The biggest gaps are (a) no schema validation at the JSON-RPC boundary (`packages/server/validate.ts:7-15` is positional key presence only) and (b) no code splitting in the web bundle — initial JS is **449 KB gzipped vs 300 KB budget (FAIL, +50%)**. Dropping `react-markdown` in and lazy-loading routes would recover most of the gap.

## Verdict Distribution
Adopt: 5 · Hybrid: 3 · Keep: 7

## Candidates

### 1. Markdown rendering
- **Current:** `packages/web/src/components/ui/MarkdownContent.tsx` (195 LOC, no direct tests — used by `DesignPreviewPage.tsx`, `event-builder.tsx`, `SessionDetail.tsx`). Regex-based: renders untrusted agent output; inline regex can over-match (`*a*b*c*` backtracks), no table / autolink / blockquote / HTML-escape, and `inlineRe` does not escape user-provided HTML inside code spans — React JSX absorbs most of the XSS risk today, but any future switch to raw-HTML injection would be unsafe.
- **Proposed:** `react-markdown` 9.x (MIT, ~18 KB gz min) + `rehype-sanitize` (MIT, ~8 KB gz) + `remark-gfm` (optional, ~10 KB gz).
- **Decision:** **adopt**.
- **Risk:** S. **Effort:** M.
- **Hex compliance:** view layer only, no adapter concerns.
- **E2e coverage:** `packages/web/e2e/session-view.spec.ts` exercises conversation rendering — add a "markdown fixture" fixture test (heading + code fence + list + bold) before swap, re-run after. Add a unit test with XSS payloads (img-onerror attempt, stray backticks, combined bold+italic).
- **Rationale:** regex markdown is a known XSS vector class; `react-markdown` handles the long tail (tables, nested emphasis, autolinks, escaping) and drops 150+ LOC of hand-rolled parsing. Bundle cost (~25-40 KB gz) is acceptable; DiffViewer / StaticTerminal swaps free more space.

### 2. Terminal sizing (`StaticTerminal.tsx`)
- **Current:** `packages/web/src/components/StaticTerminal.tsx` (94 LOC; unit tested by `packages/web/src/__tests__/terminal-display.test.ts`). `detectCols` walks `stripAnsi(output).split("\n")` to find the widest line; `fitRows` divides `clientHeight / 14`. `@xterm/addon-fit` **is already a dependency** (`package.json:43`) but unused here.
- **Proposed:** hybrid — keep manual `cols` (widest-line for horizontal-scroll semantic is intentional), but use `FitAddon.proposeDimensions().rows` to replace `Math.floor(h/14)`. Removes the hard-coded `cellHeight = 14` which breaks on font-size or zoom changes.
- **Decision:** **hybrid**.
- **Risk:** S. **Effort:** S (20 min).
- **Hex compliance:** view layer.
- **E2e coverage:** `session-view.spec.ts` "terminal tab renders output" — add a resize assertion after viewport resize.
- **Rationale:** the comment in the file explicitly rejects FitAddon for cols; valid, but the rows math is the part that's wrong today at non-default font sizes.

### 3. ANSI strip
- **Current:** two regex copies: `StaticTerminal.tsx:18` and an equivalent in `timeline-builder.ts` / `SessionDetail.tsx` (regex `\x1b\[...`).
- **Proposed:** `strip-ansi` 7.x (MIT, ~1 KB gz) + `ansi-regex` 6.x (MIT, 0.5 KB gz).
- **Decision:** **adopt**.
- **Risk:** S. **Effort:** S.
- **Hex compliance:** pure utility.
- **E2e coverage:** existing terminal render tests cover.
- **Rationale:** tiny, well-vetted, handles OSC 8 hyperlinks and 24-bit color escapes that the local regex misses. Dedupes two regex copies.

### 4. Diff viewer + `parseUnifiedDiff`
- **Current:** `packages/web/src/components/ui/DiffViewer.tsx` (86 LOC) + `parseUnifiedDiff` in `packages/web/src/components/session/timeline-builder.ts:40-86` (~47 LOC). No syntax highlighting; no word-level intra-line diff; no side-by-side view; parses git-style unified diffs only.
- **Proposed:** `diff` 5.x (BSD-3, ~15 KB gz) for parsing + keep current renderer for now, OR full swap to `react-diff-viewer-continued` (MIT, ~25 KB gz + prismjs).
- **Decision:** **hybrid** — adopt `diff` for parsing (correctness), keep current renderer (matches design tokens), defer `react-diff-viewer-continued` until product wants syntax highlighting / split view.
- **Risk:** S. **Effort:** S.
- **Hex compliance:** view.
- **E2e coverage:** `session-view.spec.ts` diff tab — add a fixture with `\ No newline at end of file`, renamed files (`rename from/to`), and binary markers that the current regex silently drops.
- **Rationale:** `parseUnifiedDiff` ignores renames, mode changes, and multi-hunk offsets (only uses first `+N` capture). `diff` library handles these. Cost is low.

### 5. JSON-RPC framing (`packages/protocol/`)
- **Current:** `transport.ts` (203 LOC) + `types.ts` (120 LOC) + `client.ts` (960 LOC). JSONL over stdio/WebSocket; homegrown framer (`createLineSplitter`) and request/response correlation in `client.ts`.
- **Proposed:** `json-rpc-2.0` (MIT, ~3 KB gz) for envelope typing **only**. Explicitly do **not** adopt `jayson` (Node `http`/`tcp`-coupled, assumes Express) or tRPC (schema commitment beyond current scope).
- **Decision:** **keep** (hybrid optional).
- **Risk:** M. **Effort:** L.
- **Hex compliance:** transport is already adapter-shaped (`Transport` interface); safe to swap.
- **E2e coverage:** every RPC test (`packages/server/__tests__/*`, `packages/web/e2e/*`) covers framing implicitly.
- **Rationale:** current code works, is narrow, and the JSONL framer over stdio is pragmatic for the `arkd` + WS daemon setup. Library replacement is a lateral move; no user-visible win. **Keep, but pair with Zod (candidate 8) for per-method param validation.**

### 6. SSH / rsync wrappers (`packages/compute/providers/ec2/ssh.ts`)
- **Current:** 159 LOC shelling out to `ssh`/`rsync`/`ssh-keygen`. ControlMaster / multiplexing lives in a sibling pool file (referenced in MEMORY.md: "SSH pool implemented"). Already uses `execFile` (not `exec`) — safe from shell injection.
- **Proposed:** `ssh2` 1.x (MIT) with `node-ssh` 13.x wrapper for native multiplexing.
- **Decision:** **keep**.
- **Risk:** L. **Effort:** L.
- **Hex compliance:** `ssh2` is a secondary adapter — fine. But `ssh2` doesn't give us `rsync`; we'd still shell out for that. And ControlMaster already works.
- **E2e coverage:** `packages/compute/__tests__/ec2-*.test.ts` (if present) must run end-to-end before/after — a swap here without live EC2 smoke test is disqualified per MEMORY.md's "10/13 pass, auth sync + ark install still failing" state.
- **Rationale:** high migration risk for marginal gain. The MEMORY note that "metrics drops stale" from the SSH pool is a bug to fix, not a library to swap.

### 7. SQLite repositories
- **Current:** `packages/core/repositories/*.ts` (1629 LOC total). Raw `bun:sqlite` via `IDatabase` facade, with a hand-maintained column whitelist (`session.ts:63-87`) — the exact pattern CLAUDE.md flags ("SQL columns match TS fields 1:1"). Easy to drift; no compile-time protection against typos in `WHERE`.
- **Proposed:** **Kysely** (MIT, ~20 KB gz, Bun-compatible, uses `bun:sqlite` via custom dialect). Type-safe queries, no ORM magic. Drizzle is also viable but more opinionated.
- **Decision:** **adopt (staged)**.
- **Risk:** M. **Effort:** L (per repo; start with `session.ts`).
- **Hex compliance:** Kysely is a pure query builder, slots behind `IDatabase` adapter.
- **E2e coverage:** all `packages/core/__tests__/*.test.ts` that touch session/compute/event tables. Add a typecheck gate (`tsc --noEmit`) as the primary regression signal.
- **Rationale:** the `SESSION_COLUMNS` whitelist is a smell — Kysely generates types from the schema once, and the `update()` method becomes type-safe automatically. Keep `bun:sqlite` driver.

### 8. Schema / validation at JSON-RPC boundary
- **Current:** `packages/server/validate.ts` (15 LOC) — checks only that required keys are present, no type validation. Every handler blindly casts via `extract<T>()`.
- **Proposed:** **Zod** 3.x (MIT, ~12 KB gz, tree-shakable). Define request schemas alongside each handler; emit error `-32602` on parse failure. Interlocks with Agent 1's type-drift findings — lets us generate TS types from schemas once and share client/server.
- **Decision:** **adopt**.
- **Risk:** M. **Effort:** L (incremental: wrap `extract` first, then migrate per handler).
- **Hex compliance:** validation is domain contract; schema lives with handler (application layer), adapter-agnostic.
- **E2e coverage:** each handler's integration test + a new "malformed RPC" fuzz test in `packages/server/__tests__/`.
- **Rationale:** high-value, low-risk if staged. Closes the class of bugs where a client sends `sessionId: null` and the server crashes in the repo layer.

### 9. Structured logging (`packages/core/observability/structured-log.ts`)
- **Current:** 112 LOC, writes JSONL, rotates at 10 MB, component filtering. Synchronous `appendFileSync` per log call — blocks the event loop on hot paths.
- **Proposed:** **Pino** 9.x (MIT, Bun-compatible, ~10 KB server-side). Async, JSON-structured, mature, rotation via `pino-roll`.
- **Decision:** **adopt**.
- **Risk:** S. **Effort:** M.
- **Hex compliance:** logger is an adapter; domain imports `log()` today, continues to with a Pino-backed shim.
- **E2e coverage:** no user-visible change; verify via unit test that log entries parse as JSON and component filter still applies.
- **Rationale:** `appendFileSync` per log is a perf landmine; Pino is the standard answer. Keep the `log()` API surface and wrap Pino behind it.

### 10. DAG / flow execution
- **Current:** flows defined in YAML (`flows/*.yaml`); runner embedded in `packages/core/services/stage-orchestrator.ts` (1255 LOC) + `services/session-orchestration.ts`. Domain semantics (stages, gates, retries) are bespoke.
- **Proposed:** none compelling. `graphlib` / `@dagrejs/graphlib` solve graph layout, not execution. Full workflow engines (Temporal, BullMQ) are too heavy.
- **Decision:** **keep**.
- **Risk:** —. **Effort:** —.
- **Rationale:** domain-specific flow semantics (breakpoints, handoffs, fan-out) don't map cleanly to any off-the-shelf runner.

### 11. Retry / backoff
- **Current:** already using `p-retry` + `p-wait-for` via `packages/compute/util.ts:1-70`.
- **Decision:** **keep**.
- **Rationale:** done; the `retry()`/`poll()` wrappers are thin facades — fine.

### 12. CLI arg parsing
- **Current:** Commander 12.x (`package.json:51`) across `packages/cli/`. No hand-rolled layer found.
- **Decision:** **keep**.

### 13. Tmux interaction
- **Current:** `packages/core/infra/tmux.ts` (281 LOC). Direct `tmux` CLI shell-out. No Node library for tmux is mature.
- **Decision:** **keep**.
- **Rationale:** CLAUDE.md: "Tmux required. No fallback." The shell-out is the right call.

### 14. UUID / ID generation
- **Current:** mixed. `packages/core/repositories/session.ts:372` uses `randomBytes(3).toString("hex")` (6 hex chars, 16.7M space, collision risk at scale). `packages/core/ledger.ts:59,100` uses `Math.random().toString(36).slice(2,6)` (4 chars, non-crypto, weak). `packages/core/schedule.ts:38` uses `randomBytes(3)`. `packages/core/auth/api-keys.ts:58` uses `randomBytes(4)` for ID and `randomBytes(24)` for secret (correct).
- **Proposed:** **`nanoid`** 5.x (MIT, ~0.5 KB gz). Standardize session/ledger/schedule IDs on `nanoid(10)` (alphanumeric, URL-safe, 58-bit space).
- **Decision:** **adopt**.
- **Risk:** S (session IDs are visible in DB and logs — keep `s-` prefix). **Effort:** S.
- **Hex compliance:** pure utility.
- **E2e coverage:** session create/get round-trip tests cover format change.
- **Rationale:** `ledger.ts`'s `Math.random()` IDs are unacceptable — not crypto-safe, high collision rate. Fix that regardless; nanoid solves it in one line.

### 15. Date / time formatting
- **Current:** `packages/web/src/util.ts:1-20` — `relTime()` and `fmtDuration()` hand-rolled (20 LOC, covered by `packages/web/__tests__/util.test.ts`). `timeline-builder.ts:33` uses native `Intl`.
- **Proposed:** none. These are tiny and correct.
- **Decision:** **keep**.
- **Rationale:** `date-fns` would be ~15 KB gz for functionality that's 20 LOC. Native `Intl.RelativeTimeFormat` would save 5 LOC if we cared. Not worth it.

## Performance Budgets

Built via `bun run packages/web/build.ts` on branch `fix/web-session-view-overhaul`:

| Metric | Budget | Actual | Status |
|---|---|---|---|
| Initial JS (gzip) | 300 KB | **449.31 KB** | **FAIL (+50%)** |
| Initial CSS (gzip) | n/a | 15.61 KB | ok |
| Per-route chunk (gzip) | 100 KB | **n/a — zero code splitting** | **FAIL** |
| First RPC round-trip p50 (localhost) | 500 ms | not measured this pass | unknown |

Vite emitted a single 1.6 MB raw bundle (`dist/assets/index-hB1nKKyv.js`) and warned: *"Some chunks are larger than 500 kB after minification."* `App.tsx` statically imports all 11 page components (`SessionsPage`, `FlowsPage`, `ComputePage`, `FlowEditor` with `@xyflow/react`, etc.). **No `React.lazy` anywhere** (grep confirmed).

**Fast wins to land under budget:**
1. `React.lazy` + `Suspense` per page route → per-chunk <100 KB, initial ≈180-220 KB gz.
2. Dynamic import `@xyflow/react` (flow editor) and `recharts` (costs/metrics) — each is ~60-100 KB gz.
3. Dynamic import `@xterm/xterm` inside `Terminal.tsx` / `StaticTerminal.tsx` — ~40 KB gz, only needed on the session detail → terminal tab.

## Findings (rolled up)

| ID | Severity | File:Line | Category | Title | Evidence | Proposed Fix | Effort | Depends On |
|---|---|---|---|---|---|---|---|---|
| F1 | high | packages/web/src/components/ui/MarkdownContent.tsx:14-55 | lib-opportunity | Regex markdown parser, XSS-adjacent | 195 LOC hand-rolled; inline regex backtracks; no table/blockquote support | `react-markdown` + `rehype-sanitize` | M | — |
| F2 | high | packages/web/* (build output) | perf-budget | Initial JS 449 KB gz > 300 KB budget | `dist/assets/index-hB1nKKyv.js` 1.6 MB raw / 449 KB gz, single chunk | `React.lazy` pages + dynamic import xyflow/recharts/xterm | M | — |
| F3 | high | packages/server/validate.ts:7-15 | lib-opportunity | No schema validation at RPC boundary | `extract<T>()` only checks key presence, casts unsafely | Adopt Zod, wrap `extract` | L | Agent 1 type-drift |
| F4 | med | packages/core/ledger.ts:59,100 | lib-opportunity | `Math.random()` used for IDs | weak, non-crypto, collisions | `nanoid(10)` | S | — |
| F5 | med | packages/core/observability/structured-log.ts:102 | lib-opportunity | `appendFileSync` per log call blocks event loop | sync fs in hot path | Pino behind existing `log()` shim | M | — |
| F6 | med | packages/core/repositories/session.ts:63-87 | lib-opportunity | Hand-maintained column whitelist | drift risk noted in CLAUDE.md | Kysely over `bun:sqlite` | L | — |
| F7 | med | packages/web/src/components/session/timeline-builder.ts:40-86 | lib-opportunity | `parseUnifiedDiff` drops renames / mode changes | regex-only, misses edge cases | `diff` library for parsing | S | — |
| F8 | low | packages/web/src/components/StaticTerminal.tsx:79 | lib-opportunity | Hardcoded `cellHeight = 14` | `Math.floor(h/14)` breaks on font-size change | Use `FitAddon.proposeDimensions().rows` | S | — |
| F9 | low | packages/web/src/components/StaticTerminal.tsx:18 | lib-opportunity | ANSI regex duplicated, misses OSC 8 | 2 copies of `\x1b\[...` regex | `strip-ansi` + `ansi-regex` | S | — |

## Top 5 Swaps (ranked by effort-adjusted value)

1. **F2 — Code-split web bundle** (M effort, unblocks perf budget immediately; no lib decision needed, just `React.lazy`).
2. **F1 — `react-markdown` + `rehype-sanitize`** (M effort, removes 195 LOC + XSS class).
3. **F3 — Zod at RPC boundary** (L effort, but interlocks with Agent 1; biggest correctness win).
4. **F4 — `nanoid` for IDs** (S effort, fixes real collision bug in `ledger.ts`).
5. **F5 — Pino behind `log()` shim** (M effort, removes blocking fs writes on hot paths).
