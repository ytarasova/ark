# Plan: Unify flow routing -- `depends_on` should create implicit edges

## Summary

The flow system has two separate routing implementations that don't talk to each other: (1) the graph-flow path that uses explicit `edges:` arrays with conditional routing, join barriers, and skipped-stage tracking, and (2) the linear fallback path that ignores `depends_on` entirely and just calls `resolveNextStage()` (pure linear progression). When a flow defines `depends_on` on its stages but has no explicit `edges:` array, `parseGraphFlow()` generates linear edges (A->B->C) instead of honoring the declared DAG dependencies. This means flows like `dag-parallel.yaml` (parallel implement+test after plan, join at integrate) never actually run in parallel -- they degrade to linear execution.

The fix: make `parseGraphFlow()` synthesize edges from `depends_on` declarations when no explicit `edges:` are provided, and route all `depends_on` flows through the graph-flow path in `advance()`.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/state/graph-flow.ts` (lines 47-52) | Generate edges from `depends_on` instead of linear fallback when stages have `depends_on` |
| `packages/core/services/session-orchestration.ts` (line 583) | Route through graph-flow path when stages have `depends_on`, not only when `edges` exist |
| `packages/core/__tests__/graph-flow.test.ts` | Add tests for `depends_on`-to-edge synthesis |
| `packages/core/__tests__/dag-advance.test.ts` | Add integration test for parallel DAG advance via `depends_on` |

## Implementation steps

### Step 1: Synthesize edges from `depends_on` in `parseGraphFlow()`

In `packages/core/state/graph-flow.ts`, lines 47-52, the auto-edge generation currently does:

```ts
if (edges.length === 0 && nodes.length > 1) {
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].name, to: nodes[i + 1].name });
  }
}
```

Replace with logic that checks if any stage has `depends_on`. The input `yaml` object is the raw flow definition, so stages are available as `yaml.nodes ?? yaml.stages`. The function must:

1. Check if any node in the raw YAML has a `depends_on` field.
2. If YES: generate one edge per dependency (`{ from: dep, to: stage.name }` for each dep in `depends_on`). Stages with no `depends_on` and `i > 0` get an implicit edge from the previous stage (preserving the existing linear fallback for mixed flows).
3. If NO `depends_on` found: keep the existing linear edge generation.
4. Explicit `edges:` from YAML still take highest priority (unchanged -- they're already parsed on line 40).

Concrete replacement for lines 47-52:

```ts
// Auto-generate edges when no explicit edges provided
if (edges.length === 0 && nodes.length > 1) {
  const rawStages = yaml.nodes ?? yaml.stages ?? [];
  const hasDependsOn = rawStages.some((s: any) => s.depends_on?.length > 0);

  if (hasDependsOn) {
    // Synthesize edges from depends_on declarations
    for (let i = 0; i < rawStages.length; i++) {
      const s = rawStages[i];
      if (s.depends_on?.length > 0) {
        for (const dep of s.depends_on) {
          edges.push({ from: dep, to: s.name });
        }
      } else if (i > 0) {
        // No depends_on: implicit linear dependency on previous stage
        edges.push({ from: rawStages[i - 1].name, to: s.name });
      }
    }
  } else {
    // Pure linear: no depends_on anywhere
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].name, to: nodes[i + 1].name });
    }
  }
}
```

### Step 2: Route `depends_on` flows through the graph-flow path in `advance()`

In `packages/core/services/session-orchestration.ts`, line 583, the condition is:

```ts
if (flowDef && flowDef.edges?.length > 0) {
```

This only triggers for flows with explicit `edges:`. Change to also trigger when any stage has `depends_on`:

```ts
const hasDependsOn = flowDef?.stages?.some(s => s.depends_on?.length > 0);
if (flowDef && (flowDef.edges?.length > 0 || hasDependsOn)) {
```

This ensures flows like `dag-parallel.yaml`, `autonomous-sdlc.yaml`, `quick.yaml`, `default.yaml`, `islc.yaml`, and `islc-quick.yaml` all route through the graph-flow path which handles join barriers, parallel readiness detection, and skipped stages.

### Step 3: No changes needed to `FlowNode` interface

`parseGraphFlow()` strips stage data to `name`, `agent`, `model`, `gate`, `on_failure` (lines 32-38). The `depends_on` field is not propagated to `FlowNode` because edges carry the dependency information. The raw YAML is available in the function scope for Step 1.

### Step 4: Add unit tests for `depends_on` edge synthesis

In `packages/core/__tests__/graph-flow.test.ts`, add these tests:

1. **`depends_on` creates correct edges** -- Parse a flow with stages using `depends_on` but no explicit edges. Verify edges match the dependency graph.
2. **Parallel fan-out from `depends_on`** -- Stages B and C both `depends_on: [A]`. Verify edges: A->B, A->C. Verify `isFanOutNode(flow, "A")` returns true.
3. **Join barrier from `depends_on`** -- Stage D `depends_on: [B, C]`. Verify edges B->D, C->D. Verify `isJoinNode(flow, "D")` returns true.
4. **Mixed `depends_on` and implicit linear** -- Stage A (no deps), B (`depends_on: [A]`), C (no deps, should get implicit B->C edge).
5. **`resolveNextStages` with synthesized edges** -- After plan completes, both implement and test are ready (parallel). After both complete, integrate is ready (join).
6. **Entrypoints detected correctly** -- First stage with no `depends_on` is auto-detected as entrypoint.

### Step 5: Add integration test for DAG advance with parallel stages

In `packages/core/__tests__/dag-advance.test.ts`, add a test using a dag-parallel flow pattern (plan -> parallel [implement, test] -> integrate):

1. Write a test flow YAML with parallel branches via `depends_on`.
2. Create a session, set stage to `plan`.
3. Advance from `plan` -- verify session moves to first ready parallel stage.
4. Verify flow state shows `plan` as completed.
5. Mark first parallel stage completed in flow state, advance -- verify `integrate` is NOT yet ready (join barrier), or second parallel stage is dispatched.
6. Complete remaining parallel stage, advance -- verify `integrate` becomes next stage.

## Testing strategy

- **Unit tests** (`graph-flow.test.ts`): Verify `parseGraphFlow()` correctly synthesizes edges from `depends_on`. Cover patterns: linear, fan-out, join, mixed.
- **Unit tests** (`dag-flow.test.ts`): Existing `getReadyStages()` tests must continue to pass (function is not modified).
- **Integration tests** (`dag-advance.test.ts`): Verify `advance()` correctly uses graph-flow routing for `depends_on` flows, including join barrier waiting behavior.
- **Existing test suite**: Run `make test` to verify no regressions. All existing flows that use `depends_on` with linear chains (like `quick.yaml`) should still advance correctly since the graph-flow path handles linear DAGs.
- **Manual verification**: Dispatch a session with `dag-parallel` flow and observe stage transitions.

## Risk assessment

1. **All `depends_on` flows now route through graph-flow path** -- This changes the code path for `autonomous-sdlc`, `quick`, `default`, `islc`, `islc-quick`, and `dag-parallel` flows. The graph-flow path is more capable (handles joins, conditionals, skipped stages), so this should be strictly better. Risk: if any flow relied on the linear path's simpler behavior, it could behave differently. Mitigation: the graph-flow path produces correct linear progression for linear chains.

2. **Flow state persistence becomes required** -- The graph-flow path uses `loadFlowState()` / `markStageCompleted()` for tracking. The linear path didn't depend on this. `loadFlowState()` returns null gracefully and `markStageCompleted()` creates the file on first call, so this is safe for flows that never had state files.

3. **`on_outcome` routing gap** -- The linear path handles `on_outcome` via `resolveNextStage()`. The graph-flow path does NOT handle `on_outcome`. However, no current flow YAML uses `on_outcome` (only the `StageDefinition` type supports it), so this is a theoretical risk only. A follow-up can map `on_outcome` to conditional edges if needed.

4. **Existing `dag-advance.test.ts` tests** -- The test creates a linear DAG flow (plan->implement->review with `depends_on`). After the change, this flow routes through graph-flow instead of linear. Assertions about `stage === "implement"` still hold since graph-flow resolves linear chains correctly. The "last stage completes flow" test uses event-based stage tracking that may need updating to use flow state instead.

5. **No breaking changes to flow YAML format** -- The `depends_on` field and `edges` array semantics are unchanged. This is purely an internal routing fix.

## Open questions

1. **Should `advance()` dispatch multiple parallel stages simultaneously?** Currently even in the graph-flow path, only `readyStages[0]` is dispatched (line 610). For true parallel execution of `dag-parallel` (implement + test at the same time), multi-dispatch would be needed. This is out of scope -- this plan only unifies routing so the DAG is correctly resolved. A follow-up can dispatch all ready stages.

2. **Should `on_outcome` be converted to conditional edges in `parseGraphFlow()`?** No current flow uses `on_outcome` without explicit `edges:`, so this isn't urgent. For completeness, `parseGraphFlow()` could translate `on_outcome` maps into conditional edge entries. Recommend deferring.
