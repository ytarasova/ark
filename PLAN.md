# Plan: Rework loop error context injection (retryWithContext)

## Summary

The `retryWithContext` function in `session-hooks.ts` logs a `retry_with_context` event and resets the session to "ready" for re-dispatch, but **the actual error context is never injected into the agent's prompt**. When `dispatch()` re-launches the agent, `buildTaskWithHandoff()` / `appendPreviousStageContext()` have no logic to detect retry events or include the failure reason. The agent retries blind -- defeating the purpose of "retry with context." This plan adds error context injection into the task prompt on retry dispatch.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/services/session-hooks.ts` (~line 683) | Store error context in `session.config._retry_context` before clearing the `error` field in `retryWithContext()` |
| `packages/core/services/session-orchestration.ts` (~line 1689) | Inject `_retry_context` into agent prompt in `appendPreviousStageContext()` |
| `packages/core/services/session-orchestration.ts` (~line 536) | Clear `_retry_context` from config after successful dispatch |
| `packages/core/__tests__/fail-loopback.test.ts` | Add test: `retryWithContext` stores `_retry_context` in session config |
| `packages/core/__tests__/on-failure-retry.test.ts` | Add test: conductor retry stores error context in session config |

## Implementation steps

### Step 1: Preserve error context in session config before clearing

In `packages/core/services/session-hooks.ts`, function `retryWithContext()` (line 683-711):

Currently it does:
```ts
app.sessions.update(sessionId, { status: "ready", error: null });
```

This clears the error before `dispatch()` runs, so `dispatch()` can't read it. Fix: store the error in `session.config._retry_context` via `mergeConfig` before the status reset.

**Change** (after the `app.events.log` call on line 698, before the status reset on line 708):

```ts
// Preserve error context for injection into next dispatch prompt
app.sessions.mergeConfig(sessionId, {
  _retry_context: {
    attempt: priorRetries + 1,
    maxRetries,
    error: typeof s.error === "string" ? s.error.slice(0, 2000) : s.error,
    stage: s.stage,
  },
});
```

The 2000-char truncation prevents oversized prompts from full stack traces.

### Step 2: Inject error context into task prompt on retry dispatch

In `packages/core/services/session-orchestration.ts`, function `appendPreviousStageContext()` (line 1689-1733):

Add a section **before** the "Previous stages" block (right after `const parts: string[] = [];` on line 1690) that reads `_retry_context` and injects the failure context:

```ts
// Inject error context from previous retry attempt (fail-loopback)
const retryCtx = (session.config as any)?._retry_context as
  { attempt: number; maxRetries: number; error: string; stage: string } | undefined;
if (retryCtx) {
  parts.push(`\n## IMPORTANT: Previous attempt failed (retry ${retryCtx.attempt}/${retryCtx.maxRetries})`);
  parts.push(`The previous attempt at this stage ('${retryCtx.stage ?? "unknown"}') failed with the following error:`);
  parts.push(`\`\`\`\n${retryCtx.error ?? "unknown error"}\n\`\`\``);
  parts.push(`Fix the issue that caused this failure. Do not repeat the same approach that failed.`);
}
```

This goes first so it's the most prominent context the agent sees.

### Step 3: Clear retry context after successful dispatch

In `packages/core/services/session-orchestration.ts`, function `dispatch()`, after `app.sessions.update(sessionId, { status: "running", agent: agentName, session_id: tmuxName })` on line 536:

```ts
// Clear retry context after successful re-dispatch (consumed by task prompt above)
if ((session.config as any)?._retry_context) {
  app.sessions.mergeConfig(sessionId, { _retry_context: null });
}
```

This ensures the retry context is consumed once and doesn't leak into subsequent non-retry dispatches.

### Step 4: Add tests

**In `packages/core/__tests__/fail-loopback.test.ts`**, add after the "error context logged as event" test:

```ts
it("stores retry context in session config", () => {
  const s = getApp().sessions.create({ summary: "test", flow: "bare" });
  getApp().sessions.update(s.id, { status: "failed", error: "Build failed: missing import", stage: "work" });

  session.retryWithContext(getApp(), s.id);

  const updated = getApp().sessions.get(s.id)!;
  const ctx = (updated.config as any)?._retry_context;
  expect(ctx).toBeDefined();
  expect(ctx.error).toBe("Build failed: missing import");
  expect(ctx.attempt).toBe(1);
  expect(ctx.stage).toBe("work");
});
```

**In `packages/core/__tests__/on-failure-retry.test.ts`**, add inside the conductor integration describe:

```ts
it("retry stores error context in session config for next dispatch", async () => {
  const app = getApp();
  const s = app.sessions.create({ summary: "context injection test", flow: "quick" });
  app.sessions.update(s.id, { status: "running", stage: "implement" });

  await postReport(s.id, {
    type: "error",
    error: "TypeError: Cannot read properties of undefined",
    stage: "implement",
  });

  const updated = app.sessions.get(s.id)!;
  const ctx = (updated.config as any)?._retry_context;
  expect(ctx).toBeDefined();
  expect(ctx.error).toBe("TypeError: Cannot read properties of undefined");
  expect(ctx.attempt).toBe(1);
  expect(ctx.maxRetries).toBe(3);
});
```

### Step 5: Run tests

```bash
make test-file F=packages/core/__tests__/fail-loopback.test.ts
make test-file F=packages/core/__tests__/on-failure-retry.test.ts
make test
```

## Testing strategy

1. **Existing tests**: All 17 existing tests in `fail-loopback.test.ts` and `on-failure-retry.test.ts` must still pass (no behavior changes to existing logic).
2. **New unit tests**: Two new tests verify `_retry_context` is stored in session config and available for prompt injection.
3. **Integration coverage**: The `appendPreviousStageContext` injection is exercised indirectly through the dispatch path. A full E2E test would require mocking the executor -- not worth the complexity for this change. Manual verification is sufficient.
4. **Manual E2E**: Dispatch a session on the `quick` flow, send an error report to the conductor, verify the re-dispatched agent's tmux pane shows "Previous attempt failed" in its initial prompt.

## Risk assessment

- **Low risk**: All changes are additive. Storing `_retry_context` in the JSON config blob requires no schema changes.
- **No breaking changes**: The `retryWithContext` function signature and return type are unchanged. Existing callers (conductor.ts lines 161 and 690) are unaffected.
- **Edge case -- long errors**: Truncated to 2000 chars in Step 1 to avoid prompt bloat.
- **Edge case -- dispatch failure after retry**: If `dispatch()` fails after `retryWithContext` sets "ready", `_retry_context` persists in config. This is harmless -- it will be consumed on the next successful dispatch or cleared manually.
- **Edge case -- multiple rapid retries**: Each `retryWithContext` call overwrites `_retry_context` with the latest error, so only the most recent failure is injected. This is correct behavior.

## Open questions

None -- the approach is straightforward and all information needed is in the codebase.
