# Temporal Integration -- Design

> **Status:** design, no code changes yet. Branch: `temporal-integration`. Scope: Phase 1.5
> finish (RF-1, RF-3, RF-5, RF-7) + Phase 2 (first workflow + shadow projector + T1-T5 e2e
> gate). Authoritative references: [`docs/temporal.md`](../temporal.md),
> [`docs/orchestrator-refactor-plan.md`](../orchestrator-refactor-plan.md).

## 0. Context and scope

`docs/temporal.md` lays out a six-phase migration to Temporal-backed orchestration. Phase 0
(design + Bun spike + local cluster + tracker issues) is complete. Phase 1 (BlobStore audit) is
partial -- S3 + local-disk BlobStore both shipped, plan-artifact and session-input callsites
migrated, but the formal audit and ESLint gate are not in place. The orchestrator-refactor plan
(`docs/orchestrator-refactor-plan.md`) inserts a Phase 1.5 of nine refactors that prepare the
orchestration code for a Temporal seam; three of those (RF-6, RF-8, RF-9) are merged, the rest
are open.

**Scope of this branch.**

In:

- RF-1 (lift hook/report cascade out of conductor)
- RF-3 (declare `OrchestrationDeps` interface)
- RF-5 (finalize BlobStore migration for orchestrator inputs)
- **RF-7 (redefined for this branch):** the original RF-7 wording was "Add
  `AppMode.orchestrator` capability field + LocalOrchestrator wiring" -- a polymorphic
  capability with two implementations. Local mode is being deprecated, so RF-7 collapses to
  "wire Temporal as the hosted orchestrator at `SessionService` boundaries via a flag check."
  No `OrchestratorCapability` interface, no `LocalOrchestrator` class.
- Migration 017 (`workflow_id` columns + projection sidecar)
- `packages/core/temporal/` directory: client, worker bootstrap, `sessionWorkflow`, 9
  activities, shadow projector
- T1-T5 e2e tests on the existing control-plane stack

Out:

- **Local mode is being deprecated. No local-mode code changes are in this branch.** The flag
  check at `SessionService` boundaries is the entire seam.
- RF-2 and RF-4. Nice-to-have without local-mode parity obligation. Revisit post-Phase-2.
- Helm sub-chart, RDS coordination, production cluster provisioning (Phase 4). Production
  shape is documented in SS5 but not built.
- Phase 3 (full activity catalog for every stage kind). Only activities needed for T1-T5 ship.
- Phase 5 (per-tenant flag flip + legacy drain) and Phase 6 (legacy retire).

The flag `features.temporalOrchestration` defaults `false`. Merging this branch does **not**
change the orchestrator any tenant uses today.

## 1. Architecture

```
         +--------------------------------------------------+
         |  RPC handlers / CLI / MCP / web SSE              |
         |  (no changes -- already go through SessionSvc)   |
         +--------------------+-----------------------------+
                              |
                              v
         +--------------------------------------------------+
         |  SessionService                                   |
         |  if mode.kind === "hosted" &&                     |
         |     features.temporalOrchestration:               |
         |       TemporalClient.startWorkflow(...)           |
         |  else:                                            |
         |       today's bespoke path (unchanged)            |
         +----------+-----------------------------------+----+
                    |                                   |
                    v                                   v
   +------------------------------+   +------------------------------------+
   |  Bespoke engine (today)      |   |  TemporalClient                    |
   |  unchanged in this branch    |   |  starts sessionWorkflow on         |
   |  retired in Phase 5          |   |  ark.<tenantId>.stages queue       |
   +------------------------------+   +----------------+-------------------+
                                                       |
                                                       v
                                      +------------------------------------+
                                      |  Temporal worker(s)               |
                                      |   - sessionWorkflow               |
                                      |   - stageWorkflow (fan-out)       |
                                      |   - 9 activities                  |
                                      +----------------+-------------------+
                                                       |
                           activities run the SAME side-effect code today's
                           bespoke engine runs (tmux launch, agent run,
                           channel report, PR creation, compute provisioning)
                                                       |
                                                       v
                    +------------------------------------------------------+
                    |  Shared DB (sessions / session_stages / events)      |
                    |  Both orchestrators write here. All read paths       |
                    |  (web SSE, CLI, MCP) unchanged.                      |
                    +------------------------------------------------------+
```

**Three load-bearing properties:**

1. **Asymmetric writers, symmetric readers.** Both orchestrators write the same tables; every
   read path stays unchanged.
2. **Shadow mode comes for free.** Phase 2 ships a projector that runs both orchestrators on
   the same input and diffs the projected rows.
3. **Bespoke engine is not modified.** Every change is additive. Reverting = drop new files,
   flip flags off, revert migration 017.

## 2. Components

### File layout

```
packages/core/
  temporal/                         <- NEW; all Temporal-specific code
    client.ts                          connection + namespace
    worker.ts                          worker bootstrap entry
    workflows/
      session-workflow.ts              the sessionWorkflow
      stage-workflow.ts                fan-out child workflow
    activities/
      start-session.ts
      resolve-compute.ts
      provision-compute.ts
      dispatch-stage.ts
      await-stage-completion.ts
      execute-action.ts
      run-verification.ts
      project-session.ts
      project-stage.ts
      index.ts                         registers all activities for worker
    deps.ts                            OrchestrationDeps interface (RF-3 surface)
    errors.ts                          non-retryable error classes
    types.ts                           workflow inputs/outputs (JSON-safe)
    projector/
      diff.ts                          shadow-mode diff harness
      seq.ts                           monotonic projectionSeq generator

  services/
    session-signals.ts              <- NEW (RF-1); lifts hook/report cascade out of conductor
    deps.ts                         <- NEW (RF-3); declares OrchestrationDeps
    plan-artifact.ts                <- RF-5 finish; attachments-as-bytes path migrated
    session-lifecycle.ts            <- RF-5 edits the attachments input shape

  conductor/
    conductor.ts                    <- RF-1 reduces to forwarding raw events to session-signals.ts
```

### Schema additions (migration 017)

```
sessions.workflow_id            TEXT NULL
sessions.workflow_run_id        TEXT NULL
session_stages.workflow_id      TEXT NULL
session_stages.workflow_run_id  TEXT NULL

session_projections (
  session_id  TEXT,
  stage_idx   INT NULL,   -- NULL for session-level projections
  last_seq    BIGINT NOT NULL,
  PRIMARY KEY (session_id, stage_idx)
)
```

The existing `sessions.orchestrator` column (migration 011, default `'custom'`) starts taking
the value `'temporal'` when the flag routes a session through the workflow path.

### Config additions

```
config.features.temporalOrchestration: boolean        // default false
config.features.temporalOrchestrationShadow: boolean  // default false (separate flag)
config.temporal: {
  serverUrl:            string   // e.g. localhost:7234 in e2e
  namespace:            string   // 'ark-e2e' | 'ark-staging' | etc
  taskQueueAssignments: string[] // queues this worker pulls from
  workerEnabled:        boolean  // false on conductor pods, true on worker pods
}
```

**Flag read time.** Both flags are read **per request inside `SessionService.start()`**, not at
boot. The flag's value at workflow-start time binds for that workflow's lifetime -- flipping the
flag off after a workflow starts does NOT cancel it; only new sessions are diverted.

Per-tenant override via a `tenant_features` row is Phase 5's work. Phase 2 uses global flags.

### Dependencies added to `package.json`

- `@temporalio/client`
- `@temporalio/worker`
- `@temporalio/workflow`
- `@temporalio/activity`

Pinned to the version validated by the Bun-compat spike (`.infra/spikes/temporal-bun/`).

## 3. Data flow

### Happy path

```
session/start RPC
  -> SessionService.start(opts)
       validates: attachments are BlobRef locators (no inline bytes)
       checks:    mode.kind === "hosted" && features.temporalOrchestration
  -> TemporalClient.startWorkflow(sessionWorkflow, {
        workflowId: `session-${sessionId}`,
        taskQueue:  `ark.${tenantId}.stages`,
        args:       [{ sessionId, tenantId, flowName, inputs }]
     })
  -> returns { sessionId } immediately

  -- workflow runs on a Temporal worker --

sessionWorkflow:
  await startSessionActivity({...})                    // DB row + worktree
  await projectSessionActivity({status:'ready'})

  for each stage in flow:
    await resolveComputeForStageActivity({...})
    await provisionComputeActivity({...})              // long-running; heartbeats
    await projectStageActivity({status:'dispatching'})
    const launch = await dispatchStageActivity({...})  // returns when tmux pane up
    await projectStageActivity({status:'running', launch})
    const result = await awaitStageCompletionActivity({timeoutMs:stage.timeoutMs})
                                                       // long-running; 30s heartbeats
    await projectStageActivity({status:result.status, result})
    if (result.status !== 'completed') break

  await projectSessionActivity({status:terminal})
```

Activities wrap existing service functions. Side-effects execute the same code paths the bespoke
engine runs. Temporal sits above them, not in place of them.

### Signals

| Signal | Replaces |
|---|---|
| `pause`, `resume`, `stop`, `interrupt` | direct mutations on session row |
| `approveReviewGate`, `rejectReviewGate` | manual-gate poll loop |
| `messageIn` | already a channel HTTP call; unchanged |
| fan-out join | `checkAutoJoin()` DB poll -- replaced by `Promise.all` of child workflows |

### Projector consistency

Every state-changing workflow step passes `projectionSeq = workflow.info().historyLength` into
`project*Activity`. The Temporal SDK increments `historyLength` on every workflow task
(activity call, signal, timer) so it is naturally monotonic within a workflow with no
bookkeeping needed.

The projector compares against `session_projections.last_seq` in a transaction; lower or equal
seq = no-op. This makes every projection write idempotent against retries and against the shadow
orchestrator writing to the same table.

```
BEGIN;
SELECT last_seq FROM session_projections
  WHERE session_id=? AND stage_idx=? FOR UPDATE;
IF incoming_seq <= last_seq -> no-op + COMMIT;
ELSE apply patch, UPDATE last_seq, COMMIT;
```

Postgres uses row-level locks. SQLite (test-only) uses `BEGIN IMMEDIATE`.

### Shadow projector

Two modes:

- **Live shadow.** When `features.temporalOrchestrationShadow=on`, bespoke-engine sessions ALSO
  emit a synthetic workflow start with `mode='shadow'`. The shadow workflow calls
  `project*Activity` against a parallel `session_projections_shadow` table. All mutating
  activities are stubbed in shadow mode -- no second tmux pane spawns, no second PR opens.
- **Diff harness** (`packages/core/temporal/projector/diff.ts`). Reads both projection tables
  for completed sessions and reports rows where the projected `(status, stage, error, pr_url)`
  tuple differs. Used by T1 and by a staging cron (Phase 5 readiness gate).

The two flags are independent -- shadow can run on every tenant without routing any real session
through Temporal.

## 4. Error handling

### Activity retry policy

Default `{ maxAttempts: 3, initialInterval: 1s, backoff: 2.0 }`. Non-retryable types tagged via
`ApplicationFailure({ nonRetryable: true })`:

- `ValidationError`, `SessionNotFound`, `StageNotReady`, `TenantQuotaError`
- `ComputeNotFoundError`, `DispatchValidationError`, `AuthError`

Defined in `packages/core/temporal/errors.ts`.

### Workflow-level branching

Verification fail -> workflow sets a `blocked` variable and
`await workflow.condition(() => manualOverride || manualReject)`.

### Compensation

Mutating activities declare a `compensate*Activity`:

- `dispatchStageActivity` -> `stopStageActivity`
- `provisionComputeActivity` -> `deprovisionComputeActivity`
- `executeActionActivity` -> action-specific rollback where one exists

On workflow cancel, `CancellationScope` runs compensations with retry-until-success semantics.

### Heartbeat contract

- Activities >60s MUST heartbeat at <=30s interval.
- Payload carries enough state to resume on reassignment (channel offset, test index, etc.).
- Heartbeat loss -> activity fails -> next attempt resumes from last heartbeat.

## 5. Deployment

### Dev / CI (this branch)

Temporal services are **always** part of the e2e docker-compose stack -- not opt-in. Both
`test-e2e-control-plane` and `test-e2e-temporal` use the same stack.

- `.infra/docker-compose.e2e.yaml` adds `temporal` + `temporal-postgres` + `temporal-ui` on
  shifted ports (`:7234`, `:8089`) -- no clash with `make dev-temporal` (`:7233`, `:8088`).
- A `temporal-worker` service is added to the same compose file. It runs the Ark image with
  the worker entrypoint (`bun packages/core/temporal/worker.ts`). The `make test-e2e-*`
  targets depend on `make docker-build-worker` so the image is current before tests run.
- No `withTemporal` flag on `docker-stack.ts` -- Temporal is always up.
- `.env.e2e` gains `TEMPORAL_HOST=localhost:7234` and `ARK_TEMPORAL_NAMESPACE=ark-e2e`.
- New Make targets: `test-e2e-temporal-up`, `test-e2e-temporal-down`, `test-e2e-temporal`.
- `test-e2e-control-plane` continues to pass unchanged -- it ignores Temporal entirely.

### Production (design only -- Helm in Phase 4)

- Shared RDS; dedicated `temporal` logical DB; pgbouncer with capped `connection_limit`.
- Worker: separate K8s Deployment from conductor; HPA on queue depth.
- Conductor pods carry `@temporalio/client` only. Workers in their own pod template.

## 6. Refactor + delivery sequence

PR-1, PR-2, PR-6 may develop in parallel sub-branches.

```
PR-1: RF-3  declare OrchestrationDeps interface
PR-2: RF-5  finalize BlobStore migration for orchestrator inputs
PR-3: RF-1  lift hook/report cascade out of conductor           (after PR-1, PR-2)
PR-4: migration 017 + temporal/ scaffolding (no workflow yet)   (after PR-3)
PR-5: sessionWorkflow + 9 activities                            (T1 passes after this)
PR-6: shadow projector + diff harness                           (parallel with PR-5)
PR-7: T2 (crash recovery) + T3 (manual gate across restart)
PR-8: T4 (fan-out race) + T5a/5b (retry policy)
PR-9: docs update (temporal.md no-local-mode; RF-2/RF-4 deferred)
```

## 7. Test strategy -- T1 through T5

All five tests extend `e2e/control-plane.test.ts`. Same `bun test` runner, same docker-compose
pattern, same `e2e/helpers/`. New file: `e2e/temporal-control-plane.test.ts`.

### T1 -- Linear flow parity (the floor)

**Condition.** Hosted mode. Extend `e2e/helpers/server-process.ts` to seed `tenant_a` and
`tenant_b` during `beforeAll`. Set `features.temporalOrchestration=on` for `tenant_a`, `=off`
for `tenant_b`. Same `e2e-docs` flow YAML, same compute target (`local + direct`), stub-runner
runtime. RPC calls carry `X-Ark-Tenant-Id` to route tenants.

**Input.**
- `session/start` with `X-Ark-Tenant-Id: tenant_a`, `flow=e2e-docs, summary=S1`.
- `session/start` with `X-Ark-Tenant-Id: tenant_b`, `flow=e2e-docs, summary=S1`.

**Assert.**
- Both sessions reach `status=completed` within 30s.
- `stage` ends at `pr`; `error IS NULL`; `pr_url` populated; three `session_stages` rows all
  `status=completed`.
- Normalized `events` projection (modulo `session_id`, timestamps, `orchestrator` field) is
  structurally identical between tenants -- verified via the diff harness from SS3.
- `tenant_a`: `orchestrator='temporal'`, `workflow_id` populated.
- `tenant_b`: `orchestrator='custom'`, `workflow_id IS NULL`.

### T2 -- Crash recovery mid-stage (the headline win)

**Condition.** Hosted, `features.temporalOrchestration=on`. Stub-agent sleeps 30s before
posting `CompletionReport`. The `temporal-worker` compose service runs with `replicas: 2`.

**Input.**
1. `session/start` flow=`e2e-docs`. Wait for `session_stages[stage=plan].status='running'`.
2. `docker kill <temporal-worker-container-1>` (SIGKILL one worker replica).
3. Docker automatically restarts the killed container within 5s (restart policy: `on-failure`).

**Assert.**
- Session reaches `status=completed` within 60s of the kill.
- No duplicate side effects: exactly one row per stage; no duplicate `dispatch_started` events;
  at most one `ark-s-<sid>-plan` tmux pane existed at any moment.
- Workflow history shows exactly one `awaitStageCompletionActivity` that succeeded -- replayed
  from heartbeat, did not redispatch.
- `events` table contains `session_resumed_from_replay` (new event type).

### T3 -- Manual gate across server restart (the durable-wait win)

**Condition.** Hosted, `features.temporalOrchestration=on`. Flow `e2e-review`:
`plan -> review_gate (manual) -> close`.

**Input.**
1. `session/start` flow=`e2e-review`. Wait for `stage=review_gate, status=awaiting_review`.
2. `SIGTERM` the hosted server; spawn a fresh process. Preserve Postgres + Temporal cluster.
3. After 5s of new-server health, call `session/manualApprove sessionId=...`.

**Assert.**
- After restart, before approve: row still `status=awaiting_review`; no lost-poller events.
- After approve: `status=completed` within 15s; `close` stage runs exactly once.
- Workflow history shows approve signal received with `runtime > 5s` -- proves the workflow
  was parked across the restart.

### T4 -- Fan-out / join under simultaneous completion (the race win)

**Condition.** Hosted, `features.temporalOrchestration=on`. Flow `e2e-fanout`: parent fans out
to N=10 stub-agent children, then joins, then runs a `summarize` action. Stub-agent waits for a
release file (`$TMPDIR/ark-fanout-release-<childId>`) before posting `CompletionReport`.

**Input.**
1. `session/start` flow=`e2e-fanout`. Wait until 10 children have `status=running`.
2. Create all 10 release files in parallel (`Promise.all` of `writeFile`).

**Assert.**
- Parent `status=completed`; all 10 children `status=completed`.
- Exactly one `fork_joined` event on parent.
- `summarize` activity input contains all 10 children's outputs -- none missing, none repeated.
- `session_stages[stage=summarize]` ran exactly once.
- Run 50x in CI; zero flakes. Temporal-only test.

### T5 -- Retry policy + non-retryable errors (the uniform-retries win)

**Condition.** Hosted, `features.temporalOrchestration=on`. Test action `flaky-pr` configurable
via env. Retry policy: `{ maxAttempts: 5, initialInterval: 1s, backoff: 2.0 }`, non-retryable
on `AuthError`.

**Input 5a (transient -- retried).**
Configure `flaky-pr` to return 503 three times then 200.

**Assert 5a.**
Session `status=completed`. Action invoked 4 times. Stage timestamps show ~1s, ~2s, ~4s gaps.
`pr_url` populated.

**Input 5b (non-retryable -- fails fast).**
Configure `flaky-pr` to throw `AuthError`.

**Assert 5b.**
Session `status=failed` within 5s. `error` column contains `AuthError: ...`. Workflow history
shows exactly one activity invocation.

### Coverage map

| User-flow concern | Covered by |
|---|---|
| Crash recovery | T2 |
| Manual gate / durable wait | T3 |
| Long verify / heartbeat reassignment | T2 (same mechanism) |
| Fan-out / join races | T4 |
| Uniform retries + non-retryable errors | T5 |
| Per-tenant fair-share | Deferred -- load test, not correctness |
| Workflow history visibility | Checked indirectly in T2/T3/T4 via history reads |

## 8. Definition of Done

Mergeable when all of the following are true:

1. RF-1, RF-3, RF-5, RF-7 each merged as their own PR with own tests passing.
2. Migration 017 applied: sqlite + postgres halves, both green in `make drift`.
3. `make test-e2e-control-plane` green (bespoke engine still ships sessions).
4. `make test-e2e-temporal` green (T1-T5 all pass).
5. `make test` (parallel suite) green with `packages/core/temporal/` included.
6. `make lint` and `make format` green.
7. `docs/temporal.md` updated: no-local-mode scope; RF-2/RF-4 marked deferred.
8. `features.temporalOrchestration` defaults `false`.

The 24-hour shadow run on staging with zero projection diff is the Phase 5 gate (not a merge
gate for this branch).

## 9. Resolved decisions

All implementation choices are closed.

| # | Question | Decision |
|---|---|---|
| Q1 | Fan-out join mechanism | `Promise.all` of child workflow handles -- no signal, structural guarantee |
| Q2 | Review gate | Explicit `approveReviewGate` / `rejectReviewGate` signals |
| Q3 | `projectionSeq` source | `workflow.info().historyLength` -- free from SDK, naturally monotonic |
| Q4 | Worker in e2e | `temporal-worker` compose service (replicas: 2, restart: on-failure) |
