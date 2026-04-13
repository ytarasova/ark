# Plan: Fix Action Stages Not Auto-Executing `create_pr` and `auto_merge`

## Summary

Consecutive action stages (e.g., `create_pr` followed by `auto_merge` in the `quick` and `autonomous-sdlc` flows) fail to chain-execute because `executeAction()` internally calls `advance()` which moves the stage pointer forward, but nobody dispatches/executes the newly-advanced-to action stage. The fix removes `advance()` from `executeAction()` (separation of concerns) and adds recursive chaining in `mediateStageHandoff()` so consecutive action stages execute in sequence.

## Root Cause

In `mediateStageHandoff()` (`session-hooks.ts:606-630`), when the next stage is an action:

1. `safeAsync` runs `executeAction("create_pr")` in the background
2. `executeAction()` creates the PR, then calls `advance()` internally -- moving stage from `pr` to `merge`, status `ready`
3. `safeAsync` callback returns. **Nobody checks if `merge` is also an action and executes it.**
4. Session sits at stage `merge` with status `ready` forever.

The `advance()` function (`session-orchestration.ts:562`) only moves the stage pointer and sets status -- it does NOT dispatch agents or execute actions. That responsibility belongs to `mediateStageHandoff()`, which has already returned.

## Files to Modify/Create

| File | Change |
|------|--------|
| `packages/core/services/session-orchestration.ts` (lines 888-928) | Remove `advance()` calls from `executeAction()` -- it should only execute the action |
| `packages/core/services/session-hooks.ts` (lines 615-629) | After `executeAction()` succeeds in the `safeAsync` callback, recursively call `mediateStageHandoff()` to advance and dispatch/execute the next stage |
| `packages/core/__tests__/action-stage-chaining.test.ts` | **New file**: test that consecutive action stages chain-execute correctly |

## Implementation Steps

### Step 1: Modify `executeAction()` to remove internal `advance()` calls

**File:** `packages/core/services/session-orchestration.ts`, function `executeAction()` (lines 888-928)

For each action case that calls `advance()`, remove the `advance()` call and return the action result directly:

```typescript
case "create_pr": {
  const result = await createWorktreePR(app, sessionId, { title: s.summary ?? undefined });
  if (result.ok) {
    app.events.log(sessionId, "action_executed", {
      stage: s.stage ?? undefined, actor: "system",
      data: { action, pr_url: result.pr_url },
    });
  }
  return result;  // was: return await advance(app, sessionId, true);
}

case "auto_merge": {
  const result = await mergeWorktreePR(app, sessionId);
  if (result.ok) {
    app.events.log(sessionId, "action_executed", {
      stage: s.stage ?? undefined, actor: "system",
      data: { action, pr_url: s.pr_url ?? undefined },
    });
  }
  return result;  // was: return await advance(app, sessionId, true);
}

case "close_ticket":
case "close": {
  app.events.log(sessionId, "action_executed", {
    stage: s.stage ?? undefined, actor: "system", data: { action },
  });
  return { ok: true, message: `Action '${action}' executed` };
  // was: return await advance(app, sessionId, true);
}

default: {
  app.events.log(sessionId, "action_skipped", {
    stage: s.stage ?? undefined, actor: "system",
    data: { action, reason: "unknown action type" },
  });
  return { ok: true, message: `Action '${action}' skipped (unknown)` };
  // was: return await advance(app, sessionId, true);
}
```

The `merge_pr`/`merge` case already does NOT call `advance()` (it calls `finishWorktree` and returns), so it needs no change.

### Step 2: Add action chaining in `mediateStageHandoff()`

**File:** `packages/core/services/session-hooks.ts`, inside the action branch of Step 3 (lines 615-629)

After `executeAction()` returns successfully, call `mediateStageHandoff()` recursively to advance past the completed action stage and dispatch/execute whatever comes next:

```typescript
} else if (nextAction.type === "action") {
  safeAsync(`auto-action: ${sessionId}/${nextAction.action}`, async () => {
    const verify = await runVerification(app, sessionId);
    if (!verify.ok) {
      logWarn("handoff", `action stage blocked by verification for ${sessionId}/${toStage}: ${verify.message}`);
      app.sessions.update(sessionId, {
        status: "blocked",
        breakpoint_reason: `Verification failed: ${verify.message.slice(0, 200)}`,
      });
      return;
    }
    const result = await executeAction(app, sessionId, nextAction.action ?? "");
    if (!result.ok) {
      logWarn("handoff", `action '${nextAction.action}' failed for ${sessionId}: ${result.message}`);
      app.sessions.update(sessionId, {
        status: "failed",
        error: `Action '${nextAction.action}' failed: ${result.message.slice(0, 200)}`,
      });
      return;
    }
    // Action succeeded -- chain into mediateStageHandoff to advance
    // past this action stage and dispatch/execute the next stage.
    await mediateStageHandoff(app, sessionId, {
      autoDispatch: true,
      source: "action_chain",
    });
  });
  dispatched = true;
}
```

The recursive chain terminates naturally when:
- `advance()` inside the recursive `mediateStageHandoff` completes the flow (no more stages)
- The next stage is an agent/fork (gets dispatched, no further recursion)
- An action fails (returns early from `safeAsync` callback)
- Verification fails (returns early)

### Step 3: Write tests for action stage chaining

**File:** `packages/core/__tests__/action-stage-chaining.test.ts` (new)

Test cases using `AppContext.forTest()` and inline flow definitions:

1. **Single action stage chains to completion**: Flow with `[agent, action:close]`. Set session at agent stage with status `ready`, call `mediateStageHandoff()`. Verify `action_executed` event logged and flow completes (`session.status === "completed"`).

2. **Consecutive action stages chain-execute**: Flow with `[agent, action:close, action:close]`. Verify both `action_executed` events logged and session reaches `completed`.

3. **Action failure stops chain and sets failed status**: Flow with `[agent, action:create_pr, action:auto_merge]`. Session has no workdir/repo so `create_pr` fails. Verify session gets `failed` status and no `auto_merge` event.

4. **Action stage followed by agent stage**: Flow with `[agent1, action:close, agent2]`. Verify action executes, then session advances to `agent2` stage with status `ready` and `dispatched=true`.

5. **`executeAction` no longer calls advance internally**: Call `executeAction()` directly for `close` action. Verify session stage is unchanged after the call.

Note: Use `close` action for success cases since it requires no external dependencies (no git, no `gh`). Use `create_pr` for failure cases since it fails without a workdir.

### Step 4: Run tests and verify

```bash
make test-file F=packages/core/__tests__/action-stage-chaining.test.ts
make test-file F=packages/core/__tests__/conductor-gaps.test.ts
make test-file F=packages/core/__tests__/stage-handoff.test.ts
make test-file F=packages/core/__tests__/stage-validation-e2e.test.ts
make test-file F=packages/core/__tests__/quality-gate-autonomous.test.ts
make test
```

## Testing Strategy

1. **Unit test `executeAction()`**: Verify it no longer calls `advance()` -- after execution, session stage should remain unchanged.
2. **Integration test `mediateStageHandoff()` with action stages**: Verify the full chain: agent completes -> action stage executes -> next stage dispatched/executed.
3. **Consecutive action chain**: Create inline flow with multiple `close` actions. Verify all execute and flow completes.
4. **Error handling**: Verify action failures set `failed` status and stop the chain.
5. **Regression tests**: Run existing stage-handoff, quality-gate, and conductor-gaps tests to ensure no regressions.

## Risk Assessment

### Low Risk
- **`executeAction()` API change**: Only called from one place -- `mediateStageHandoff()` in `session-hooks.ts:626`. Return type stays `{ ok, message }`.
- **`merge_pr`/`merge` case**: Already does not call `advance()`, so unaffected.

### Medium Risk
- **Recursive `mediateStageHandoff()` stack depth**: Flows rarely have more than 2-3 consecutive action stages. No mitigation needed.
- **Action failures now set `failed` status**: Previously, if `create_pr` failed, `executeAction` returned the error to the `safeAsync` callback which silently ate it (only logged). Now the session gets `failed` status with an error message. This is actually better behavior -- operators can see the failure.

### Edge Cases
- **Action stage with verify scripts**: The `safeAsync` callback runs `runVerification()` before `executeAction()`. The recursive `mediateStageHandoff()` also runs pre-advance verification on the completed action stage. This double-verification is harmless since action stages typically have no verify scripts.
- **Hook-status path**: `handleHookStatus` in `conductor.ts` also calls `mediateStageHandoff()`. The fix applies equally to both paths.
- **Graph-flow (DAG) routing**: The `quick` and `autonomous-sdlc` flows use `depends_on` but not `edges`, so they use linear resolution. The fix works for both graph-flow and linear paths since the chaining happens in `mediateStageHandoff()` which is called after `advance()` regardless of routing mode.

## Open Questions

None -- the fix is mechanical and well-scoped. The only behavioral change is that consecutive action stages now auto-execute instead of stalling.
