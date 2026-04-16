# Burn Dashboard -- PR #153 Review Fixes

**Date:** 2026-04-16
**Status:** Approved for implementation
**Branch:** `feature/burn-dashboard`
**Parent PR:** ytarasova/ark#153

## Problem

Code review on PR #153 surfaced 3 issues:

1. **Em dashes (U+2014) in design specs** violate the repo-wide CLAUDE.md rule: "Never use em dashes. Use hyphens (-) or double dashes (--) everywhere." 39 occurrences in the new spec files.
2. **Timezone mismatch** in `packages/server/handlers/burn.ts getDateRange()`: local-timezone midnight is converted to UTC via `.toISOString()`, and `packages/core/repositories/burn.ts getDailyBreakdown()` buckets via SQLite `DATE(timestamp)` which is UTC. For non-UTC users, "Today" cuts at the wrong hour and Daily Activity bars attribute evening work to the next calendar day. The same function has an off-by-one bug: "week" covers 8 calendar days instead of 7 (and "30days" covers 31).
3. **Silent empty catch** around `syncBurn(app)` in `packages/core/observability/costs.ts:161`: schema errors, corrupt JSONL, and classifier crashes are swallowed with no log, so real production failures will never surface.

## Goals

- Zero em dashes in tracked files, enforced by a lint check.
- Correct per-user day bucketing and correct N-day ranges for any client timezone.
- Visible server-side logs when burn sync fails.

## Non-goals

- Redesigning `BurnSummaryResponse` shape.
- Propagating timezone through other observability paths (costs page is unchanged).
- Adding telemetry events / metrics for sync failures; a console warn is enough.

## Design

### Issue 1: em dash cleanup + lint guard

**Cleanup:** `perl -i -pe 's/\x{2014}/--/g'` across all tracked `.md`, `.ts`, `.tsx`, `.yaml`, `.yml`, `.json` files (avoids embedding U+2014 in this spec). Verify `grep -rln $'\xe2\x80\x94' .` returns zero.

**Guard:** `scripts/check-no-em-dashes.sh` that fails if any em dash is committed:

```sh
#!/usr/bin/env bash
if grep -rn --include='*.md' --include='*.ts' --include='*.tsx' \
  --include='*.yaml' --include='*.yml' --include='*.json' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.worktrees \
  -l $'\xe2\x80\x94' . 2>/dev/null; then
  echo "Em dashes found. Replace with '--'." >&2
  exit 1
fi
```

Wire into `make lint`: append `bash scripts/check-no-em-dashes.sh` after the ESLint step.

### Issue 2: timezone-aware date ranges + off-by-one fix

**Protocol (additive, backward compatible):**

- `burn/summary` accepts optional `tz?: string` field (IANA zone, e.g. `"America/New_York"`). If absent, server falls back to `"UTC"`.

**Server (`packages/server/handlers/burn.ts`):**

- `getDateRange(period, tz)` computes start at zone-midnight, then converts back to UTC ISO for the DB comparison.
- Helper `zoneOffsetString(tz, atDate)` returns the SQLite-compatible modifier string (e.g. `"-5 hours"`). Never interpolates raw client input into SQL; the IANA zone is resolved through `Intl.DateTimeFormat` server-side.
- Ranges, with `zoneMidnight(tz)` returning that day's midnight in the given zone:
  - `today`: `[zoneMidnight(tz, today), now]`
  - `week`: `[zoneMidnight(tz, today - 6 days), now]` -- 7 calendar days inclusive
  - `30days`: `[zoneMidnight(tz, today - 29 days), now]` -- 30 calendar days inclusive
  - `month`: `[zoneMidnight(tz, first of month), now]`
- Pass `tz` through to `BurnRepository` methods that bucket by date.

**Repository (`packages/core/repositories/burn.ts`):**

- Extend `BurnQueryOpts` with optional `tz?: string`.
- `getDailyBreakdown(opts)`: when `opts.tz` present, use parameterized SQLite modifier:

  ```sql
  SELECT DATE(timestamp, ?) as date, SUM(cost_usd) as cost, SUM(api_calls) as calls
  FROM burn_turns
  WHERE ...
  GROUP BY DATE(timestamp, ?)
  ORDER BY date
  ```

  with `params = [..., zoneModifier, zoneModifier]`. Compute `zoneModifier` in the handler layer and pass as a vetted string.

**Web (`packages/web/src/hooks/useBurnQueries.ts`):**

- `useBurnSummary` includes `tz: Intl.DateTimeFormat().resolvedOptions().timeZone` in the RPC payload. No UI change.

### Issue 3: observable burn sync failures

`packages/core/observability/costs.ts`:

```ts
try {
  syncBurn(app);
} catch (err) {
  console.warn("[burn] sync failed:", err);
}
```

Matches the `console.warn` pattern already used for best-effort paths in the same file. Preserves the "do not fail syncCosts on burn error" behavior.

## Testing strategy (TDD)

Each fix gets a failing test first.

**Issue 1:**

- `scripts/check-no-em-dashes.sh` test: run the script against a fixture tree containing an em dash; assert nonzero exit. Then against a clean tree; assert zero exit.

**Issue 2:**

- `packages/server/__tests__/burn-date-range.test.ts`:
  - `getDateRange("today", "America/New_York")` at a fixed `now = 2026-04-16T03:00:00Z` (23:00 EDT April 15) returns start = `2026-04-15T04:00:00Z` (midnight EDT April 15).
  - `getDateRange("week", "UTC")` at fixed now returns exactly 7 days span (604800000 ms +/- the partial current day).
  - `getDateRange("30days", "UTC")` returns exactly 30 days span.
  - `getDateRange("today", undefined)` falls back to UTC midnight (regression guard).
- `packages/core/repositories/__tests__/burn-daily-tz.test.ts`:
  - Insert 3 turns at `2026-04-16T03:00:00Z`. Query `getDailyBreakdown({ tz: "America/New_York" })` -> bucketed under `2026-04-15`. Query without `tz` -> bucketed under `2026-04-16`.

**Issue 3:**

- `packages/core/observability/__tests__/costs-sync-burn-error.test.ts`:
  - Stub `BurnParserRegistry` to throw inside `syncBurn`. Spy on `console.warn`.
  - Call `syncCosts(app)`; assert it resolves (no throw) AND `console.warn` was called with a string starting `"[burn] sync failed:"`.

All tests use real `AppContext.forTest()` and real SQLite per the project TDD rule (no mocks of internal logic).

## Implementation order

1. Issue 3 (trivial, unblocks other work). Test -> fix -> green.
2. Issue 1 cleanup + lint script + test for the script.
3. Issue 2:
   a. Add `zoneOffsetString` / `zoneMidnight` helpers + tests.
   b. Thread `tz` through `getDateRange` with fallback, tests.
   c. Thread `tz` through `BurnRepository.getDailyBreakdown` + `BurnQueryOpts`, tests.
   d. Update handler to build `zoneModifier` and pass through; update `burn/summary` request parsing.
   e. Update `useBurnSummary` to send `tz`.
   f. Manual smoke in the web UI.

## Modified files

- `packages/core/observability/costs.ts`
- `packages/core/repositories/burn.ts`
- `packages/core/observability/burn/types.ts` (extend `BurnQueryOpts`)
- `packages/server/handlers/burn.ts`
- `packages/web/src/hooks/useBurnQueries.ts`
- `packages/web/src/hooks/useApi.ts` (pass `tz` through if typed)
- `Makefile` (append em-dash check to lint target)
- `docs/superpowers/specs/2026-04-15-burn-dashboard-design.md` (em-dash cleanup)
- `docs/superpowers/specs/2026-04-16-burn-multi-runtime-design.md` (em-dash cleanup)

## New files

- `scripts/check-no-em-dashes.sh`
- `packages/server/__tests__/burn-date-range.test.ts`
- `packages/core/repositories/__tests__/burn-daily-tz.test.ts`
- `packages/core/observability/__tests__/costs-sync-burn-error.test.ts`
- `scripts/__tests__/check-no-em-dashes.test.ts` (bun:test runs the shell script)

## PR strategy

Stack fixes on the existing `feature/burn-dashboard` branch. 3 commits (one per issue, test + fix in the same commit per TDD). No new PR -- pushes to PR #153.
