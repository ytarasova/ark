/**
 * Costs page integration tests -- real end-to-end cost pipeline coverage.
 *
 * These tests exercise the full cost-tracking stack:
 *   sessions + usage_records tables (seeded via sqlite3 CLI)
 *     -> UsageRecorder.getSessionCost()
 *     -> getAllSessionCosts()
 *     -> costs/read RPC handler
 *     -> useCostsQuery + CostsView (Recharts)
 *
 * Seeding strategy: each test resets the sessions + usage_records tables
 * via sqlite3 CLI, inserts a known set of rows, then reloads the page to
 * blow away react-query's in-memory cache. We then assert against BOTH
 * the RPC response (structural truth) and the DOM (rendering truth).
 *
 * Why direct SQL and not a CLI seeder? `ark session start` only creates
 * sessions, not usage records, and the subscription/free cost modes are
 * written by UsageRecorder at session-completion time -- the only path
 * to seed a usage row from a test is an INSERT.
 *
 * Why reload the page instead of invalidating the query cache? The web
 * server runs in a subprocess; we don't have a handle on its QueryClient.
 * Reloading remounts the Costs page and forces a fresh `costs/read` call.
 *
 * The sessions rows we seed satisfy the `costs/read` handler's contract:
 * it calls `app.sessions.list()` (tenant = 'default') and maps each
 * session to its usage records. A usage record without a matching
 * sessions row would be invisible to the handler, even though the
 * record itself is in the DB.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ws = await setupWebServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(ws.baseUrl);
  await page.waitForSelector("nav", { timeout: 15_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  if (ws) await ws.teardown();
});

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

/** Escape a value for inline SQL (single-quote safe). */
function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Run a sqlite3 CLI command against the test DB. */
function runSql(arkDir: string, sql: string): void {
  execFileSync("sqlite3", [`${arkDir}/ark.db`, sql], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

/**
 * Reset the cost-related tables so each test starts from a known state.
 * Uses WAL-safe DELETE (not DROP) so the schema survives.
 */
function resetCosts(arkDir: string): void {
  runSql(arkDir, "DELETE FROM usage_records; DELETE FROM sessions;");
}

/**
 * Seed a session row + a matching usage_records row. Both are required
 * because the `costs/read` handler only walks sessions returned by
 * `app.sessions.list()`; an orphan usage_records row is invisible.
 *
 * We write `cost_usd` directly to bypass PricingRegistry so the expected
 * totals are deterministic regardless of model-catalog drift.
 */
function seedUsageRecord(arkDir: string, row: SeedRow): void {
  const now = new Date().toISOString();
  const costMode = row.costMode ?? "api";
  // The subscription/free cost modes should report zero cost, matching
  // what UsageRecorder.record() would have written. Tests passing
  // `costMode: "subscription"` must also pass `costUsd: 0` to stay
  // faithful to the production write path.
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

/**
 * Append an additional usage_records row to an existing session (no
 * new sessions row). Used to test multi-record-per-session aggregation.
 */
function appendUsageRecord(arkDir: string, row: SeedRow): void {
  const now = new Date().toISOString();
  const costMode = row.costMode ?? "api";
  const sql =
    `INSERT INTO usage_records (session_id, tenant_id, user_id, model, provider, runtime, agent_role, ` +
    `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_mode, source, created_at) ` +
    `VALUES (${sqlQuote(row.sessionId)}, 'default', 'test', ${sqlQuote(row.model)}, ${sqlQuote(row.provider)}, ` +
    `'claude', 'worker', ${row.inputTokens}, ${row.outputTokens}, 0, 0, ${row.costUsd}, ${sqlQuote(costMode)}, 'test', ${sqlQuote(now)})`;
  runSql(arkDir, sql);
}

async function goToCostsFresh(): Promise<void> {
  // Full page reload blows away useCostsQuery's in-memory cache so the
  // UI re-fetches our freshly-seeded rows instead of serving a stale
  // zero from the beforeAll navigation. We can't invalidate the query
  // cache directly (it lives in the subprocess).
  await page.goto(ws.baseUrl);
  await page.waitForSelector("nav", { timeout: 15_000 });
  await page.click('nav button:has-text("Costs")');
  await expect(page.locator("h1")).toContainText("Costs");
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("3 usage records aggregate to the correct total via RPC and DOM", async () => {
  const arkDir = ws.env.app.arkDir;
  resetCosts(arkDir);
  // Seeded costs: 1.50 + 2.75 + 0.25 = 4.50 total
  seedUsageRecord(arkDir, {
    sessionId: "s-aa0001",
    summary: "first task",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 1.5,
  });
  seedUsageRecord(arkDir, {
    sessionId: "s-aa0002",
    summary: "second task",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 2000,
    outputTokens: 900,
    costUsd: 2.75,
  });
  seedUsageRecord(arkDir, {
    sessionId: "s-aa0003",
    summary: "third task",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 500,
    outputTokens: 200,
    costUsd: 0.25,
  });

  // RPC assertion -- the canonical truth: sum of cost_usd across records.
  const data = await ws.rpc<{ costs: any[]; total: number }>("costs/read");
  expect(data.costs).toHaveLength(3);
  // Floating-point tolerance: cost totals are summed in JS so tiny drift
  // can creep in (1.50 + 2.75 + 0.25 = 4.5 exactly here, but keep the
  // tolerance pattern for the general case).
  expect(data.total).toBeCloseTo(4.5, 2);

  // DOM assertion -- the rendering pipeline (CostsView hero + session list).
  await goToCostsFresh();
  // Hero renders fmtCost(total) = "$4.50"
  await expect(page.locator("text=$4.50").first()).toBeVisible({ timeout: 10_000 });
  // The "(N sessions with usage data)" label reflects the seeded row count.
  await expect(page.locator("text=/3 sessions with usage data/i")).toBeVisible();
  // And at least one seeded session summary renders in the left-pane list.
  await expect(page.locator("body")).toContainText("first task");
  await expect(page.locator("body")).toContainText("second task");
  await expect(page.locator("body")).toContainText("third task");
});

test("per-model breakdown aggregates records grouped by model", async () => {
  const arkDir = ws.env.app.arkDir;
  resetCosts(arkDir);
  // Seeded: claude-sonnet-4-6 totals $3.00 (1.25 + 1.75), gpt-5 totals $2.00
  seedUsageRecord(arkDir, {
    sessionId: "s-bb0001",
    summary: "sonnet task A",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 1.25,
  });
  seedUsageRecord(arkDir, {
    sessionId: "s-bb0002",
    summary: "sonnet task B",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens: 1200,
    outputTokens: 600,
    costUsd: 1.75,
  });
  seedUsageRecord(arkDir, {
    sessionId: "s-bb0003",
    summary: "gpt task",
    model: "gpt-5",
    provider: "openai",
    inputTokens: 800,
    outputTokens: 400,
    costUsd: 2.0,
  });

  // RPC: verify grouping by model using the costs/summary endpoint.
  const summary = await ws.rpc<{ summary: any[]; total: number }>("costs/summary", { groupBy: "model" });
  expect(summary.total).toBeCloseTo(5.0, 2);
  const models = new Map(summary.summary.map((r: any) => [r.key, r.cost]));
  expect(models.get("claude-sonnet-4-6")).toBeCloseTo(3.0, 2);
  expect(models.get("gpt-5")).toBeCloseTo(2.0, 2);

  // costs/read mirrors the per-session rows that CostsView groups by model.
  const read = await ws.rpc<{ costs: any[]; total: number }>("costs/read");
  expect(read.total).toBeCloseTo(5.0, 2);
  const modelSet = new Set(read.costs.map((c: any) => c.model));
  expect(modelSet.has("claude-sonnet-4-6")).toBe(true);
  expect(modelSet.has("gpt-5")).toBe(true);

  // DOM: the per-model cards show both models with their totals.
  await goToCostsFresh();
  await expect(page.locator("text=$5.00").first()).toBeVisible({ timeout: 10_000 });
  const body = page.locator("body");
  await expect(body).toContainText("claude-sonnet-4-6");
  await expect(body).toContainText("gpt-5");
  // Per-model card values ($3.00 for sonnet, $2.00 for gpt). The values
  // also appear elsewhere but their presence proves the groupings were
  // computed and rendered.
  await expect(body).toContainText("$3.00");
  await expect(body).toContainText("$2.00");
});

test("cost_mode=subscription/free contribute zero dollars even with tokens", async () => {
  const arkDir = ws.env.app.arkDir;
  resetCosts(arkDir);
  // One billed record ($1.00) + one subscription record (cost_usd=0, tokens>0)
  // + one free record (cost_usd=0, tokens>0). Total must equal $1.00.
  seedUsageRecord(arkDir, {
    sessionId: "s-cc0001",
    summary: "api-billed task",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 500,
    outputTokens: 250,
    costUsd: 1.0,
    costMode: "api",
  });
  seedUsageRecord(arkDir, {
    sessionId: "s-cc0002",
    summary: "claude-max subscription",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 10_000,
    outputTokens: 5_000,
    costUsd: 0,
    costMode: "subscription",
  });
  seedUsageRecord(arkDir, {
    sessionId: "s-cc0003",
    summary: "free-tier task",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 2_000,
    outputTokens: 1_000,
    costUsd: 0,
    costMode: "free",
  });

  // RPC: total reflects just the $1.00 from the api-mode record.
  const read = await ws.rpc<{ costs: any[]; total: number }>("costs/read");
  expect(read.total).toBeCloseTo(1.0, 2);
  // getAllSessionCosts filters to rows with cost>0 OR input_tokens>0, so
  // all three seeded sessions should still appear in the list -- the
  // subscription/free ones just have cost=0.
  expect(read.costs.length).toBe(3);
  const byId = new Map(read.costs.map((c: any) => [c.sessionId, c]));
  expect(byId.get("s-cc0001")?.cost).toBeCloseTo(1.0, 2);
  expect(byId.get("s-cc0002")?.cost).toBe(0);
  expect(byId.get("s-cc0003")?.cost).toBe(0);
  // Token attribution survives even for zero-cost modes.
  expect(byId.get("s-cc0002")?.usage?.input_tokens).toBe(10_000);
  expect(byId.get("s-cc0003")?.usage?.output_tokens).toBe(1_000);

  // DOM: hero shows $1.00 total, and the subscription session renders $0.00.
  await goToCostsFresh();
  await expect(page.locator("text=$1.00").first()).toBeVisible({ timeout: 10_000 });
  const body = page.locator("body");
  await expect(body).toContainText("api-billed task");
  await expect(body).toContainText("claude-max subscription");
  // Session list row renders fmtCost(0) = "$0.00" for the subscription row.
  await expect(body).toContainText("$0.00");
});

test("per-session attribution: 2 sessions aggregate their own records", async () => {
  const arkDir = ws.env.app.arkDir;
  resetCosts(arkDir);
  // Session alpha: two records totaling $2.50
  seedUsageRecord(arkDir, {
    sessionId: "s-dd0001",
    summary: "alpha session",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 1.0,
  });
  appendUsageRecord(arkDir, {
    sessionId: "s-dd0001",
    summary: "alpha session",
    model: "sonnet",
    provider: "anthropic",
    inputTokens: 1500,
    outputTokens: 700,
    costUsd: 1.5,
  });
  // Session beta: one record totaling $3.75
  seedUsageRecord(arkDir, {
    sessionId: "s-dd0002",
    summary: "beta session",
    model: "opus",
    provider: "anthropic",
    inputTokens: 2000,
    outputTokens: 1000,
    costUsd: 3.75,
  });

  // RPC: sessions list has two entries; beta sorts first (higher cost).
  const read = await ws.rpc<{ costs: any[]; total: number }>("costs/read");
  expect(read.total).toBeCloseTo(6.25, 2);
  expect(read.costs).toHaveLength(2);
  // getAllSessionCosts sorts by cost desc: beta ($3.75) before alpha ($2.50).
  expect(read.costs[0].sessionId).toBe("s-dd0002");
  expect(read.costs[0].cost).toBeCloseTo(3.75, 2);
  expect(read.costs[1].sessionId).toBe("s-dd0001");
  expect(read.costs[1].cost).toBeCloseTo(2.5, 2);
  // Per-session token aggregation: alpha sums both records.
  expect(read.costs[1].usage.input_tokens).toBe(2500);
  expect(read.costs[1].usage.output_tokens).toBe(1200);

  // Per-session RPC endpoint returns the same per-session totals.
  const alphaSession = await ws.rpc<{ cost: number; records: any[] }>("costs/session", { sessionId: "s-dd0001" });
  expect(alphaSession.cost).toBeCloseTo(2.5, 2);
  expect(alphaSession.records).toHaveLength(2);
  const betaSession = await ws.rpc<{ cost: number; records: any[] }>("costs/session", { sessionId: "s-dd0002" });
  expect(betaSession.cost).toBeCloseTo(3.75, 2);
  expect(betaSession.records).toHaveLength(1);

  // DOM: hero shows $6.25, and both session summaries appear in the list.
  await goToCostsFresh();
  await expect(page.locator("text=$6.25").first()).toBeVisible({ timeout: 10_000 });
  const body = page.locator("body");
  await expect(body).toContainText("alpha session");
  await expect(body).toContainText("beta session");
  // Session-row cost pills: beta shows $3.75, alpha shows $2.50.
  await expect(body).toContainText("$3.75");
  await expect(body).toContainText("$2.50");
});
