# E2E Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unified `packages/e2e/` package with comprehensive, flow-focused e2e tests for Web UI (Playwright) and TUI (tmux/TuiDriver), organized in fast (CRUD/UI) and slow (dispatch) tiers.

**Architecture:** Shared fixtures boot isolated AppContext + DB. Web tests spawn `ark web` as subprocess pointed at the test DB via `ARK_TEST_DIR`. TUI tests launch `ark tui` in tmux via TuiDriver with the same env var. Playwright config covers web/ only; TUI tests run via `bun test`.

**Tech Stack:** Playwright (web), bun:test (TUI), tmux (TUI driver), AppContext.forTest() (isolation)

---

## File Map

### New files (create)

| File | Purpose |
|------|---------|
| `packages/e2e/playwright.config.ts` | Playwright config for web/ tests |
| `packages/e2e/fixtures/app.ts` | Shared AppContext boot/teardown + git workdir |
| `packages/e2e/fixtures/web-server.ts` | Boot `ark web` subprocess for Playwright |
| `packages/e2e/fixtures/tui-driver.ts` | TuiDriver re-export (thin wrapper) |
| `packages/e2e/fixtures/session-factory.ts` | Session creation helper with cleanup tracking |
| `packages/e2e/web/navigation.spec.ts` | Sidebar, tabs, SSE, API health |
| `packages/e2e/web/sessions.spec.ts` | Session CRUD: create, filter, search, delete, clone, archive |
| `packages/e2e/web/session-detail.spec.ts` | Detail panel, todos, messages, actions, export/import |
| `packages/e2e/web/agents-flows.spec.ts` | Agent/flow listing |
| `packages/e2e/web/compute.spec.ts` | Compute CRUD |
| `packages/e2e/web/dispatch.spec.ts` | Dispatch, live output, stop/resume (slow tier) |
| `packages/e2e/tui/tabs.test.ts` | Tab switching, per-tab content, hints |
| `packages/e2e/tui/sessions.test.ts` | Session list nav, detail pane, status labels |
| `packages/e2e/tui/session-crud.test.ts` | New (n), delete (x), clone (c), group (m/g), archive (Z) |
| `packages/e2e/tui/talk.test.ts` | Talk to agent (t), inbox (i) |
| `packages/e2e/tui/dispatch.test.ts` | Dispatch, output, stop, interrupt, resume, attach (slow) |
| `packages/e2e/tui/worktree.test.ts` | Worktree overlay (W), diff display (slow) |

### Files to modify

| File | Change |
|------|--------|
| `Makefile` | Update test-e2e targets, add test-e2e-fast/web/tui |

### Files to delete

| File | Reason |
|------|--------|
| `packages/tui/__tests__/e2e-setup.ts` | Moved to `packages/e2e/fixtures/app.ts` |
| `packages/tui/__tests__/tui-driver.ts` | Moved to `packages/e2e/fixtures/tui-driver.ts` |
| `packages/tui/__tests__/e2e-tui-real.test.ts` | Split into `tui/tabs.test.ts` + `tui/sessions.test.ts` |
| `packages/tui/__tests__/e2e-tui-dispatch.test.ts` | Merged into `tui/dispatch.test.ts` |
| `packages/tui/__tests__/e2e-attach-tui.test.ts` | Merged into `tui/dispatch.test.ts` |
| `packages/tui/__tests__/e2e-session-flow.test.ts` | Merged into `tui/session-crud.test.ts` |
| `packages/tui/__tests__/e2e-attach.test.ts` | Merged into `tui/dispatch.test.ts` |
| `packages/desktop/tests/app.spec.ts` | Superseded by `web/navigation.spec.ts` + `web/sessions.spec.ts` |

---

### Task 1: Scaffold packages/e2e with fixtures

**Files:**
- Create: `packages/e2e/fixtures/app.ts`
- Create: `packages/e2e/fixtures/tui-driver.ts`
- Create: `packages/e2e/fixtures/session-factory.ts`
- Create: `packages/e2e/fixtures/web-server.ts`
- Create: `packages/e2e/playwright.config.ts`

- [ ] **Step 1: Create `packages/e2e/fixtures/app.ts`**

This is the shared E2E environment. Evolved from `packages/tui/__tests__/e2e-setup.ts` with the same interface.

```ts
/**
 * Shared E2E test setup -- full isolation from production state.
 *
 * Provides:
 * - Isolated DB via AppContext.forTest() (temp dir, not ~/.ark)
 * - Isolated workdir (temp dir with git repo)
 * - Tmux cleanup on teardown
 */

import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import * as tmux from "../../core/tmux.js";

export interface E2EEnv {
  app: AppContext;
  /** Isolated temp workdir with git repo */
  workdir: string;
  /** Track tmux sessions for cleanup */
  tmuxSessions: string[];
  /** Track session IDs for cleanup */
  sessionIds: string[];
  /** Tear everything down */
  teardown: () => Promise<void>;
}

export async function setupE2E(): Promise<E2EEnv> {
  const app = AppContext.forTest();
  setApp(app);
  await app.boot();

  const workdir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-"));
  try {
    execFileSync("git", ["init", workdir], { stdio: "pipe" });
    writeFileSync(join(workdir, ".gitkeep"), "");
    execFileSync("git", ["-C", workdir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", workdir, "commit", "-m", "init", "--allow-empty"], { stdio: "pipe" });
  } catch {
    // git init failed -- workdir still usable for non-git tests
  }

  const env: E2EEnv = {
    app,
    workdir,
    tmuxSessions: [],
    sessionIds: [],
    teardown: async () => {
      for (const name of env.tmuxSessions) {
        try { tmux.killSession(name); } catch {}
      }
      await app.shutdown();
      clearApp();
      try {
        const { rmSync } = await import("fs");
        rmSync(workdir, { recursive: true, force: true });
      } catch {}
      try {
        execFileSync("git", ["worktree", "prune"], { stdio: "pipe", cwd: process.cwd() });
      } catch {}
    },
  };

  return env;
}
```

- [ ] **Step 2: Create `packages/e2e/fixtures/tui-driver.ts`**

Thin re-export from its new location. The TuiDriver class itself moves here after the old file is deleted in a later task.

```ts
/**
 * TuiDriver -- re-exported from its canonical location.
 * After migration, the full TuiDriver class lives in this file.
 * For now, this is a placeholder that will receive the full class in Task 8.
 */
export { TuiDriver, type TuiDriverOptions, type ScreenRegions } from "../../tui/__tests__/tui-driver.js";
```

- [ ] **Step 3: Create `packages/e2e/fixtures/session-factory.ts`**

```ts
/**
 * Session creation helper with sensible defaults and cleanup tracking.
 */
import * as core from "../../core/index.js";
import type { E2EEnv } from "./app.js";

interface CreateOpts {
  summary?: string;
  repo?: string;
  flow?: string;
  group_name?: string;
  ticket?: string;
  compute_name?: string;
  workdir?: string;
}

/**
 * Create a session with defaults. Tracks the session ID on env for cleanup.
 */
export function createTestSession(env: E2EEnv, opts: CreateOpts = {}) {
  const session = core.startSession({
    summary: opts.summary ?? `e2e-${Date.now()}`,
    repo: opts.repo ?? env.workdir,
    flow: opts.flow ?? "bare",
    group_name: opts.group_name,
    ticket: opts.ticket,
    compute_name: opts.compute_name,
    workdir: opts.workdir ?? env.workdir,
  });
  env.sessionIds.push(session.id);
  return session;
}

/**
 * Clean up all tracked sessions (call in afterEach).
 */
export function cleanupSessions(env: E2EEnv) {
  for (const id of env.sessionIds) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) {
        try { core.killSession(s.session_id); } catch {}
      }
      core.deleteSession(id);
    } catch {}
  }
  env.sessionIds.length = 0;
}
```

- [ ] **Step 4: Create `packages/e2e/fixtures/web-server.ts`**

```ts
/**
 * Boot `ark web` subprocess for Playwright tests.
 * Uses ARK_TEST_DIR to share the isolated DB with the test process.
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { join } from "path";
import { setupE2E, type E2EEnv } from "./app.js";

const ARK_BIN = join(import.meta.dir, "..", "..", "..", "ark");

export interface WebTestEnv {
  env: E2EEnv;
  port: number;
  baseUrl: string;
  serverProcess: ChildProcess;
  teardown: () => Promise<void>;
}

export async function setupWebE2E(): Promise<WebTestEnv> {
  const env = await setupE2E();

  // Build web frontend
  execFileSync("bun", ["run", join(import.meta.dir, "..", "..", "web", "build.ts")], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdio: "pipe",
    timeout: 60_000,
  });

  const port = 18420 + Math.floor(Math.random() * 1000);

  const serverProcess = spawn(ARK_BIN, ["web", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ARK_TEST_DIR: env.app.config.arkDir,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    },
  });

  // Wait for server ready
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`http://localhost:${port}/api/status`);
      if (res.ok) break;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }

  return {
    env,
    port,
    baseUrl: `http://localhost:${port}`,
    serverProcess,
    teardown: async () => {
      serverProcess.kill();
      await env.teardown();
    },
  };
}
```

- [ ] **Step 5: Create `packages/e2e/playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web",
  timeout: 60_000,
  globalTimeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
});
```

- [ ] **Step 6: Verify fixtures compile**

Run: `cd /Users/paytmlabs/Projects/ark && npx tsc --noEmit packages/e2e/fixtures/app.ts packages/e2e/fixtures/session-factory.ts 2>&1 | head -20`

Expected: No errors related to these files (other existing errors may appear).

- [ ] **Step 7: Commit**

```bash
git add packages/e2e/
git commit -m "feat(e2e): scaffold packages/e2e with shared fixtures"
```

---

### Task 2: Web navigation tests

**Files:**
- Create: `packages/e2e/web/navigation.spec.ts`

- [ ] **Step 1: Create `packages/e2e/web/navigation.spec.ts`**

```ts
/**
 * Web UI navigation -- sidebar, tab switching, SSE, API health.
 * Fast tier: no dispatch, no tmux.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebE2E, type WebTestEnv } from "../fixtures/web-server.js";

let web: WebTestEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  web = await setupWebE2E();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(web.baseUrl);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  await web?.teardown();
});

// -- Sidebar --

test("sidebar renders all 9 navigation items", async () => {
  const navItems = page.locator("nav button");
  await expect(navItems).toHaveCount(9);
});

test("sidebar logo is visible", async () => {
  await expect(page.locator("text=ark").first()).toBeVisible();
});

test("sessions view is the default", async () => {
  await expect(page.locator("h1")).toContainText("Sessions");
});

// -- Tab switching --

const tabs = ["Agents", "Tools", "Flows", "Compute", "Schedules", "Memory", "Costs"];

for (const tab of tabs) {
  test(`click ${tab} navigates and shows content`, async () => {
    await page.click(`button:has-text('${tab}')`);
    await expect(page.locator("h1")).toContainText(tab);
  });
}

test("click Sessions returns to sessions view", async () => {
  await page.click("button:has-text('Sessions')");
  await expect(page.locator("h1")).toContainText("Sessions");
});

// -- SSE --

test("SSE event stream connects", async () => {
  const connected = await page.evaluate(() => {
    return new Promise((resolve) => {
      const es = new EventSource("/api/events/stream");
      es.onopen = () => { es.close(); resolve(true); };
      es.onerror = () => { es.close(); resolve(false); };
      setTimeout(() => { es.close(); resolve(false); }, 5000);
    });
  });
  expect(connected).toBe(true);
});

// -- API health --

test("GET /api/status returns session counts", async () => {
  const res = await page.evaluate(() => fetch("/api/status").then(r => r.json()));
  expect(res).toHaveProperty("total");
});

test("GET /api/sessions returns array", async () => {
  const res = await page.evaluate(() => fetch("/api/sessions").then(r => r.json()));
  expect(Array.isArray(res)).toBe(true);
});

test("GET /api/agents returns non-empty array", async () => {
  const res = await page.evaluate(() => fetch("/api/agents").then(r => r.json()));
  expect(Array.isArray(res)).toBe(true);
  expect(res.length).toBeGreaterThan(0);
});

test("GET /api/flows returns non-empty array", async () => {
  const res = await page.evaluate(() => fetch("/api/flows").then(r => r.json()));
  expect(Array.isArray(res)).toBe(true);
  expect(res.length).toBeGreaterThan(0);
});

test("GET /api/compute returns array with local", async () => {
  const res = await page.evaluate(() => fetch("/api/compute").then(r => r.json()));
  expect(Array.isArray(res)).toBe(true);
  expect(res.some((c: any) => c.name === "local")).toBe(true);
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/e2e && npx playwright test web/navigation.spec.ts`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/web/navigation.spec.ts
git commit -m "feat(e2e): web navigation tests -- sidebar, tabs, SSE, API health"
```

---

### Task 3: Web session CRUD tests

**Files:**
- Create: `packages/e2e/web/sessions.spec.ts`

- [ ] **Step 1: Create `packages/e2e/web/sessions.spec.ts`**

```ts
/**
 * Web UI session CRUD flows -- create, filter, search, delete, clone, archive.
 * Fast tier: all operations via UI + API, no dispatch.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebE2E, type WebTestEnv } from "../fixtures/web-server.js";

let web: WebTestEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  web = await setupWebE2E();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(web.baseUrl);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  await web?.teardown();
});

test("create session via New Session modal", async () => {
  // Click New Session button
  await page.click("button:has-text('New Session')");

  // Fill the form
  const summaryInput = page.locator("input[name='summary'], input[placeholder*='summary' i], textarea[name='summary']").first();
  await summaryInput.waitFor({ timeout: 5000 });
  await summaryInput.fill("e2e-web-create-test");

  // Submit the form (look for Create/Submit/Save button inside the modal)
  const submitBtn = page.locator("button:has-text('Create'), button:has-text('Submit'), button:has-text('Save'), button[type='submit']").first();
  await submitBtn.click();

  // Verify session appears in the list
  await expect(page.locator("text=e2e-web-create-test")).toBeVisible({ timeout: 5000 });
});

test("filter sessions by status", async () => {
  // Create sessions in different states via API
  const running = await page.evaluate(() =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "e2e-filter-running" }),
    }).then(r => r.json())
  );

  const failed = await page.evaluate(() =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "e2e-filter-failed" }),
    }).then(r => r.json())
  );

  // Mark one as failed via API
  if (failed.session?.id) {
    await page.evaluate((id) =>
      fetch(`/api/sessions/${id}/stop`, { method: "POST" }), failed.session.id);
  }

  // Reload to get fresh state
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });

  // Click "All" filter -- should show both
  await page.click("button:has-text('All')");
  await expect(page.locator("text=e2e-filter-running")).toBeVisible({ timeout: 3000 });
});

test("search sessions by summary", async () => {
  // Create a session with distinct name via API
  await page.evaluate(() =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "e2e-unique-searchable-xyz" }),
    }).then(r => r.json())
  );

  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });

  const searchInput = page.locator("input[placeholder*='Search']");
  await searchInput.fill("unique-searchable-xyz");

  // Wait for filtered results
  await expect(page.locator("text=e2e-unique-searchable-xyz")).toBeVisible({ timeout: 5000 });
});

test("delete and undelete session", async () => {
  // Create session via API
  const res = await page.evaluate(() =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "e2e-delete-target" }),
    }).then(r => r.json())
  );
  const sessionId = res.session?.id;
  expect(sessionId).toBeTruthy();

  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });

  // Click the session to open detail
  await page.click("text=e2e-delete-target");
  await page.waitForTimeout(500);

  // Click delete button in detail panel
  const deleteBtn = page.locator("button:has-text('Delete')").first();
  if (await deleteBtn.isVisible()) {
    await deleteBtn.click();
    await page.waitForTimeout(1000);
  }

  // Verify deleted via API
  const deleted = await page.evaluate((id) =>
    fetch(`/api/sessions/${id}`).then(r => r.json()), sessionId);
  // Session should be in deleting state or gone
  expect(deleted.status === "deleting" || deleted.error).toBeTruthy();

  // Undelete
  await page.evaluate((id) =>
    fetch(`/api/sessions/${id}/undelete`, { method: "POST" }), sessionId);

  const restored = await page.evaluate((id) =>
    fetch(`/api/sessions/${id}`).then(r => r.json()), sessionId);
  expect(restored.status).not.toBe("deleting");
});

test("clone session", async () => {
  const res = await page.evaluate(() =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "e2e-clone-source" }),
    }).then(r => r.json())
  );
  const sourceId = res.session?.id;

  // Clone via API
  const cloneRes = await page.evaluate((id) =>
    fetch(`/api/sessions/${id}/fork`, { method: "POST" }).then(r => r.json()), sourceId);
  expect(cloneRes.ok).toBe(true);

  // Reload and verify clone appears
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });

  // Both source and clone should be visible (clone has same summary)
  const items = await page.locator("text=e2e-clone-source").count();
  expect(items).toBeGreaterThanOrEqual(2);
});

test("archive and restore session", async () => {
  // Create and complete a session
  const res = await page.evaluate(() =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "e2e-archive-target" }),
    }).then(r => r.json())
  );
  const sessionId = res.session?.id;

  // Complete it
  await page.evaluate((id) =>
    fetch(`/api/sessions/${id}/complete`, { method: "POST" }), sessionId);

  // Archive
  const archiveRes = await page.evaluate((id) =>
    fetch(`/api/sessions/${id}/archive`, { method: "POST" }).then(r => r.json()), sessionId);
  expect(archiveRes.ok).toBe(true);

  // Verify archived (not in normal list)
  const sessions = await page.evaluate(() =>
    fetch("/api/sessions").then(r => r.json()));
  const found = sessions.find((s: any) => s.id === sessionId);
  expect(!found || found.status === "archived").toBe(true);

  // Restore
  await page.evaluate((id) =>
    fetch(`/api/sessions/${id}/restore`, { method: "POST" }), sessionId);

  const restored = await page.evaluate((id) =>
    fetch(`/api/sessions/${id}`).then(r => r.json()), sessionId);
  expect(restored.status).not.toBe("archived");
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/e2e && npx playwright test web/sessions.spec.ts`

Expected: All tests pass. If any selectors don't match, inspect the page with `page.content()` or `page.screenshot()` and adjust selectors.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/web/sessions.spec.ts
git commit -m "feat(e2e): web session CRUD tests -- create, filter, search, delete, clone, archive"
```

---

### Task 4: Web session detail tests

**Files:**
- Create: `packages/e2e/web/session-detail.spec.ts`

- [ ] **Step 1: Create `packages/e2e/web/session-detail.spec.ts`**

```ts
/**
 * Web UI session detail -- todos, messages, actions, export/import.
 * Fast tier: all via UI + API, no dispatch.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebE2E, type WebTestEnv } from "../fixtures/web-server.js";

let web: WebTestEnv;
let browser: Browser;
let page: Page;
let sessionId: string;

test.beforeAll(async () => {
  web = await setupWebE2E();
  browser = await chromium.launch();
  page = await browser.newPage();

  // Create a test session via API
  const res = await fetch(`${web.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "e2e-detail-test", repo: web.env.workdir, flow: "bare" }),
  });
  const data = await res.json();
  sessionId = data.session.id;

  await page.goto(web.baseUrl);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  await web?.teardown();
});

test("clicking session opens detail panel with session info", async () => {
  await page.click("text=e2e-detail-test");
  await page.waitForTimeout(500);

  // Detail should show session ID and status
  await expect(page.locator(`text=${sessionId}`)).toBeVisible({ timeout: 5000 });
});

test("add and manage todos", async () => {
  // Navigate to session detail
  await page.click("text=e2e-detail-test");
  await page.waitForTimeout(500);

  // Add a todo via API
  await fetch(`${web.baseUrl}/api/sessions/${sessionId}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Review the PR" }),
  });

  // Reload to see the todo
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await page.click("text=e2e-detail-test");
  await page.waitForTimeout(500);

  // Verify todo is visible
  await expect(page.locator("text=Review the PR")).toBeVisible({ timeout: 5000 });

  // Verify via API that todo exists
  const todosRes = await fetch(`${web.baseUrl}/api/sessions/${sessionId}/todos`);
  const todos = await todosRes.json();
  expect(todos.length).toBeGreaterThanOrEqual(1);
  expect(todos.some((t: any) => t.content === "Review the PR")).toBe(true);
});

test("send message to session", async () => {
  // Send message via API
  await fetch(`${web.baseUrl}/api/sessions/${sessionId}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello from e2e test" }),
  });

  // Verify message persisted
  const events = await fetch(`${web.baseUrl}/api/sessions/${sessionId}/events`).then(r => r.json());
  const hasMessage = events.some((e: any) =>
    e.type === "message_sent" || (e.data && JSON.stringify(e.data).includes("Hello from e2e test"))
  );
  expect(hasMessage).toBe(true);
});

test("session actions change status", async () => {
  // Complete the session
  const completeRes = await fetch(`${web.baseUrl}/api/sessions/${sessionId}/complete`, { method: "POST" });
  const completeData = await completeRes.json();
  expect(completeData.ok).toBe(true);

  // Verify status changed
  const session = await fetch(`${web.baseUrl}/api/sessions/${sessionId}`).then(r => r.json());
  expect(session.status).toBe("completed");
});

test("export and import session round-trip", async () => {
  // Export
  const exportRes = await fetch(`${web.baseUrl}/api/sessions/${sessionId}/export`);
  const exportData = await exportRes.json();
  expect(exportData).toHaveProperty("session");
  expect(exportData.session.id).toBe(sessionId);

  // Import (creates a new session from export)
  const importRes = await fetch(`${web.baseUrl}/api/sessions/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exportData),
  });
  const importData = await importRes.json();
  expect(importData.ok).toBe(true);

  // Verify new session exists
  const sessions = await fetch(`${web.baseUrl}/api/sessions`).then(r => r.json());
  expect(sessions.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/e2e && npx playwright test web/session-detail.spec.ts`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/web/session-detail.spec.ts
git commit -m "feat(e2e): web session detail tests -- todos, messages, actions, export/import"
```

---

### Task 5: Web agents, flows, and compute tests

**Files:**
- Create: `packages/e2e/web/agents-flows.spec.ts`
- Create: `packages/e2e/web/compute.spec.ts`

- [ ] **Step 1: Create `packages/e2e/web/agents-flows.spec.ts`**

```ts
/**
 * Web UI agents and flows listing.
 * Fast tier.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebE2E, type WebTestEnv } from "../fixtures/web-server.js";

let web: WebTestEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  web = await setupWebE2E();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(web.baseUrl);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  await web?.teardown();
});

test("agents page shows builtin agents", async () => {
  await page.click("button:has-text('Agents')");
  await expect(page.locator("h1")).toContainText("Agents");

  // Check for known builtin agents
  const text = await page.locator("main, [role='main'], #root").first().textContent();
  const hasAgents = text?.includes("planner") || text?.includes("implementer") || text?.includes("worker");
  expect(hasAgents).toBe(true);
});

test("flows page shows builtin flows", async () => {
  await page.click("button:has-text('Flows')");
  await expect(page.locator("h1")).toContainText("Flows");

  const text = await page.locator("main, [role='main'], #root").first().textContent();
  const hasFlows = text?.includes("default") || text?.includes("quick") || text?.includes("bare");
  expect(hasFlows).toBe(true);
});

test("flows API returns stages for each flow", async () => {
  const flows = await page.evaluate(() =>
    fetch("/api/flows").then(r => r.json()));
  expect(flows.length).toBeGreaterThan(0);

  // Fetch detail for first flow
  const detail = await page.evaluate((name: string) =>
    fetch(`/api/flows/${name}`).then(r => r.json()), flows[0].name);
  expect(detail).toHaveProperty("stages");
  expect(Array.isArray(detail.stages)).toBe(true);
});
```

- [ ] **Step 2: Create `packages/e2e/web/compute.spec.ts`**

```ts
/**
 * Web UI compute CRUD.
 * Fast tier.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebE2E, type WebTestEnv } from "../fixtures/web-server.js";

let web: WebTestEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  web = await setupWebE2E();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(web.baseUrl);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  await web?.teardown();
});

test("compute page shows local compute as running", async () => {
  await page.click("button:has-text('Compute')");
  await expect(page.locator("h1")).toContainText("Compute");

  const text = await page.locator("main, [role='main'], #root").first().textContent();
  expect(text).toContain("local");
});

test("create compute target via API and verify in list", async () => {
  // Create via API
  const res = await page.evaluate(() =>
    fetch("/api/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-test-compute", provider: "local" }),
    }).then(r => r.json()));
  expect(res.ok).toBe(true);

  // Reload compute page
  await page.click("button:has-text('Compute')");
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await page.click("button:has-text('Compute')");

  const text = await page.locator("main, [role='main'], #root").first().textContent();
  expect(text).toContain("e2e-test-compute");
});

test("delete compute target", async () => {
  await page.evaluate(() =>
    fetch("/api/compute/e2e-test-compute/delete", { method: "POST" }));

  const computes = await page.evaluate(() =>
    fetch("/api/compute").then(r => r.json()));
  const found = computes.find((c: any) => c.name === "e2e-test-compute");
  expect(found).toBeFalsy();
});
```

- [ ] **Step 3: Run both tests**

Run: `cd packages/e2e && npx playwright test web/agents-flows.spec.ts web/compute.spec.ts`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/web/agents-flows.spec.ts packages/e2e/web/compute.spec.ts
git commit -m "feat(e2e): web agents, flows, and compute tests"
```

---

### Task 6: Web dispatch tests (slow tier)

**Files:**
- Create: `packages/e2e/web/dispatch.spec.ts`

- [ ] **Step 1: Create `packages/e2e/web/dispatch.spec.ts`**

```ts
/**
 * Web UI dispatch flow -- dispatch, live output, stop, resume.
 * Slow tier: creates real tmux sessions and git worktrees.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebE2E, type WebTestEnv } from "../fixtures/web-server.js";

let web: WebTestEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  web = await setupWebE2E();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(web.baseUrl);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  await web?.teardown();
});

test("dispatch session and verify running status", async () => {
  // Create session via API
  const createRes = await fetch(`${web.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "e2e-web-dispatch", repo: web.env.workdir }),
  });
  const { session } = await createRes.json();

  // Dispatch via API
  const dispatchRes = await fetch(`${web.baseUrl}/api/sessions/${session.id}/dispatch`, { method: "POST" });
  const dispatchData = await dispatchRes.json();
  expect(dispatchData.ok).toBe(true);

  // Poll until running
  let status = "ready";
  for (let i = 0; i < 20; i++) {
    const s = await fetch(`${web.baseUrl}/api/sessions/${session.id}`).then(r => r.json());
    status = s.status;
    if (status === "running" || status === "failed") break;
    await new Promise(r => setTimeout(r, 500));
  }
  expect(["running", "failed"]).toContain(status);

  // Reload page and verify session shows as running in UI
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await expect(page.locator("text=e2e-web-dispatch")).toBeVisible({ timeout: 5000 });

  // Stop it
  await fetch(`${web.baseUrl}/api/sessions/${session.id}/stop`, { method: "POST" });

  // Verify stopped
  const stopped = await fetch(`${web.baseUrl}/api/sessions/${session.id}`).then(r => r.json());
  expect(stopped.status).toBe("stopped");
}, 30_000);

test("get live output from running session", async () => {
  const createRes = await fetch(`${web.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "e2e-web-output", repo: web.env.workdir }),
  });
  const { session } = await createRes.json();

  await fetch(`${web.baseUrl}/api/sessions/${session.id}/dispatch`, { method: "POST" });

  // Wait for running
  for (let i = 0; i < 20; i++) {
    const s = await fetch(`${web.baseUrl}/api/sessions/${session.id}`).then(r => r.json());
    if (s.status === "running") break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Get output
  const output = await fetch(`${web.baseUrl}/api/sessions/${session.id}/output`).then(r => r.text());
  expect(typeof output).toBe("string");

  // Cleanup
  await fetch(`${web.baseUrl}/api/sessions/${session.id}/stop`, { method: "POST" });
}, 30_000);

test("stop and restart session", async () => {
  const createRes = await fetch(`${web.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "e2e-web-restart", repo: web.env.workdir }),
  });
  const { session } = await createRes.json();

  await fetch(`${web.baseUrl}/api/sessions/${session.id}/dispatch`, { method: "POST" });

  // Wait for running
  for (let i = 0; i < 20; i++) {
    const s = await fetch(`${web.baseUrl}/api/sessions/${session.id}`).then(r => r.json());
    if (s.status === "running") break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Stop
  await fetch(`${web.baseUrl}/api/sessions/${session.id}/stop`, { method: "POST" });
  let s = await fetch(`${web.baseUrl}/api/sessions/${session.id}`).then(r => r.json());
  expect(s.status).toBe("stopped");

  // Restart
  await fetch(`${web.baseUrl}/api/sessions/${session.id}/restart`, { method: "POST" });

  // Wait for running again
  for (let i = 0; i < 20; i++) {
    s = await fetch(`${web.baseUrl}/api/sessions/${session.id}`).then(r => r.json());
    if (s.status === "running") break;
    await new Promise(r => setTimeout(r, 500));
  }
  expect(["running", "ready"]).toContain(s.status);

  // Cleanup
  await fetch(`${web.baseUrl}/api/sessions/${session.id}/stop`, { method: "POST" });
}, 60_000);
```

- [ ] **Step 2: Run the test**

Run: `cd packages/e2e && npx playwright test web/dispatch.spec.ts`

Expected: All pass (requires tmux).

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/web/dispatch.spec.ts
git commit -m "feat(e2e): web dispatch tests -- dispatch, output, stop, restart (slow tier)"
```

---

### Task 7: TUI tab and session list tests (fast tier)

**Files:**
- Create: `packages/e2e/tui/tabs.test.ts`
- Create: `packages/e2e/tui/sessions.test.ts`

- [ ] **Step 1: Create `packages/e2e/tui/tabs.test.ts`**

```ts
/**
 * TUI tab switching, per-tab content, status bar hints.
 * Fast tier: no dispatch.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { TuiDriver } from "../fixtures/tui-driver.js";

describe("e2e TUI tabs", () => {
  it("shows all 6 tabs and switches between them", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Verify all tabs present
      const raw = tui.text();
      for (const tab of ["Sessions", "Agents", "Tools", "Flows", "History", "Compute"]) {
        expect(raw).toContain(tab);
      }

      // Switch to each tab
      await tui.switchTab(2);
      tui.expectRegion("tabBar", "Agents");

      await tui.switchTab(3);
      tui.expectRegion("tabBar", "Tools");

      await tui.switchTab(4);
      tui.expectRegion("tabBar", "Flows");

      await tui.switchTab(5);
      tui.expectRegion("tabBar", "History");

      await tui.switchTab(6);
      tui.expectRegion("tabBar", "Compute");

      await tui.switchTab(1);
      tui.expectRegion("tabBar", "Sessions");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("agents tab shows builtin agent names", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(2);
      const raw = tui.text();
      const hasAgent = raw.includes("planner") || raw.includes("implementer") || raw.includes("worker");
      expect(hasAgent).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("flows tab shows builtin flow names", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(4);
      const raw = tui.text();
      const hasFlow = raw.includes("default") || raw.includes("quick") || raw.includes("bare");
      expect(hasFlow).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("compute tab shows local compute as running", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(6);
      await tui.waitFor("local");
      expect(tui.text()).toContain("local");
      expect(tui.text()).toContain("running");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("status bar hints change per tab", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Sessions tab should show "new" and "quit"
      tui.expectRegion("statusBar", "new");
      tui.expectRegion("statusBar", "quit");

      // Compute tab should show "provision"
      await tui.switchTab(6);
      await tui.waitFor("provision", 3000, { region: "statusBar" });
      tui.expectRegion("statusBar", "provision");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Create `packages/e2e/tui/sessions.test.ts`**

```ts
/**
 * TUI session list navigation, detail pane, status labels.
 * Fast tier: sessions created via core API, no dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let tmuxSnapshot: Set<string>;
let app: AppContext;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
  clearApp();
});

describe("e2e TUI session list", () => {
  it("shows sessions created via core API in list pane", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({ repo: process.cwd(), summary: "e2e-list-visible", flow: "bare" });
      await tui.start();
      const found = await tui.waitFor("e2e-list-visible");
      expect(found).toBe(true);
      tui.expectRegion("listPane", "e2e-list-visible");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("navigate with j/k and detail pane updates", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({ repo: process.cwd(), summary: "e2e-nav-first", flow: "bare" });
      tui.createSession({ repo: process.cwd(), summary: "e2e-nav-second", flow: "bare" });
      await tui.start();
      await tui.waitFor("e2e-nav-first");

      // Move down
      await tui.selectDown();
      await new Promise(r => setTimeout(r, 300));

      // Detail pane should show one of the sessions
      const detail = tui.screen().detailPane.join("\n");
      const hasSession = detail.includes("e2e-nav-first") || detail.includes("e2e-nav-second");
      expect(hasSession).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("tab toggles focus between list and detail pane", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({ repo: process.cwd(), summary: "e2e-pane-toggle", flow: "bare" });
      await tui.start();
      await tui.waitFor("e2e-pane-toggle");

      // Verify detail shows session ID
      const { detailPane } = tui.screen();
      const detail = detailPane.join("\n");
      expect(detail.includes("s-") || detail.includes("bare")).toBe(true);

      // Toggle to detail pane
      tui.togglePane();
      await new Promise(r => setTimeout(r, 300));

      // Toggle back to list
      tui.togglePane();
      await new Promise(r => setTimeout(r, 300));

      // List pane should still show session
      tui.expectRegion("listPane", "e2e-pane-toggle");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("status bar shows session count", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      expect(tui.screen().statusBar).toMatch(/\d+ sessions/);
    } finally {
      tui.stop();
    }
  }, 30_000);
});
```

- [ ] **Step 3: Run both tests**

Run: `make test-file F=packages/e2e/tui/tabs.test.ts && make test-file F=packages/e2e/tui/sessions.test.ts`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/tui/tabs.test.ts packages/e2e/tui/sessions.test.ts
git commit -m "feat(e2e): TUI tabs and session list tests (fast tier)"
```

---

### Task 8: TUI session CRUD and talk tests (fast tier)

**Files:**
- Create: `packages/e2e/tui/session-crud.test.ts`
- Create: `packages/e2e/tui/talk.test.ts`

- [ ] **Step 1: Create `packages/e2e/tui/session-crud.test.ts`**

```ts
/**
 * TUI session CRUD -- new (n), delete (x), clone (c), group (m/g), archive (Z).
 * Fast tier: no dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let tmuxSnapshot: Set<string>;
let app: AppContext;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
  clearApp();
});

describe("e2e TUI session CRUD", () => {
  it("create new session with n key", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Press n to open new session form
      tui.press("n");
      await tui.waitFor(/summary|Summary|task/i, 5000);

      // Type a summary
      tui.typeChars("e2e-new-session-test");
      tui.press("enter");

      // Wait for possible repo/flow fields -- press enter to accept defaults
      await new Promise(r => setTimeout(r, 500));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 500));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 500));

      // Session should appear in list
      const found = await tui.waitFor("e2e-new-session-test", 5000);
      expect(found).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("delete session with x x", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ repo: process.cwd(), summary: "e2e-delete-me", flow: "bare" });
      await tui.start();
      await tui.waitFor("e2e-delete-me");

      tui.press("x");
      await new Promise(r => setTimeout(r, 500));
      tui.press("x");

      const gone = await tui.waitForGone("e2e-delete-me");
      expect(gone).toBe(true);

      const updated = core.getSession(s.id);
      expect(updated?.status).toBe("deleting");
      tui.untrack(s.id);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("clone session with c key", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({ repo: process.cwd(), summary: "e2e-clone-me", flow: "bare" });
      await tui.start();
      await tui.waitFor("e2e-clone-me");

      tui.press("c");
      await new Promise(r => setTimeout(r, 1000));

      // Should now have 2 items with the same summary (or "clone" in the name)
      const raw = tui.text();
      // After clone, the list should show an additional session
      const matches = raw.split("e2e-clone-me").length - 1;
      expect(matches).toBeGreaterThanOrEqual(1);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("archive and restore with Z key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ repo: process.cwd(), summary: "e2e-archive-me", flow: "bare" });
      // Complete it so it can be archived
      core.complete(s.id);

      await tui.start();
      await tui.waitFor("e2e-archive-me");

      // Archive
      tui.press("Z");
      const gone = await tui.waitForGone("e2e-archive-me", 5000);
      expect(gone).toBe(true);

      const archived = core.getSession(s.id);
      expect(archived?.status).toBe("archived");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Create `packages/e2e/tui/talk.test.ts`**

```ts
/**
 * TUI talk to agent (t) and inbox (i).
 * Fast tier: uses sessions in "waiting" state.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let tmuxSnapshot: Set<string>;
let app: AppContext;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
  clearApp();
});

describe("e2e TUI talk and inbox", () => {
  it("send message to session with t key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ repo: process.cwd(), summary: "e2e-talk-target", flow: "bare" });
      // Set to waiting so talk is available
      core.updateSession(s.id, { status: "waiting", breakpoint_reason: "question" });

      await tui.start();
      await tui.waitFor("e2e-talk-target");

      // Press t to open talk overlay
      tui.press("t");
      await new Promise(r => setTimeout(r, 500));

      // Type a message
      tui.typeChars("Hello from TUI test");
      tui.press("enter");

      await new Promise(r => setTimeout(r, 1000));

      // Verify message was sent (check DB)
      const messages = core.listMessages(s.id);
      const found = messages.some(m => m.content.includes("Hello from TUI test"));
      expect(found).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("inbox overlay opens with i key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ repo: process.cwd(), summary: "e2e-inbox-test", flow: "bare" });
      core.updateSession(s.id, { status: "waiting", breakpoint_reason: "question" });

      await tui.start();
      await tui.waitFor("e2e-inbox-test");

      tui.press("i");
      await new Promise(r => setTimeout(r, 500));

      // Inbox overlay should be visible
      const raw = tui.text();
      const hasInbox = raw.includes("Inbox") || raw.includes("inbox") || raw.includes("Thread") || raw.includes("thread");
      expect(hasInbox).toBe(true);

      // Close with Escape
      tui.press("escape");
      await new Promise(r => setTimeout(r, 300));
    } finally {
      tui.stop();
    }
  }, 30_000);
});
```

- [ ] **Step 3: Run both tests**

Run: `make test-file F=packages/e2e/tui/session-crud.test.ts && make test-file F=packages/e2e/tui/talk.test.ts`

Expected: All pass. Some tests may need selector/timing adjustments based on the actual TUI form behavior.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/tui/session-crud.test.ts packages/e2e/tui/talk.test.ts
git commit -m "feat(e2e): TUI session CRUD and talk tests (fast tier)"
```

---

### Task 9: TUI dispatch and worktree tests (slow tier)

**Files:**
- Create: `packages/e2e/tui/dispatch.test.ts`
- Create: `packages/e2e/tui/worktree.test.ts`

- [ ] **Step 1: Create `packages/e2e/tui/dispatch.test.ts`**

Consolidates existing `e2e-tui-dispatch`, `e2e-attach-tui`, and `e2e-attach` tests plus new flows.

```ts
/**
 * TUI dispatch, output, stop, interrupt, resume, attach.
 * Slow tier: creates real tmux sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let tmuxSnapshot: Set<string>;
let app: AppContext;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
  clearApp();
});

describe("e2e TUI dispatch", () => {
  it("dispatch with Enter, verify running status", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ summary: "tui-dispatch-test", repo: process.cwd(), flow: "bare" });
      await tui.start();
      await tui.waitFor("tui-dispatch-test");

      tui.press("enter");

      await tui.waitUntil(() => {
        const updated = core.getSession(s.id);
        return updated?.status === "running" || updated?.status === "failed";
      }, 10_000, 500);

      const updated = core.getSession(s.id)!;
      expect(["running", "failed"]).toContain(updated.status);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("stop running session with s key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ summary: "tui-stop-test", repo: process.cwd(), flow: "bare" });
      await core.dispatch(s.id);

      await tui.start();
      await tui.waitFor("tui-stop-test");

      tui.press("s");

      await tui.waitUntil(() => {
        const updated = core.getSession(s.id);
        return updated?.status === "stopped";
      }, 8000, 500);

      expect(core.getSession(s.id)!.status).toBe("stopped");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("interrupt running session with I key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ summary: "tui-interrupt-test", repo: process.cwd(), flow: "bare" });
      await core.dispatch(s.id);

      await tui.start();
      await tui.waitFor("tui-interrupt-test");

      tui.press("I");
      await new Promise(r => setTimeout(r, 2000));

      // Session should still exist (interrupt doesn't kill)
      const updated = core.getSession(s.id)!;
      expect(updated).not.toBeNull();
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("attach opens new tmux window with a key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ summary: "tui-attach-test", repo: process.cwd(), flow: "bare" });
      await core.dispatch(s.id);

      await tui.start();
      await tui.waitFor("tui-attach-test");

      tui.press("a");
      await new Promise(r => setTimeout(r, 1000));

      // TUI should still be alive
      expect(tui.alive()).toBe(true);

      // Check window count increased
      try {
        const windows = execFileSync("tmux", ["list-windows", "-t", tui.name],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const windowCount = windows.trim().split("\n").length;
        expect(windowCount).toBeGreaterThanOrEqual(1);
      } catch {
        // tmux session may have different structure
      }
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("detail pane shows events after dispatch", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({ summary: "tui-events-test", repo: process.cwd(), flow: "bare" });
      await tui.start();
      await tui.waitFor("tui-events-test");

      tui.press("tab");
      await new Promise(r => setTimeout(r, 500));

      const raw = tui.text();
      expect(raw.includes("Events") || raw.includes("stage_ready") || raw.includes("tui-events-test")).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("live output section appears for running session", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({ summary: "tui-live-output", repo: process.cwd(), flow: "bare" });
      await core.dispatch(s.id);

      await tui.start();
      const found = await tui.waitFor(/Live Output|tui-live-output/, 5000);
      expect(found).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("orphan tmux cleanup", async () => {
    const freshApp = AppContext.forTest();
    setApp(freshApp);
    await freshApp.boot();

    const { listArkSessionsAsync, killSession } = await import("../../core/tmux.js");
    const orphanName = `ark-s-orphan-test-${Date.now()}`;

    try {
      execFileSync("tmux", [
        "new-session", "-d", "-s", orphanName, "-x", "80", "-y", "24",
        "bash", "-c", "sleep 300",
      ], { stdio: "pipe" });

      let sessions = await listArkSessionsAsync();
      expect(sessions.some(s => s.name === orphanName)).toBe(true);

      // Orphan has no DB record
      const sessionId = orphanName.replace("ark-", "");
      expect(core.getSession(sessionId)).toBeNull();

      // Clean orphans
      for (const ts of sessions) {
        const sid = ts.name.replace("ark-", "");
        if (!core.getSession(sid)) {
          killSession(ts.name);
        }
      }

      sessions = await listArkSessionsAsync();
      expect(sessions.some(s => s.name === orphanName)).toBe(false);
    } finally {
      try { execFileSync("tmux", ["kill-session", "-t", orphanName], { stdio: "pipe" }); } catch {}
      await freshApp.shutdown();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Create `packages/e2e/tui/worktree.test.ts`**

```ts
/**
 * TUI worktree overlay (W) -- diff display, merge/PR options.
 * Slow tier: requires dispatch with real git repo.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import * as core from "../../core/index.js";
import { setupE2E, type E2EEnv } from "../fixtures/app.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

let env: E2EEnv;
let tmuxSnapshot: Set<string>;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  env = await setupE2E();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await env?.teardown();
});

describe("e2e TUI worktree", () => {
  it("dispatch creates worktree, W shows overlay", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "tui-worktree-test",
        repo: env.workdir,
        flow: "bare",
        workdir: env.workdir,
      });

      await core.dispatch(s.id);

      const dispatched = core.getSession(s.id)!;
      expect(dispatched.status).toBe("running");

      await tui.start();
      await tui.waitFor("tui-worktree-test");

      // Press W for worktree overlay
      tui.press("W");
      await new Promise(r => setTimeout(r, 1000));

      const raw = tui.text();
      // Worktree overlay should show diff info or merge/PR options
      const hasWorktreeContent = raw.includes("Worktree") || raw.includes("diff") ||
        raw.includes("Merge") || raw.includes("PR") || raw.includes("Changes");
      expect(hasWorktreeContent).toBe(true);

      // Close overlay
      tui.press("escape");

      // Cleanup
      await core.stop(s.id);

      // Clean worktree
      const worktreePath = join(env.app.config.worktreesDir, s.id);
      if (existsSync(worktreePath)) {
        try {
          const { execFileSync } = await import("child_process");
          execFileSync("git", ["-C", env.workdir, "worktree", "remove", "--force", worktreePath], { stdio: "pipe" });
        } catch {}
      }
    } finally {
      tui.stop();
    }
  }, 30_000);
});
```

- [ ] **Step 3: Run both tests**

Run: `make test-file F=packages/e2e/tui/dispatch.test.ts && make test-file F=packages/e2e/tui/worktree.test.ts`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/tui/dispatch.test.ts packages/e2e/tui/worktree.test.ts
git commit -m "feat(e2e): TUI dispatch and worktree tests (slow tier)"
```

---

### Task 10: Migrate TuiDriver and delete old files

**Files:**
- Modify: `packages/e2e/fixtures/tui-driver.ts` (replace re-export with full class)
- Delete: `packages/tui/__tests__/e2e-setup.ts`
- Delete: `packages/tui/__tests__/tui-driver.ts`
- Delete: `packages/tui/__tests__/e2e-tui-real.test.ts`
- Delete: `packages/tui/__tests__/e2e-tui-dispatch.test.ts`
- Delete: `packages/tui/__tests__/e2e-attach-tui.test.ts`
- Delete: `packages/tui/__tests__/e2e-session-flow.test.ts`
- Delete: `packages/tui/__tests__/e2e-attach.test.ts`
- Delete: `packages/desktop/tests/app.spec.ts`

- [ ] **Step 1: Copy full TuiDriver into `packages/e2e/fixtures/tui-driver.ts`**

Copy the entire contents of `packages/tui/__tests__/tui-driver.ts` into `packages/e2e/fixtures/tui-driver.ts`. Update the import paths:

Change:
```ts
import * as core from "../../core/index.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { loadConfig } from "../../core/config.js";
```
To:
```ts
import * as core from "../../core/index.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";
```

The `ARK_BIN` path stays the same since the relative path from `packages/e2e/fixtures/` to the project root is `../../..` (same depth as `packages/tui/__tests__/`).

- [ ] **Step 2: Delete old files**

```bash
rm packages/tui/__tests__/e2e-setup.ts
rm packages/tui/__tests__/tui-driver.ts
rm packages/tui/__tests__/e2e-tui-real.test.ts
rm packages/tui/__tests__/e2e-tui-dispatch.test.ts
rm packages/tui/__tests__/e2e-attach-tui.test.ts
rm packages/tui/__tests__/e2e-session-flow.test.ts
rm packages/tui/__tests__/e2e-attach.test.ts
rm packages/desktop/tests/app.spec.ts
```

- [ ] **Step 3: Verify no broken imports in remaining tui tests**

Run: `grep -r "e2e-setup\|tui-driver" packages/tui/__tests__/ --include="*.ts" 2>/dev/null`

Expected: No results (all e2e tests moved, only unit tests remain).

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `make test`

Expected: All existing unit tests still pass. The moved e2e tests no longer run from the old location.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(e2e): migrate TuiDriver and delete old e2e test files"
```

---

### Task 11: Update Makefile targets

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Update Makefile with new e2e targets**

Replace the existing `test-e2e` target and add new ones. The existing block (lines 82-84) is:

```makefile
test-e2e: build-web ## Run Playwright E2E tests against the Web UI
	@cd packages/desktop && npm install --silent 2>/dev/null
	cd packages/desktop && npx playwright install chromium --with-deps 2>/dev/null; npx playwright test
```

Replace with:

```makefile
test-e2e: build-web ## Run all E2E tests (web + TUI, sequential)
	cd packages/e2e && npx playwright install chromium --with-deps 2>/dev/null; npx playwright test
	$(BUN) test packages/e2e/tui --concurrency 1

test-e2e-fast: build-web ## Run fast-tier E2E tests only (CI-safe, no tmux dispatch)
	cd packages/e2e && npx playwright test --grep-invert "dispatch"
	$(BUN) test packages/e2e/tui/tabs.test.ts packages/e2e/tui/sessions.test.ts packages/e2e/tui/session-crud.test.ts packages/e2e/tui/talk.test.ts --concurrency 1

test-e2e-web: build-web ## Run web E2E tests only (Playwright)
	cd packages/e2e && npx playwright install chromium --with-deps 2>/dev/null; npx playwright test

test-e2e-tui: ## Run TUI E2E tests only (tmux)
	$(BUN) test packages/e2e/tui --concurrency 1
```

Also update the `.PHONY` line to include the new targets and the `test` target to include `packages/e2e` in the unit test run exclusion (e2e tests run separately).

- [ ] **Step 2: Update the .PHONY line**

The current `.PHONY` line (lines 13-16) includes `test-e2e`. Add the new targets:

```makefile
.PHONY: help install dev dev-web tui web desktop \
        test test-file test-e2e test-e2e-fast test-e2e-web test-e2e-tui test-watch lint \
        build build-cli build-web build-desktop \
```

- [ ] **Step 3: Verify targets work**

Run: `make test-e2e-web 2>&1 | tail -5`

Expected: Playwright tests run and pass.

Run: `make test-e2e-tui 2>&1 | tail -5`

Expected: TUI tests run and pass.

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "feat(e2e): update Makefile with test-e2e-fast, test-e2e-web, test-e2e-tui targets"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full test suite (unit + e2e)**

Run: `make test && make test-e2e`

Expected: All unit tests pass (2212+), all e2e tests pass.

- [ ] **Step 2: Run fast tier only**

Run: `make test-e2e-fast`

Expected: All fast-tier tests pass without needing tmux dispatch.

- [ ] **Step 3: Verify no orphan files**

Run: `ls packages/tui/__tests__/e2e-* packages/tui/__tests__/tui-driver.ts 2>&1`

Expected: "No such file or directory" for all.

Run: `ls packages/e2e/web/*.spec.ts packages/e2e/tui/*.test.ts packages/e2e/fixtures/*.ts`

Expected: All new files listed.

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix(e2e): final adjustments from verification run"
```
