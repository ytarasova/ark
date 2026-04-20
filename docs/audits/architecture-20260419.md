# Architecture Audit -- 2026-04-19

Scope: layer separation, god files, circular imports, cross-package leaks.
Branch: `worktree-agent-a068e9e0` (off `main` at `db2b593`).
Tooling: `bunx madge --circular --extensions ts packages/`, ripgrep, manual LOC scan.

---

## 1. Package dependency graph

```
                           +------------+
                           |   cli/     |  Commander.js entry point
                           +------+-----+
                                  | (imports core services directly;
                                  |  no workspace, so relative)
                                  v
                           +------+-----+            +------------+
                           |   core/    |<---------->|  compute/  |
                           +--+-+--+-+--+            +------+-----+
                              | |  | |                      ^
   +--------------------------+ |  | +--------------+       |
   |              +-------------+  |                |       |
   v              v                v                v       |
+--+----+   +-----+----+   +-------+------+    +----+------+|
| arkd/ |   | router/  |   |  server/     |    |  types/   ||
+-------+   +----------+   |  (handlers)  |    +-----------+|
                           +-------+------+                 |
                                   |                        |
                                   v                        |
                           +-------+------+                 |
                           |  protocol/   |<----------------+
                           |  (ArkClient) |
                           +-------+------+
                                   ^
                                   |
                           +-------+------+
                           |   web/       |  (Vite; only touches protocol/)
                           +--------------+

                           +--------------+
                           |  desktop/    |  Electron shell around web/
                           +--------------+
```

Intended layering: `cli` / `web` -> `protocol` -> `server` -> `core` services -> `core` repositories -> SQL. `compute` is a sibling of `core` that both core services and arkd depend on. `types` holds pure domain interfaces.

Observed: `cli` reaches into `core` directly (by design, no workspace). `web` stays on `protocol` (with one test exception). `compute` <-> `core` is the real hotspot -- see section 3.

## 2. Ranked layer violations

| # | Severity | Location | Violation |
|---|----------|----------|-----------|
| 1 | High | `packages/server/handlers/metrics.ts:87-127` | `compute/kill-process`, `compute/docker-logs`, `compute/docker-action` handlers shell out to `kill` / `docker` directly. Business logic in a handler; should live in a compute-control service. |
| 2 | High | `packages/server/handlers/fs.ts:7,37-132` | `fs/list-dir` handler calls `readdirSync`, `statSync`, `existsSync`, does hosted-mode gating and path sanitization. Entire filesystem-traversal policy lives in the HTTP layer. |
| 3 | High | `packages/server/handlers/session.ts:255-311` | `session/resume` and `session/pause` embed the snapshot-fallback orchestration (dynamic-import `session-snapshot`, inspect `notSupported`, decide which state path to walk). This belongs in `SessionService`. |
| 4 | Medium | `packages/server/handlers/session.ts:105-117` | `session/fork` handler sets `group_name` on the returned session by calling `app.sessions.update` directly -- the fork service should accept `group_name` as an option. |
| 5 | Medium | `packages/server/handlers/resource.ts:65-121` | Agent CRUD handlers contain non-trivial resolution logic (scope defaults, `_source === "builtin"` guards, project-root resolution). Should live in an `AgentService`. |
| 6 | Medium | `packages/server/handlers/resource.ts:140-175` | Flow CRUD identical pattern; `flow/create` hand-writes the YAML shape cast. |
| 7 | Low | `packages/server/handlers/knowledge.ts:80-83` | Checks for codegraph binary via `existsSync` + dynamic import in a handler. |
| 8 | Low | `packages/server/handlers/tools.ts:1,32` | Unlinks settings files directly in the handler. |
| 9 | Low | `packages/web/src/__tests__/attachments-sanitize.test.ts:13` | Test imports `safeAttachmentName` from `core/services/workspace-service` via deep relative path. Should re-export from `@ark/protocol` or `types` or hoist into `core/util`. |
| 10 | Info | `packages/compute/core/{types,local,ec2,k8s,...}.ts` | `AppContext` imported from `core/app.js` inside compute. Compute needs app for logging / port-allocation / config. Hard to avoid without DI; main driver of the 63 cycles below. Flag for Agent 5 (DI). |

Services -> repositories: clean. `grep` for `prepare|SELECT|INSERT|UPDATE` in `packages/core/services/` returns zero hits -- every SQL access is mediated by repos. No violations found.

Repositories -> HTTP/RPC: clean. `grep` for `RpcError|JsonRpc|fetch(` in `packages/core/repositories/` returns zero hits.

## 3. Circular imports

Tool: `bunx madge --circular --extensions ts packages/`.

Total cycles: **63** (was 56 before this PR's split; the 7 added cycles are all internal to the orchestration split below and are broken at runtime via `await import(...)`; madge counts dynamic imports as edges).

Top clusters:

1. **compute <-> core::app** (~20 cycles). Every compute adapter imports `AppContext` for config/port-allocation/logging; `core/app.ts` imports compute for pool management and provider registry.
   - Representative: `core/app.ts -> compute/core/types.ts -> core/app.ts` (cycle #2 originally).
   - Root cause: `AppContext` is the de-facto service locator. DI or service registry injection would eliminate.

2. **app <-> conductor <-> integrations/pollers** (~15 cycles). `app.ts` constructs the conductor; the conductor's integration modules (issue-poller, pr-poller, pr-merge-poller, rollback) all import `AppContext`.

3. **Session orchestration siblings** (~17 cycles pre-split, ~24 post-split). The orchestration modules reference each other for fork/join/advance/dispatch paths. Static cycles broken at build time by using dynamic imports.

4. **server -> core hosted -> web** (1 cycle). `server/register.ts -> server/handlers/config.ts -> core/index.ts -> core/hosted/server.ts -> core/hosted/web.ts` cycling back through `core/index.ts`.

Note: these cycles do not cause runtime failures -- Bun's ES module loader tolerates static cycles because initialization follows declaration order, and runtime calls happen after all modules have evaluated. They do make IDE refactoring harder and mask layering violations.

## 4. LOC histogram (files over 500 LOC)

Snapshot after this PR's split. Rows marked `[*]` are the split result.

```
LOC   File
----  --------------------------------------------------------------
1266  packages/core/app.ts                                  <- service locator god object
1083  packages/arkd/server.ts                               <- single-file HTTP daemon
1059  packages/core/conductor/conductor.ts                  <- tick loop + polling
 986  packages/protocol/client.ts                           <- typed RPC client
 909  packages/core/claude/claude.ts                        <- Claude session I/O
 884  packages/core/services/workspace-service.ts           <- git worktree + PR ops
 826  packages/core/services/session-hooks.ts               <- stop-hook / mediator
 740  packages/cli/commands/session.ts                      <- 20+ subcommands
 721  packages/router/providers.ts
 667  packages/cli/commands/compute.ts
 662  packages/core/services/session-lifecycle.ts
 597  packages/protocol/rpc-schemas.ts
 571  packages/compute/core/ec2.ts
 567  packages/compute/providers/remote-arkd.ts
 557  packages/core/index.ts
 548  packages/compute/core/firecracker/vm.ts
 535  packages/core/services/session.ts                     <- SessionService facade
 519  packages/router/server.ts
 515  packages/core/search/search.ts
 504  packages/compute/providers/local-arkd.ts
 497  packages/core/services/dispatch.ts                    [*] new
 472  packages/server/handlers/resource.ts
 460  packages/compute/runtimes/devcontainer.ts
 460  packages/cli/commands/misc.ts
 453  packages/types/rpc.ts
 445  packages/core/repositories/session.ts
 438  packages/web/src/hooks/useApi.ts
 437  packages/compute/providers/docker/index.ts
 431  packages/core/config.ts
 430  packages/server/handlers/session.ts
 376  packages/core/services/stage-advance.ts               [*] new
 166  packages/core/services/fork-join.ts                   [*] new
 136  packages/core/services/dispatch-context.ts            [*] new
 128  packages/core/services/stage-actions.ts               [*] new
 101  packages/core/services/session-orchestration.ts       (barrel)
  89  packages/core/services/subagents.ts                   [*] new
  18  packages/core/services/stage-orchestrator.ts          (barrel)
```

**Before this PR**: `stage-orchestrator.ts` was 1271 LOC (the actual implementation, already partially split from the historical 3100-line `session-orchestration.ts` barrel work).
**After**: `stage-orchestrator.ts` is an 18-line re-export barrel; the largest split child is `dispatch.ts` at 497 LOC. All new files under 500 LOC.

### Next split candidates (documented, not executed in this PR)

1. **`core/app.ts` (1266 LOC)** -- highest leverage. App plays service locator. Plan: extract `AppContext` construction helpers into per-domain modules (`app/stores.ts`, `app/observability.ts`, `app/compute-bootstrap.ts`). Unblocks ~20 cycles.
2. **`packages/arkd/server.ts` (1083)** -- single-file HTTP daemon. Split by endpoint family (`endpoints/exec.ts`, `endpoints/fs.ts`, `endpoints/codegraph.ts`, `endpoints/metrics.ts`).
3. **`core/conductor/conductor.ts` (1059)** -- tick loop, poller wiring. Split the per-poller setup off.
4. **`core/claude/claude.ts` (909)** -- already borderline; split transcript parser vs session state.
5. **`core/services/workspace-service.ts` (884)** -- natural split: worktree-lifecycle (create/remove/cleanup) vs PR ops (create/merge/finish) vs rebase.
6. **`core/services/session-hooks.ts` (826)** -- split by hook kind (stop-hook vs report vs handoff).
7. **`core/services/session-lifecycle.ts` (662)** -- split at verification / delete / pause-resume boundaries.
8. **`cli/commands/session.ts` (740)** -- 20+ subcommands; split by verb groups (lifecycle, introspection, workflow).
9. **`router/providers.ts` (721)** -- per-provider adapter files.
10. **`protocol/client.ts` (986)** -- group RPC methods by domain (already done via `rpc-schemas.ts`; client itself can be split or code-generated).

## 5. Cross-package type leaks

`packages/types/` already holds domain interfaces. Scanning for same-named types defined locally + also in types/:

- `packages/compute/types.ts` re-declares `ComputeProvider`. `packages/core/ports/index.ts` re-exports it. Two places for the "provider" shape. Consolidate in `types/compute.ts`.
- `packages/compute/core/compute-target.ts` declares `ComputeTarget` internally; it is imported by `core/services/session-lifecycle.ts`. Would be cleaner in `types/compute.ts` alongside `ComputeKind` + `RuntimeKind`.
- Test file violations (acceptable but listed): `packages/core/__tests__/session-pause-snapshot.test.ts` imports `Compute`, `ComputeHandle`, `Snapshot`, `NotSupportedError`, `FsSnapshotStore` directly from `packages/compute/core/*` -- OK for tests, but `NotSupportedError` is a runtime value that should live in `types/compute.ts` since error semantics are domain behavior, not compute-internal.
- `packages/core/services/workspace-service.ts:45` imports `ComputeProvider` from `compute/types.js`. Fine, but promotes compute-provider contract to a cross-package one.

No egregious duplicates or wrong-direction leaks surfaced. The main hygiene item is hoisting `ComputeProvider` + `ComputeTarget` + `NotSupportedError` into `types/compute.ts` so `core/services` and `compute/` share a single definition.

## 6. This PR: session orchestration split

Scope: decompose `packages/core/services/stage-orchestrator.ts` (was 1271 LOC) into focused sibling modules. No public-API changes. `SessionService` facade and the `session-orchestration.ts` re-export barrel are untouched.

| New file | LOC | Responsibility |
|----------|-----|----------------|
| `dispatch.ts` | 497 | `dispatch`, `resume`, `resolveComputeForStage`, fork/fan-out dispatchers |
| `dispatch-context.ts` | 136 | Knowledge-graph index, context injection, repo-map render |
| `stage-advance.ts` | 376 | `advance`, `complete`, `handoff`, non-Claude transcript parse |
| `stage-actions.ts` | 128 | `executeAction` (create_pr, merge, auto_merge, close) |
| `fork-join.ts` | 166 | `fork`, `joinFork`, `checkAutoJoin`, `fanOut` |
| `subagents.ts` | 89 | `spawnSubagent`, `spawnParallelSubagents` |
| `stage-orchestrator.ts` | 18 | barrel that re-exports everything above |

Cyclic call-chains (fork -> dispatch, advance -> dispatch, etc.) are broken at runtime via `await import("./sibling.js")`. This is consistent with how the rest of core handles ordering-sensitive imports.

No test was rewritten. All existing `__tests__` target the barrel (`session-orchestration.js`), which continues to re-export the now-split API.

Flagged for Agent 5 (DI): the `await import(...)` pattern is a signal that these modules want dependency injection. Once `SessionService` is injected with its collaborators, the dynamic imports can go.

## 7. Ranked TODO (not executed here)

1. Split `core/app.ts` into smaller construction modules (most cycles, highest leverage).
2. Pull snapshot-fallback policy from `session.ts` handler into `SessionService.resume` / `SessionService.pause`.
3. Move process-control endpoints (`compute/kill-process`, `compute/docker-logs`, `compute/docker-action`) out of `handlers/metrics.ts` into a compute-control service.
4. Promote `ComputeProvider`, `ComputeTarget`, `NotSupportedError` into `packages/types/compute.ts`.
5. Split `packages/arkd/server.ts` by endpoint family.
6. Split `core/services/workspace-service.ts` into worktree-lifecycle + PR-ops + rebase.
7. Re-export `safeAttachmentName` from a neutral module so `packages/web/src/__tests__/attachments-sanitize.test.ts` stops deep-importing core.
8. Delete the lingering `server/register.ts -> core/index.ts -> core/hosted/*` loop by inlining the few handler-side imports.
