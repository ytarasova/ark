# Plan: Fix 49 pre-existing test failures in CI

## Summary

The test suite has 49 failures across 17 test files caused by 8 root causes. The majority stem from three issues: (1) a singleton-provider guard added to `ComputeRepository.create()` that tests weren't updated for, (2) `writeHooksConfig()` now unconditionally writing `permissions.allow` even when no agent is provided (breaking tests that expect `permissions` to be `undefined`), and (3) the quick flow gaining a 4th `merge` stage that tests still reference `pr` as the terminal stage. All fixes are test-side or minor source adjustments -- no architectural changes needed.

## Root Cause Taxonomy

| # | Root Cause | Failures | Files Affected |
|---|-----------|----------|----------------|
| RC1 | Singleton-provider guard rejects `provider: "local"` creates (seeded at boot) | 12 | 5 test files |
| RC2 | `writeHooksConfig` always writes `permissions.allow` (even without agent) | 11 | 3 test files |
| RC3 | Quick flow now has 4 stages (merge after pr) -- tests hardcode "pr" as terminal | 4 | 3 test files |
| RC4 | `PostCompact` hook array includes sync `postCompactTaskHook` alongside async hooks | 3 | 2 test files |
| RC5 | `autoAcceptChannelPrompt` double-taps Enter -- tests expect single Enter | 3 | 1 test file |
| RC6 | `ToolsTab` test doesn't pass `app` prop to `ArkClientProvider` | 6 | 1 test file |
| RC7 | `claude.test.ts` uses undefined `wfs` instead of `writeFileSync` | 1 | 1 test file |
| RC8 | Environment/port issues (daemon-status, local-arkd, web-server, codegraph, fan-out timeout) | 9 | 5 test files |

## Files to modify

### RC1: Singleton-provider guard (12 failures)
- **`packages/core/__tests__/store-compute.test.ts`** -- Change `provider: "local"` to `"docker"` in 5 test cases (lines 100, 113, 140, 154, 174). Tests that don't specify a provider also default to "local" and must add `provider: "docker"`.
- **`packages/core/__tests__/store-row-mapping.test.ts`** -- Change `provider: "local"` to `"docker"` in `rowToCompute via DB` tests (lines 164, 176, 182).
- **`packages/core/__tests__/store-core.test.ts`** -- Add `provider: "docker"` to `mergeComputeConfig` creates (lines 86, 103).
- **`packages/core/__tests__/e2e-cli.test.ts`** -- Change `provider: "local"` to `"docker"` in the compute lifecycle test (line ~97).
- **`packages/compute/__tests__/e2e-compute.test.ts`** -- Change `provider: "local"` to `"docker"` in mergeComputeConfig/getMetrics/probePorts tests (lines ~219, ~263, ~312).
- **`packages/tui/__tests__/useComputeActions.test.ts`** -- Change `provider: "local"` to `"docker"` in the delete test (line ~114).

### RC2: writeHooksConfig always writes permissions.allow (11 failures)
- **`packages/core/claude/claude.ts`** (lines 361-376) -- Conditionally write `permissions.allow` only when an agent is provided OR when no agent is provided but autonomy is "edit"/"read-only" (i.e., when permissions block is already needed). When no agent and no restricted autonomy, skip writing `permissions` entirely. When autonomy is "edit"/"read-only" and no agent is provided, preserve any pre-existing `allow` entries rather than overwriting.
  
  The current code:
  ```ts
  const allow = opts?.agent ? buildPermissionsAllow(opts.agent) : [];
  if (!allow.includes("mcp__ark-channel__*")) allow.push("mcp__ark-channel__*");
  const perms = (existing.permissions ?? {}) as Record<string, unknown>;
  perms.allow = allow;
  existing.permissions = perms;
  arkMeta.managedAllow = true;
  ```
  
  Should become (pseudocode):
  ```ts
  if (opts?.agent) {
    const allow = buildPermissionsAllow(opts.agent);
    if (!allow.includes("mcp__ark-channel__*")) allow.push("mcp__ark-channel__*");
    const perms = (existing.permissions ?? {}) as Record<string, unknown>;
    perms.allow = allow;
    existing.permissions = perms;
    arkMeta.managedAllow = true;
  }
  // permissions.deny is handled separately below for edit/read-only autonomy
  ```
  
  **NOTE**: This conflicts with 4 tests in `claude-hooks.test.ts` (lines 249-261) that EXPECT `mcp__ark-channel__*` even without an agent. These tests (which pass today) need to be updated to NOT expect `permissions.allow` when no agent is provided, OR we keep the behavior of always writing `mcp__ark-channel__*` and instead update the autonomy tests. **Decision needed: which tests represent the correct behavior?**
  
  Looking at both test sets:
  - `claude-hooks.test.ts` lines 249-261: Recently added tests that expect `mcp__ark-channel__*` always. These PASS today.
  - `autonomy.test.ts` lines 94-110, `e2e-autonomy.test.ts` lines 162-187: Older tests expecting `permissions` to be `undefined` when no agent and non-restricted autonomy. These FAIL today.
  
  **Resolution**: The older tests represent the original design intent (permissions should be clean when not needed). The newer `claude-hooks.test.ts` tests were written to match the current (broken) behavior. Fix: change the source to conditionally write `permissions.allow`, and update the 4 `claude-hooks.test.ts` tests (lines 249-261) to not expect `permissions.allow` when no agent is provided.

### RC3: Quick flow 4th stage "merge" (4 failures)
- **`packages/core/__tests__/completion-paths.test.ts`** -- Update "advance() on last auto-gate stage" test (line 172): change `stage: "pr"` to `stage: "merge"`. Update "full auto path through all stages" test (lines 211-246): add a 4th stage completion cycle for the `merge` stage after `pr`.
- **`packages/core/__tests__/dag-advance.test.ts`** -- Update "linear flow (quick) completes when last stage done" test (line 85): change `stage: "pr"` to `stage: "merge"`.
- **`packages/core/__tests__/completion-paths.test.ts`** (lines 252-261 and 302-311) -- `applyHookStatus` with SessionEnd on auto-gate now returns `"ready"` + `shouldAdvance=true` (not `"completed"`). The test expects `newStatus === "completed"`. Fix: update assertions to expect `"ready"` and verify `shouldAdvance === true`. For the "does not override already-completed" test (line 309): the current session.status is "completed", the hook maps to "ready", but the guard on line 2316-2318 blocks the override -- so `newStatus` becomes undefined. Update test to expect `undefined`.

### RC4: PostCompact hook has mixed async/sync (3 failures)
- **`packages/core/claude/claude.ts`** (line 298) -- Change `postCompactTaskHook` to return `async: true` instead of `async: false`. The task reminder hook doesn't need to be synchronous -- it's a fire-and-forget echo command.
- **Or** update the test to skip PostCompact's second hook when checking async. The simpler fix is changing the source since there's no reason for this hook to block.

### RC5: autoAcceptChannelPrompt double-tap Enter (3 failures)
- **`packages/core/__tests__/auto-accept-channel-prompt.test.ts`** -- Update 3 test expectations to include the extra Enter keypress:
  - Line 86: Change `[["1"], ["Enter"]]` to `[["1"], ["Enter"], ["Enter"]]`
  - Line 109: Change `[["1"], ["Enter"]]` to `[["1"], ["Enter"], ["Enter"]]`
  - Line 149: Change `[["1"], ["Enter"]]` to `[["1"], ["Enter"], ["Enter"]]`

### RC6: ToolsTab missing app prop (6 failures)
- **`packages/tui/__tests__/ToolsTab.test.tsx`** (line 25) -- Pass the `app` context to `ArkClientProvider`:
  ```tsx
  <ArkClientProvider onReady={onReady} app={app}>
  ```

### RC7: Undefined `wfs` variable (1 failure)
- **`packages/core/__tests__/claude.test.ts`** (line 304) -- Change `wfs(` to `writeFileSync(`. The function `writeFileSync` is already imported at line 1.

### RC8: Environment/port issues (9 failures)

- **`packages/core/__tests__/daemon-status.test.ts`** (line 53) -- The test expects `arkd.online === false` but port 19300 may be in use. Fix: either use a custom port for the arkd probe in the test, or make the test check the shape of the response without asserting online status, or start the web server on a port that uses a different default arkd URL. Best fix: override `DEFAULT_ARKD_URL` env var in the test to point at an unused port.

- **`packages/compute/__tests__/local-arkd.test.ts`** (lines 55-60) -- Port 19300 collides. Fix: use a different port (e.g., 19350) for this test.

- **`packages/core/__tests__/web.test.ts`** (line 31-37) -- "starts and serves dashboard HTML" fails because `packages/web/dist/` doesn't exist in the test environment (build step `make build-web` runs before `make test` but may not run in isolated CI). Fix: either skip the test when dist is missing, or make the web server return a fallback HTML page.

- **`packages/core/knowledge/__tests__/codegraph-binary.test.ts`** (line 26) -- `isCodegraphInstalled()` returns false when codegraph binary isn't in PATH. Fix: mark this test as skipped when codegraph is not installed (conditional skip, not removal).

- **`packages/core/__tests__/fan-out.test.ts`** (line 589) -- `spawnParallelSubagents` calls `dispatch()` which attempts to launch real tmux sessions, causing a 5s timeout. Fix: the test should call `spawnSubagent` directly (which just creates sessions in DB) instead of `spawnParallelSubagents` (which calls dispatch). Or, mock dispatch.

- **`packages/core/__tests__/conductor-hooks.test.ts`** (line 351) -- "StopFailure still fails auto-gate sessions" uses `flow: "default"` which has manual-gate stages before implement. `applyHookStatus` checks the gate of the current stage. Since `implement` in the default flow is auto-gated, this should still work -- but the issue is likely that `applyHookStatus` now runs a git check (`execFileSync`) on SessionEnd/StopFailure for auto-gate sessions, and the test doesn't have a real workdir. Fix: ensure the session has no `workdir` set (so the git check is skipped), or use `flow: "quick"` instead.

## Implementation steps

### Step 1: Fix RC7 -- trivial typo (1 failure)
1. In `packages/core/__tests__/claude.test.ts` line 304, replace `wfs(` with `writeFileSync(`.
2. Run: `make test-file F=packages/core/__tests__/claude.test.ts`

### Step 2: Fix RC6 -- ToolsTab missing app prop (6 failures)
1. In `packages/tui/__tests__/ToolsTab.test.tsx` line 25, add `app={app}` prop.
2. Run: `make test-file F=packages/tui/__tests__/ToolsTab.test.tsx`

### Step 3: Fix RC5 -- autoAcceptChannelPrompt expectations (3 failures)
1. Update the 3 assertions in `packages/core/__tests__/auto-accept-channel-prompt.test.ts` (lines 86, 109, 149) to expect the double-tap: `[["1"], ["Enter"], ["Enter"]]`.
2. Run: `make test-file F=packages/core/__tests__/auto-accept-channel-prompt.test.ts`

### Step 4: Fix RC1 -- singleton-provider guard (12 failures)
1. In each of the 6 affected test files, change `provider: "local"` to `provider: "docker"` (or add `provider: "docker"` where no provider is specified and it defaults to "local").
2. For `store-compute.test.ts` lines 100, 113, 140, 154, 174.
3. For `store-row-mapping.test.ts` lines 164, 176, 182.
4. For `store-core.test.ts` lines 86, 103.
5. For `e2e-cli.test.ts` line ~97.
6. For `e2e-compute.test.ts` lines ~219, ~263, ~312.
7. For `useComputeActions.test.ts` line ~114.
8. Run each file individually to verify.

### Step 5: Fix RC4 -- PostCompact hook async (3 failures)
1. In `packages/core/claude/claude.ts` line 298, change `async: false` to `async: true` in `postCompactTaskHook`.
2. Run: `make test-file F=packages/core/__tests__/claude-hooks.test.ts`
3. Run: `make test-file F=packages/core/__tests__/e2e-dispatch-compute.test.ts`

### Step 6: Fix RC2 -- writeHooksConfig permissions.allow (11 failures)
1. In `packages/core/claude/claude.ts` lines 361-376, make `permissions.allow` conditional on agent being provided:
   - If `opts?.agent` is provided: build and write `permissions.allow` (current behavior).
   - If no agent: do NOT write `permissions.allow`. Do NOT set `arkMeta.managedAllow`.
   - The `permissions.deny` block below (for `edit`/`read-only` autonomy) should still create `existing.permissions` when needed but should preserve any pre-existing `allow` entries instead of overwriting.
2. Update `packages/core/__tests__/claude-hooks.test.ts` lines 249-261: remove the 4 tests that expect `mcp__ark-channel__*` without an agent (lines 249-261), or change them to expect `permissions` to be `undefined`.
3. Run the affected test files:
   - `make test-file F=packages/core/__tests__/autonomy.test.ts`
   - `make test-file F=packages/core/__tests__/e2e-autonomy.test.ts`
   - `make test-file F=packages/core/__tests__/claude-hooks.test.ts`
   - `make test-file F=packages/core/__tests__/e2e-dispatch-compute.test.ts`

### Step 7: Fix RC3 -- quick flow 4th stage (4 failures)
1. In `packages/core/__tests__/completion-paths.test.ts`:
   - Line 172: change `stage: "pr"` to `stage: "merge"`.
   - Lines 211-246: add a 4th completion cycle for `merge` after `pr`.
   - Lines 252-261: update `applyHookStatus` SessionEnd assertion to expect `newStatus === "ready"` and `result.shouldAdvance === true` (since auto-gate SessionEnd now goes through advance).
   - Lines 302-311: update "does not override already-completed" to expect `newStatus` is `undefined` (guard blocks "ready" from overriding "completed").
2. In `packages/core/__tests__/dag-advance.test.ts` line 85: change `stage: "pr"` to `stage: "merge"`.
3. In `packages/core/__tests__/conductor-hooks.test.ts` line 351-362: the test uses `flow: "default"` which has the implement stage as auto-gated. The StopFailure should still map to "failed" for auto-gate. Investigate whether the test failure is actually from the git workdir check. If so, ensure the session has no `workdir`.
4. In `packages/core/__tests__/completion-paths.test.ts` lines 405-426: "POST /hooks/status with SessionEnd on auto-gate completes session via HTTP" -- update to expect `status: "ready"` and `shouldAdvance` behavior (or the conductor endpoint handles advance internally, so check actual outcome).

### Step 8: Fix RC8 -- environment/port issues (9 failures)
1. **daemon-status.test.ts**: Set `ARK_ARKD_URL` to an unused port in the test setup (e.g., `http://localhost:19399`) so the health probe fails predictably.
2. **local-arkd.test.ts**: Change `ARKD_PORT` to a non-colliding port (e.g., 19350).
3. **web.test.ts**: Add a guard: if `packages/web/dist/index.html` doesn't exist, skip the "serves dashboard HTML" test.
4. **codegraph-binary.test.ts**: Wrap in `describe.skipIf(!isCodegraphInstalled())` or add conditional skip.
5. **fan-out.test.ts** (line 589): Replace `spawnParallelSubagents` call (which dispatches) with direct `spawnSubagent` calls (which only create DB records) and verify model override separately.
6. **conductor-hooks.test.ts** (line 351): Ensure session has no `workdir` or use `flow: "quick"` and verify the StopFailure mapping.

### Step 9: Full suite verification
1. Run `make test` (full sequential suite).
2. Verify all 49 previously-failing tests now pass.
3. Verify no regressions in the 3059 previously-passing tests.

## Testing strategy

- Run each affected test file individually after fixing (`make test-file F=<path>`) to verify the fix in isolation.
- After all fixes, run the full suite (`make test`) to check for regressions.
- Key tests to monitor for regressions:
  - `packages/core/__tests__/claude-hooks.test.ts` -- the "writeHooksConfig with agent" tests (lines 228-301) should still pass after RC2 fix.
  - `packages/core/__tests__/completion-paths.test.ts` -- the manual-gate tests (lines 43-131) should be unaffected.
  - `packages/core/__tests__/store-compute.test.ts` -- the non-singleton tests (lines 85-92, 128-136) should be unaffected.

## Risk assessment

- **RC2 (permissions.allow)** is the highest-risk fix because it changes production behavior in `claude.ts`. The change is small and well-scoped (only affects the no-agent code path), but must be verified against the 4 passing `claude-hooks.test.ts` tests that were written to match the current behavior.
- **RC4 (PostCompact async)** changes production hook behavior. The postCompactTaskHook is a fire-and-forget `echo` command -- making it async is safe and matches the intent (no need to block Claude Code's compaction on a file read).
- **RC3 (quick flow stages)** is purely test-side. The quick flow's 4th stage was added intentionally and tests need to catch up.
- **All other fixes are test-only** -- no production code changes.

## Open questions

1. **RC2 decision**: Should `mcp__ark-channel__*` always be in `permissions.allow` (even without an agent), or only when an agent is provided? The 11 failing tests say "no", the 4 passing tests say "yes". Recommendation: only write it when agent is provided, update the 4 newer tests.
2. **RC8 web.test.ts**: Should `make test` require `build-web` as a prerequisite (it currently does in the Makefile), or should the test gracefully skip? In CI, `build-web` runs first, so this may only fail in worktrees. Recommendation: add a conditional skip.
3. **RC8 codegraph-binary**: Is codegraph expected to be installed in CI? If not, the test should be conditional. Recommendation: skip when binary is not found.
