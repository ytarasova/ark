# Plan: Extract Hook/Report Status Logic from session-orchestration.ts

## Summary

Extract the hook status processing (`applyHookStatus`, `HookStatusResult`), report processing (`applyReport`, `ReportResult`), and stage handoff orchestration (`mediateStageHandoff`, `StageHandoffResult`) into a new dedicated module `packages/core/services/session-hooks.ts`. These three groups form a cohesive "inbound event processing" subsystem that is logically distinct from the session lifecycle operations (start, stop, dispatch, advance) in `session-orchestration.ts`. This reduces the 3070-line god class by ~630 lines and isolates the conductor-facing business logic into a single, focused module.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/services/session-hooks.ts` | **CREATE** -- new module containing `applyHookStatus`, `applyReport`, `mediateStageHandoff`, `parseOnFailure`, `retryWithContext`, `detectStatus`, and their interfaces (`HookStatusResult`, `ReportResult`, `StageHandoffResult`) |
| `packages/core/services/session-orchestration.ts` | **MODIFY** -- remove the extracted functions/interfaces (~lines 2208-2874), add re-exports from `session-hooks.js` for backward compatibility |
| `packages/core/services/index.ts` | **MODIFY** -- update re-exports to source types from `session-hooks.js` |
| `packages/core/conductor/conductor.ts` | **MODIFY** -- update import to use `session-hooks.js` for `applyHookStatus`, `applyReport`, `mediateStageHandoff`, `retryWithContext` (currently imports all via `session-orchestration.js` as `session.*`) |
| `packages/core/index.ts` | **MODIFY** -- update type re-exports if needed (currently re-exports `HookStatusResult`, `ReportResult` from `session-orchestration.js`) |

## Implementation steps

### Step 1: Create `packages/core/services/session-hooks.ts`

Extract these functions and interfaces into the new file:

**Interfaces (lines 2219-2237, 2439-2460, 2675-2690):**
- `HookStatusResult`
- `ReportResult`
- `StageHandoffResult`

**Functions (lines 2209-2434, 2467-2671, 2709-2830, 2839-2874):**
- `detectStatus` (line 2209) -- tmux status detection fallback
- `applyHookStatus` (line 2248) -- hook event business logic
- `applyReport` (line 2467) -- channel report business logic
- `mediateStageHandoff` (line 2709) -- orchestrated stage-to-stage handoff
- `parseOnFailure` (line 2839) -- on_failure directive parser
- `retryWithContext` (line 2846) -- retry-with-error-context logic

**Internal helpers that must move with the functions:**
- `recordSessionUsage` (line 91) -- called by `applyHookStatus` for transcript usage. This is also called from `complete()` via `parseNonClaudeTranscript()`, so it should remain in `session-orchestration.ts` and be imported by `session-hooks.ts`, OR be extracted to a shared utility. **Decision: keep `recordSessionUsage` in `session-orchestration.ts` and import it into `session-hooks.ts`** since it's a general utility used by both modules.

**Imports the new module will need:**
- `AppContext` from `../app.js`
- `Session`, `MessageRole`, `MessageType` from `../../types/index.js`
- `OutboundMessage` from `../conductor/channel-types.js`
- `* as flow` from `../state/flow.js`
- `execFileSync` from `child_process`
- `detectHandoff` from `../handoff.js`
- `logError`, `logWarn` from `../observability/structured-log.js`
- `evaluateTermination`, `parseTermination`, `TerminationContext` from `../termination.js`
- `loadRepoConfig` from `../repo-config.js`
- `safeAsync` from `../safe.js`
- Cross-references back to `session-orchestration.js`: `advance`, `runVerification`, `dispatch`, `getOutput`, `executeAction`, `recordSessionUsage`

### Step 2: Update imports in `session-orchestration.ts`

Remove the extracted code blocks (lines 2208-2874). Add re-exports for backward compatibility:

```ts
// Re-exports from session-hooks.ts for backward compatibility
export {
  applyHookStatus,
  applyReport,
  mediateStageHandoff,
  parseOnFailure,
  retryWithContext,
  detectStatus,
} from "./session-hooks.js";
export type {
  HookStatusResult,
  ReportResult,
  StageHandoffResult,
} from "./session-hooks.js";
```

This ensures all 35+ test files and the conductor that import from `session-orchestration.js` continue to work without modification.

### Step 3: Update `conductor.ts` imports (optional optimization)

The conductor currently does `import * as session from "../services/session-orchestration.js"` and calls `session.applyHookStatus(...)`, `session.applyReport(...)`, etc. Since re-exports preserve this, **no changes are strictly required**. However, for clarity, the conductor could import hook-related functions directly from `session-hooks.js`:

```ts
import { applyHookStatus, applyReport, mediateStageHandoff, retryWithContext } from "../services/session-hooks.js";
import * as session from "../services/session-orchestration.js"; // for dispatch, stop, cleanupOnTerminal, etc.
```

**Decision: skip this for now.** Re-exports make it unnecessary, and touching conductor imports adds risk for no functional gain. Can be done in a follow-up cleanup pass.

### Step 4: Update `packages/core/services/index.ts`

Change the type re-exports to source from `session-hooks.js`:

```ts
export type { HookStatusResult, ReportResult, StageHandoffResult } from "./session-hooks.js";
```

### Step 5: Update `packages/core/index.ts`

Change the type re-exports to source from `session-hooks.js` (or leave as-is since `session-orchestration.js` re-exports them).

**Decision: leave as-is** -- the re-exports in `session-orchestration.js` make this transparent.

### Step 6: Handle circular dependency between `session-hooks.ts` and `session-orchestration.ts`

`session-hooks.ts` needs to call functions from `session-orchestration.ts`:
- `applyHookStatus` calls `getOutput()` (line 2421)
- `mediateStageHandoff` calls `advance()`, `runVerification()`, `dispatch()`, `executeAction()` (lines 2758, 2730, 2788, 2803)

`session-orchestration.ts` currently calls `applyHookStatus` / `applyReport` only through re-exports (no internal calls).

**Solution: use dynamic `import()` in `session-hooks.ts`** for the cross-module calls, matching the existing pattern used throughout the codebase (e.g., `await import("../session/guardrails.js")`). This avoids circular dependency issues at module load time.

Alternatively, since `session-hooks.ts` imports from `session-orchestration.ts` but not vice versa (only re-exports), this is a one-way dependency and static imports should work fine. The re-exports in `session-orchestration.ts` are just `export { ... } from "./session-hooks.js"` which don't create a true circular dependency in ES modules.

**Decision: use static imports.** `session-orchestration.ts` only re-exports (no import-and-use), so there's no circular dependency.

### Step 7: Run tests

```bash
make test-file F=packages/core/__tests__/completion-paths.test.ts
make test-file F=packages/core/__tests__/autonomous-flow.test.ts
make test-file F=packages/core/__tests__/on-failure-retry.test.ts
make test-file F=packages/core/__tests__/commit-verification.test.ts
make test-file F=packages/core/__tests__/stage-handoff.test.ts
make test-file F=packages/core/__tests__/on-outcome.test.ts
make test-file F=packages/core/__tests__/bug-fixes.test.ts
make test
```

## Testing strategy

- **No new tests needed.** This is a pure extraction refactor -- all existing behavior is preserved. The 7 test files that directly import `applyHookStatus`/`applyReport`/`mediateStageHandoff` from `session-orchestration.js` will continue to work via re-exports.
- **Run the full test suite** (`make test`) to verify no import resolution or runtime breakage.
- **Key test files to verify first** (they directly exercise the extracted functions):
  - `completion-paths.test.ts` -- `applyHookStatus` + `applyReport` status transitions
  - `autonomous-flow.test.ts` -- `applyHookStatus` SessionEnd auto-gate fallback
  - `on-failure-retry.test.ts` -- `applyHookStatus` + `retryWithContext` retry logic
  - `commit-verification.test.ts` -- `applyReport` + `applyHookStatus` commit checks
  - `stage-handoff.test.ts` -- `mediateStageHandoff` integration with `applyHookStatus`
  - `on-outcome.test.ts` -- `applyReport` outcome routing
  - `bug-fixes.test.ts` -- `applyReport` edge cases

## Risk assessment

| Risk | Mitigation |
|------|------------|
| **Circular dependency** between `session-hooks.ts` and `session-orchestration.ts` | One-way dependency only: hooks imports from orchestration, orchestration only re-exports from hooks. ES module re-exports don't create circular deps. |
| **Import breakage** in test files or other consumers | Re-exports in `session-orchestration.ts` maintain 100% backward compatibility. No test files need modification. |
| **`recordSessionUsage` shared between both modules** | Keep it in `session-orchestration.ts` (where `parseNonClaudeTranscript` also uses it), import into `session-hooks.ts`. It's an internal (non-exported) helper, so export it from orchestration. |
| **`.js` extension in imports** | All new imports must use `.js` extensions per project convention. |
| **`conductor.ts` namespace import** | Conductor uses `import * as session`, so all re-exported names appear on the `session` namespace unchanged. |

## Open questions

1. **Should `recordSessionUsage` move to a shared utility module?** It's used by both `session-orchestration.ts` (via `parseNonClaudeTranscript` in `complete()`) and `session-hooks.ts` (via `applyHookStatus`). Currently a private function -- extracting it to e.g. `services/usage.ts` would be cleaner but adds scope. Recommendation: export it from `session-orchestration.ts` for now, extract to a utility in a future pass.

2. **Should we update conductor.ts imports now or later?** The conductor could import directly from `session-hooks.js` for hook/report functions. This is cleaner but not necessary due to re-exports. Recommendation: defer to a follow-up PR to keep this change minimal and safe.
