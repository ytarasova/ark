# Temporal Orchestration for Ark (Design / Phase 0)

> Status: **design-only**. Nothing in this document is implemented. Phase 0 delivers only the design + a Bun-compat spike + a local Temporal cluster. Phases 1--6 are tracked as GitHub issues (see "Migration sequence" at the bottom).
>
> Authoritative source of the existing orchestrator: `packages/core/state/flow.ts` + `packages/core/services/*-orchestration.ts` (decomposed set: `session-lifecycle.ts`, `stage-orchestrator.ts`, `task-builder.ts`, `workspace-service.ts`, `agent-launcher.ts`, `session-output.ts`).

## Why Temporal

Ark today runs a bespoke state machine: sessions carry a `status`, stages carry a `status`, and `advance()` in `stage-orchestrator.ts` is the arbiter. That model has served well through 11 compute providers and a fan-out DAG, but is creaking on:

- **Crash recovery.** If the conductor dies mid-stage we rely on status-polling + launch-pid heuristics to reconcile. Losing the `dispatching` window is easy.
- **Long-lived waits.** Manual gates, PR review, and `verify` scripts are polled. We have timers but no durable sleep primitive.
- **Fan-out joins.** `checkAutoJoin()` in `stage-orchestrator.ts` is correct but brittle; any hop through the DB is at-least-once, and collapsing that into a workflow's `Promise.all()` is how Temporal is meant to be used.
- **Retries with back-off.** Implemented per-callsite in `dispatch.ts`; the retry policy is scattered and untested against partial failures.
- **Observability of orchestration state.** We have events, but nothing like Temporal's workflow-history timeline.

Temporal gives us:
- Durable, replayable workflow state (no "what was the status at crash time?" class of bugs).
- First-class child workflows, signals, timers.
- Native retries / exponential back-off / per-error retryability.
- Worker task queues we can partition by tenant for fair-share scheduling and isolation.

## Guiding constraints

1. **No rip-and-replace.** The legacy orchestrator keeps shipping sessions during the entire migration. Temporal sits behind a feature flag (`features.temporalOrchestration`) flipped per-tenant. Phase 6 is the earliest we retire legacy code.
2. **Projection, not replacement, for reads.** The existing `sessions` / `session_stages` tables stay the read model. A projector turns workflow events into table rows. Callers keep reading the DB they read today.
3. **No bytes in workflow state.** Temporal history has a 2 MB event cap and 50 MB history cap. Large payloads (plan artifacts, analysis JSON, attachments, MCP configs) go through BlobStore; workflows carry only `BlobRef`s. This is enforced at activity boundaries.
4. **Bun-first where possible.** Conductor + arkd stay under Bun. Temporal worker host is Bun if the SDK works (spike result below), else Node. Either way: no change to Ark's primary runtime.
5. **Zero changes in Phase 0.** No code under `packages/core/state/` or `packages/core/services/*-orchestration.ts` is touched. Phase 0 is docs + infra + tracking only.

## Workflow taxonomy

Two workflow types. Both are long-running.

### `sessionWorkflow(input: SessionWorkflowInput)`
Owns one Ark session. Spawned by `SessionService.startSession()` when the tenant has the flag on, or by the projector during migration replay.

Responsibilities:
- Call `startSessionActivity` (existing `startSession()` wrapped) to create the session row + worktree.
- Iterate the flow DAG. For each stage:
  - Resolve compute (activity: `resolveComputeForStageActivity`).
  - If `stage.type === "fork" || "fan_out"`: spawn child workflows (see below), wait via `Promise.all()`.
  - Else: call `dispatchStageActivity` + `awaitStageCompletionActivity`.
- Handle signals:
  - `pause`, `resume`, `stop`, `interrupt` -- each mapped to the corresponding activity.
  - `manualApprove` / `manualReject` for review gates (replaces today's manual-gate polling).
  - `messageIn` to pass user messages into a live stage.
- Write-through projection: every state change calls `projectSessionActivity` before deciding the next step.

Cancellation: Temporal cancellation cascades to children. Session stop -> cancel workflow -> Temporal cancels in-flight activities -> activities run their compensation (kill tmux pane, mark stage `stopped`).

### `stageWorkflow(input: StageWorkflowInput)`
Owns one fan-out child task. Exists so a parent `sessionWorkflow` can `Promise.all()` over dozens of stages without exploding the parent's history.

Scope: single stage. Activities only -- no nested children. This keeps the history per workflow bounded.

### Spawn rules (`sessionWorkflow` -> `stageWorkflow`)
- Linear / DAG stages: executed **inline** (no child workflow). Keeps parent history compact when the common case is 3--6 stages.
- `fork` / `fan_out` with >1 subtask: **one child workflow per subtask**. Fan-out of 20 subagents = 1 parent + 20 children.
- `depends_on`-based DAGs: parent resolves the topological order and scheduler starts children as their deps complete. The parent uses `workflow.condition()` to gate.
- Child-workflow task queue inherits from parent (`ark.<tenantId>.stages`) unless the stage's compute kind needs a dedicated queue (`ark.compute.<kind>`, see below).

## Activity catalog

One activity per existing Ark side-effect, plus a handful of idempotent projector activities. Every activity is implemented as a thin wrapper over an existing `services/*-orchestration.ts` function. The wrapper is the only new code.

All activities take `{ tenantId, sessionId, ...args }`, are idempotent by `(sessionId, stageIdx, activityName)` key (we pass `workflow.info().activityId` into the DB to dedupe), and log via the existing `structured-log.ts`.

### Schema sketch
Input / output types live in `packages/core/temporal/types.ts` (Phase 2). For now, reference existing types:

| Activity | Input (existing type) | Output | Retry | Heartbeat | Compensation |
|---|---|---|---|---|---|
| `startSessionActivity` | `StartSessionInput` from `services/session-lifecycle.ts` | `{ sessionId }` | 3 attempts, 1s initial, 2.0 backoff. Non-retryable: `ValidationError`, `TenantQuotaError`. | n/a (fast) | On cancel: `deleteSessionAsync` |
| `resolveComputeForStageActivity` | `{ sessionId, stageIdx }` | `ComputeTarget` (existing) | 5 attempts, 2s initial, 2.0 backoff. Non-retryable: `ComputeNotFoundError`. | n/a | None (read-only) |
| `provisionComputeActivity` | `ComputeTarget` | `{ computeId, endpoint }` | 3 attempts, 5s initial, 2.0 backoff. Non-retryable: `ProviderQuotaError`, `AuthError`. | 30s (long-running for k8s/firecracker/ec2) | `deprovisionComputeActivity` |
| `dispatchStageActivity` | `{ sessionId, stageIdx, prompt: BlobRef, env, isolation }` | `{ launchPid, channelPort, tmuxSession }` | 3 attempts, 1s initial, 2.0 backoff. Non-retryable: `DispatchValidationError`, `AgentNotFoundError`. | n/a (finishes on launch, not completion) | `stopStageActivity` |
| `awaitStageCompletionActivity` | `{ sessionId, stageIdx, timeoutMs }` | `StageResult` (existing) | 1 attempt. Activity itself runs arbitrarily long. | 60s. Heartbeat payload = latest stage status. | On cancel: `stopStageActivity` |
| `runVerificationActivity` | `{ sessionId, stageIdx, scripts: string[] }` | `{ ok, logs: BlobRef }` | 2 attempts, 5s initial, 2.0 backoff. Non-retryable: `VerificationScriptError`. | 30s | None (read-only) |
| `executeActionActivity` | `{ sessionId, stageIdx, action, inputs }` | `{ outputs }` | Per-action default: 3 attempts, 2s initial, 2.0 backoff. Action-specific overrides published alongside each action in `services/actions/`. Non-retryable list: `AuthError`, `NotFound`, `Conflict409`. | 30s for long-running actions (GitHub PR, Jira update). | Action-specific `compensate*Activity` for actions that have a rollback (PR close, branch delete). Most actions are idempotent + no-op on duplicate. |
| `joinForkActivity` | `{ sessionId, parentStageIdx }` | `{ aggregated }` | 3 attempts, 1s initial, 2.0 backoff. | n/a | None |
| `sendMessageActivity` | `{ sessionId, stageIdx, payload: BlobRef }` | `{ messageId }` | 5 attempts, 500ms initial, 2.0 backoff. Non-retryable: `ChannelClosed`. | n/a | None (append-only) |
| `projectSessionActivity` | `{ sessionId, patch }` | `void` | 10 attempts, 200ms initial, 1.5 backoff. Must remain idempotent (see projector section). | n/a | None |
| `projectStageActivity` | `{ sessionId, stageIdx, patch }` | `void` | 10 attempts, 200ms initial, 1.5 backoff. Idempotent. | n/a | None |
| `stopStageActivity` (compensation) | `{ sessionId, stageIdx, reason }` | `void` | Retry indefinitely with 30s cap. Compensation activities MUST eventually succeed or escalate to on-call. | n/a | Terminal |
| `deprovisionComputeActivity` (compensation) | `{ computeId }` | `void` | Same as above. Idempotent. | n/a | Terminal |
| `uploadBlobActivity` | `{ tenantId, namespace, filename, bytes }` | `BlobRef` | 5 attempts, 500ms initial, 2.0 backoff. Non-retryable: `QuotaExceeded`. | 30s for >10 MB | None (put is idempotent by content hash) |
| `downloadBlobActivity` | `BlobRef` | `{ bytes }` | 5 attempts, 500ms initial, 2.0 backoff. | 30s | None |

### Retryable error taxonomy
- **Retryable** (default): network, 5xx from compute providers, SQLite busy, SIGPIPE on tmux.
- **Non-retryable** (must declare in each policy): validation, quota, auth, 4xx. Declared via the activity throwing a tagged error class (`ValidationError extends ApplicationFailure` with `nonRetryable: true`).

### Heartbeat contract
Any activity whose normal runtime exceeds 60 seconds MUST heartbeat at <= half its `heartbeatTimeout`. Loss of heartbeat -> Temporal fails the activity -> worker retries per policy. Heartbeat payload should be enough to resume (e.g. "I'm at step 7/12 on $stage"), so future versions can turn these into resumable activities.

### Cancellation semantics
- All activities are cancellable. A cancellation raises `CancelledFailure` inside the activity.
- Activities MUST install a cleanup handler that (a) kills any child process, (b) writes a `stopped` projection, (c) releases compute leases, and (d) rethrows so the workflow sees `CancelledFailure` rather than success.
- Compensation activities (`stopStageActivity`, `deprovisionComputeActivity`) run in `CANCELLED` workflow state via `CancellationScope`. They retry indefinitely because a stuck compute lease is worse than a retry loop.

## Task queue taxonomy

```
ark.<tenantId>.stages     -> default queue for sessionWorkflow / stageWorkflow + lightweight activities
ark.<tenantId>.system     -> tenant-scoped side-effects (project activities, PR / Jira actions)
ark.compute.<kind>        -> long-running compute-specific activities
                             where <kind> in {local, docker, devcontainer, firecracker, e2b, k8s, k8s-kata, ec2-*}
ark.blob                  -> uploadBlobActivity / downloadBlobActivity (sharded by backend; local vs s3)
```

### Routing rules
- Workflows run on `ark.<tenantId>.stages`. One tenant's backlog cannot block another's.
- Fast activities (DB writes, projections, sendMessage) run on the same tenant queue the workflow uses. Keeps affinity tight + cold-cache misses rare.
- Compute-provisioning activities are pinned to `ark.compute.<kind>`. This lets us scale the k8s worker pool independently of the ec2 one, and keeps the tenant queue out of the critical path while a 30-second k8s pod boot runs.
- BlobStore activities run on `ark.blob` so we can give them a pool sized to the S3 / local-disk backend, not the CPU-bound tenant queue.

### Per-tenant capacity
Each tenant's queue gets a bounded worker set. In `control-plane` profile the worker host scales horizontally and pulls from the subset of queues assigned to it (config: `config.temporal.taskQueueAssignments`). Local mode = single worker, all queues.

## Projector consistency model

> This is the hard part. Getting it wrong risks duplicate rows, stale UI, or a flag flip that silently loses sessions.

The DB is the read model. Workflows are the source of truth for state transitions. Two coordinates matter:

- **`sessionId`** -- the logical session. Unchanged during migration.
- **`workflowRunId`** -- Temporal's run identifier. New rows carry it; legacy rows have NULL.

### Shape of the projection
We add three columns (Phase 2 migration):
```sql
ALTER TABLE sessions ADD COLUMN orchestrator TEXT NOT NULL DEFAULT 'legacy';  -- 'legacy' | 'temporal'
ALTER TABLE sessions ADD COLUMN workflow_id TEXT;                              -- Temporal workflow id
ALTER TABLE sessions ADD COLUMN workflow_run_id TEXT;                          -- Temporal run id
```
(Same on `session_stages` so we can tie individual stage rows back to workflow events.)

Projections write via `projectSessionActivity` / `projectStageActivity`. Each takes a patch and a **projection key** `(sessionId, stageIdx, projectionSeq)` where `projectionSeq` is a monotonic counter emitted by the workflow. The projector stores the last-applied `projectionSeq` per `(sessionId, stageIdx)` in a `session_projections` sidecar table (indexed by `(sessionId, stageIdx)`).

### Out-of-order event handling
Temporal guarantees at-least-once activity delivery but not per-activity ordering across retries of different activities. The workflow emits a monotonic `projectionSeq` on every projection call. The projector runs the patch inside a transaction:

```
BEGIN;
SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx=? FOR UPDATE;
IF incoming_seq <= last_seq -> no-op + COMMIT;
ELSE apply patch, UPDATE last_seq, COMMIT;
```

An out-of-order or retried patch is a cheap no-op. Postgres gets row-level locks; SQLite (local mode) gets a `BEGIN IMMEDIATE`.

### Retry-causing duplicate projections
Same mechanism -- the `projectionSeq` gate drops duplicates. Because projection activities are idempotent *and* gated, Temporal can retry them freely without corruption. The projector is explicitly NOT supposed to be correct on its own; it relies on the workflow being the oracle.

### Flag-flip mid-session
We do NOT migrate in-flight sessions. When `features.temporalOrchestration` flips on for a tenant:
1. New `startSession()` calls take the Temporal path.
2. In-flight legacy sessions keep running on the old orchestrator until terminal (`completed|failed|stopped|archived`).
3. Reads go through a dispatching layer (see below) that keys on `sessions.orchestrator`.

Flipping the flag off mid-session: new sessions go legacy; already-running Temporal sessions finish under Temporal. A "drain before retire" operator workflow tracks the remaining Temporal sessions under a retired tenant.

### Legacy + Temporal coexistence
Both write to the same `sessions` + `session_stages` tables. `sessions.orchestrator` partitions them. Every read path that resolves "what's the current state of this session?" sees a consistent row regardless of which orchestrator owns it. Every write path that would mutate state (`advance`, `dispatch`, etc.) MUST first check `orchestrator`:
- `legacy`: current code path unchanged.
- `temporal`: the write is rejected at the service boundary; callers must signal the workflow (`pause`, `resume`, `manualApprove`, etc.) instead. For Phase 2 we ship a thin adapter in `SessionService` that turns a legacy-style call into a Temporal signal.

### Reads that must hit either path transparently
All existing reads (`SessionRepository.getById`, `listStages`, `listByTenant`, etc.) read tables, not workflows. They keep working. What they do NOT have is low-latency "current workflow activity" visibility. If we want that (e.g. "dispatch pending, waiting on compute lease"), we add a thin RPC `describeWorkflow(sessionId)` that goes through the Temporal client on demand. Not on the hot path.

### Event bus
The existing `hooks.eventBus` and the `events` table are written by the projector, so SSE consumers (web UI, `ark stream`) don't change.

## Feature-flag state machine

Flag: `features.temporalOrchestration` (type `bool`, default `false`, source: `config.features` + optional per-tenant override in a `tenant_features` table added in Phase 5).

States:
- `off (default)`: every session dispatches via legacy. Temporal worker may or may not be running -- irrelevant.
- `shadow`: legacy owns the session. A sidecar `sessionWorkflow` is also started per session; it only runs projection activities to a parallel `session_stages_shadow` table. We diff the shadow rows against the real rows in CI. No user-visible change. This is Phase 2's exit criterion.
- `on`: new sessions start under Temporal. Legacy sessions continue as-is. This is Phase 5.
- `retired`: legacy orchestrator code deleted. Only Temporal. This is Phase 6.

Transitions: `off -> shadow -> on -> retired`. Backwards transitions allowed in Phases 2--5 as escape hatches (bail out of Temporal; new sessions go legacy again). Phase 6 is one-way.

## BlobStore integration

**The rule: no Ark-owned byte payload larger than 256 KiB goes through a workflow input or output.**

Rationale: Temporal history is 2 MB per event (hard), 50 MB per workflow (hard), and event sourcing means every retained event stays in history forever. A session that passes a 500 KB plan artifact through a workflow input 20 times over its life hits 10 MB of history just from that. Crossing the cap kills the workflow and there is no easy recovery.

Callsites that already handle large payloads (already BlobStore-ready):
- Session input uploads -- `packages/core/storage/__tests__/save-input.test.ts` et al.
- Sage analysis JSON -- `packages/core/services/actions/fetch-sage-analysis.ts`.

Callsites that inline bytes today and must migrate to BlobStore **before Phase 2** (tracked in Phase 1 issue):
- Plan artifact serialized inline on stage transition (`services/plan-artifact.ts`).
- Task-builder prompt, when rendered with large inputs (`services/task-builder.ts`).
- Worktree diff captured in stage outputs (`services/workspace-service.ts`).
- MCP config injected into the dispatch env (`services/dispatch.ts`).
- Stage output capture (`services/session-output.ts`).
- Session snapshot / restore (`services/session-snapshot.ts`).

Audit procedure (Phase 1 acceptance): `rg -n 'writeFileSync|readFileSync|Buffer\.from' packages/core/services` then mark each hit either "small + bounded" (<= 4 KiB, commit a comment) or "large + must BlobStore" (file issue, land migration). Automated gate: an ESLint rule that fails the build if any service module passes a `Buffer` bigger than 256 KiB into an activity-bound function (Phase 2 adds the rule; Phase 1 grandfathers).

Every activity that accepts a large payload takes a `BlobRef` (locator + tenantId + optional content hash). Activities expand it via `downloadBlobActivity` inside their own scope. Activities that produce a large payload call `uploadBlobActivity` first and return the `BlobRef`.

## RDS co-tenancy risks

Production Temporal runs on a shared RDS cluster with the Ark control plane. This is **not** the local-dev model -- local dev uses a dedicated `temporal-postgres` container, see `.infra/docker-compose.temporal.yaml`.

Risks and mitigations:

- **Write-heavy workload.** Temporal persists every workflow event. At 100 concurrent sessions with 20 activities each, we're at ~4k--10k writes per minute. Mitigation: separate `temporal` logical database within the RDS cluster, dedicated `temporal` Postgres role with capped connections, parameter-group tuning (`autovacuum_max_workers`, `max_wal_size`). Before we cut over in production, Ops provides a write-amplification ceiling and we load-test at 2x.
- **Connection pool pressure.** Temporal history + matching + frontend services each maintain their own pool. With default sizing + Ark's own pool we can exhaust `max_connections` on a modest RDS instance. Mitigation: `pgbouncer` layer sized per-service; RDS instance sized for `expected workflow concurrency x 3 + ark pool size x 2`. Ops sizes the instance before Phase 4.
- **Schema isolation.** Temporal installs its own schema (`temporal_visibility`, `temporal` schemas). We isolate by logical database, NOT schema -- Temporal's own DDL expects to own its database. Ark's schema lives in a separate logical DB. Two DBs, one RDS instance.
- **Backup / restore coupling.** A full-cluster snapshot captures both DBs at the same point; a selective restore is harder. Mitigation: documented restore playbook in `docs/temporal-ops.md` (Phase 4) that covers "restore only Ark" and "restore both". Disaster recovery RTO must assume the worst case.
- **Failure blast radius.** Temporal DB pressure can starve Ark's DB connections. Mitigation: `pgbouncer` per logical DB, separate IAM role with capped `connection_limit`, CloudWatch alarm on Temporal DB CPU at 70%. If we cross 80% sustained, we promote Temporal to its own RDS cluster (Phase 4.5, not planned but not forbidden).

Decision: start on shared RDS with the above guardrails. Revisit after 30 days of production traffic. Separate cluster only if metrics demand it.

## Bun-vs-Node worker decision

We ran the Phase 0 spike (`.infra/spikes/temporal-bun/` + `scripts/spike-temporal-bun.sh`) against Bun 1.3.11 on darwin-arm64.

Results:
- `import @temporalio/worker`: PASS
- `import @temporalio/workflow / activity / client`: PASS
- `bundleWorkflowCode()` (webpack bundler): PASS -- bundled 977 KiB, webpack 5.106.2 compiled in ~140 ms.
- `Worker.create()` native core-bridge load: PASS -- the Rust NAPI addon loads under Bun and attempts a transport connection (we expect a `TransportError: Connection refused` because the spike does not start a server; this is fine -- the bridge demonstrably loaded).
- Runtime warning observed: `v8.promiseHooks.createHook is not available; stack trace collection will be disabled.` This means the workflow-stack-traces feature -- useful for debugging stuck workflows via `temporal workflow stack` -- is unavailable under Bun. Workflows still run correctly; we lose an inspection tool.

**Verdict: Bun-compatible, with caveats.**

Recommendation:
- Local dev: run worker under Bun (consistent with the rest of Ark).
- Production: start on Bun. If we lose the `workflow stack` debugging surface during an incident, or if a future SDK upgrade regresses on Bun, switch the worker process to Node. The worker is a separate process -- dual-process deployment is cheap.

Decision criteria (when to switch to Node):
1. A Bun-specific crash or memory leak we can reproduce on Node-hosted worker cannot.
2. Upstream Temporal releases a Bun-incompatible worker version we cannot skip.
3. Ops asks for `temporal workflow stack` during an incident and we cannot provide it.

Tracking: Phase 4 issue "Helm sub-chart + RDS co-tenancy" documents the deployment. The Helm chart ships with `runtime: bun` default and `runtime: node` as a supported alternative.

## Failure modes (explicit)

| Failure | Symptom | Recovery |
|---|---|---|
| Temporal server down | Workflows cannot advance; SessionService fails fast on new-session dispatch. Running sessions are pinned (no writes reaching DB) until server returns. | Alarm on frontend health; auto-restart; if prolonged, page on-call. Running sessions resume on their own once history replay completes. |
| Worker pool down | Backlog on `ark.<tenant>.stages`. No visible corruption; latency rises. | Scale workers; inspect task queue via `temporal task-queue describe`. |
| Worker crashes mid-activity | Temporal retries per policy. Compensation activities run if the workflow is cancelled. | No action -- Temporal handles it. Investigate root cause from worker logs. |
| RDS failover | 30--60s of workflow stall + activity retries. | None required; retries absorb the stall. If it exceeds 2 minutes, page. |
| Projector lag | UI shows stale session state for a few seconds after the workflow advances. | Acceptable. Projector runs inside an activity with its own retry. Chronic lag -> investigate DB hot rows. |
| Duplicate projections | Sidecar table gate drops them. | No action. Visible in projector logs as `seq <= last_seq`. |
| Flag flipped off during in-flight Temporal sessions | Running Temporal sessions continue; new sessions legacy. | Operator drains via `temporal workflow list --namespace ark-<tenant>` until empty. |
| Bytes-in-workflow-state breach | Activity throws when encoding payload > 256 KiB without a `BlobRef`. | Bug in the activity wrapper. Add BlobStore step, redeploy. Cannot fix in-flight -- that workflow is already broken; cancel + re-run from the last completed stage (durable state helps). |
| History size approaching 50 MB | Temporal warns at 40 MB. | Workflow calls `continueAsNew` with the current session state to start a fresh history. `sessionWorkflow` checks history size every activity completion and rolls over if near the cap. |
| Tenant queue starvation | One tenant's backlog grows; others fine (isolated queues). | Scale workers for that queue; check for a runaway retry on a broken activity. |

## Migration sequence

Tracked in GH meta-issue **#374** (Temporal orchestration rollout).

| Phase | Issue | Scope | Exit criteria |
|---|---|---|---|
| **0 (this doc)** | #374 | Design + Bun spike + local cluster + tracker issues. No code changes. | Issues filed; `make dev-temporal` works; spike result documented. |
| **1: BlobStore audit** | #368 | Find every inline-bytes site in the legacy orchestrator; convert to BlobStore. ESLint rule that gates new violators. | `rg -n 'writeFileSync|readFileSync|Buffer\.from' packages/core/services` has no unexplained hits; every service I/O site is either `<= 4 KiB` or `BlobRef`. |
| **2: Client wrapper + shadow projector** | #369 | Add `packages/core/temporal/` with a client wrapper, a minimal `sessionWorkflow`, the first two activities (`startSessionActivity`, `awaitStageCompletionActivity`). New sessions in `test` profile can opt into shadow mode. | Shadow projector diff is 0 over a 24-hour run on staging. |
| **3: Activity catalog buildout** | #370 | Port every stage kind to activities. Unit + integration tests per activity. Compensation activities for cancellation paths. | All stage kinds covered; flow tests pass on both legacy and temporal paths. |
| **4: Helm sub-chart + RDS coordination** | #371 | Ship the worker as a sub-chart. Ops provisions the shared RDS logical DB, pgbouncer, IAM roles. Load-test at 2x expected throughput. | Staging runs Temporal-backed sessions for 1 tenant for 7 days, zero orchestration-related incidents. |
| **5: Projector to real tables + flag flip for new sessions** | #372 | Flip `features.temporalOrchestration=on` per-tenant. Legacy drains naturally. Per-tenant override in `tenant_features` table. Reads unified behind `SessionService`. | Two early-access tenants on Temporal for 30 days; parity with legacy on all SLOs. |
| **6: Retire legacy** | #373 | Delete `packages/core/services/stage-orchestrator.ts` (and its siblings) and `packages/core/state/flow.ts`. `sessions.orchestrator` column fixed to `'temporal'`. Migration script archives anything `orchestrator='legacy'`. | No references to legacy orchestrator in tree; docs updated; `features.temporalOrchestration` removed. |

## Appendix: worked example (linear flow)

```
User -> ark session start --recipe plan-then-build

SessionService.startSession()
  -> featureEnabled(temporalOrchestration, tenantId)  // true
  -> temporalClient.start('sessionWorkflow', {
       workflowId: `session-${sessionId}`,
       taskQueue:  `ark.${tenantId}.stages`,
       args: [{ sessionId, tenantId, flowName: 'plan-then-build' }]
     })
  -> return { sessionId }                            // caller sees no change

sessionWorkflow(input) {
  await startSessionActivity(input)                   // row created, worktree set up
  await projectSessionActivity({ status: 'ready' })

  for (const stage of flow.stages) {
    const compute = await resolveComputeForStageActivity({ sessionId, stageIdx: stage.idx })
    await provisionComputeActivity(compute)

    await projectStageActivity({ stageIdx: stage.idx, status: 'dispatching' })
    const launch = await dispatchStageActivity({ sessionId, stageIdx: stage.idx, prompt })
    await projectStageActivity({ stageIdx: stage.idx, status: 'running', launch })

    // Long-running; heartbeats carry stage status + last-seen-event-id.
    const result = await awaitStageCompletionActivity({ sessionId, stageIdx: stage.idx, timeoutMs: stage.timeoutMs })
    await projectStageActivity({ stageIdx: stage.idx, status: result.status, result })

    if (result.status !== 'completed') break
  }

  await projectSessionActivity({ status: 'completed' })
}
```

User-visible change: none. The `sessions` and `session_stages` rows evolve exactly as they do today.
