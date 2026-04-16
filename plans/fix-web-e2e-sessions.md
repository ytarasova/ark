# Plan: Fix web e2e test failures in sessions.spec.ts

## Summary

The `web-e2e` CI check fails because `packages/e2e/web/sessions.spec.ts` tests 6-9 depend on sessions created by tests 4-5, but when a Playwright worker gets SIGKILL'd (transient resource pressure -- acknowledged in `playwright.config.ts:7-10`), retries spawn a fresh worker whose `beforeAll` creates a new server with an empty DB, losing all sessions. Additionally, search/filter tests have race conditions: they interact with the search input before the session list has loaded from the API.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/e2e/web/sessions.spec.ts` | Pre-create sessions in `beforeAll`, add load-waits before search/filter assertions, decouple UI form test from data-dependent tests |

## Implementation steps

### Step 1: Pre-create sessions in `beforeAll` (line 16-22)

Add session creation via RPC after the server/browser/page setup. This ensures sessions exist even when retries create a fresh worker with a new DB.

```ts
// After line 21: await page.waitForSelector("nav", { timeout: 15_000 });
// Add:
await ws.rpc("session/start", { summary: "E2E test session alpha", repo: ws.env.workdir, flow: "bare" });
await ws.rpc("session/start", { summary: "E2E test session beta", repo: ws.env.workdir, flow: "bare" });
```

### Step 2: Decouple the "create session via form" test (line 57-78)

Change the summary in the form test from `"E2E test session alpha"` to `"E2E form test session"` (line 67). Update the visibility assertion at line 77 to match. This test now purely validates the form UI without being a data prerequisite for later tests.

### Step 3: Remove the "create second session for filtering" test (line 80-92)

Delete the entire test block. Its purpose was to create beta via RPC and verify it appears -- now handled by `beforeAll`. The `page.reload()` + `goToSessions()` + visibility check it performed are no longer needed as a data prerequisite.

### Step 4: Fix race condition in "search filters sessions by summary text" (line 96-109)

After `goToSessions()` (line 97), wait for the session list to populate before typing into the search input:

```ts
await goToSessions();
// Wait for sessions to load from API before searching
await expect(page.locator("text=E2E test session alpha")).toBeVisible({ timeout: 10_000 });
const searchInput = page.locator('input[placeholder*="Search"]');
await searchInput.fill("alpha");
```

Without this wait, the client-side filter in `SessionList.tsx:21-30` runs against an empty `sessions` array (the `session/list` RPC is still in flight), producing zero results.

### Step 5: Fix race condition in "filter chips show only matching status sessions" (line 113-126)

Same pattern -- wait for the session list to load before clicking filter chips:

```ts
await goToSessions();
// Wait for sessions to load
await expect(page.locator("text=E2E test session alpha")).toBeVisible({ timeout: 10_000 });
// Click "Running" filter
await page.click('button:has-text("Running")');
```

### Step 6: Fix race condition in "delete and undelete session" (line 130-154)

After `goToSessions()`, add a visibility wait before clicking the session:

```ts
await goToSessions();
// Wait for sessions to load
await expect(page.locator("text=E2E test session alpha")).toBeVisible({ timeout: 10_000 });
await page.locator("text=E2E test session alpha").click();
```

This prevents the 60s timeout when the page/browser is in a bad state from cascading failures.

### Step 7: Fix "clone session via fork button" (line 158-179)

Same race condition fix:

```ts
await goToSessions();
await expect(page.locator("text=E2E test session alpha").first()).toBeVisible({ timeout: 10_000 });
await page.locator("text=E2E test session alpha").first().click();
```

## Testing strategy

1. **Run locally**: `cd packages/e2e && bunx --bun playwright test web/sessions.spec.ts` -- all tests should pass
2. **Verify retry resilience**: Run with `--retries 2` and confirm that even if a transient SIGKILL occurs, retried tests pass (sessions exist from `beforeAll`)
3. **Push to PR branch**: The `web-e2e` CI job should go green
4. **Verify no regressions**: All other e2e spec files (`agents-flows`, `compute`, `costs`, `dashboard`, `memory`, etc.) should remain green -- they're independent files with their own `setupWebServer()`

## Risk assessment

- **Low risk**: Changes are confined to the test file. No production code is modified.
- **Duplicate sessions on clean run**: On a clean run (no SIGKILL), `beforeAll` creates alpha/beta, then the form test creates "E2E form test session". Search for "alpha" still matches exactly one session. No conflict.
- **Session status**: Sessions created with `flow: "bare"` stay in `pending`/`ready` status. The "Running" filter test correctly expects zero running sessions. If `bare` sessions ever auto-transition to `deleting` or `archived`, they'd be excluded from `session/list` (the SQL filters `WHERE status != 'deleting' AND status != 'archived'`). This is unlikely given the bare flow design.
- **Memory test flake**: `memory.spec.ts:41` also had a transient SIGKILL (0ms, self-healed on retry). This is the same resource-pressure issue but doesn't need a code fix -- it's handled by the existing `retries: 2` in `playwright.config.ts`.

## Open questions

None -- the fix is mechanical. The root cause (SIGKILL from resource pressure) is a known CI characteristic already documented in `playwright.config.ts:7-10`. The fix makes the test suite resilient to it rather than trying to eliminate the transient.
