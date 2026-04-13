# Plan: Unified Claude Settings Bundle -- Rename writeHooksConfig to writeSettings

## Summary

`writeHooksConfig` in `packages/core/claude/claude.ts` manages the full Claude `settings.local.json` bundle (hooks, permissions allow/deny, `_ark` metadata) but its name implies it only handles hooks. Rename to `writeSettings`/`removeSettings`, extract a typed `ClaudeSettingsOpts` interface, update all call sites and tests, and add backward-compatible aliases so nothing breaks. A prior attempt exists on branch `ark-s-35c483` (commit `35bcacf`) but was never merged and contained unrelated changes -- this plan delivers the rename cleanly against current main (`6d864f4`).

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/claude/claude.ts` | Rename functions, extract `ClaudeSettingsOpts` interface, add JSDoc, add backward-compat aliases |
| `packages/core/executors/claude-code.ts` | Update call `claude.writeHooksConfig` -> `claude.writeSettings` (line 66) |
| `packages/core/services/session-orchestration.ts` | Update 3 call sites: `writeHooksConfig` (line 1540), `removeHooksConfig` (lines 773, 1306), and their log messages |
| `packages/core/app.ts` | Update dynamic import of `removeHooksConfig` -> `removeSettings` (line 678-679) |
| `packages/core/__tests__/claude-hooks.test.ts` | Update imports and all test references to new names |
| `packages/core/__tests__/e2e-autonomy.test.ts` | Update imports and all test references to new names |
| `CLAUDE.md` | Update documentation references (lines 479, 483) |

## Implementation steps

### Step 1: Rename core functions in `packages/core/claude/claude.ts`

1. **Add `ClaudeSettingsOpts` interface** before the function (insert before line 330):
   ```ts
   /** Options for writing the unified Claude settings bundle (.claude/settings.local.json). */
   export interface ClaudeSettingsOpts {
     autonomy?: string;
     agent?: AgentToolSpec;
     tenantId?: string;
   }
   ```

2. **Rename `writeHooksConfig` to `writeSettings`** (line 330):
   - Add JSDoc:
     ```ts
     /**
      * Write the unified Claude settings bundle to .claude/settings.local.json.
      *
      * Manages three concerns in a single atomic write:
      *   1. Status hooks -- curl-based event reporting to the conductor
      *   2. Permissions -- allow list (from agent tools) and deny list (from autonomy level)
      *   3. _ark metadata -- tracks which settings are ark-managed for clean teardown
      */
     ```
   - Change function signature opts type from inline `{ autonomy?: string; agent?: AgentToolSpec; tenantId?: string }` to `ClaudeSettingsOpts`
   - Update error message string: `writeHooksConfig:` -> `writeSettings:`

3. **Rename `removeHooksConfig` to `removeSettings`** (line 429):
   - Add JSDoc: `/** Remove ark-managed settings from .claude/settings.local.json (hooks, permissions, metadata). */`
   - Update error message string: `removeHooksConfig:` -> `removeSettings:`

4. **Update `removeChannelConfig` JSDoc** (line 405): change `removeHooksConfig` reference to `removeSettings`

5. **Add backward-compatible aliases** after `removeSettings`:
   ```ts
   /** @deprecated Use writeSettings instead */
   export const writeHooksConfig = writeSettings;
   /** @deprecated Use removeSettings instead */
   export const removeHooksConfig = removeSettings;
   ```

### Step 2: Update `packages/core/executors/claude-code.ts` (line 66)

Change:
```ts
claude.writeHooksConfig(session.id, conductorUrl, effectiveWorkdir, {
```
To:
```ts
claude.writeSettings(session.id, conductorUrl, effectiveWorkdir, {
```

### Step 3: Update `packages/core/services/session-orchestration.ts` (3 sites)

1. **Line 1540** (dispatch path): `claude.writeHooksConfig(...)` -> `claude.writeSettings(...)`
2. **Line 773** (stop path): `claude.removeHooksConfig(...)` -> `claude.removeSettings(...)` and update log message from `removeHooksConfig` to `removeSettings`
3. **Line 1306** (delete path): `claude.removeHooksConfig(...)` -> `claude.removeSettings(...)` and update log message from `removeHooksConfig` to `removeSettings`

### Step 4: Update `packages/core/app.ts` (lines 678-679)

Change:
```ts
const { removeHooksConfig } = await import("./claude/claude.js");
removeHooksConfig(cwd);
```
To:
```ts
const { removeSettings } = await import("./claude/claude.js");
removeSettings(cwd);
```

### Step 5: Update `packages/core/__tests__/claude-hooks.test.ts`

1. Update import (line 7): `writeHooksConfig, removeHooksConfig` -> `writeSettings, removeSettings`
2. Rename all `writeHooksConfig(...)` calls to `writeSettings(...)`
3. Rename all `removeHooksConfig(...)` calls to `removeSettings(...)`
4. Update describe block names:
   - `"writeHooksConfig"` -> `"writeSettings"`
   - `"removeHooksConfig"` -> `"removeSettings"`
   - `"writeHooksConfig with agent"` -> `"writeSettings with agent"`
   - `"removeHooksConfig with agent permissions"` -> `"removeSettings with agent permissions"`

### Step 6: Update `packages/core/__tests__/e2e-autonomy.test.ts`

1. Update import (line 14): `writeHooksConfig, removeHooksConfig` -> `writeSettings, removeSettings`
2. Rename all `writeHooksConfig(...)` calls to `writeSettings(...)`
3. Rename all `removeHooksConfig(...)` calls to `removeSettings(...)`
4. Update describe block names and comments referencing the old names

### Step 7: Update `CLAUDE.md` (lines 479, 483)

1. Line 479: Change `claude.writeHooksConfig()` to `claude.writeSettings()`
2. Line 483: Change `writeHooksConfig, removeHooksConfig` to `writeSettings, removeSettings`

### Step 8: Verify

```bash
# Targeted test files first
make test-file F=packages/core/__tests__/claude-hooks.test.ts
make test-file F=packages/core/__tests__/e2e-autonomy.test.ts

# Grep audit: no remaining non-alias references
grep -r "writeHooksConfig\|removeHooksConfig" packages/core/ --include="*.ts" | grep -v "deprecated\|@deprecated\|export const writeHooksConfig\|export const removeHooksConfig"

# Full suite
make test
```

## Testing strategy

1. **No new tests needed** -- this is a pure rename. All existing tests verify the same behavior.
2. **Run targeted test files first**: `claude-hooks.test.ts` (18 tests) and `e2e-autonomy.test.ts` (10 tests) directly exercise the renamed functions.
3. **Grep audit** to confirm no call sites still use the old names (excluding the alias definitions).
4. **Full test suite** (`make test`) to catch any transitive breakage from test files that weren't identified above.

## Risk assessment

- **Low risk**: Pure rename with zero behavior change. Backward-compatible aliases ensure any code still using `writeHooksConfig`/`removeHooksConfig` (including dynamic imports in `app.ts`) continues to work.
- **No migration concerns**: No runtime data or configuration references these function names.
- **Prior attempt reference**: The `ark-s-35c483` branch also fixed "4 stale test expectations that assumed permissions.allow was not always written." Those fixes are NOT needed here -- the current main already has the correct test expectations after commit `87ed580`.

## Open questions

None -- the scope is narrow and well-defined from the prior attempt and the ROADMAP entry.
