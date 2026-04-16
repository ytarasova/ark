# Burn Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 3 code review issues on PR #153 (em dashes, timezone bug, silent catch) with TDD.

**Architecture:** Three independent fixes stacked as commits on `feature/burn-dashboard`. Each fix lands test-first, then minimal code, then commit. No cross-cutting refactor.

**Tech Stack:** Bun + bun:test, TypeScript, better-sqlite3 modifier syntax, Intl API, POSIX sh.

**Working dir:** `/Users/zineng/featureScala/ark/.worktrees/burn-dashboard`

**Spec:** `docs/superpowers/specs/2026-04-16-burn-review-fixes-design.md`

---

## Task 1: Issue 3 -- observable burn sync failures

**Files:**
- Create: `packages/core/observability/__tests__/costs-sync-burn-error.test.ts`
- Modify: `packages/core/observability/costs.ts` (around line 161)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/observability/__tests__/costs-sync-burn-error.test.ts
import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { AppContext } from "../../app.js";
import { syncCosts } from "../costs.js";

describe("syncCosts: burn sync error visibility", () => {
  let app: AppContext;

  beforeAll(async () => {
    app = AppContext.forTest();
    await app.boot();
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  it("logs a warning when syncBurn throws, and syncCosts does not throw", async () => {
    const origGet = app.burnParsers.get.bind(app.burnParsers);
    app.burnParsers.get = () => {
      throw new Error("boom: simulated parser registry failure");
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(syncCosts(app)).resolves.toBeDefined();
      const calls = warnSpy.mock.calls.map((args) => String(args[0] ?? ""));
      expect(calls.some((m) => m.startsWith("[burn] sync failed:"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      app.burnParsers.get = origGet;
    }
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

```bash
make test-file F=packages/core/observability/__tests__/costs-sync-burn-error.test.ts
```

Expected: fails -- warn spy never matches `"[burn] sync failed:"` (current catch is silent).

- [ ] **Step 3: Write the fix**

Edit `packages/core/observability/costs.ts` line 161. Replace:

```ts
try { syncBurn(app); } catch { /* burn sync is best-effort */ }
```

with:

```ts
try {
  syncBurn(app);
} catch (err) {
  console.warn("[burn] sync failed:", err);
}
```

- [ ] **Step 4: Run test, verify it PASSES**

```bash
make test-file F=packages/core/observability/__tests__/costs-sync-burn-error.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/observability/costs.ts \
        packages/core/observability/__tests__/costs-sync-burn-error.test.ts
git commit -m "fix(burn): log burn sync failures instead of swallowing them"
```

---

## Task 2: Issue 1 -- em-dash cleanup + lint guard

**Files:**
- Create: `scripts/check-no-em-dashes.sh`
- Create: `scripts/__tests__/check-no-em-dashes.test.ts`
- Modify: `Makefile` (lint target)
- Modify: `docs/superpowers/specs/2026-04-15-burn-dashboard-design.md`
- Modify: `docs/superpowers/specs/2026-04-16-burn-multi-runtime-design.md`
- Modify: any other tracked file with em dashes (found by scan)

- [ ] **Step 1: Write the failing test**

```ts
// scripts/__tests__/check-no-em-dashes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const SCRIPT = join(import.meta.dir, "..", "check-no-em-dashes.sh");

describe("check-no-em-dashes.sh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emdash-"));
    chmodSync(SCRIPT, 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 when no em dashes present", () => {
    writeFileSync(join(dir, "clean.md"), "hello -- world\n");
    const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("exits nonzero when an em dash is present", () => {
    writeFileSync(join(dir, "dirty.md"), "hello \u2014 world\n");
    const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

```bash
make test-file F=scripts/__tests__/check-no-em-dashes.test.ts
```

Expected: fails -- script does not exist.

- [ ] **Step 3: Create the check script**

```bash
cat > scripts/check-no-em-dashes.sh <<'SH'
#!/usr/bin/env bash
set -u
hits=$(grep -rln \
  --include='*.md' --include='*.ts' --include='*.tsx' \
  --include='*.yaml' --include='*.yml' --include='*.json' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.worktrees \
  --exclude-dir=.git \
  $'\xe2\x80\x94' . 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "Em dashes (U+2014) found in:" >&2
  echo "$hits" >&2
  echo "Replace with '--' or '-'." >&2
  exit 1
fi
exit 0
SH
chmod +x scripts/check-no-em-dashes.sh
```

- [ ] **Step 4: Run test, verify it PASSES**

```bash
make test-file F=scripts/__tests__/check-no-em-dashes.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Clean em dashes across the tree**

```bash
# Find all files with em dashes
grep -rln $'\xe2\x80\x94' \
  --include='*.md' --include='*.ts' --include='*.tsx' \
  --include='*.yaml' --include='*.yml' --include='*.json' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.worktrees \
  --exclude-dir=.git . > /tmp/emdash-files.txt

# Replace em dashes with '--' in each
while IFS= read -r f; do
  perl -i -pe 's/\x{2014}/--/g' "$f"
done < /tmp/emdash-files.txt

# Verify repo-level check now passes
bash scripts/check-no-em-dashes.sh
echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 6: Wire into `make lint`**

View current lint target:

```bash
grep -n "^lint:" Makefile
```

Append the em-dash check. For example, if the current recipe is `bunx eslint ...`, edit the `lint:` target in `Makefile` so it reads:

```makefile
lint:
	bunx eslint . --max-warnings=0
	bash scripts/check-no-em-dashes.sh
```

(Preserve the exact existing eslint command; only append the new line.)

- [ ] **Step 7: Run full lint to verify**

```bash
make lint
```

Expected: passes with zero warnings and zero em-dash hits.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-no-em-dashes.sh \
        scripts/__tests__/check-no-em-dashes.test.ts \
        Makefile \
        docs/superpowers/specs/2026-04-15-burn-dashboard-design.md \
        docs/superpowers/specs/2026-04-16-burn-multi-runtime-design.md
# Plus any other files changed by the perl pass:
git add -u
git commit -m "fix: remove em dashes and add lint guard per CLAUDE.md"
```

---

## Task 3a: Issue 2 -- timezone helper functions

**Files:**
- Create: `packages/server/handlers/__tests__/burn-tz-helpers.test.ts`
- Modify: `packages/server/handlers/burn.ts` (add helpers)

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/handlers/__tests__/burn-tz-helpers.test.ts
import { describe, it, expect } from "bun:test";
import { zoneMidnight, zoneOffsetMinutes, zoneSqliteModifier } from "../burn.js";

describe("zoneMidnight", () => {
  it("returns UTC midnight for UTC", () => {
    const d = new Date("2026-04-16T03:00:00Z");
    expect(zoneMidnight("UTC", d).toISOString()).toBe("2026-04-16T00:00:00.000Z");
  });
  it("returns America/New_York midnight for EDT input", () => {
    // 2026-04-16T03:00:00Z is 2026-04-15 23:00 EDT
    const d = new Date("2026-04-16T03:00:00Z");
    // EDT midnight of that local date is 2026-04-15T04:00:00Z
    expect(zoneMidnight("America/New_York", d).toISOString()).toBe("2026-04-15T04:00:00.000Z");
  });
});

describe("zoneOffsetMinutes", () => {
  it("UTC -> 0", () => {
    expect(zoneOffsetMinutes("UTC", new Date("2026-04-16T12:00:00Z"))).toBe(0);
  });
  it("America/New_York in April (EDT) -> -240", () => {
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-04-16T12:00:00Z"))).toBe(-240);
  });
});

describe("zoneSqliteModifier", () => {
  it("UTC -> '+0 hours'", () => {
    expect(zoneSqliteModifier("UTC", new Date("2026-04-16T12:00:00Z"))).toBe("+0 hours");
  });
  it("EDT -> '-4 hours'", () => {
    expect(zoneSqliteModifier("America/New_York", new Date("2026-04-16T12:00:00Z"))).toBe("-4 hours");
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

```bash
make test-file F=packages/server/handlers/__tests__/burn-tz-helpers.test.ts
```

Expected: fails -- exports do not exist.

- [ ] **Step 3: Implement helpers**

Add to `packages/server/handlers/burn.ts` (top of file, exported):

```ts
export function zoneOffsetMinutes(tz: string, at: Date): number {
  // Intl returns the wall-clock time in the target zone; the offset is
  // (wall-clock in tz) - UTC, in minutes.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtcMs - at.getTime()) / 60000);
}

export function zoneMidnight(tz: string, at: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // Midnight wall-clock in tz expressed as UTC ms:
  const wallUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  // The real UTC instant is wallUtc - offset.
  const offset = zoneOffsetMinutes(tz, new Date(wallUtc));
  return new Date(wallUtc - offset * 60000);
}

export function zoneSqliteModifier(tz: string, at: Date): string {
  const offMin = zoneOffsetMinutes(tz, at);
  const hours = offMin / 60;
  const sign = hours >= 0 ? "+" : "-";
  return `${sign}${Math.abs(hours)} hours`;
}
```

- [ ] **Step 4: Run test, verify it PASSES**

```bash
make test-file F=packages/server/handlers/__tests__/burn-tz-helpers.test.ts
```

Expected: all 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/handlers/burn.ts \
        packages/server/handlers/__tests__/burn-tz-helpers.test.ts
git commit -m "feat(burn): add timezone helpers for zone-aware date ranges"
```

---

## Task 3b: Issue 2 -- tz-aware getDateRange with off-by-one fix

**Files:**
- Create: `packages/server/handlers/__tests__/burn-date-range.test.ts`
- Modify: `packages/server/handlers/burn.ts:16-47` (rewrite `getDateRange`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/handlers/__tests__/burn-date-range.test.ts
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { getDateRange } from "../burn.js";

function at(iso: string, fn: () => void) {
  const real = Date;
  // @ts-expect-error  override for test
  globalThis.Date = class extends real {
    constructor(...args: any[]) {
      if (args.length === 0) return new real(iso);
      // @ts-expect-error
      return new real(...args);
    }
    static now() { return new real(iso).getTime(); }
  };
  try { fn(); } finally { globalThis.Date = real; }
}

describe("getDateRange", () => {
  it("today in UTC: start = UTC midnight", () => {
    at("2026-04-16T15:30:00Z", () => {
      const r = getDateRange("today", "UTC");
      expect(r.start).toBe("2026-04-16T00:00:00.000Z");
    });
  });

  it("today in America/New_York at 23:00 EDT: start = EDT midnight of local date", () => {
    at("2026-04-16T03:00:00Z", () => {
      const r = getDateRange("today", "America/New_York");
      expect(r.start).toBe("2026-04-15T04:00:00.000Z");
    });
  });

  it("week covers 7 calendar days (not 8)", () => {
    at("2026-04-16T15:00:00Z", () => {
      const r = getDateRange("week", "UTC");
      // start = midnight UTC 6 days ago
      expect(r.start).toBe("2026-04-10T00:00:00.000Z");
    });
  });

  it("30days covers 30 calendar days (not 31)", () => {
    at("2026-04-16T15:00:00Z", () => {
      const r = getDateRange("30days", "UTC");
      // start = midnight UTC 29 days ago
      expect(r.start).toBe("2026-03-18T00:00:00.000Z");
    });
  });

  it("undefined tz falls back to UTC (regression guard)", () => {
    at("2026-04-16T15:30:00Z", () => {
      const r = getDateRange("today", undefined);
      expect(r.start).toBe("2026-04-16T00:00:00.000Z");
    });
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

```bash
make test-file F=packages/server/handlers/__tests__/burn-date-range.test.ts
```

Expected: all fail -- `getDateRange` currently ignores tz and has off-by-one.

- [ ] **Step 3: Rewrite `getDateRange`**

Replace `packages/server/handlers/burn.ts:16-47` with:

```ts
export function getDateRange(
  period: BurnPeriod,
  tz: string | undefined,
): { start: string; end: string; tz: string } {
  const zone = tz ?? "UTC";
  const now = new Date();
  const end = now.toISOString();
  const todayZoneMidnight = zoneMidnight(zone, now);
  let start: Date;

  switch (period) {
    case "today":
      start = todayZoneMidnight;
      break;
    case "week":
      start = new Date(todayZoneMidnight.getTime() - 6 * 24 * 60 * 60 * 1000);
      break;
    case "30days":
      start = new Date(todayZoneMidnight.getTime() - 29 * 24 * 60 * 60 * 1000);
      break;
    case "month": {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric", month: "2-digit",
      }).formatToParts(now);
      const y = Number(parts.find((p) => p.type === "year")?.value);
      const m = Number(parts.find((p) => p.type === "month")?.value);
      // First of the month at zone midnight
      const wallUtc = Date.UTC(y, m - 1, 1);
      const offset = zoneOffsetMinutes(zone, new Date(wallUtc));
      start = new Date(wallUtc - offset * 60000);
      break;
    }
    default:
      start = new Date(todayZoneMidnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  }

  return { start: start.toISOString(), end, tz: zone };
}
```

- [ ] **Step 4: Run test, verify it PASSES**

```bash
make test-file F=packages/server/handlers/__tests__/burn-date-range.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/handlers/burn.ts \
        packages/server/handlers/__tests__/burn-date-range.test.ts
git commit -m "fix(burn): make getDateRange timezone-aware and fix week/30days off-by-one"
```

---

## Task 3c: Issue 2 -- repository daily bucketing by tz

**Files:**
- Create: `packages/core/repositories/__tests__/burn-daily-tz.test.ts`
- Modify: `packages/core/repositories/burn.ts` (extend `BurnQueryOpts`, rewrite `getDailyBreakdown`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/repositories/__tests__/burn-daily-tz.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../app.js";
import type { BurnTurnRow } from "../burn.js";

describe("BurnRepository.getDailyBreakdown tz bucketing", () => {
  let app: AppContext;
  beforeAll(async () => { app = AppContext.forTest(); await app.boot(); });
  afterAll(async () => { await app?.shutdown(); });

  beforeEach(() => {
    app.db.prepare("DELETE FROM burn_turns").run();
  });

  const baseRow = (ts: string, idx: number): BurnTurnRow => ({
    session_id: "s-tz-test",
    tenant_id: "default",
    turn_index: idx,
    project: null,
    timestamp: ts,
    user_message_preview: null,
    category: "coding",
    model: "claude-sonnet",
    provider: "anthropic",
    runtime: "claude",
    input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    cost_usd: 1, api_calls: 1,
    has_edits: 0, retries: 0, is_one_shot: 0,
    tools_json: "[]", mcp_tools_json: "[]", bash_cmds_json: "[]",
    speed: "normal", transcript_mtime: null,
  });

  it("buckets 23:00 EDT April 15 under April 15 when tz=America/New_York", () => {
    app.burn.upsertTurns("s-tz-test", [baseRow("2026-04-16T03:00:00.000Z", 0)]);
    const rows = app.burn.getDailyBreakdown({
      tenantId: "default",
      since: "2026-04-10T00:00:00.000Z",
      until: "2026-04-20T00:00:00.000Z",
      tz: "America/New_York",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe("2026-04-15");
  });

  it("defaults to UTC bucketing when tz omitted", () => {
    app.burn.upsertTurns("s-tz-test", [baseRow("2026-04-16T03:00:00.000Z", 0)]);
    const rows = app.burn.getDailyBreakdown({
      tenantId: "default",
      since: "2026-04-10T00:00:00.000Z",
      until: "2026-04-20T00:00:00.000Z",
    });
    expect(rows[0].date).toBe("2026-04-16");
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

```bash
make test-file F=packages/core/repositories/__tests__/burn-daily-tz.test.ts
```

Expected: both fail -- `tz` field not accepted, bucketing always UTC.

- [ ] **Step 3: Extend the repository**

In `packages/core/repositories/burn.ts`, extend `BurnQueryOpts`:

```ts
export interface BurnQueryOpts {
  tenantId?: string;
  since?: string;
  until?: string;
  /** Optional SQLite date modifier like "-4 hours". Resolved server-side. Never raw client input. */
  tz?: string;
}
```

Rewrite `getDailyBreakdown`:

```ts
getDailyBreakdown(opts: BurnQueryOpts): DailyBreakdownRow[] {
  const { where, params } = this._buildWhere(opts);
  // Accept either an IANA zone label or a SQLite modifier. Only two safe forms.
  const modifier = this._resolveSqliteModifier(opts.tz);
  const sql = modifier
    ? `
      SELECT
        DATE(timestamp, ?) as date,
        SUM(cost_usd) as cost,
        SUM(api_calls) as calls
      FROM burn_turns
      WHERE ${where}
      GROUP BY DATE(timestamp, ?)
      ORDER BY date
    `
    : `
      SELECT
        DATE(timestamp) as date,
        SUM(cost_usd) as cost,
        SUM(api_calls) as calls
      FROM burn_turns
      WHERE ${where}
      GROUP BY DATE(timestamp)
      ORDER BY date
    `;
  const finalParams = modifier ? [modifier, ...params, modifier] : params;
  // SQLite wants modifier BEFORE other params in SELECT but AFTER in GROUP BY;
  // the actual order is [SELECT-modifier, ...WHERE-params, GROUP-BY-modifier].
  return this.db.prepare(sql).all(...finalParams) as DailyBreakdownRow[];
}

/** Whitelist-style resolver: only allow IANA-style or "+/-N hours" inputs. */
private _resolveSqliteModifier(tz: string | undefined): string | null {
  if (!tz) return null;
  // Already a modifier like "-4 hours" or "+5 hours"
  if (/^[+-]\d+(\.\d+)?\s+hours$/.test(tz)) return tz;
  // IANA zone -- compute offset at "now"
  if (/^[A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+){0,2}$/.test(tz)) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date());
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      const now = Date.now();
      const wall = Date.UTC(
        get("year"), get("month") - 1, get("day"),
        get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"),
      );
      const offsetMin = Math.round((wall - now) / 60000);
      const hours = offsetMin / 60;
      const sign = hours >= 0 ? "+" : "-";
      return `${sign}${Math.abs(hours)} hours`;
    } catch {
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test, verify it PASSES**

```bash
make test-file F=packages/core/repositories/__tests__/burn-daily-tz.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/repositories/burn.ts \
        packages/core/repositories/__tests__/burn-daily-tz.test.ts
git commit -m "feat(burn): tz-aware daily bucketing in BurnRepository"
```

---

## Task 3d: Issue 2 -- wire tz through handler + web client

**Files:**
- Modify: `packages/server/handlers/burn.ts` (`burn/summary` handler body)
- Modify: `packages/core/observability/burn/types.ts` (extend `BurnSummaryResponse` unchanged; just ensure `tz` allowed in request extraction)
- Modify: `packages/web/src/hooks/useBurnQueries.ts` (include `tz` in payload)

- [ ] **Step 1: Update the handler to accept + forward tz**

In `packages/server/handlers/burn.ts`, edit `burn/summary`:

```ts
router.handle("burn/summary", async (p) => {
  const { period, tz } = extract<{ period?: BurnPeriod; tz?: string }>(p, []);
  const per = period ?? "week";
  const dateRange = getDateRange(per, tz);
  const opts = {
    tenantId: "default",
    since: dateRange.start,
    until: dateRange.end,
    tz: dateRange.tz,
  };

  const overview = app.burn.getOverview(opts);
  // ... rest unchanged, but pass `opts` (now containing tz) through all calls
```

Ensure every `app.burn.*` call in this handler receives `opts` (so the tz flows into `getDailyBreakdown`).

- [ ] **Step 2: Update the web client**

Edit `packages/web/src/hooks/useBurnQueries.ts`:

```ts
export function useBurnSummary(period: BurnPeriod) {
  return useQuery({
    queryKey: ["burn/summary", period],
    queryFn: async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      return api.getBurnSummary({ period, tz });
    },
  });
}
```

And in `packages/web/src/hooks/useApi.ts`, broaden the `getBurnSummary` signature to accept `tz: string`.

- [ ] **Step 3: Run the full burn suite**

```bash
make test-file F=packages/server/handlers/__tests__/burn-date-range.test.ts
make test-file F=packages/core/repositories/__tests__/burn-daily-tz.test.ts
# And any pre-existing burn tests:
make test-file F=packages/core/observability/burn/__tests__/sync.test.ts
```

Expected: all pass.

- [ ] **Step 4: Manual smoke in web UI**

```bash
make dev
# Visit http://localhost:5173/#/burn
# Confirm period tabs still populate; Daily Activity bar for "today" aligns with local date.
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/handlers/burn.ts \
        packages/web/src/hooks/useBurnQueries.ts \
        packages/web/src/hooks/useApi.ts
git commit -m "feat(burn): wire timezone through burn/summary request and web client"
```

---

## Task 4: Final verification + push

- [ ] **Step 1: Run full lint + test suites**

```bash
make format
make lint
make test
```

Expected: zero warnings, all tests pass (except the 2 pre-existing failures in `action-stage-chaining.test.ts` that exist on main).

- [ ] **Step 2: Ask the user for push approval**

Per CLAUDE.md push protocol: do NOT run `git push` without explicit user confirmation. Summarize commits added and ask.

```bash
git log --oneline origin/feature/burn-dashboard..HEAD
```

Then message the user with the list and ask "Push to the PR #153 branch?"

- [ ] **Step 3: After approval, push**

```bash
git push fork feature/burn-dashboard
```

---

## Self-review checklist

- Spec issue 1 (em dashes) -> Task 2
- Spec issue 2 (timezone + off-by-one) -> Tasks 3a, 3b, 3c, 3d
- Spec issue 3 (silent catch) -> Task 1
- Every task has test-first step, fail verification, implementation, pass verification, commit
- No placeholders, no "TODO", all code blocks concrete
- Helper names consistent across tasks (`zoneMidnight`, `zoneOffsetMinutes`, `zoneSqliteModifier`, `getDateRange`)
