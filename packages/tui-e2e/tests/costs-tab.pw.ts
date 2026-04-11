/**
 * Ark TUI Costs tab -- substantive end-to-end tests.
 *
 * These tests exercise the real cost pipeline on the TUI side:
 *   sessions + usage_records tables (seeded via sqlite3 CLI)
 *     -> UsageRecorder.getSessionCost()
 *     -> getAllSessionCosts()
 *     -> costs/read RPC handler (the TUI goes through ArkClient, not HTTP)
 *     -> useArkClient().costsRead() in CostsTab.tsx
 *     -> rendered SplitPane title + left-pane session list + right-pane
 *        model bars / sparkline / totals
 *
 * Seed-before-boot pattern is mandatory here: the harness spawns
 * `ark tui` as a subprocess which opens a WAL connection to ark.db. We
 * write rows via the sqlite3 CLI BEFORE that subprocess is spawned so
 * the TUI's first `costs/read` call sees our seeded data. (Post-boot
 * writes would eventually appear because CostsTab polls every 10s, but
 * seed-before-boot keeps the test wall time bounded.)
 *
 * Matching strategy: we assert on the xterm buffer via readTerminal().
 * The TUI uses formatCost() which renders "$X.XX" (same format as the
 * web's fmtCost), so exact substring matches like "$4.50" work.
 */

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startHarness,
  waitForText,
  readTerminal,
  pressKey,
  mkTempArkDir,
} from "../harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Seed helpers ────────────────────────────────────────────────────────────

interface SeedRow {
  sessionId: string;
  summary: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costMode?: "api" | "subscription" | "free";
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function runSql(arkDir: string, sql: string): void {
  execFileSync("sqlite3", [`${arkDir}/ark.db`, sql], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

/**
 * Initialize schema on a fresh ARK_DIR by running a no-op ark command.
 * `ark session list` boots AppContext, runs initSchema(), and exits,
 * leaving an empty ark.db with all tables present. We then write seed
 * rows via sqlite3 before spawning the TUI subprocess.
 *
 * Without this bootstrap, sqlite3 INSERT would fail because the
 * `sessions` / `usage_records` tables don't exist yet.
 */
function findArkBinary(): string {
  const candidates = [
    resolve(__dirname, "..", "..", "..", "ark"),
    resolve(__dirname, "..", "..", "..", "ark-native"),
    "/usr/local/bin/ark",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Could not find ark binary. Checked: ${candidates.join(", ")}`);
}

function bootstrapSchema(arkDir: string): void {
  // Running any read-only ark command boots AppContext, calls
  // initSchema() on the empty arkDir/ark.db, and exits cleanly. After
  // it returns, the sessions/usage_records tables exist and we can
  // write rows with sqlite3 CLI before spawning the TUI subprocess.
  const bin = findArkBinary();
  execFileSync(bin, ["session", "list"], {
    env: { ...process.env, ARK_TEST_DIR: arkDir },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * Seed a matching (sessions, usage_records) pair. The `costs/read`
 * handler iterates `app.sessions.list()` so both tables need a row.
 * cost_usd is written directly (not computed via PricingRegistry) so
 * totals are deterministic.
 */
function seedUsageRecord(arkDir: string, row: SeedRow): void {
  const now = new Date().toISOString();
  const costMode = row.costMode ?? "api";
  const sessionSql =
    `INSERT INTO sessions (id, summary, repo, status, flow, tenant_id, config, created_at, updated_at) ` +
    `VALUES (${sqlQuote(row.sessionId)}, ${sqlQuote(row.summary)}, '/tmp/test-repo', 'completed', 'bare', 'default', '{}', ${sqlQuote(now)}, ${sqlQuote(now)})`;
  const usageSql =
    `INSERT INTO usage_records (session_id, tenant_id, user_id, model, provider, runtime, agent_role, ` +
    `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_mode, source, created_at) ` +
    `VALUES (${sqlQuote(row.sessionId)}, 'default', 'test', ${sqlQuote(row.model)}, ${sqlQuote(row.provider)}, ` +
    `'claude', 'worker', ${row.inputTokens}, ${row.outputTokens}, 0, 0, ${row.costUsd}, ${sqlQuote(costMode)}, 'test', ${sqlQuote(now)})`;
  runSql(arkDir, `${sessionSql}; ${usageSql};`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("Ark TUI Costs tab -- cost pipeline integration", () => {
  test("3 seeded usage records render the correct total in the Costs tab", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      bootstrapSchema(arkDir);
      // Seeded costs: 1.50 + 2.75 + 0.25 = $4.50
      seedUsageRecord(arkDir, {
        sessionId: "s-ca0001", summary: "tui-cost-alpha", model: "sonnet",
        provider: "anthropic", inputTokens: 1000, outputTokens: 500, costUsd: 1.5,
      });
      seedUsageRecord(arkDir, {
        sessionId: "s-ca0002", summary: "tui-cost-beta", model: "sonnet",
        provider: "anthropic", inputTokens: 2000, outputTokens: 900, costUsd: 2.75,
      });
      seedUsageRecord(arkDir, {
        sessionId: "s-ca0003", summary: "tui-cost-gamma", model: "sonnet",
        provider: "anthropic", inputTokens: 500, outputTokens: 200, costUsd: 0.25,
      });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        // Press 9 to swap to the Costs tab.
        await pressKey(page, "9");

        // CostsTab's left-pane SplitPane title renders
        //   "Costs - $4.50"
        // via `leftTitle={\`Costs - ${formatCost(total)}\`}`. Waiting
        // for the exact dollar total is a rock-solid signal that the
        // tab mounted AND the costs/read RPC returned our seeded rows.
        await waitForText(page, "$4.50", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        // The overview body renders "Total: $4.50  (3 sessions)"
        expect(text).toContain("$4.50");
        expect(text).toContain("3 sessions");
        // At least one seeded summary appears in the left-pane list.
        // Summaries are truncated/padded to 32 chars but short names
        // like "tui-cost-alpha" survive intact.
        expect(text).toContain("tui-cost-alpha");
        // No crash artifacts.
        expect(text).not.toMatch(/TypeError|ReferenceError|Uncaught/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("per-model breakdown renders both seeded models with their totals", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      bootstrapSchema(arkDir);
      // Two models: sonnet at $3.00 (1.25 + 1.75), opus at $2.00. Total $5.00.
      seedUsageRecord(arkDir, {
        sessionId: "s-cb0001", summary: "tui-sonnet-one", model: "sonnet",
        provider: "anthropic", inputTokens: 1000, outputTokens: 500, costUsd: 1.25,
      });
      seedUsageRecord(arkDir, {
        sessionId: "s-cb0002", summary: "tui-sonnet-two", model: "sonnet",
        provider: "anthropic", inputTokens: 1200, outputTokens: 600, costUsd: 1.75,
      });
      seedUsageRecord(arkDir, {
        sessionId: "s-cb0003", summary: "tui-opus-one", model: "opus",
        provider: "anthropic", inputTokens: 2000, outputTokens: 800, costUsd: 2.0,
      });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "9");
        // Wait for the total to render; the right pane's default view
        // shows "Total: $5.00  (3 sessions)" after the first poll.
        await waitForText(page, "$5.00", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        // The right-pane "By Model" / "Cost by Model" section renders
        // each model with its formatted cost. Both should be present.
        expect(text).toContain("sonnet");
        expect(text).toContain("opus");
        // Per-model totals rendered by formatCost():
        expect(text).toContain("$3.00");
        expect(text).toContain("$2.00");
        // Section header is either "Cost Overview" (no session
        // selected) or "Cost by Model" (selected-session detail view).
        // Both paths render per-model bars, so either label proves the
        // per-model aggregation pipeline is wired end to end.
        expect(text).toMatch(/Cost Overview|Cost by Model|By Model/);
        // And the per-model session counts line up with what we seeded:
        // sonnet has 2 sessions, opus has 1.
        expect(text).toContain("2 sessions");
        expect(text).toContain("1 sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("seeded session appears in the Costs tab session list", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      bootstrapSchema(arkDir);
      // Single session with a distinctive summary. We'll look for it
      // in the left-pane list and its cost in the right-pane detail.
      seedUsageRecord(arkDir, {
        sessionId: "s-cd0001", summary: "unique-tui-cost-session", model: "sonnet",
        provider: "anthropic", inputTokens: 3000, outputTokens: 1500, costUsd: 1.23,
      });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "9");
        // Wait for a Costs-tab-exclusive marker FIRST: the leftTitle
        // renders "Costs - $1.23". The unique session summary is
        // visible in BOTH the Sessions tab (via seeded row) and the
        // Costs tab, so matching on it alone would false-positive
        // before the tab switch actually lands.
        await waitForText(page, "$1.23", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        // The session appears in the left-pane list with its cost.
        expect(text).toContain("unique-tui-cost-session");
        expect(text).toContain("$1.23");
        // Total also renders the session's cost since it's the only record.
        // The overview line is "Total: $1.23  (1 sessions)".
        expect(text).toContain("1 sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("cost_mode=subscription records render with $0.00 cost contribution", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      bootstrapSchema(arkDir);
      // One api-billed record ($2.00) + one subscription record ($0.00 but
      // 15K tokens). The total must be $2.00, and the subscription session
      // should still render in the list with cost $0.00.
      seedUsageRecord(arkDir, {
        sessionId: "s-cd0001", summary: "tui-api-billed", model: "sonnet",
        provider: "anthropic", inputTokens: 1000, outputTokens: 500, costUsd: 2.0,
        costMode: "api",
      });
      seedUsageRecord(arkDir, {
        sessionId: "s-cd0002", summary: "tui-subscription", model: "sonnet",
        provider: "anthropic", inputTokens: 10_000, outputTokens: 5_000, costUsd: 0,
        costMode: "subscription",
      });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "9");
        // Total should be exactly the api-mode record ($2.00), confirming
        // that subscription records contribute zero dollars.
        await waitForText(page, "$2.00", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        // Both session summaries should still appear -- subscription
        // rows are kept because their token count > 0 (filter in
        // getAllSessionCosts is cost>0 OR input_tokens>0).
        expect(text).toContain("tui-api-billed");
        expect(text).toContain("tui-subscription");
        // The subscription row renders its cost as "$0.00".
        expect(text).toContain("$0.00");
        // Total reflects only the api-mode dollars.
        expect(text).toContain("$2.00");
        // And we see "2 sessions" in the overview (both sessions make it
        // into the list even though one is zero-cost).
        expect(text).toContain("2 sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
