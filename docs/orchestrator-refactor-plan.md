# Orchestrator Refactor Plan (Phase 1.5 — design only)

> Status: design, no code changes. This plan sets up the `AppMode.orchestrator: OrchestratorCapability` seam so Phase 2 (`packages/core/temporal/`, tracked in #369) can land cleanly. Authoritative references: [docs/temporal.md](./temporal.md), `packages/core/modes/app-mode.ts`.

## 0. The DI problem we're also fixing

Today's orchestration functions have the signature `dispatch(app, sessionId, opts)`, `advance(app, sessionId, ...)`, `startSession(app, opts)`. That's not DI — it's the **service-locator-as-argument** anti-pattern. The function receives a kitchen-sink `AppContext` and plucks ~25 `app.*` fields out of it (cataloged in RF-3 #383). The dependency graph is invisible until you read every line of the function body.

Awilix is already wired (`packages/core/container.ts` defines the `Cradle`; repositories + services are registered). The orchestration layer just doesn't use it.

Consequences this refactor must fix — not just paper over:

1. **Hidden dependency graph.** Hard to know what breaks when `app.X` changes.
2. **Temporal activities can't take `AppContext` as input.** Activity inputs are serialized to Temporal history (JSON). Passing an AppContext is a non-starter. Activities need narrow deps injected at worker construction time.
3. **Testability.** Every orchestration test today must build a full AppContext. Narrow deps + injection lets tests mock only what the function actually uses.
4. **The `No global state` memory rule** (*pass all state as arguments, no ARK_DIR() or getApp() from utility functions*) is meant to prevent exactly this — but an opaque `app` arg satisfies the letter while violating the spirit.

Fix: **migrate orchestration from module-level functions taking `app` to injectable classes with explicit constructor-injected dependencies**, registered in the existing Awilix container (see RF-3 #383). The capability seam (RF-7 #387) sits on top of the DI'd classes.

Further decomposition — optional, post-Phase-2 — breaks the single `OrchestrationDeps` bag into per-concern narrow `*Deps` interfaces and extracts `SessionDispatcher` / `StageAdvancer` / `ForkJoiner` / `SubagentSpawner` / `SessionLifecycle` / `ReviewGateHooks` classes each with its OWN Deps. This is better OO discipline but can come later — the single-Deps intermediate is a valid first step.

## 1. External surface today

Nearly all non-test orchestration callers go through exactly one of two entry points:

1. **`app.sessionService.*`** — everything in `packages/server/handlers/session.ts` + `messaging.ts`, plus `packages/server/handlers/resource.ts` (`sessionService.start`).
2. **Direct imports from `packages/core/services/session-orchestration.js`** — a smaller set:
   - `packages/core/conductor/conductor.ts` (`startSession`, `dispatch`, `applyHookStatus`, `applyReport`, `mediateStageHandoff`, `retryWithContext`).
   - `packages/core/acp.ts` (`startSession`, `stop`, `resume`, `deleteSessionAsync`, `getOutput`, `send`).
   - `packages/core/integrations/github-webhook.ts` (`dispatch`).
   - `packages/server/handlers/sage.ts`, `history.ts`, `web.ts` (`startSession`, `dispatch`, `cleanupWorktrees`).
   - `packages/cli/exec.ts`, `commands/session.ts`, `commands/worktree.ts` (`startSession`, `dispatch`, `waitForCompletion`, `runVerification`, `findOrphanedWorktrees`, `cleanupWorktrees`).
   - ~35 test files in `packages/core/__tests__/`.

The **logical surface** the capability must cover:

| Method family | Sync / async behaviour | Notes |
|---|---|---|
| `startSession(opts)` | create row + first stage + emit `session_created` (default dispatch listener kicks) | This is the `sessionWorkflow.start()` moment |
| `stop / pause / resume / interrupt / archive / restore / delete / undelete` | state transitions + cleanup (tmux, k8s Secret, worktree, compute GC) | Map to Temporal signals + cancel |
| `dispatch` | resolve agent, build task, launch executor or schedule to worker | One activity per side-effect |
| `advance(force?, outcome?)` | gate eval + graph-flow routing + completion bookkeeping | Workflow owns the loop; becomes a workflow call, not an RPC |
| `complete` | verify -> log -> advance(true) | Collapses into `awaitStageCompletionActivity` + workflow control |
| `fork / clone / handoff / fanOut / joinFork / spawn / checkAutoJoin` | child-session creation + dispatch | Child-workflow spawn in Temporal |
| `executeAction` | in-process action for non-agent stages (create_pr, merge, ...) | `executeActionActivity` |
| `runVerification` | local verify scripts + todos | `runVerificationActivity` |
| `applyHookStatus(session, event, payload)` | pure-ish policy that returns `HookStatusResult` (updates + events + shouldAdvance + shouldRetry + ...) | Today a mix of policy + hidden side effect (handoff detection fire-and-forget). Remains a **policy** function in local mode; Temporal wraps the resulting "advance" / "retry" / "dispatch" into signals. |
| `applyReport(sessionId, report)` | same: policy returning `ReportResult` (updates + logEvents + busEvents + message + outcome + shouldAdvance + shouldRetry) | Ditto. |
| `mediateStageHandoff(opts)` | verify -> advance -> optional dispatch -> log | Workflow-native in Temporal; local orchestrator keeps the function. |
| `retryWithContext` | failed -> ready transition with retry budget | Workflow retry policy absorbs this in Temporal. |
| `send(sessionId, message)` / `getOutput` | tmux I/O | Out of scope for Temporal (these are liveness ops against a running compute). Stay on `sessionService`. |
| `saveInput(opts)` / `input/read` | BlobStore puts/gets for session inputs | Already BlobStore-backed; stays on `sessionService`. |
| Worktree ops (`worktreeDiff`, `finishWorktree`, `createWorktreePR`, `rebaseOntoBase`, `findOrphanedWorktrees`, `cleanupWorktrees`) | local-FS git ops | Stay on `sessionService` — not part of the core orchestrator shape (they're operator / UX actions, not stage transitions). |

## 2. Proposed `OrchestratorCapability`

> One-page TypeScript sketch. Narrow surface: only the methods that need to differ between local state-machine vs. Temporal workflow engine. Everything else stays on `SessionService` unchanged.

```ts
// packages/core/modes/app-mode.ts (new interface, added alongside the others)

import type { Session, CreateSessionOpts } from "../../types/index.js";
import type { OutboundMessage } from "../conductor/channel-types.js";
import type { HookStatusResult, ReportResult, StageHandoffResult } from "../services/session-hooks.js";
import type { VerificationResult } from "../services/session-lifecycle.js";

/**
 * Orchestration engine capability. Local mode uses the bespoke state machine
 * in `packages/core/state/` + `services/*-orchestration.ts`. Hosted mode will
 * (Phase 5+) plug in a Temporal-backed implementation. Both must agree on
 * this surface; callers read `app.mode.orchestrator.*` and never branch.
 */
export interface OrchestratorCapability {
  readonly kind: "local" | "temporal";

  // ── Lifecycle ───────────────────────────────────────────────────────────
  /** Create row, set first stage, emit session_created so the default
   *  dispatcher listener can kick. Never throws on missing flow. */
  startSession(input: StartSessionInput): Promise<{ sessionId: string }>;

  /** Idempotent: terminal states + force flag tolerated. */
  stop(input: { sessionId: string; force?: boolean }): Promise<OpResult>;

  pause(input: { sessionId: string; reason?: string }): Promise<OpResult>;

  resume(input: { sessionId: string; rewindToStage?: string }): Promise<OpResult>;

  interrupt(input: { sessionId: string }): Promise<OpResult>;

  archive(input: { sessionId: string }): Promise<OpResult>;

  restore(input: { sessionId: string }): Promise<OpResult>;

  deleteSession(input: { sessionId: string }): Promise<OpResult>;

  undeleteSession(input: { sessionId: string }): Promise<OpResult>;

  // ── Dispatch + advance ──────────────────────────────────────────────────
  /** Resolve agent, build task, launch executor. Route action stages
   *  in-process. Temporal impl records one activity per side-effect. */
  dispatch(input: { sessionId: string }): Promise<OpResult>;

  /** Gate eval + graph-flow routing + completion bookkeeping. Force flag
   *  skips gate evaluation (review-gate approve). */
  advance(input: { sessionId: string; force?: boolean; outcome?: string }): Promise<OpResult>;

  /** Verify + mark completed + cascade-advance. */
  complete(input: { sessionId: string; force?: boolean }): Promise<OpResult>;

  // ── Fan-out / fork ──────────────────────────────────────────────────────
  fork(input: { sessionId: string; task: string; agent?: string }): Promise<OpResult>;
  clone(input: { sessionId: string; name?: string }): Promise<OpResult>;
  fanOut(input: { sessionId: string; tasks: SubtaskSpec[] }): Promise<FanOutResult>;
  join(input: { parentId: string; force?: boolean }): Promise<OpResult>;
  spawn(input: { parentId: string; spec: SubagentSpec }): Promise<OpResult>;
  handoff(input: { sessionId: string; agent: string; instructions?: string }): Promise<OpResult>;

  // ── Signals (hook + report channels) ────────────────────────────────────
  /** Incoming Claude hook. Local impl: runs applyHookStatus policy + the
   *  side effects it chooses (advance / dispatch / retry). Temporal impl:
   *  signals the workflow; workflow drives the side effects. */
  onHookStatus(input: { sessionId: string; event: string; payload: Record<string, unknown> }): Promise<void>;

  /** Incoming channel report. Same split as onHookStatus. */
  onReport(input: { sessionId: string; report: OutboundMessage }): Promise<void>;

  /** Verify -> advance -> optional dispatch. Local impl = mediateStageHandoff.
   *  Temporal impl = workflow signal that completes the verify/advance loop. */
  mediateStageHandoff(input: { sessionId: string; autoDispatch?: boolean; source?: string; outcome?: string }): Promise<StageHandoffResult>;

  // ── Review gate signals ────────────────────────────────────────────────
  approveReviewGate(input: { sessionId: string }): Promise<OpResult>;
  rejectReviewGate(input: { sessionId: string; reason: string }): Promise<OpResult>;

  // ── Queries ────────────────────────────────────────────────────────────
  runVerification(input: { sessionId: string }): Promise<VerificationResult>;
  waitForCompletion(input: { sessionId: string; timeoutMs?: number; pollMs?: number }): Promise<{ session: Session | null; timedOut: boolean }>;

  // ── Retry / on_failure plumbing ────────────────────────────────────────
  retryWithContext(input: { sessionId: string; maxRetries?: number }): Promise<OpResult>;
}

// ── Inputs / outputs ──────────────────────────────────────────────────────

export type OpResult = { ok: true; sessionId: string } | { ok: false; message: string };

export type StartSessionInput = CreateSessionOpts & {
  /** Locators, never inline bytes. Phase 1 migration turns every byte site
   *  into a locator (see BlobStore section). */
  attachments?: Array<{ name: string; locator: string; type?: string }>;
  inputs?: { files?: Record<string, string /* locator */>; params?: Record<string, string> };
};

export type SubtaskSpec = { summary: string; agent?: string; flow?: string };

export type FanOutResult = { ok: true; childIds: string[] } | { ok: false; message: string };

export type SubagentSpec = {
  task: string;
  agent?: string;
  model?: string;
  group_name?: string;
  extensions?: string[];
};
```

### Error types

Define in `packages/core/services/orchestrator-errors.ts`:

- `OrchestratorError extends Error` — base.
- `ValidationError` (non-retryable in Temporal).
- `SessionNotFound` (non-retryable).
- `StageNotReady` (non-retryable).
- `TenantQuotaError` (non-retryable).
- `ComputeNotFoundError` (non-retryable).
- `DispatchValidationError` (non-retryable).
- `TransientOrchestratorError` (retryable — network, DB busy, tmux SIGPIPE).

Temporal wraps non-retryable variants in `ApplicationFailure({ nonRetryable: true })` at the activity boundary. Local orchestrator surfaces them as `OpResult{ ok: false, message }` for caller parity.

### Return-type serialization contract

Every `OrchestratorCapability` return value **must be plain JSON** — no class instances, no `Map`, no functions. This is enforced by convention in local mode and by the Temporal SDK codec in hosted. Known violators (today):

- `runVerification` returns `VerificationResult` with script arrays — already JSON-safe.
- `applyHookStatus` / `applyReport` return shapes that contain `Partial<Session>` updates. Already JSON-safe.
- `SessionService.worktreeDiff` returns an object — already JSON-safe.

Flag any future additions with an ESLint rule at Phase 2 boundary.

## 3. LocalOrchestrator integration plan

`LocalOrchestrator` is a thin delegator. Every method calls an existing function with a small input-shape adapter. Below, left = capability method, right = target function.

| Capability method | Delegates to |
|---|---|
| `startSession` | `services/session-lifecycle.ts:startSession` |
| `stop` | `services/session-lifecycle.ts:stop` |
| `pause` / `resume` / `interrupt` / `archive` / `restore` | `services/session-lifecycle.ts:*` |
| `deleteSession` / `undeleteSession` | `services/session-lifecycle.ts:deleteSessionAsync` / `undeleteSessionAsync` |
| `dispatch` | `services/dispatch.ts:dispatch` |
| `advance` | `services/stage-advance.ts:advance` |
| `complete` | `services/stage-advance.ts:complete` |
| `fork` / `clone` / `handoff` | `services/session-lifecycle.ts:forkSession` / `cloneSession`, `services/stage-advance.ts:handoff` |
| `fanOut` / `join` / `spawn` | `services/fork-join.ts:fanOut` / `joinFork`, `services/subagents.ts:spawnSubagent` |
| `onHookStatus` | `services/session-hooks.ts:applyHookStatus` + today's conductor side effects (advance / dispatch / retry). We lift the "decide + apply" loop out of `conductor.ts` into `LocalOrchestrator.onHookStatus` so the conductor only forwards the raw event. |
| `onReport` | Same pattern: wraps `applyReport` + the conductor's post-report side-effect loop. |
| `mediateStageHandoff` | `services/session-hooks.ts:mediateStageHandoff` |
| `approveReviewGate` / `rejectReviewGate` | `services/session-orchestration.ts` wrappers |
| `runVerification` / `waitForCompletion` | `services/session-lifecycle.ts:*` |
| `retryWithContext` | `services/session-hooks.ts:retryWithContext` |

`SessionService` becomes a thin compatibility facade over `app.mode.orchestrator` for the methods listed. All `await import("./session-orchestration.js")` dynamic imports in `SessionService` collapse into `app.mode.orchestrator.*` calls. Non-orchestration methods on `SessionService` (`saveInput`, `send`, `getOutput`, `worktreeDiff`, `createWorktreePR`, `finishWorktree`, `rebaseOntoBase`) stay where they are — they are not orchestration.

### Tests that need to move

Tests under `packages/core/__tests__/` currently import from `services/session-orchestration.js` directly. After the refactor they should:

- Keep calling the underlying functions directly for *unit-level* assertions (still valid; these are local-orchestrator internals).
- Add one integration test per capability method in `packages/core/modes/__tests__/orchestrator-local.test.ts` that calls through `app.mode.orchestrator.*`. Proves the facade is wired and lets us run the same test matrix against `TemporalOrchestrator` later.
- No test file needs to be deleted.

## 4. Refactors needed BEFORE Phase 2

Prioritized, each a standalone issue. Effort key: **S** <= 1 day, **M** = 2–3 days, **L** = a week.

### P0 (blocking)

**RF-1 (M) — Lift hook / report side-effect loop out of `conductor.ts` into a service function.**
Today `packages/core/conductor/conductor.ts` is the one caller of `applyHookStatus` / `applyReport` and encodes the "apply updates, log events, maybe retry, maybe dispatch, maybe mediateStageHandoff" cascade inline (lines ~349–407 and ~874–946). That cascade is part of the orchestration surface, not the conductor. Move to `packages/core/services/session-signals.ts` exposing `handleHookStatus(app, sessionId, event, payload)` and `handleReport(app, sessionId, report)`. Conductor then just calls those. This is the seam `OrchestratorCapability.onHookStatus` / `onReport` will bind to.

**RF-2 (S) — Remove `await import("./session-orchestration.js")` from `SessionService`.**
Every dynamic import in `services/session.ts` resolves at runtime to a function that lives in the same tree and has no circular-dep reason to be deferred post-RF-1. Replace with top-of-file imports. Precondition for binding `SessionService.*` through the capability.

**RF-3 (M) — Audit `AppContext` ambient access in orchestration functions; reduce to a declared interface.**
`services/session-lifecycle.ts` / `dispatch.ts` / `stage-advance.ts` / `session-hooks.ts` / `workspace-service.ts` read `app.sessions`, `app.events`, `app.messages`, `app.flows`, `app.flowStates`, `app.computes`, `app.launcher`, `app.blobStore`, `app.secrets`, `app.runtimes`, `app.agents`, `app.pluginRegistry`, `app.usageRecorder`, `app.knowledge`, `app.codeIntel`, `app.scheduler`, `app.todos`, `app.statusPollers`, `app.transcriptParsers`, `app.config`, `app.tenantId`, `app.arkDir`, `app.sessionService`. Every one of those is an ambient dependency that a Temporal activity would need to re-resolve from scratch on each invocation. Define `OrchestrationDeps` in `services/deps.ts` that lists the ports, and make Temporal wrappers inject the narrower subset they need. Local orchestrator can continue passing `app` as-is (the ports are trivially derivable from `AppContext`). This is cheap now and expensive later.

**RF-4 (S) — Move the `sessionService.emitSessionCreated` side effect out of `startSession`.**
`services/session-lifecycle.ts:startSession` currently reaches back into `app.sessionService.emitSessionCreated(...)`. This is a subtle cycle: the service delegates to a function that calls back into the service. Replace with an event returned from `startSession` and have the capability's `startSession` method emit it after the function resolves. Keeps `startSession` a pure "create + return ids"; the capability wrapper handles the dispatcher-kick.

**RF-5 (M) — BlobStore migration (complete the Phase 1 audit already scoped in #368).**
The capability's `StartSessionInput` says "attachments carry locators, not bytes". Today `startSession` accepts `attachments: Array<{ name, content, type }>` and stores the base64 inline in `config.attachments` until the first dispatch calls `materializeAttachments` (workspace-service.ts) and rewrites with locators. The capability contract forces callers to upload first and pass locators. The sites that must migrate:

- `services/session-lifecycle.ts:startSession` — `attachments` input.
- `services/workspace-service.ts:materializeAttachments` — keep it for legacy rows, add a no-op fast-path when every entry already has a locator.
- `services/task-builder.ts:renderAttachmentsBlock` — already handles both shapes.
- `services/plan-artifact.ts` — inline markdown -> locator (Phase 1 is already on this).
- `services/session-output.ts:getOutput` — returns raw string; acceptable (not workflow input).
- `services/dispatch.ts` — `task` is built inline from session data; bounded (<2 KiB typical); acceptable.
- MCP config in `services/agent-launcher.ts` — written to disk via `claude.writeChannelConfig`; local I/O, not workflow input; acceptable.
- `services/session-snapshot.ts` — snapshot capture already writes to BlobStore; acceptable.

Outcome: every `OrchestratorCapability` method receives JSON + locators. RF-5 is blocking because the capability signature is load-bearing.

**RF-6 (S) — Split `session-orchestration.ts` barrel into explicit per-function imports at every caller.**
Removes the cross-package barrel that masks which function each test / caller depends on, makes dead-code elimination easier, and forces contributors to think about "is this orchestration? or something else?" when they import. Mechanical.

### P1 (blocking but smaller scope)

**RF-7 (S) — `AppMode.orchestrator` field addition + wiring.**
Add to `AppMode` interface; wire `LocalOrchestrator` in `buildLocalAppMode`; wire the same `LocalOrchestrator` in `buildHostedAppMode` for now (Temporal ships in Phase 5). Capability starts off returning `kind: "local"` in both modes. **Do not edit these files during Phase 1.5 (per design constraint)**; file the issue, wait for the green-light sprint.

**RF-8 (S) — Idempotency keys on side-effectful orchestration calls.**
Temporal requires every activity to be idempotent by `(sessionId, stageIdx, activityName)`. Today `dispatch` is idempotent on the "already running" branch, `stop` is idempotent on terminal states, but `advance` / `complete` / `executeAction` are not explicitly keyed. Add an optional `idempotencyKey` field to the capability inputs (ignored in local, honored in Temporal). Document which methods are already naturally idempotent.

**RF-9 (S) — Remove `app.sessions.mergeConfig` fire-and-forget calls that lack await.**
`services/workspace-service.ts:materializeAttachments` and `:worktreeDiff` call `app.sessions.mergeConfig(...)` without `await`. Under Temporal activities this creates a dangling promise the activity won't wait for — workflow advances, row isn't updated, next activity's read is stale. Add `await`s. Mechanical; trivial.

### Summary of blocking refactors: **9**

## 5. Nice-to-have (post-Phase-2)

- **NH-1 (M)** — Consolidate `app.events.log` callers into a domain-event emitter with typed payloads. Today events are free-form `Record<string, unknown>`; hosted Temporal workers will want typed projections. Post-Phase-2 because the projector's shape is decided in #369.
- **NH-2 (S)** — Drop the `ComputeProvider` vs. `ComputeTarget` double path in `session-lifecycle.ts:withProvider` / `withComputeTarget`. Legacy adapters can go after Wave 3 settles.
- **NH-3 (S)** — Promote `detectInjection`, `detectHandoff`, `parseTermination` into a named `PolicyDeps` bundle. They currently import from free-standing modules; bundling makes them easy to stub in tests and to override in hosted mode (e.g., stricter injection rules per tenant).
- **NH-4 (M)** — Split `SessionService` into `OrchestratorFacade` (delegates to capability) + `WorktreeService` (worktree/PR/diff/finish) + `InputService` (saveInput / input/read). Three focused services vs. one 700-line grab-bag.
- **NH-5 (S)** — Extract `parseOnFailure` + retry-budget logic from `session-hooks.ts` into a named policy so Temporal's built-in retry can either consume it or explicitly shadow it.
- **NH-6 (S)** — Remove the `checkAutoJoin` DB-polling from `fork-join.ts` once Temporal replaces it with `workflow.condition()`. Local mode keeps it.

## 6. Open design questions

1. **Who emits `session_created`?** Today `startSession` reaches back into `sessionService.emitSessionCreated`. After RF-4 the capability's `startSession` method emits it. But the default-dispatcher listener (`SessionService.registerDefaultDispatcher`) currently reads the session row to decide whether to kick dispatch. In Temporal mode the workflow **is** the dispatcher — no listener needed. Proposal: capability's `startSession` returns `{ sessionId, kickDispatch: boolean }`, local mode sets `kickDispatch: true`, Temporal mode sets `kickDispatch: false`. Handlers pass the flag to a shared `maybeKickDispatch` helper.

2. **Does `onHookStatus` / `onReport` block the caller?** The conductor's hook endpoint is synchronous from the agent's perspective; it expects a response. In Temporal mode the signal is fire-and-forget and the workflow drives the cascade. The capability contract needs one of: (a) always-async, caller never relies on the result (simplest); (b) return a typed `DecisionResult` the caller can inspect for diagnostics only. Recommend (a) — it matches Temporal semantics and the current conductor already discards most of the structured response.

3. **Verification: activity or workflow control?** `mediateStageHandoff` calls `runVerification` synchronously. In Temporal mode the workflow would call `runVerificationActivity`. What happens if verify fails? Today: session goes `blocked`. In workflow terms: workflow sends a `blocked` signal to itself and awaits `manualApprove` / `manualOverride`. Needs product confirmation before we lock the signal shape.

4. **Retry policy ownership.** `retryWithContext` has its own retry-count ledger in the events table. Temporal's retry policy also tracks attempts. Double-counting is a footgun. Proposal: in Temporal mode, `retryWithContext` becomes a workflow-internal decision and the events-table ledger is projected from workflow history. Needs #369 alignment.

5. **Stop semantics vs. Temporal cancellation.** `stop` today does synchronous cleanup before updating DB rows. Temporal cancellation is asynchronous + activities have a compensation contract. Should local mode's `stop` return before cleanup completes (matching Temporal semantics), or should Temporal's `stop` block on compensation (matching local semantics)? Recommend the former: both return fast, cleanup completes asynchronously, callers observe via `waitForCompletion`.

6. **Fan-out scope.** Local `fanOut` creates child sessions + dispatches each. Temporal `fanOut` spawns child workflows. Parent workflow uses `Promise.all`. Does the capability expose a uniform `onChildComplete` signal, or does the parent always poll child statuses? Recommend signal for parity with Temporal + synthetic signal emission from the local orchestrator's `advance` when a child session completes.

7. **Where does `executeAction` live?** It's used both inline by `dispatch` (action stages) and by `mediateStageHandoff` (post-agent chain). In Temporal it becomes an activity. In the capability, should it be exposed as a top-level method or hidden inside `advance` / `dispatch`? Recommend exposing it: webhook-driven action replays (retry a failed create_pr without touching the session's current stage) are a thing, and hiding it forces callers through `resume` which has side effects.

## 7. Dependency order (what-to-fix-first)

1. **RF-5** (BlobStore) — shapes the capability's input types. Others depend on the final `StartSessionInput` / `SubtaskSpec`.
2. **RF-1** (lift hook/report side effects out of conductor) — capability can't expose `onHookStatus` / `onReport` until the policy+effect cascade is a single function.
3. **RF-3** (`OrchestrationDeps`) — once done, RF-7 (mode wiring) is mechanical and RF-8 (idempotency) is a one-field addition.

RF-2, RF-4, RF-6, RF-9 are independent and can land in any order after RF-1.

## 8. Issues filed

See console summary at the end of the session. All blocking items above are filed as individual issues + a meta tracker. #369 (Phase 2) is linked from the meta.
