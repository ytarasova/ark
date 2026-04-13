# PLAN: Audit async/await usage across the codebase

## Summary

Audit every async/await pattern in the Ark codebase to find spots where Promises are not properly awaited, categorize them as bugs vs. intentional fire-and-forget, and fix the bugs. The codebase uses `safeAsync()` and `.catch()` as intentional fire-and-forget patterns in several places (polling, notifications, plugin loading) which are acceptable -- the real issues are unawaited async calls that silently discard errors or cause race conditions.

## Findings

### BUG -- Must Fix (7 items)

| # | File | Line(s) | Pattern | Risk |
|---|------|---------|---------|------|
| 1 | `packages/core/services/session-hooks.ts` | 617 | `dispatch(app, sessionId).catch(...)` without await in `mediateStageHandoff` | Race: caller returns before dispatch finishes; `dispatched=true` is set but dispatch may fail asynchronously. The handoff return value is sent before we know if dispatch succeeded. |
| 2 | `packages/core/conductor/conductor.ts` | 174 | `session.dispatch(app, sessionId).catch(...)` without await in hook status handler | Response `{ status: "ok", mapped: "retry" }` returned before dispatch attempt completes. If dispatch fails, the conductor has already reported success. |
| 3 | `packages/core/conductor/conductor.ts` | 700 | `session.dispatch(app, sessionId).catch(...)` without await in report handler | Same as #2 -- early return before dispatch completes. |
| 4 | `packages/core/conductor/conductor.ts` | 685, 714 | `sendOSNotification(...)` (async) called without await | `sendOSNotification` returns `Promise<void>`. While it internally catches errors, the unawaited promise could produce unhandled-rejection warnings in strict runtimes. |
| 5 | `packages/core/conductor/conductor.ts` | 770 | `safeAsync("auto-pr: ...")` without await | Auto-PR creation is fire-and-forget. If it fails, no event is logged to the session. The function containing this is async and could easily await it. |
| 6 | `packages/core/executors/status-poller.ts` | 74 | `sendOSNotification(...)` without await inside async callback | Same as #4 -- unawaited async call. |
| 7 | `packages/core/__tests__/e2e-session-lifecycle.test.ts` | 328 | `complete(app, session.id)` without await in test | Test assertion on line 329 reads status synchronously after an unawaited async call. This is a real test bug -- the assertion may pass by accident (synchronous DB write inside complete) but is fragile. |

### INTENTIONAL -- Acceptable fire-and-forget (document with comments)

| # | File | Line(s) | Pattern | Why acceptable |
|---|------|---------|---------|----------------|
| A | `packages/core/app.ts` | 482 | `pricingRegistry.refreshFromRemote().catch(() => {})` | Non-blocking boot optimization. Local prices are fine. |
| B | `packages/core/app.ts` | 540-547 | `loadPluginExecutors(...).then(...).catch(...)` | Plugin loading is best-effort. Has `.catch()`. |
| C | `packages/core/app.ts` | 646 | `safeAsync("boot: cleanup logs", ...)` without await | Log cleanup is non-critical. Errors are caught by safeAsync. |
| D | `packages/core/conductor/conductor.ts` | 410, 443, 449, 457-459 | `setInterval(() => safeAsync(...))` | Polling timers -- fire-and-forget by nature. safeAsync catches errors. |
| E | `packages/core/integrations/github-pr.ts` | 196-208 | Nested `safeAsync().then(...)` | Channel delivery steering is fire-and-forget. Has error handling. |
| F | `packages/core/integrations/issue-poller.ts` | 149, 152 | `safeAsync(...)` without await in `startIssuePoller` | Interval-based polling. safeAsync catches errors. |
| G | `packages/core/conductor/conductor.ts` | 323-329 | `watchMergedPR(...).catch(...)` | Long-running rollback watcher. Fire-and-forget with `.catch()`. |
| H | `packages/core/mcp-pool.ts` | 277 | `proxy.restart().catch(...)` inside setInterval | Health monitor restart. Has `.catch()`. |
| I | `packages/core/executors/subprocess.ts` | 80 | `proc.exited.then(...)` | Process exit tracking callback. Standard pattern. |
| J | `packages/cli/index.ts` | 123 | `checkForUpdate(...).then(...).catch(() => {})` | Non-blocking update check after CLI runs. |
| K | `packages/arkd/server.ts` | 91, 99, 325 | `fetch(...).catch(() => {})` | Control plane registration/heartbeat/deregister. Best-effort. |
| L | `packages/core/app.ts` | 851 | `setInterval(async () => { await safeAsync(...) })` | Metrics poller. `await` inside callback is correct; setInterval ignoring the promise is fine. |
| M | `packages/core/executors/status-poller.ts` | 20 | `setInterval(async () => { ... })` | Status poller. Same pattern as L. |

### NOT BUGS -- Correct patterns

| Pattern | Locations | Why correct |
|---------|-----------|-------------|
| `.then()` in React `useEffect` | `packages/tui/hooks/useSessionDetailData.ts`, `packages/web/src/hooks/useSessionDetailData.ts` | Standard React async-in-useEffect pattern. All have `.catch()`. |
| `Promise.all(arr.map(async ...))` | `packages/tui/hooks/useArkStore.ts:71-81,86-98`, `packages/tui/hooks/useEventLog.ts:29` | Correctly awaited `Promise.all` wrapping `.map(async ...)`. |
| `.then()` in API client wrappers | `packages/web/src/hooks/useApi.ts` (30+ lines) | Return value transformers in API definitions. Consumers await or use in React Query. |
| `postgres.ts` blocking pattern | `packages/core/database/postgres.ts:134-145,185-195,225-235` | Intentional sync-over-async using `Bun.sleepSync`. Bun processes I/O during sleepSync. Errors properly thrown after the loop. |

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/services/session-hooks.ts` | Await dispatch at line 617, or restructure to return dispatch result |
| `packages/core/conductor/conductor.ts` | Await sendOSNotification at 685, 714; await safeAsync at 770; add fire-and-forget comments at 174, 700 |
| `packages/core/executors/status-poller.ts` | Await sendOSNotification at line 74 |
| `packages/core/__tests__/e2e-session-lifecycle.test.ts` | Add `await` to `complete(app, session.id)` at line 328 |

## Implementation steps

### Step 1: Fix unawaited `dispatch` in session-hooks.ts (Bug #1)

**File:** `packages/core/services/session-hooks.ts:617`

Change:
```ts
dispatch(app, sessionId).catch(err => {
  logError("handoff", `auto-dispatch failed for ${sessionId}/${toStage}: ${err?.message ?? err}`);
});
dispatched = true;
```

To:
```ts
const dispatchResult = await safeAsync(`handoff: auto-dispatch ${sessionId}/${toStage}`, () =>
  dispatch(app, sessionId),
);
dispatched = dispatchResult;
```

This ensures the handoff return value accurately reflects whether dispatch succeeded.

### Step 2: Document conductor dispatch retries as intentional fire-and-forget (Bugs #2, #3)

**File:** `packages/core/conductor/conductor.ts:174`

The dispatch at line 174 is inside an HTTP handler that returns a Response. Awaiting it would block the HTTP response. This is intentional -- the HTTP response confirms the retry was *initiated*, not that it succeeded. **Add a `// fire-and-forget: HTTP response confirms retry was initiated, not completed` comment.**

**File:** `packages/core/conductor/conductor.ts:700`

Same pattern -- inside `applyReport` which is called from an HTTP handler. The retry dispatch is intentionally non-blocking because the HTTP response needs to return quickly. **Add a matching comment.**

### Step 3: Fix unawaited `sendOSNotification` in conductor.ts (Bug #4)

**File:** `packages/core/conductor/conductor.ts:685,714`

These are inside async functions. Add `await`:
```ts
await sendOSNotification("Ark: Verification failed", ...);
// and
await sendOSNotification(`Ark: ${notifyTitle}`, notifyBody);
```

`sendOSNotification` is best-effort and never throws (catches internally), so awaiting it is safe and eliminates unhandled-rejection risk with zero performance cost.

### Step 4: Fix unawaited `safeAsync` for auto-PR in conductor.ts (Bug #5)

**File:** `packages/core/conductor/conductor.ts:770`

Change:
```ts
safeAsync(`auto-pr: ${sessionId}`, async () => {
```
To:
```ts
await safeAsync(`auto-pr: ${sessionId}`, async () => {
```

This is inside `applyReport` which is already async. Awaiting ensures auto-PR errors are properly tracked.

### Step 5: Fix unawaited `sendOSNotification` in status-poller.ts (Bug #6)

**File:** `packages/core/executors/status-poller.ts:74`

Change:
```ts
sendOSNotification(`Ark: ${title}`, session.summary ?? sessionId);
```
To:
```ts
await sendOSNotification(`Ark: ${title}`, session.summary ?? sessionId);
```

### Step 6: Fix unawaited `complete` in test (Bug #7)

**File:** `packages/core/__tests__/e2e-session-lifecycle.test.ts:328`

Change:
```ts
complete(app, session.id);
```
To:
```ts
await complete(app, session.id);
```

### Step 7: Add `// fire-and-forget` comments to intentional patterns

For items A-M in the "Intentional" list, verify or add a `// fire-and-forget:` comment explaining why the Promise is intentionally not awaited. Many already have these comments. Add where missing:

- `app.ts:540` -- add `// fire-and-forget: plugin loading is best-effort, never blocks boot`
- `conductor.ts:323` -- add `// fire-and-forget: long-running rollback watcher, errors logged via .catch()`
- `issue-poller.ts:149` -- add `// fire-and-forget: initial poll runs in background`

## Testing strategy

1. **Run the full test suite** (`make test`) after all changes to ensure nothing breaks.
2. **Specifically verify `e2e-session-lifecycle.test.ts`** passes with the `await` fix.
3. **Verify `session-hooks.ts` change** by running `make test-file F=packages/core/__tests__/completion-paths.test.ts` -- this tests the mediateStageHandoff flow.
4. **Verify conductor changes** don't break report handling: `make test-file F=packages/core/__tests__/conductor-e2e.test.ts`.
5. No new tests needed -- these are correctness fixes to existing code.

## Risk assessment

- **Low risk:** Steps 3, 5, 6, 7 -- adding `await` to already-async contexts with non-throwing functions, or fixing a test. Cannot break anything.
- **Medium risk:** Step 1 -- changing the dispatch in mediateStageHandoff from fire-and-forget to awaited. This means the handoff function will now wait for dispatch to complete before returning. Callers (`applyReport`, `applyHookStatus`) need to handle the slightly longer execution time. Since these are already async, this should be fine. **The bigger concern is that `dispatch` might throw on tmux/Claude CLI failures**, but `safeAsync` wraps it safely.
- **Low risk:** Steps 2, 4 -- conductor changes. Adding `await` to `safeAsync` in `applyReport` only makes the function wait for PR creation, which is fine. The HTTP handler that calls `applyReport` is already async. Adding comments has zero risk.
- **No breaking changes.** All changes are internal behavior improvements, not API changes.
- **Edge case:** If `dispatch()` hangs indefinitely in Step 1, `mediateStageHandoff` would also hang. In practice, dispatch either succeeds quickly (tmux spawn) or fails quickly (binary not found, session not ready). Consider adding a timeout wrapper if this becomes an issue.

## Open questions

1. **Should conductor dispatch retries (lines 174, 700) remain fire-and-forget?** They're inside HTTP handlers where awaiting would delay the response. The current pattern is arguably correct for this context -- the HTTP response confirms "retry initiated", not "retry completed". I've kept them as-is with documentation comments, but the team should confirm this is the desired behavior.

2. **Should we add a lint rule to catch future unawaited async calls?** TypeScript's `@typescript-eslint/no-floating-promises` rule would catch most of these patterns automatically. However, the project currently has no ESLint config for this rule. Worth considering as a follow-up.
