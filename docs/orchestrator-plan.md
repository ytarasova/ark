# Orchestrator refactor plan — `AppMode.orchestrator`

**Status:** design. Written 2026-04-21 after the "Temporal is hosted-only" scope correction. Counterpart to `docs/temporal.md`.

**Goal:** one polymorphic capability slot so callers never branch on mode. Local mode keeps its bespoke state machine forever; hosted mode gets Temporal. Same pattern as `AppMode.database`, `AppMode.secrets`, `AppMode.tenantResolver`.

---

## 1. Surface we already have

`SessionService` (`packages/core/services/session.ts`) is the **single facade** all callers use today. Every handler, CLI command, Web hook, and trigger dispatcher calls `app.sessionService.{start, stop, advance, resume, ...}`. That's the boundary we preserve; no handler or CLI change needed.

**20 public methods on SessionService** today, grouped by concern:

| Concern | Methods |
|---|---|
| Lifecycle | `start`, `stop`, `stopAll`, `complete`, `archive`, `restore`, `delete`, `undelete` |
| Execution | `dispatch`, `advance`, `resume`, `pause`, `interrupt`, `send` |
| Fan-out | `fork`, `clone`, `spawn`, `fanOut`, `handoff` |
| Runtime | `saveInput`, `drainPendingDispatches`, `getOutput`, `waitForCompletion`, `worktreeDiff`, `finishWorktree` |

Internally it delegates to module-level functions in:
- `packages/core/services/session-orchestration.ts` — re-export barrel
- `packages/core/services/session-lifecycle.ts` — start / stop / delete / persist
- `packages/core/services/stage-orchestrator.ts` — dispatch / advance / fork / fanOut / subagents
- `packages/core/services/dispatch.ts` — the central dispatch function (the state-machine arbiter)
- `packages/core/services/stage-advance.ts` — stage transitions
- `packages/core/services/actions/` — action-stage handlers
- `packages/core/services/fork-join.ts` — fork + auto-join logic
- `packages/core/services/subagents.ts` — subagent spawn
- `packages/core/services/session-hooks.ts` — manual-gate approve/reject + report status

**Two top-level functions** in `session-orchestration.ts` that aren't on SessionService:
- `approveReviewGate(app, sessionId)`
- `rejectReviewGate(app, sessionId, reason)`

These are called from handlers directly — should fold onto SessionService for consistency (small refactor, part of prep work).

---

## 2. `OrchestratorCapability` interface

Under `packages/core/modes/orchestrator.ts`:

```ts
import type { Session, CreateSessionOpts } from "../../types/session.js";

export interface OpResult {
  ok: boolean;
  message?: string;
  sessionId?: string;
}

export interface OrchestratorCapability {
  /** Create a new session row + emit session_created event. */
  createSession(opts: CreateSessionOpts): Promise<Session>;

  /** Advance the state machine one tick — compute-resolves, launches stage, or handles action. */
  dispatch(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<OpResult>;

  /** Manually advance past the current stage (used by gates + the advance handler). */
  advance(sessionId: string, opts?: { force?: boolean; outcome?: string }): Promise<OpResult>;

  /** Terminal transition — session ends with status="completed". */
  complete(sessionId: string): Promise<OpResult>;

  /** Stop the running process (if any) + mark session stopped. */
  stop(sessionId: string, opts?: { force?: boolean }): Promise<OpResult>;

  /** Pause without killing the process. */
  pause(sessionId: string, reason?: string): Promise<OpResult>;

  /** Resume from current stage or rewound stage. */
  resume(sessionId: string, opts?: { rewindToStage?: string }): Promise<OpResult>;

  /** Interrupt the running agent (send SIGINT-equivalent). */
  interrupt(sessionId: string): Promise<OpResult>;

  /** Deliver a user message to the running agent. */
  send(sessionId: string, message: string): Promise<OpResult>;

  /** Manual-gate approve / reject. */
  approveReviewGate(sessionId: string): Promise<OpResult>;
  rejectReviewGate(sessionId: string, reason: string): Promise<OpResult>;

  /** Handoff current stage to a named agent with optional instructions. */
  handoff(sessionId: string, agent: string, instructions?: string): Promise<OpResult>;

  /** Spawn child session. */
  spawn(parentSessionId: string, opts: SpawnOpts): Promise<OpResult>;

  /** Fan-out N parallel subagents. */
  fanOut(sessionId: string, opts: { tasks: FanOutTask[] }): Promise<OpResult>;
}

export interface SpawnOpts {
  summary: string;
  agent?: string;
  flow?: string;
  inputs?: Record<string, unknown>;
}

export interface FanOutTask {
  summary: string;
  agent?: string;
  flow?: string;
}
```

### What the interface does NOT cover

These stay on `SessionService`; they are local concerns or read-only facades:

- `stopAll()` — process-level shutdown hook (arkd uses this on SIGTERM). Not a per-session op.
- `drainPendingDispatches()` — arkd worker graceful drain.
- `saveInput()` — BlobStore write. Belongs on the BlobStore / input-upload service.
- `getOutput()` / `waitForCompletion()` — read-only status peeks. Stay on SessionService as pass-throughs.
- `worktreeDiff()` / `finishWorktree()` — worktree tools. Belong on a `WorktreeService` (refactor opportunity, not in scope for this issue).
- `archive` / `restore` / `delete` / `undelete` — soft-delete surface. Belongs on `SessionRepository` wrapped by SessionService.
- `fork` / `clone` — row-level operations that don't run the state machine.

`SessionService` becomes thin: it owns the lifecycle (session rows, events, listeners, defaults) and delegates the **execution** concerns to `app.mode.orchestrator.*`.

---

## 3. `LocalOrchestrator` implementation

`packages/core/modes/orchestrators/local.ts`:

```ts
import type { AppContext } from "../../app.js";
import * as dispatchFns from "../../services/dispatch.js";
import * as stageAdvance from "../../services/stage-advance.js";
import * as forkJoin from "../../services/fork-join.js";
import * as subagents from "../../services/subagents.js";
import * as lifecycle from "../../services/session-lifecycle.js";
import * as hooks from "../../services/session-hooks.js";

export class LocalOrchestrator implements OrchestratorCapability {
  constructor(private readonly app: AppContext) {}

  async createSession(opts) { return lifecycle.startSession(this.app, opts); }
  async dispatch(id, opts) { return dispatchFns.dispatch(this.app, id, opts); }
  async advance(id, opts) { return stageAdvance.advance(this.app, id, opts?.force ?? false, opts?.outcome); }
  async stop(id, opts) { return lifecycle.stopSession(this.app, id, opts); }
  async resume(id, opts) { return dispatchFns.resume(this.app, id, opts); }
  async pause(id, reason) { return lifecycle.pauseSession(this.app, id, reason); }
  async interrupt(id) { return lifecycle.interruptSession(this.app, id); }
  async complete(id) { return stageAdvance.complete(this.app, id); }
  async send(id, msg) { return lifecycle.sendMessage(this.app, id, msg); }
  async approveReviewGate(id) { return hooks.approveReviewGate(this.app, id); }
  async rejectReviewGate(id, reason) { return hooks.rejectReviewGate(this.app, id, reason); }
  async handoff(id, agent, instr) { return stageAdvance.handoff(this.app, id, agent, instr); }
  async spawn(parentId, opts) { return subagents.spawn(this.app, parentId, opts); }
  async fanOut(id, opts) { return forkJoin.fanOut(this.app, id, opts); }
}
```

**Zero rewrites.** Thin delegation wrapping existing functions. Because functions already take `app` as an explicit first argument, there's no hidden ambient-state coupling to untangle.

Wiring: `buildLocalAppMode(app)` registers `mode.orchestrator = new LocalOrchestrator(app)`.

`SessionService` changes:
```diff
- async dispatch(id, opts) { return dispatchFns.dispatch(this._app, id, opts); }
+ async dispatch(id, opts) { return this._app.mode.orchestrator.dispatch(id, opts); }
```
One diff per execution method. Lifecycle + read methods untouched.

---

## 4. `TemporalOrchestrator` implementation (hosted mode)

`packages/core/temporal/orchestrator.ts`:

```ts
export class TemporalOrchestrator implements OrchestratorCapability {
  constructor(private readonly client: TemporalClient, private readonly app: AppContext) {}

  async createSession(opts): Promise<Session> {
    const session = await lifecycle.startSession(this.app, opts);  // same row creation
    await this.client.workflow.start("sessionWorkflow", {
      workflowId: `session-${session.id}`,
      taskQueue: `ark.${session.tenant_id}.stages`,
      args: [{ sessionId: session.id, tenantId: session.tenant_id }],
    });
    return session;
  }

  async dispatch(id): Promise<OpResult> {
    // No-op — sessionWorkflow advances itself. Kept for API parity.
    return { ok: true, message: "dispatch is implicit in Temporal mode" };
  }

  async advance(id, opts): Promise<OpResult> {
    await this.client.workflow.getHandle(`session-${id}`).signal("advance", opts);
    return { ok: true };
  }

  async stop(id, opts): Promise<OpResult> {
    await this.client.workflow.getHandle(`session-${id}`).cancel();
    return { ok: true };
  }

  async pause(id, reason): Promise<OpResult> {
    await this.client.workflow.getHandle(`session-${id}`).signal("pause", { reason });
    return { ok: true };
  }

  // …resume / interrupt / send / approveReviewGate / rejectReviewGate / handoff /
  // spawn / fanOut all route as signals to the sessionWorkflow.
}
```

Inside the workflow, activities wrap the same functions `LocalOrchestrator` calls directly. Retry / heartbeat / cancellation policies live on the activity; the underlying function stays unchanged.

---

## 5. Refactors needed before the capability can land

All small. Numbered for independent issue filing.

### R1. Consolidate `approveReviewGate` / `rejectReviewGate` onto SessionService (S)
Two top-level functions in `session-orchestration.ts` — fold them onto SessionService so the capability surface matches the service surface. Handlers that call the functions today get migrated to the method call.

### R2. Surface explicit `OpResult` return type (S)
Several orchestration functions return `{ok, message}` loosely typed. Promote `OpResult` to a shared type in `packages/types/session.ts` and tighten signatures.

### R3. Split action-stage dispatch path from the dispatch() function (M)
Today `dispatch.ts:250` handles both agent-launch AND action-stage execution. For Temporal, these need to become two activities (one invokes an arkd worker to launch an agent; one runs in-process inside the workflow worker). The split is small but the function body exceeds 350 LOC; worth extracting `dispatchActionStage(app, sessionId, stage)` and keeping `dispatch()` as the branch point.

### R4. Event emission isolation (M)
`session_created`, `stage_ready`, `action_executed`, `session_completed` events are emitted inline inside the orchestration functions today. Temporal workflows can't have side effects; the Temporal activity path needs to emit events inside activities. Introduce an `OrchestratorEvents` helper that each orchestrator constructs — `LocalOrchestrator` uses the existing `app.events.log(...)` directly; `TemporalOrchestrator` emits from inside activities.

Not a breaking change for local mode — same events fire from the same function bodies.

### R5. `stopAll` / `drainPendingDispatches` stay on SessionService (S)
These are process-shutdown concerns, not per-session ops. Document their lifecycle ownership, don't thread through the capability.

### R6. Move `reviewgate` handler helpers out of `session-hooks.ts` if needed (S)
Small cleanup — if `session-hooks.ts` is a grab bag, it may deserve a split. Scope: inspect and decide; fold into R1 if the target file is already clean.

### R7. Type `SpawnOpts` + `FanOutTask` in one place (S)
Today these are inferred from function signatures. Promote to the shared types package.

### R8. `dispatch.dispatch()` return: surface whether a stage actually started vs was already running (S)
Today it returns `{ok: true, message: "Already running (...)"}` when idempotency kicks in. Temporal needs to know the distinction (did I spawn a workflow or not?). Add an `outcome: 'started' | 'already_running' | 'action_completed' | 'blocked'` discriminator.

---

## 6. Ordered implementation sequence

1. **R1–R8 refactors** land as independent PRs. Each is small + merge-independent. Unblocks Phase 2.
2. **Capability interface lands** in `packages/core/modes/orchestrator.ts`. Wired into `AppMode` type + `buildLocalAppMode` + `buildHostedAppMode` (hosted stub for now).
3. **`LocalOrchestrator` class** lands with the thin delegation. `SessionService` methods rewired through `app.mode.orchestrator.*`.
4. **Test gate**: full `make test` passes with zero behavioral change — the capability is a pure introduction. Run all existing orchestration tests.
5. **Commit + deploy** local mode with the capability seam in place. No hosted behavior change yet.
6. **`TemporalOrchestrator` lands** (Phase 2 as re-scoped in #369). First workflow covers the simplest action-stage flow. Hosted integration test via `make dev-temporal`.
7. **Activity catalog buildout** moves to Phase 3 (#370).

---

## 7. What doesn't change (explicit)

- `SessionService` stays. Callers stay.
- `packages/core/state/flow.ts` stays.
- `packages/core/services/*-orchestration.ts` files stay.
- The set of events emitted from a session stays identical in local mode.
- `arkd` does not gain Temporal coupling in local mode.
- No change to the DB schema from this refactor (Temporal stores its own state in its own DB).

---

## 8. Open design questions

1. **Subagent dispatch in Temporal mode.** `spawn` / `fanOut` in LocalOrchestrator creates DB rows + calls `dispatch` recursively. In Temporal mode, the parent workflow should start child workflows. Is the child-workflow lifecycle tied to the parent session's workflow via `workflow.child()`, or is each subagent a top-level workflow with a parent reference on the row? **Proposal:** top-level workflows with `parentSessionId` — keeps fan-out of 20+ children from blowing the parent's workflow history.

2. **Event ordering guarantees.** Local mode emits events synchronously; Temporal activities could emit out of order if retried. Do we need monotonic event sequencing, or is `created_at` ordering sufficient?

3. **`spawn` return shape.** Today returns `SessionOpResult` with the child id. In Temporal mode, should it return the child's `workflowId` as well for observability? **Proposal:** yes; add `childWorkflowId?: string` to `OpResult` when Temporal is active.

4. **Cancellation semantics for `stop(force: true)`.** In local mode this kills the process hard. In Temporal this is workflow cancellation — which is graceful by default. Do we map `force: true` to `terminate` (abandon workflow immediately) vs `cancel` (run compensation activities)?

5. **Arkd worker model for Temporal activities.** Some activities (e.g. `dispatchStageActivity` that launches a Claude session via tmux) must run on a specific arkd node where the tmux lives. This needs a per-worker task queue (`ark.arkd.<nodeId>`) or a sticky-session mechanism. Detailed design in Phase 3.

---

## 9. Tracking

Issues to be filed from this plan (design-review agent may have already):
- R1–R8 as independent issues
- This plan referenced from #369 + #374

Companion docs: `docs/temporal.md` (design of the Temporal orchestrator), `docs/temporal-local-dev.md` (local cluster setup).
