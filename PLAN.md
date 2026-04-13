# Plan: auto_merge must wait for CI before completing the session

## Summary

The `auto_merge` action in `executeAction()` calls `gh pr merge --auto` then immediately calls `advance()`, which marks the session completed since "merge" is the last flow stage. But `--auto` only *queues* the PR for merge once CI passes -- it doesn't mean the PR is actually merged. If CI fails, the PR never merges, yet the session is already marked completed. The fix: after `gh pr merge --auto` succeeds, transition the session to a `waiting` state and poll `gh pr view` until the PR is actually merged (or fails).

## Files to modify/create

1. **`packages/core/services/session-orchestration.ts`** (~lines 910-917) -- Change the `auto_merge` case in `executeAction()` to set session status to `waiting` instead of immediately calling `advance()`.
2. **`packages/core/integrations/pr-merge-poller.ts`** (new) -- New poller that monitors sessions in `waiting` status at the `merge` stage, polls `gh pr view --json state` to detect MERGED/CLOSED, then calls `advance()` on success or fails the session on CI failure.
3. **`packages/core/conductor/conductor.ts`** (~line 437) -- Register the merge poller alongside the existing PR review poller in the conductor's interval loop.
4. **`packages/core/__tests__/pr-merge-poller.test.ts`** (new) -- Unit tests for the merge polling logic.
5. **`packages/core/__tests__/conductor-gaps.test.ts`** (~line 156) -- Update existing `executeAction auto_merge` tests to verify the new waiting behavior.

## Implementation steps

### Step 1: Create `pr-merge-poller.ts`

Create `packages/core/integrations/pr-merge-poller.ts` following the same pattern as `pr-poller.ts`:

```ts
// Key exports:
export function setGhExec(fn: GhExecFn): void  // for testing
export async function fetchPRState(prUrl: string, ghExec?): Promise<{ state: string; mergedAt?: string } | null>
export async function pollPRMerges(app: AppContext, opts?: { ghExec? }): Promise<void>
export async function checkSessionMerge(app: AppContext, session: Session, opts?): Promise<void>
```

**Logic for `pollPRMerges()`:**
- Scan sessions where: `status === "waiting"` AND `pr_url` is set AND the session config has `merge_queued_at` (set by the `auto_merge` action).
- For each, call `fetchPRState()` via `gh pr view <url> --json state,mergedAt`.
- Cooldown: skip if `last_merge_check` in config was < 30s ago (check more frequently than reviews since this blocks flow completion).
- Delegate to `checkSessionMerge()` for each matched session.

**Logic for `checkSessionMerge()`:**
- If `state === "MERGED"`: log `pr_merged_confirmed` event, call `advance(app, sessionId, true)` to complete the flow. The advance call will reach the "no next stage" branch and mark the session completed.
- If `state === "CLOSED"` (not merged): log `pr_merge_failed` event, set session status to `failed` with error "PR was closed without merging -- CI checks may have failed".
- If `state === "OPEN"`: PR is still waiting for CI. Update `last_merge_check` timestamp and continue polling.
- gh CLI error: graceful no-op, keep polling on next tick.

### Step 2: Modify `executeAction` for `auto_merge`

In `packages/core/services/session-orchestration.ts`, change the `auto_merge` case (~line 910):

**Before:**
```ts
case "auto_merge": {
  const result = await mergeWorktreePR(app, sessionId);
  if (result.ok) {
    app.events.log(sessionId, "action_executed", { ... });
    return await advance(app, sessionId, true);
  }
  return result;
}
```

**After:**
```ts
case "auto_merge": {
  const result = await mergeWorktreePR(app, sessionId);
  if (result.ok) {
    app.events.log(sessionId, "action_executed", { ... });
    // Don't advance yet -- gh pr merge --auto only queues the merge.
    // Transition to waiting; pr-merge-poller will advance once PR is actually merged.
    app.sessions.update(sessionId, {
      status: "waiting",
      breakpoint_reason: "Waiting for CI checks to pass and PR to merge",
      config: {
        ...(s.config ?? {}),
        merge_queued_at: new Date().toISOString(),
      },
    });
    app.events.log(sessionId, "merge_waiting", {
      stage: s.stage ?? undefined,
      actor: "system",
      data: { pr_url: s.pr_url, reason: "gh pr merge --auto queued, waiting for CI" },
    });
    return { ok: true, message: "Auto-merge queued -- waiting for CI to pass" };
  }
  return result;
}
```

### Step 3: Register merge poller in conductor

In `packages/core/conductor/conductor.ts`, after the PR review poller registration (~line 438):

```ts
import { pollPRMerges } from "../integrations/pr-merge-poller.js";

// PR merge poller - check every 30 seconds (blocks flow completion, needs faster checks)
const mergeTimer = setInterval(() =>
  safeAsync("PR merge polling", () => pollPRMerges(app)),
30_000);
```

Add `mergeTimer` to the cleanup list alongside `prTimer`.

### Step 4: Write tests

Create `packages/core/__tests__/pr-merge-poller.test.ts`:

1. **`fetchPRState` tests**: parses MERGED/OPEN/CLOSED states from gh output, returns null on error.
2. **`pollPRMerges` tests**: skips sessions without pr_url, skips non-waiting sessions, skips sessions without `merge_queued_at`, respects cooldown.
3. **`checkSessionMerge` tests**: 
   - MERGED state -> calls advance, session reaches completed.
   - CLOSED state -> session set to failed with descriptive error.
   - OPEN state -> session stays waiting, config updated with timestamp.
   - gh CLI error -> graceful no-op (keeps polling).

### Step 5: Update existing tests

In `conductor-gaps.test.ts`, update the `executeAction auto_merge` tests:
- Verify that after `executeAction(app, sessionId, "auto_merge")`, the session status is `waiting` (not `completed`).
- Verify that `breakpoint_reason` is set.
- Verify that `merge_queued_at` is stored in config.
- Note: these tests already mock the gh command (it fails), so the waiting behavior is only tested when `mergeWorktreePR` succeeds. The new `pr-merge-poller.test.ts` covers the polling side.

## Testing strategy

1. **Unit tests** (`pr-merge-poller.test.ts`): Mock `gh` CLI via `setGhExec()` pattern (same as `pr-poller.ts`). Test each state transition (MERGED -> complete, CLOSED -> fail, OPEN -> keep waiting).
2. **Integration tests** (`conductor-gaps.test.ts`): Verify `executeAction("auto_merge")` produces the correct intermediate `waiting` state.
3. **Manual E2E**: Dispatch an `autonomous-sdlc` or `quick` flow session, let it reach the merge stage, verify it enters `waiting` status in the TUI, then confirm it completes after the PR actually merges on GitHub.
4. **Edge cases to test**:
   - Session has no pr_url when auto_merge fires (existing error path, unchanged).
   - `gh pr merge --auto` itself fails (e.g., auto-merge not enabled on repo). Existing error path handles this.
   - Repo has no CI at all -- `gh pr merge --auto` may merge immediately. Poller should detect MERGED on first check (~30s delay).
   - Session manually stopped while waiting for merge -- poller skips non-waiting sessions.
   - Conductor restart while session is waiting -- poller picks it up since it scans all sessions.

## Risk assessment

1. **Repos without branch protection**: `gh pr merge --auto` requires branch protection with required status checks. If not configured, `gh` may reject `--auto` or merge immediately. The existing `mergeWorktreePR()` error path handles the rejection case. If it merges immediately, the poller will pick up MERGED on first tick (30s delay, acceptable).

2. **Polling overhead**: One `gh pr view` call per waiting-to-merge session every 30s. Minimal -- rarely more than a few sessions in this state. GitHub rate limit is 5000/hr for authenticated users; this adds ~120/hr per session.

3. **No breaking changes**: The only behavioral change is that `auto_merge` no longer immediately completes the session. Sessions that previously jumped to `completed` will now spend time in `waiting` first. This is the correct behavior.

4. **Backward compatibility**: Flows that don't use `auto_merge` are unaffected. The merge poller only targets sessions with `merge_queued_at` in their config.

5. **Edge case -- conductor restart**: If the conductor restarts while a session is waiting for merge, the poller will pick it up on the next tick since it scans all sessions in the right state. No state is lost.

6. **30s completion delay for instant merges**: If the PR merges instantly (no CI), there's a worst-case 30s delay before the session transitions to completed. This is acceptable -- the TUI shows "waiting for CI" which is informative.

## Open questions

1. **Fallback for repos without branch protection**: Should we detect the "auto-merge not supported" error from `gh` and fall back to a direct merge (drop `--auto`)? Or keep the current behavior where the error propagates and the session fails? Recommend: keep failing -- direct merge without CI is unsafe. If needed, users can set `auto_merge: false` in `.ark.yaml` to skip the merge stage entirely.

2. **Timeout behavior**: Should there be a hard timeout that fails the session after extended CI wait? Recommend: start without a timeout. The `waiting` state is visible in the TUI, and users can manually stop/retry. Add timeout config later if needed.

3. **Notification on long wait**: Should we emit a TUI notification / event when CI has been pending for > 10 minutes? Nice to have, not blocking for this change.
