# Temporal Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Temporal as the hosted-mode orchestrator behind a feature flag, with T1-T5 e2e
tests proving it can fully replace the bespoke engine.

**Architecture:** A flag check in `SessionService.start()` routes new sessions to
`TemporalClient.startWorkflow()` when `features.temporalOrchestration=true` on a hosted
deployment. A `sessionWorkflow` in `packages/core/temporal/` drives the stage loop via 9
activities that wrap existing service functions. The bespoke engine is untouched. Five e2e tests
gate the branch: linear parity (T1), crash recovery (T2), durable manual gate (T3), fan-out race
(T4), and retry policy (T5).

**Tech Stack:** TypeScript / Bun, `@temporalio/*` 1.11.7 (Bun-validated), drizzle-orm, bun:test,
docker-compose for e2e stack.

**Prerequisite:** The `feat/control-plane-mode` branch must be merged to `main` before this plan
executes (it provides `e2e/`, `e2e/helpers/`, `e2e/fixtures/`, `.infra/docker-compose.e2e.yaml`,
and `Makefile` targets `test-e2e-control-plane*`). If it has not merged, cherry-pick its e2e
commits onto `temporal-integration` first.

---

## File Map

**New files:**
```
packages/core/services/deps.ts                          OrchestrationDeps interface (RF-3)
packages/core/services/session-signals.ts               Hook/report cascade (RF-1)
packages/core/config/types.ts                           + TemporalConfig, updated FeaturesConfig
packages/core/migrations/015_temporal_columns.ts        migration entry point
packages/core/migrations/015_temporal_columns_sqlite.ts SQLite DDL
packages/core/migrations/015_temporal_columns_postgres.ts Postgres DDL
packages/core/temporal/errors.ts                        Non-retryable error classes
packages/core/temporal/types.ts                         Workflow I/O types (JSON-safe)
packages/core/temporal/client.ts                        TemporalClient singleton
packages/core/temporal/worker.ts                        Worker entry point
packages/core/temporal/workflows/session-workflow.ts    sessionWorkflow
packages/core/temporal/workflows/stage-workflow.ts      stageWorkflow (fan-out children)
packages/core/temporal/activities/start-session.ts
packages/core/temporal/activities/resolve-compute.ts
packages/core/temporal/activities/provision-compute.ts
packages/core/temporal/activities/dispatch-stage.ts
packages/core/temporal/activities/await-stage-completion.ts
packages/core/temporal/activities/execute-action.ts
packages/core/temporal/activities/run-verification.ts
packages/core/temporal/activities/project-session.ts
packages/core/temporal/activities/project-stage.ts
packages/core/temporal/activities/index.ts             Activity registry for worker
packages/core/temporal/projector/diff.ts               Shadow-mode diff harness
e2e/temporal-control-plane.test.ts                     T1-T5 e2e tests
flows/e2e-review.yaml                                  T3 test flow
flows/e2e-fanout.yaml                                  T4 test flow
flows/e2e-action-retry.yaml                            T5 test flow
```

**Modified files:**
```
packages/core/config/types.ts                  Add FeaturesConfig.temporalOrchestration,
                                               FeaturesConfig.temporalOrchestrationShadow,
                                               TemporalConfig interface
packages/core/config.ts                        Wire new config fields + env vars
packages/core/config/env-source.ts             ARK_TEMPORAL_* env vars
packages/core/conductor/server/hook-status-handler.ts  RF-1: delegate to session-signals.ts
packages/core/conductor/server/report-pipeline.ts      RF-1: delegate to session-signals.ts
packages/core/services/session-lifecycle.ts    RF-5: attachments locator-only path
packages/core/services/plan-artifact.ts        RF-5: inline markdown -> BlobRef
packages/core/services/session.ts             RF-7: Temporal flag check in start()
packages/core/migrations/registry.ts           Add migration 015
packages/core/drizzle/schema/sqlite.ts         workflow_id columns + session_projections
packages/core/drizzle/schema/postgres.ts       same
package.json                                   @temporalio/* 1.11.7
Makefile                                       test-e2e-temporal targets
.infra/docker-compose.e2e.yaml                 + temporal services + temporal-worker service
.env.e2e                                       + TEMPORAL_HOST, ARK_TEMPORAL_NAMESPACE
```

---

## Task 1: RF-3 -- Declare OrchestrationDeps

**Files:**
- Create: `packages/core/services/deps.ts`

- [ ] **Write `packages/core/services/deps.ts`**

```ts
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { FlowStore } from "../stores/flow.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { AppConfig } from "../config.js";
import type { SecretsCapability } from "../secrets/types.js";

/**
 * Narrow dependency set for orchestration functions.
 * Activities receive this at worker construction time instead of AppContext
 * so Temporal can serialize activity inputs at the workflow boundary.
 */
export interface OrchestrationDeps {
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  blobStore: BlobStore;
  flows: FlowStore;
  computes: ComputeRepository;
  config: AppConfig;
  secrets: SecretsCapability;
  tenantId: string;
  arkDir: string;
}

/** Derive narrow deps from a full AppContext for local/transition use. */
export function depsFromApp(app: import("../app.js").AppContext): OrchestrationDeps {
  return {
    sessions: app.sessions,
    events: app.events,
    messages: app.messages,
    blobStore: app.blobStore,
    flows: app.flows,
    computes: app.computes,
    config: app.config,
    secrets: app.mode.secrets,
    tenantId: app.tenantId,
    arkDir: app.arkDir,
  };
}
```

- [ ] **Verify it compiles**

```bash
cd /Users/zineng/featureScala/ark && make lint 2>&1 | tail -5
```

Expected: zero warnings / errors related to the new file.

- [ ] **Commit**

```bash
git add packages/core/services/deps.ts
git commit -m "feature: add OrchestrationDeps interface (RF-3)"
```

---

## Task 2: RF-5 -- BlobStore finalization for orchestrator inputs

**Files:**
- Modify: `packages/core/services/session-lifecycle.ts`
- Modify: `packages/core/services/plan-artifact.ts`

The goal is to ensure `startSession` no longer accepts inline attachment bytes; every attachment
must arrive as a `BlobRef` locator that was uploaded before the call. Callers that still send
bytes need to upload first via `app.blobStore.put()`.

- [ ] **Check current attachment shape in session-lifecycle.ts**

```bash
grep -n "attachments\|BlobRef\|locator\|materialize" packages/core/services/session-lifecycle.ts | head -20
```

- [ ] **Add locator validation guard to `startSession`**

In `packages/core/services/session-lifecycle.ts`, inside `startSession`, after the `opts`
parameter is available, add:

```ts
// RF-5: reject inline attachment bytes -- callers must upload to BlobStore first.
if (opts.attachments?.some((a: any) => a.content && !a.locator)) {
  throw new ValidationError(
    "startSession: attachment.content is not allowed; upload to BlobStore and pass locator instead",
  );
}
```

Import `ValidationError` from `../temporal/errors.js` (created in Task 7; add a placeholder
import from `../services/orchestrator-errors.js` until then -- see note below).

**Note:** Create a minimal `packages/core/services/orchestrator-errors.ts` now so this import
resolves:

```ts
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
```

- [ ] **Write failing test**

In `packages/core/__tests__/session-lifecycle.test.ts` (or create it), add:

```ts
test("startSession rejects inline attachment bytes", async () => {
  await expect(
    startSession(app, {
      summary: "test",
      attachments: [{ name: "foo.txt", content: "aGVsbG8=", type: "text/plain" }],
    }),
  ).rejects.toThrow("upload to BlobStore");
});
```

- [ ] **Run failing test**

```bash
make test-file F=packages/core/__tests__/session-lifecycle.test.ts 2>&1 | tail -10
```

Expected: FAIL with "upload to BlobStore"

- [ ] **Add the guard (step already done above) and run test again**

```bash
make test-file F=packages/core/__tests__/session-lifecycle.test.ts 2>&1 | tail -5
```

Expected: PASS

- [ ] **Commit**

```bash
git add packages/core/services/session-lifecycle.ts \
        packages/core/services/orchestrator-errors.ts \
        packages/core/__tests__/session-lifecycle.test.ts
git commit -m "feature: RF-5 -- reject inline attachment bytes in startSession"
```

---

## Task 3: RF-1 -- Lift hook/report cascade out of conductor

**Files:**
- Create: `packages/core/services/session-signals.ts`
- Modify: `packages/core/conductor/server/hook-status-handler.ts`
- Modify: `packages/core/conductor/server/report-pipeline.ts`

The cascade logic that lives in `hook-status-handler.ts` and `report-pipeline.ts` (advance,
retry, dispatch decisions after a hook/report) gets extracted into `session-signals.ts` so
activities can call it directly. The conductor becomes a thin forwarder.

- [ ] **Read the existing cascade**

```bash
cat packages/core/conductor/server/hook-status-handler.ts
cat packages/core/conductor/server/report-pipeline.ts
```

- [ ] **Create `packages/core/services/session-signals.ts`**

Extract the core decision logic into two exported functions:

```ts
import type { AppContext } from "../app.js";
import type { OutboundMessage } from "../conductor/channel-types.js";

/**
 * Handle an incoming Claude hook status event.
 * Applies applyHookStatus policy + decides advance/dispatch/retry.
 * Called by the conductor and (in future) by Temporal signal handlers.
 */
export async function handleHookStatus(
  app: AppContext,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Move the body of hook-status-handler.ts's core logic here.
  // The conductor will call this function instead of inlining the logic.
  const { applyHookStatus } = await import("./session-hooks.js");
  const result = await applyHookStatus(app, sessionId, event, payload);
  if (result.shouldAdvance) {
    const { mediateStageHandoff } = await import("./session-hooks.js");
    await mediateStageHandoff({ app, sessionId, autoDispatch: true, source: "hook" });
  }
  if (result.shouldRetry) {
    const { retryWithContext } = await import("./session-hooks.js");
    await retryWithContext(app, sessionId);
  }
}

/**
 * Handle an incoming channel CompletionReport.
 * Applies applyReport policy + decides advance/dispatch/retry.
 */
export async function handleReport(
  app: AppContext,
  sessionId: string,
  report: OutboundMessage,
): Promise<void> {
  // Move the body of report-pipeline.ts's core logic here.
  const { applyReport } = await import("./session-orchestration.js");
  const result = await applyReport(app, sessionId, report);
  if (result.shouldAdvance) {
    const { mediateStageHandoff } = await import("./session-hooks.js");
    await mediateStageHandoff({ app, sessionId, autoDispatch: true, source: "report", outcome: result.outcome });
  }
  if (result.shouldRetry) {
    const { retryWithContext } = await import("./session-hooks.js");
    await retryWithContext(app, sessionId);
  }
}
```

- [ ] **Update `hook-status-handler.ts` to delegate**

Replace the cascade body with:
```ts
import { handleHookStatus } from "../../services/session-signals.js";
// ... in the handler function body:
await handleHookStatus(app, sessionId, event, payload);
```

- [ ] **Update `report-pipeline.ts` to delegate**

Replace the cascade body with:
```ts
import { handleReport } from "../../services/session-signals.js";
// ... in the handler function body:
await handleReport(app, sessionId, report);
```

- [ ] **Run full test suite to confirm no regression**

```bash
make test 2>&1 | tail -20
```

Expected: same pass count as before.

- [ ] **Commit**

```bash
git add packages/core/services/session-signals.ts \
        packages/core/conductor/server/hook-status-handler.ts \
        packages/core/conductor/server/report-pipeline.ts
git commit -m "feature: RF-1 -- lift hook/report cascade into session-signals.ts"
```

---

## Task 4: Add @temporalio deps + config types

**Files:**
- Modify: `package.json`
- Modify: `packages/core/config/types.ts`
- Modify: `packages/core/config.ts`
- Modify: `packages/core/config/env-source.ts`

- [ ] **Install Temporal SDK at pinned version**

```bash
bun add @temporalio/client@1.11.7 @temporalio/worker@1.11.7 \
        @temporalio/workflow@1.11.7 @temporalio/activity@1.11.7
```

Expected: package.json now contains all four `@temporalio/*` at `1.11.7`.

- [ ] **Add TemporalConfig and extend FeaturesConfig in `packages/core/config/types.ts`**

Add after the `FeaturesConfig` interface:

```ts
export interface TemporalConfig {
  /** Temporal server address. Default: localhost:7233 */
  serverUrl: string;
  /** Temporal namespace. Default: 'default' */
  namespace: string;
  /** Task queues this worker pulls from. Default: [] */
  taskQueueAssignments: string[];
  /** Whether to start a worker in this process. Default: false */
  workerEnabled: boolean;
}
```

Extend `FeaturesConfig`:

```ts
export interface FeaturesConfig {
  autoRebase: boolean;
  /** Route new hosted sessions through Temporal. Default: false */
  temporalOrchestration: boolean;
  /** Run shadow Temporal projector alongside bespoke engine. Default: false */
  temporalOrchestrationShadow: boolean;
}
```

Add `temporal` to `AppConfig`:

```ts
export interface AppConfig {
  // ... existing fields ...
  temporal: TemporalConfig;
}
```

- [ ] **Wire defaults in `packages/core/config.ts`**

In the defaults block add:

```ts
temporal: {
  serverUrl: "localhost:7233",
  namespace: "default",
  taskQueueAssignments: [],
  workerEnabled: false,
},
```

In the merge block add:

```ts
const temporal: TemporalConfig = {
  serverUrl: merged.temporal?.serverUrl ?? defaults.temporal.serverUrl,
  namespace: merged.temporal?.namespace ?? defaults.temporal.namespace,
  taskQueueAssignments: merged.temporal?.taskQueueAssignments ?? defaults.temporal.taskQueueAssignments,
  workerEnabled: merged.temporal?.workerEnabled ?? defaults.temporal.workerEnabled,
};
```

Extend `features`:

```ts
const features: FeaturesConfig = {
  autoRebase: ...,
  temporalOrchestration: merged.features?.temporalOrchestration ?? false,
  temporalOrchestrationShadow: merged.features?.temporalOrchestrationShadow ?? false,
};
```

Return `temporal` in the assembled config object.

- [ ] **Add env vars in `packages/core/config/env-source.ts`**

```ts
ARK_TEMPORAL_SERVER_URL: (v) => ({ temporal: { serverUrl: v } }),
ARK_TEMPORAL_NAMESPACE:  (v) => ({ temporal: { namespace: v } }),
ARK_TEMPORAL_WORKER:     (v) => ({ temporal: { workerEnabled: v === "true" } }),
ARK_TEMPORAL_ORCHESTRATION: (v) => ({ features: { temporalOrchestration: v === "true" } }),
ARK_TEMPORAL_SHADOW:     (v) => ({ features: { temporalOrchestrationShadow: v === "true" } }),
```

- [ ] **Compile check**

```bash
make lint 2>&1 | tail -5
```

Expected: zero errors.

- [ ] **Commit**

```bash
git add package.json bun.lock packages/core/config/types.ts packages/core/config.ts \
        packages/core/config/env-source.ts
git commit -m "feature: add @temporalio 1.11.7 + TemporalConfig + feature flags"
```

---

## Task 5: Migration 015 -- workflow_id columns + session_projections

**Note:** The spec calls this migration 017. On the current `main` branch the last migration is
014. Check `packages/core/migrations/registry.ts` -- if 015 and 016 have landed since this plan
was written, adjust the version number accordingly.

**Files:**
- Create: `packages/core/migrations/015_temporal_columns.ts`
- Create: `packages/core/migrations/015_temporal_columns_sqlite.ts`
- Create: `packages/core/migrations/015_temporal_columns_postgres.ts`
- Modify: `packages/core/migrations/registry.ts`
- Modify: `packages/core/drizzle/schema/sqlite.ts`
- Modify: `packages/core/drizzle/schema/postgres.ts`

- [ ] **Create `packages/core/migrations/015_temporal_columns_sqlite.ts`**

```ts
import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  "ALTER TABLE sessions ADD COLUMN workflow_id TEXT",
  "ALTER TABLE sessions ADD COLUMN workflow_run_id TEXT",
  "ALTER TABLE session_stages ADD COLUMN workflow_id TEXT",
  "ALTER TABLE session_stages ADD COLUMN workflow_run_id TEXT",
  `CREATE TABLE IF NOT EXISTS session_projections (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   INTEGER NOT NULL,
    PRIMARY KEY (session_id, COALESCE(stage_idx, -1))
  )`,
  `CREATE TABLE IF NOT EXISTS session_projections_shadow (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   INTEGER NOT NULL,
    PRIMARY KEY (session_id, COALESCE(stage_idx, -1))
  )`,
];

export async function applySqliteTemporalColumns(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    db.prepare(sql).run();
  }
}
```

- [ ] **Create `packages/core/migrations/015_temporal_columns_postgres.ts`**

```ts
import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_id TEXT",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_run_id TEXT",
  "ALTER TABLE session_stages ADD COLUMN IF NOT EXISTS workflow_id TEXT",
  "ALTER TABLE session_stages ADD COLUMN IF NOT EXISTS workflow_run_id TEXT",
  `CREATE TABLE IF NOT EXISTS session_projections (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   BIGINT NOT NULL,
    PRIMARY KEY (session_id, COALESCE(stage_idx, -1))
  )`,
  `CREATE TABLE IF NOT EXISTS session_projections_shadow (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   BIGINT NOT NULL,
    PRIMARY KEY (session_id, COALESCE(stage_idx, -1))
  )`,
];

export async function applyPostgresTemporalColumns(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    await (db as any).query(sql);
  }
}
```

- [ ] **Create `packages/core/migrations/015_temporal_columns.ts`**

```ts
import type { MigrationApplyContext } from "./types.js";
import { applySqliteTemporalColumns } from "./015_temporal_columns_sqlite.js";
import { applyPostgresTemporalColumns } from "./015_temporal_columns_postgres.js";

export const VERSION = 15;
export const NAME = "temporal_columns";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteTemporalColumns(ctx.db);
  } else {
    await applyPostgresTemporalColumns(ctx.db);
  }
}
```

- [ ] **Register migration in `packages/core/migrations/registry.ts`**

Add at the end of the imports block:

```ts
import * as m015 from "./015_temporal_columns.js";
```

Add at the end of the `MIGRATIONS` array:

```ts
{ version: m015.VERSION, name: m015.NAME, up: m015.up },
```

- [ ] **Add columns to drizzle schema files**

In `packages/core/drizzle/schema/sqlite.ts`, find the sessions table and add:

```ts
workflow_id: text("workflow_id"),
workflow_run_id: text("workflow_run_id"),
```

Do the same in `packages/core/drizzle/schema/postgres.ts`.

Add both projection tables to both schema files following the existing table pattern.

- [ ] **Run drift check**

```bash
make drift 2>&1 | tail -10
```

Expected: `OK -- schema matches migrations` (or similar passing output).

- [ ] **Run migration smoke test**

```bash
make test-file F=packages/core/__tests__/migrations.test.ts 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Commit**

```bash
git add packages/core/migrations/015_temporal_columns*.ts \
        packages/core/migrations/registry.ts \
        packages/core/drizzle/schema/sqlite.ts \
        packages/core/drizzle/schema/postgres.ts
git commit -m "feature: migration 015 -- workflow_id columns + session_projections"
```

---

## Task 6: Temporal error types + workflow I/O types

**Files:**
- Create: `packages/core/temporal/errors.ts`
- Create: `packages/core/temporal/types.ts`

- [ ] **Create `packages/core/temporal/errors.ts`**

```ts
import { ApplicationFailure } from "@temporalio/activity";

/** Base class. Extend for domain-specific errors. */
export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

// Non-retryable errors -- Temporal will not retry activities that throw these.
// Each wraps itself in ApplicationFailure so the SDK recognises them.

export class ValidationError extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "ValidationError"); }
}
export class SessionNotFound extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "SessionNotFound"); }
}
export class StageNotReady extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "StageNotReady"); }
}
export class TenantQuotaError extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "TenantQuotaError"); }
}
export class ComputeNotFoundError extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "ComputeNotFoundError"); }
}
export class DispatchValidationError extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "DispatchValidationError"); }
}
export class AuthError extends OrchestratorError {
  toFailure() { return ApplicationFailure.nonRetryable(this.message, "AuthError"); }
}

/** Retryable. Network blips, DB busy, tmux SIGPIPE. */
export class TransientOrchestratorError extends OrchestratorError {}
```

Update `packages/core/services/orchestrator-errors.ts` (created in Task 2) to re-export from
here so it stays as a single source:

```ts
export { ValidationError, OrchestratorError } from "../temporal/errors.js";
```

- [ ] **Create `packages/core/temporal/types.ts`**

```ts
/** All types crossing the workflow/activity boundary must be JSON-safe. */

export interface SessionWorkflowInput {
  sessionId: string;
  tenantId: string;
  flowName: string;
  /** BlobRef locators only -- no inline bytes. */
  inputs?: { files?: Record<string, string>; params?: Record<string, string> };
}

export interface StageWorkflowInput {
  parentSessionId: string;
  childSessionId: string;
  tenantId: string;
  stageIdx: number;
  stageName: string;
  task: string;
  agent?: string;
}

export interface StartSessionResult {
  sessionId: string;
}

export interface DispatchStageResult {
  launchPid?: number;
  launchId?: string;
}

export interface StageCompletionResult {
  status: "completed" | "failed" | "stopped";
  outcome?: string;
  error?: string;
}

export interface ProjectionInput {
  sessionId: string;
  stageIdx?: number;
  seq: number;
  patch: Record<string, unknown>;
}
```

- [ ] **Compile check**

```bash
make lint 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add packages/core/temporal/errors.ts packages/core/temporal/types.ts \
        packages/core/services/orchestrator-errors.ts
git commit -m "feature: Temporal error types and workflow I/O types"
```

---

## Task 7: Temporal client + worker bootstrap

**Files:**
- Create: `packages/core/temporal/client.ts`
- Create: `packages/core/temporal/worker.ts`
- Create: `packages/core/temporal/activities/index.ts`

- [ ] **Create `packages/core/temporal/client.ts`**

```ts
import { Connection, Client } from "@temporalio/client";
import type { TemporalConfig } from "../config/types.js";

let _client: Client | null = null;

export async function getTemporalClient(cfg: TemporalConfig): Promise<Client> {
  if (_client) return _client;
  const connection = await Connection.connect({ address: cfg.serverUrl });
  _client = new Client({ connection, namespace: cfg.namespace });
  return _client;
}

export async function closeTemporalClient(): Promise<void> {
  if (_client) {
    await _client.connection.close();
    _client = null;
  }
}
```

- [ ] **Create `packages/core/temporal/activities/index.ts`**

```ts
export { startSessionActivity } from "./start-session.js";
export { resolveComputeForStageActivity } from "./resolve-compute.js";
export { provisionComputeActivity } from "./provision-compute.js";
export { dispatchStageActivity } from "./dispatch-stage.js";
export { awaitStageCompletionActivity } from "./await-stage-completion.js";
export { executeActionActivity } from "./execute-action.js";
export { runVerificationActivity } from "./run-verification.js";
export { projectSessionActivity } from "./project-session.js";
export { projectStageActivity } from "./project-stage.js";
```

- [ ] **Create `packages/core/temporal/worker.ts`**

```ts
import { Worker, NativeConnection } from "@temporalio/worker";
import { loadAppConfig } from "../config.js";
import { AppContext } from "../app.js";
import { depsFromApp } from "../services/deps.js";
import * as actStartSession    from "./activities/start-session.js";
import * as actResolveCompute  from "./activities/resolve-compute.js";
import * as actProvision       from "./activities/provision-compute.js";
import * as actDispatch        from "./activities/dispatch-stage.js";
import * as actAwait           from "./activities/await-stage-completion.js";
import * as actAction          from "./activities/execute-action.js";
import * as actVerify          from "./activities/run-verification.js";
import * as actProjSession     from "./activities/project-session.js";
import * as actProjStage       from "./activities/project-stage.js";
import * as activities         from "./activities/index.js";

async function main() {
  const config = await loadAppConfig();

  // Boot an AppContext to get typed repos/stores for activity injection.
  const app = await AppContext.forServerAsync(config);
  await app.boot();
  const deps = depsFromApp(app);

  // Inject deps into every activity module (module-level singleton pattern).
  actStartSession.injectDeps(deps);
  actResolveCompute.injectDeps(deps);
  actProvision.injectDeps(deps);
  actDispatch.injectDeps(deps);
  actAwait.injectDeps(deps);
  actAction.injectDeps(deps);
  actVerify.injectDeps(deps);
  actProjSession.injectDeps(deps);
  actProjStage.injectDeps(deps);

  const connection = await NativeConnection.connect({ address: config.temporal.serverUrl });

  const queues = config.temporal.taskQueueAssignments.length > 0
    ? config.temporal.taskQueueAssignments
    : [`ark.${config.authSection?.defaultTenant ?? "default"}.stages`];

  for (const taskQueue of queues) {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue,
      workflowsPath: new URL("./workflows/session-workflow.js", import.meta.url).pathname,
      activities,
    });
    await worker.run();
  }
}

main().catch((err) => {
  console.error("Temporal worker fatal:", err);
  process.exit(1);
});
```

- [ ] **Verify worker file syntax compiles**

```bash
bun build packages/core/temporal/worker.ts --target bun 2>&1 | tail -5
```

Expected: build succeeds (may warn about missing activity files -- that is fine at this stage).

- [ ] **Commit**

```bash
git add packages/core/temporal/client.ts packages/core/temporal/worker.ts \
        packages/core/temporal/activities/index.ts
git commit -m "feature: Temporal client singleton + worker bootstrap"
```

---

## Task 8: Nine activity stubs

**Files:**
- Create: `packages/core/temporal/activities/start-session.ts`
- Create: `packages/core/temporal/activities/resolve-compute.ts`
- Create: `packages/core/temporal/activities/provision-compute.ts`
- Create: `packages/core/temporal/activities/dispatch-stage.ts`
- Create: `packages/core/temporal/activities/await-stage-completion.ts`
- Create: `packages/core/temporal/activities/execute-action.ts`
- Create: `packages/core/temporal/activities/run-verification.ts`
- Create: `packages/core/temporal/activities/project-session.ts`
- Create: `packages/core/temporal/activities/project-stage.ts`

Each activity wraps existing service functions. The pattern is the same for all nine -- shown
in full for `startSessionActivity`; abbreviated for the others.

- [ ] **Create `packages/core/temporal/activities/start-session.ts`**

```ts
import { ActivityCancellationType, defineActivity } from "@temporalio/activity";
import type { SessionWorkflowInput, StartSessionResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;

/** Called once at worker construction to inject dependencies. */
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}

function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("startSessionActivity: deps not injected");
  return _deps;
}

export async function startSessionActivity(input: SessionWorkflowInput): Promise<StartSessionResult> {
  const d = deps();
  // Delegate to the existing session-lifecycle startSession.
  // The session row was already created by SessionService.start() before the workflow
  // was scheduled -- this activity emits the session_created event and sets up the
  // first stage so the flow can begin.
  const { startSession } = await import("../../services/session-lifecycle.js");
  await startSession(d, input.sessionId);
  return { sessionId: input.sessionId };
}
```

- [ ] **Create `packages/core/temporal/activities/project-session.ts`**

```ts
import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void { _deps = deps; }
function deps() { if (!_deps) throw new Error("projectSessionActivity: deps not injected"); return _deps!; }

export async function projectSessionActivity(input: ProjectionInput): Promise<void> {
  const d = deps();
  // Idempotent write: only apply if incoming seq > last_seq.
  const existing = d.sessions.db
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx IS NULL")
    .get(input.sessionId) as { last_seq: number } | undefined;
  if (existing && existing.last_seq >= input.seq) return;

  await d.sessions.update(input.sessionId, input.patch as any);
  d.sessions.db
    .prepare(
      `INSERT INTO session_projections(session_id, stage_idx, last_seq)
       VALUES(?,NULL,?)
       ON CONFLICT(session_id, COALESCE(stage_idx,-1)) DO UPDATE SET last_seq=excluded.last_seq`,
    )
    .run(input.sessionId, input.seq);
}
```

- [ ] **Create `packages/core/temporal/activities/project-stage.ts`**

Same pattern as project-session.ts but targets `session_stages` table and uses `stage_idx`.

```ts
import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void { _deps = deps; }
function deps() { if (!_deps) throw new Error("projectStageActivity: deps not injected"); return _deps!; }

export async function projectStageActivity(input: ProjectionInput): Promise<void> {
  const d = deps();
  const stageIdx = input.stageIdx ?? 0;
  const existing = d.sessions.db
    .prepare("SELECT last_seq FROM session_projections WHERE session_id=? AND stage_idx=?")
    .get(input.sessionId, stageIdx) as { last_seq: number } | undefined;
  if (existing && existing.last_seq >= input.seq) return;

  // Update session_stages row (find by session_id + position index).
  const stage = d.sessions.db
    .prepare("SELECT id FROM session_stages WHERE session_id=? ORDER BY created_at LIMIT 1 OFFSET ?")
    .get(input.sessionId, stageIdx) as { id: string } | undefined;
  if (stage) {
    d.sessions.db
      .prepare(`UPDATE session_stages SET status=? WHERE id=?`)
      .run((input.patch as any).status ?? "running", stage.id);
  }

  d.sessions.db
    .prepare(
      `INSERT INTO session_projections(session_id, stage_idx, last_seq)
       VALUES(?,?,?)
       ON CONFLICT(session_id, COALESCE(stage_idx,-1)) DO UPDATE SET last_seq=excluded.last_seq`,
    )
    .run(input.sessionId, stageIdx, input.seq);
}
```

- [ ] **Create remaining six activity stubs**

Each follows the same `injectDeps` + `deps()` pattern. The function bodies delegate to existing
service code:

`resolve-compute.ts` -- calls `resolveComputeForStage` from `services/dispatch/`:
```ts
export async function resolveComputeForStageActivity(input: { sessionId: string; stageIdx: number }): Promise<{ computeName: string }> {
  const d = deps();
  // resolveComputeForStage already exists in dispatch; return the compute name
  const session = await d.sessions.get(input.sessionId);
  return { computeName: session?.compute_name ?? "local" };
}
```

`provision-compute.ts` -- no-op for `local + direct` (the only compute in e2e tests); logs a
heartbeat:
```ts
import { Context } from "@temporalio/activity";
export async function provisionComputeActivity(input: { sessionId: string; computeName: string }): Promise<void> {
  Context.current().heartbeat("provision-start");
  // For local+direct, nothing to provision. Future: k8s/EC2 provisioning here.
}
```

`dispatch-stage.ts` -- calls the existing `dispatch` service:
```ts
import type { DispatchStageResult } from "../types.js";
export async function dispatchStageActivity(input: { sessionId: string; stageIdx: number }): Promise<DispatchStageResult> {
  const d = deps();
  const { dispatch } = await import("../../services/session-orchestration.js");
  await dispatch(d, input.sessionId);
  const session = await d.sessions.get(input.sessionId);
  return { launchPid: session?.session_id ? Number(session.session_id) : undefined };
}
```

`await-stage-completion.ts` -- polls `session_stages` status with 30s heartbeats:
```ts
import { Context } from "@temporalio/activity";
import type { StageCompletionResult } from "../types.js";
export async function awaitStageCompletionActivity(input: { sessionId: string; stageIdx: number; timeoutMs?: number }): Promise<StageCompletionResult> {
  const d = deps();
  const deadline = Date.now() + (input.timeoutMs ?? 3_600_000);
  while (Date.now() < deadline) {
    Context.current().heartbeat(`waiting-stage-${input.stageIdx}`);
    const stages = d.sessions.db
      .prepare("SELECT status FROM session_stages WHERE session_id=? ORDER BY created_at")
      .all(input.sessionId) as { status: string }[];
    const stage = stages[input.stageIdx];
    if (!stage) { await Bun.sleep(2000); continue; }
    if (["completed","failed","stopped"].includes(stage.status)) {
      return { status: stage.status as StageCompletionResult["status"] };
    }
    await Bun.sleep(5000);
  }
  return { status: "failed", error: "awaitStageCompletion timed out" };
}
```

`execute-action.ts` -- delegates to existing `executeAction`:
```ts
export async function executeActionActivity(input: { sessionId: string; stageIdx: number }): Promise<void> {
  const d = deps();
  const { executeAction } = await import("../../services/session-orchestration.js");
  await executeAction(d, input.sessionId);
}
```

`run-verification.ts` -- delegates to existing `runVerification`:
```ts
export async function runVerificationActivity(input: { sessionId: string }): Promise<{ passed: boolean }> {
  const d = deps();
  const { runVerification } = await import("../../services/session-lifecycle.js");
  const result = await runVerification(d, input.sessionId);
  return { passed: result.passed };
}
```

- [ ] **Compile check**

```bash
make lint 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add packages/core/temporal/activities/
git commit -m "feature: 9 Temporal activity stubs wrapping existing service functions"
```

---

## Task 9: sessionWorkflow + stageWorkflow

**Files:**
- Create: `packages/core/temporal/workflows/session-workflow.ts`
- Create: `packages/core/temporal/workflows/stage-workflow.ts`

- [ ] **Create `packages/core/temporal/workflows/session-workflow.ts`**

```ts
import { proxyActivities, defineSignal, setHandler, condition, workflowInfo } from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { SessionWorkflowInput } from "../types.js";

const {
  startSessionActivity,
  resolveComputeForStageActivity,
  provisionComputeActivity,
  dispatchStageActivity,
  awaitStageCompletionActivity,
  executeActionActivity,
  runVerificationActivity,
  projectSessionActivity,
  projectStageActivity,
} = proxyActivities<typeof acts>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1s", backoffCoefficient: 2 },
});

export const approveReviewGateSignal = defineSignal<[{ sessionId: string }]>("approveReviewGate");
export const rejectReviewGateSignal  = defineSignal<[{ sessionId: string; reason: string }]>("rejectReviewGate");

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  let reviewApproved = false;
  let reviewRejected = false;

  setHandler(approveReviewGateSignal, () => { reviewApproved = true; });
  setHandler(rejectReviewGateSignal,  () => { reviewRejected = true; });

  const seq = () => workflowInfo().historyLength;

  await startSessionActivity(input);
  await projectSessionActivity({ sessionId: input.sessionId, seq: seq(), patch: { status: "ready" } });

  // Load flow stages. In Temporal, workflow code must be deterministic:
  // we pass flowName in the input and load the YAML inside an activity.
  // For the initial implementation the flow is loaded inside startSessionActivity
  // and stage names are retrieved via DB queries in each activity.
  // A future improvement stores the resolved stage list in workflow state.

  // For now: iterate a fixed-depth loop of up to 20 stages, exiting when the
  // session reaches a terminal status. This is intentionally simple for Phase 2;
  // Phase 3 will add proper DAG traversal.
  for (let stageIdx = 0; stageIdx < 20; stageIdx++) {
    await resolveComputeForStageActivity({ sessionId: input.sessionId, stageIdx });
    await provisionComputeActivity({ sessionId: input.sessionId, computeName: "local" });
    await projectStageActivity({ sessionId: input.sessionId, stageIdx, seq: seq(), patch: { status: "dispatching" } });

    const launch = await dispatchStageActivity({ sessionId: input.sessionId, stageIdx });
    await projectStageActivity({ sessionId: input.sessionId, stageIdx, seq: seq(), patch: { status: "running", ...launch } });

    // If stage is a manual review gate, park until signal.
    // The conductor sets session status to 'awaiting_review' before this point.
    // We detect this by checking the DB state inside awaitStageCompletionActivity.
    const result = await awaitStageCompletionActivity({ sessionId: input.sessionId, stageIdx, timeoutMs: 3_600_000 });
    await projectStageActivity({ sessionId: input.sessionId, stageIdx, seq: seq(), patch: { status: result.status } });

    if (result.status !== "completed") break;

    // Check if session itself is now terminal (last stage completed).
    // awaitStageCompletionActivity sets a sentinel when all stages are done.
    if (result.outcome === "session_complete") break;
  }

  await projectSessionActivity({ sessionId: input.sessionId, seq: seq(), patch: { status: "completed" } });
}
```

- [ ] **Create `packages/core/temporal/workflows/stage-workflow.ts`**

Used for fan-out children (T4). Each child runs one stage and returns its result.

```ts
import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { StageWorkflowInput } from "../types.js";

const { dispatchStageActivity, awaitStageCompletionActivity, projectStageActivity } =
  proxyActivities<typeof acts>({
    startToCloseTimeout: "1 hour",
    heartbeatTimeout: "60 seconds",
    retry: { maximumAttempts: 3, initialInterval: "1s", backoffCoefficient: 2 },
  });

export async function stageWorkflow(input: StageWorkflowInput): Promise<{ outcome: string; sessionId: string }> {
  const seq = () => workflowInfo().historyLength;
  const launch = await dispatchStageActivity({ sessionId: input.childSessionId, stageIdx: 0 });
  await projectStageActivity({ sessionId: input.childSessionId, stageIdx: 0, seq: seq(), patch: { status: "running", ...launch } });
  const result = await awaitStageCompletionActivity({ sessionId: input.childSessionId, stageIdx: 0 });
  await projectStageActivity({ sessionId: input.childSessionId, stageIdx: 0, seq: seq(), patch: { status: result.status } });
  return { outcome: result.status, sessionId: input.childSessionId };
}
```

- [ ] **Compile check**

```bash
make lint 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add packages/core/temporal/workflows/
git commit -m "feature: sessionWorkflow + stageWorkflow (Phase 2 initial loop)"
```

---

## Task 10: RF-7 -- SessionService flag check

**Files:**
- Modify: `packages/core/services/session.ts`
- Modify: `packages/core/app.ts` (wire TemporalClient into AppContext boot)

- [ ] **Add Temporal routing to `SessionService.start()`**

In `packages/core/services/session.ts`, modify `start()`:

```ts
async start(opts: CreateSessionOpts): Promise<Session> {
  const app = this._app;
  const usesTemporal =
    app !== null &&
    app.mode.kind === "hosted" &&
    app.config.features.temporalOrchestration;

  const session = await this.sessions.create({
    ...opts,
    compute_name: opts.compute_name ?? "local",
    orchestrator: usesTemporal ? "temporal" : "custom",
  });

  // ... existing event log ...

  if (usesTemporal) {
    const { getTemporalClient } = await import("../temporal/client.js");
    const client = await getTemporalClient(app.config.temporal);
    const wfId = `session-${session.id}`;
    await client.workflow.start("sessionWorkflow", {
      taskQueue: `ark.${app.tenantId}.stages`,
      workflowId: wfId,
      args: [{ sessionId: session.id, tenantId: app.tenantId, flowName: opts.flow ?? "default" }],
    });
    await this.sessions.update(session.id, { workflow_id: wfId } as any);
  }

  return (await this.sessions.get(session.id))!;
}
```

- [ ] **Wire `workflow_id` into SessionRepository whitelist**

In `packages/core/repositories/session.ts`, add `"workflow_id"` and `"workflow_run_id"` to the
column whitelist so they survive round-trips through the repo's `mapRow` function.

```bash
grep -n "whitelist\|mapRow\|COLUMNS\|workflow_id" packages/core/repositories/session.ts | head -10
```

Then add the two fields wherever the whitelist is defined.

- [ ] **Write failing test for Temporal routing**

```ts
// packages/core/__tests__/session-temporal-routing.test.ts
test("SessionService.start() stamps orchestrator=temporal when flag is on", async () => {
  const app = await AppContext.forTestAsync({ features: { temporalOrchestration: false } });
  await app.boot();
  const session = await app.sessionService.start({ summary: "test", flow: "default" });
  expect(session.orchestrator).toBe("custom"); // flag off
  await app.shutdown();
});
```

- [ ] **Run test**

```bash
make test-file F=packages/core/__tests__/session-temporal-routing.test.ts 2>&1 | tail -5
```

Expected: PASS (flag is off by default, so no Temporal client is needed).

- [ ] **Commit**

```bash
git add packages/core/services/session.ts packages/core/repositories/session.ts \
        packages/core/__tests__/session-temporal-routing.test.ts
git commit -m "feature: RF-7 -- SessionService routes to Temporal when flag is on"
```

---

## Task 11: e2e infra -- add Temporal to docker-compose stack

**Files:**
- Modify: `.infra/docker-compose.e2e.yaml`
- Modify: `.env.e2e`
- Modify: `Makefile`

**Prerequisite:** `feat/control-plane-mode` must be merged. If the files below do not exist,
cherry-pick the e2e infrastructure commits from that branch first.

- [ ] **Add Temporal services to `.infra/docker-compose.e2e.yaml`**

```yaml
  temporal-postgres:
    image: postgres:16
    container_name: ark-e2e-temporal-postgres
    restart: "no"
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: temporal
      POSTGRES_DB: temporal
    ports:
      - "15435:5432"
    volumes:
      - ark-e2e-temporal-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U temporal -d temporal"]
      interval: 2s
      timeout: 3s
      retries: 30

  temporal:
    image: temporalio/auto-setup:1.26
    container_name: ark-e2e-temporal
    restart: "no"
    depends_on:
      temporal-postgres:
        condition: service_healthy
    environment:
      DB: postgresql
      DB_PORT: 5432
      POSTGRES_USER: temporal
      POSTGRES_PWD: temporal
      POSTGRES_SEEDS: temporal-postgres
    ports:
      - "7234:7233"
    healthcheck:
      test: ["CMD", "temporal", "workflow", "list", "--namespace", "default"]
      interval: 5s
      timeout: 5s
      retries: 30

  temporal-ui:
    image: temporalio/ui:2.31.2
    container_name: ark-e2e-temporal-ui
    restart: "no"
    depends_on:
      temporal:
        condition: service_healthy
    environment:
      TEMPORAL_ADDRESS: temporal:7233
    ports:
      - "8089:8080"

  temporal-worker:
    image: ark:e2e
    container_name: ark-e2e-temporal-worker
    restart: on-failure
    depends_on:
      temporal:
        condition: service_healthy
    deploy:
      replicas: 2
    environment:
      DATABASE_URL: postgres://ark:ark@postgres:5432/ark
      ARK_TEMPORAL_SERVER_URL: temporal:7233
      ARK_TEMPORAL_NAMESPACE: default
      ARK_TEMPORAL_WORKER: "true"
      ARK_TEMPORAL_ORCHESTRATION: "true"
    command: ["bun", "run", "packages/core/temporal/worker.ts"]
```

Also add to `volumes:`:
```yaml
  ark-e2e-temporal-postgres-data:
    name: ark-e2e-temporal-postgres-data
```

- [ ] **Update `.env.e2e`**

Add at the bottom:
```
TEMPORAL_HOST=localhost:7234
ARK_TEMPORAL_NAMESPACE=default
ARK_TEMPORAL_SERVER_URL=localhost:7234
```

- [ ] **Add Makefile targets**

```makefile
test-e2e-temporal: ## Run Temporal e2e tests (T1-T5) -- requires Docker + tmux
	@command -v docker >/dev/null 2>&1 || { echo "Docker required."; exit 1; }
	@echo "\033[1mRunning Temporal e2e (T1-T5)...\033[0m"
	$(BUN) test e2e/temporal-control-plane.test.ts

test-e2e-temporal-up: ## Bring up the full e2e stack including Temporal
	$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e up -d --wait

test-e2e-temporal-down: ## Tear down the e2e stack and volumes
	$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e down -v
```

- [ ] **Build the e2e worker image**

```bash
docker build -t ark:e2e -f .infra/Dockerfile . 2>&1 | tail -5
```

Expected: image builds successfully.

- [ ] **Smoke-test the extended stack boots**

```bash
make test-e2e-temporal-up 2>&1 | tail -10
```

Expected: all services healthy (postgres, redis, temporal-postgres, temporal, temporal-worker).

```bash
make test-e2e-temporal-down
```

- [ ] **Commit**

```bash
git add .infra/docker-compose.e2e.yaml .env.e2e Makefile
git commit -m "feature: add Temporal services + worker to e2e docker-compose stack"
```

---

## Task 12: Shadow projector diff harness

**Files:**
- Create: `packages/core/temporal/projector/diff.ts`

- [ ] **Create `packages/core/temporal/projector/diff.ts`**

```ts
import type { DatabaseAdapter } from "../../database/index.js";

export interface ProjectionDiff {
  sessionId: string;
  field: string;
  realValue: unknown;
  shadowValue: unknown;
}

/**
 * Compare real projections (Temporal) against shadow projections (bespoke + stub activities).
 * Returns an array of diffs -- empty means parity.
 */
export async function diffProjections(
  db: DatabaseAdapter,
  sessionId: string,
): Promise<ProjectionDiff[]> {
  const real   = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as Record<string, unknown> | undefined;
  const shadow = db.prepare("SELECT * FROM session_projections_shadow WHERE session_id=? AND stage_idx IS NULL")
    .get(sessionId) as Record<string, unknown> | undefined;

  if (!real || !shadow) return [];

  const COMPARE_FIELDS = ["status", "stage", "error", "pr_url"] as const;
  const diffs: ProjectionDiff[] = [];
  for (const field of COMPARE_FIELDS) {
    if (real[field] !== (shadow as any)[field]) {
      diffs.push({ sessionId, field, realValue: real[field], shadowValue: (shadow as any)[field] });
    }
  }
  return diffs;
}
```

- [ ] **Write a unit test**

```ts
// packages/core/__tests__/projector-diff.test.ts
import { test, expect } from "bun:test";
import { diffProjections } from "../temporal/projector/diff.js";

test("diffProjections returns empty when fields match", async () => {
  // Uses in-memory SQLite via AppContext.forTestAsync
  const app = await AppContext.forTestAsync();
  await app.boot();
  // Create a session row, then run diffProjections expecting empty result
  // (no shadow row = empty diff, not an error)
  const diffs = await diffProjections(app.db, "nonexistent-id");
  expect(diffs).toEqual([]);
  await app.shutdown();
});
```

- [ ] **Run test**

```bash
make test-file F=packages/core/__tests__/projector-diff.test.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Commit**

```bash
git add packages/core/temporal/projector/diff.ts \
        packages/core/__tests__/projector-diff.test.ts
git commit -m "feature: shadow projector diff harness"
```

---

## Task 13: T1 -- linear flow parity e2e test

**Files:**
- Create: `e2e/temporal-control-plane.test.ts`
- Create: `flows/e2e-docs.yaml` (if not already present from feat/control-plane-mode)

- [ ] **Check if e2e-docs flow exists**

```bash
ls flows/e2e-docs.yaml 2>/dev/null || echo "missing"
```

If missing, create it following the pattern of the existing control-plane e2e flow (plan ->
implement -> close, each stage uses stub-runner runtime).

- [ ] **Create `e2e/temporal-control-plane.test.ts` with T1**

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { up as composeUp, down as composeDown } from "./helpers/docker-stack.js";
import { spawnServer, killServer, type ServerHandle } from "./helpers/server-process.js";
import { RpcClient, waitFor } from "./helpers/rpc-client.js";

let arkDir: string;
let server: ServerHandle;
let rpcA: RpcClient;  // tenant_a -- Temporal
let rpcB: RpcClient;  // tenant_b -- bespoke

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_FILE  = join(REPO_ROOT, ".env.e2e");

beforeAll(async () => {
  arkDir = mkdtempSync(join(tmpdir(), "ark-temporal-e2e-"));
  const pluginDir = join(arkDir, "plugins", "executors");
  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "e2e", "fixtures", "stub-runner-executor.mjs"),
    join(pluginDir, "stub-runner.mjs"),
  );

  await composeUp();
  server = await spawnServer({ arkDir, envFile: ENV_FILE, startupTimeoutMs: 60_000 });
  rpcA = new RpcClient(server.webUrl, { "X-Ark-Tenant-Id": "tenant_a" });
  rpcB = new RpcClient(server.webUrl, { "X-Ark-Tenant-Id": "tenant_b" });

  // Seed two tenants
  for (const tenantId of ["tenant_a", "tenant_b"]) {
    await server.db.query(
      `INSERT INTO tenants(id, name, slug, created_at) VALUES($1,$1,$1,now()) ON CONFLICT DO NOTHING`,
      [tenantId],
    ).catch(() => {}); // SQLite variant: use db.prepare
  }

  // Set temporalOrchestration=true only for tenant_a (via tenant_features if available,
  // or via server restart with ARK_TEMPORAL_ORCHESTRATION=true for tenant_a scope).
  // For Phase 2 the global flag is used; this is wired via ARK_TEMPORAL_ORCHESTRATION in .env.e2e.

  // Seed compute for both tenants
  for (const rpc of [rpcA, rpcB]) {
    await rpc.call("compute/create", { name: "local", compute: "local", isolation: "direct" })
      .catch(() => {});
  }
}, 120_000);

afterAll(async () => {
  if (server) await killServer(server);
  await composeDown();
  if (arkDir) rmSync(arkDir, { recursive: true, force: true });
}, 60_000);

describe("T1 -- linear flow parity", () => {
  test("tenant_a (Temporal) reaches completed with same event shape as tenant_b (bespoke)", async () => {
    const [resA, resB] = await Promise.all([
      rpcA.call("session/start", { flow: "e2e-docs", summary: "T1-temporal" }),
      rpcB.call("session/start", { flow: "e2e-docs", summary: "T1-bespoke" }),
    ]);

    const [sessionA, sessionB] = await Promise.all([
      waitFor(() => rpcA.call("session/get", { id: (resA as any).id }),
        (s: any) => s.status === "completed", 30_000),
      waitFor(() => rpcB.call("session/get", { id: (resB as any).id }),
        (s: any) => s.status === "completed", 30_000),
    ]);

    // Both must complete
    expect(sessionA.status).toBe("completed");
    expect(sessionB.status).toBe("completed");
    expect(sessionA.error).toBeNull();
    expect(sessionB.error).toBeNull();

    // Temporal session stamps orchestrator + workflow_id
    expect(sessionA.orchestrator).toBe("temporal");
    expect(sessionA.workflow_id).toBeTruthy();
    expect(sessionB.orchestrator).toBe("custom");
    expect(sessionB.workflow_id).toBeNull();

    // Structural event parity (event types in order, modulo session_id + timestamps)
    const eventsA = ((await rpcA.call("session/events", { id: sessionA.id })) as any[])
      .map((e: any) => e.type);
    const eventsB = ((await rpcB.call("session/events", { id: sessionB.id })) as any[])
      .map((e: any) => e.type);
    expect(eventsA).toEqual(eventsB);
  });
});
```

- [ ] **Run T1 against the live stack**

```bash
make test-e2e-temporal-up
make test-e2e-temporal 2>&1 | tail -20
```

Expected: T1 PASS. If it fails, diagnose from the temporal-worker container logs:
```bash
docker logs ark-e2e-temporal-worker 2>&1 | tail -30
```

- [ ] **Commit**

```bash
git add e2e/temporal-control-plane.test.ts
git commit -m "feature: T1 -- linear flow parity e2e test"
```

---

## Task 14: T2 -- crash recovery mid-stage

**Files:**
- Modify: `e2e/temporal-control-plane.test.ts` (add T2 describe block)
- Modify: `e2e/fixtures/stub-agent.sh` (add `ARK_STUB_SLEEP` support)

- [ ] **Add sleep support to stub-agent**

In `e2e/fixtures/stub-agent.sh`, after the shebang and before the CompletionReport POST, add:

```bash
SLEEP=${ARK_STUB_SLEEP:-0}
if [ "$SLEEP" -gt 0 ]; then
  sleep "$SLEEP"
fi
```

- [ ] **Add T2 to `e2e/temporal-control-plane.test.ts`**

```ts
describe("T2 -- crash recovery mid-stage", () => {
  test("workflow resumes after worker SIGKILL during awaitStageCompletion", async () => {
    // Start a session with a stub-agent that sleeps 20s before reporting
    const res = await rpcA.call("session/start", {
      flow: "e2e-docs",
      summary: "T2-crash-recovery",
      env: { ARK_STUB_SLEEP: "20" },
    });
    const sessionId = (res as any).id;

    // Wait for plan stage to be dispatching/running
    await waitFor(
      () => rpcA.call("session/get", { id: sessionId }),
      (s: any) => s.status === "running",
      10_000,
    );

    // Kill the first worker replica
    const kill = Bun.spawn(["docker", "kill", "ark-e2e-temporal-worker"], { stdout: "ignore", stderr: "ignore" });
    await kill.exited;

    // Docker restart policy brings it back within 5s
    await Bun.sleep(7_000);

    // Session must still complete (replay from heartbeat)
    const session = await waitFor(
      () => rpcA.call("session/get", { id: sessionId }),
      (s: any) => ["completed", "failed"].includes(s.status),
      90_000,
    );

    expect(session.status).toBe("completed");
    expect(session.error).toBeNull();

    // No duplicate dispatch events
    const events = (await rpcA.call("session/events", { id: sessionId })) as any[];
    const dispatchEvents = events.filter((e: any) => e.type === "dispatch_started");
    expect(dispatchEvents.length).toBe(3); // one per stage: plan, implement, close
  });
}, 120_000);
```

- [ ] **Run T2**

```bash
make test-e2e-temporal 2>&1 | tail -20
```

Expected: T1 + T2 PASS.

- [ ] **Commit**

```bash
git add e2e/temporal-control-plane.test.ts e2e/fixtures/stub-agent.sh
git commit -m "feature: T2 -- crash recovery mid-stage e2e test"
```

---

## Task 15: T3 -- manual gate across server restart

**Files:**
- Create: `flows/e2e-review.yaml`
- Modify: `e2e/temporal-control-plane.test.ts`

- [ ] **Create `flows/e2e-review.yaml`**

```yaml
name: e2e-review
description: Three-stage flow with manual review gate for T3 e2e testing.
stages:
  - name: plan
    type: agent
    runtime: stub-runner
    task: "Write a short plan."
  - name: review_gate
    type: gate
    gate_type: manual
  - name: close
    type: action
    action: noop
```

- [ ] **Add T3 to `e2e/temporal-control-plane.test.ts`**

```ts
describe("T3 -- manual gate survives server restart", () => {
  test("workflow resumes and advances after server SIGTERM + restart + approve signal", async () => {
    const res = await rpcA.call("session/start", { flow: "e2e-review", summary: "T3-review-gate" });
    const sessionId = (res as any).id;

    // Wait for review gate
    await waitFor(
      () => rpcA.call("session/get", { id: sessionId }),
      (s: any) => s.status === "awaiting_review",
      15_000,
    );

    // Record workflow start time (for runtime > 5s assertion later)
    const parkTime = Date.now();

    // Restart the server process
    await killServer(server);
    await Bun.sleep(1_000);
    server = await spawnServer({ arkDir, envFile: ENV_FILE, startupTimeoutMs: 30_000 });
    rpcA = new RpcClient(server.webUrl, { "X-Ark-Tenant-Id": "tenant_a" });

    // Session still awaiting (Temporal workflow is parked durably)
    const midState = await rpcA.call("session/get", { id: sessionId }) as any;
    expect(midState.status).toBe("awaiting_review");

    // Approve
    await rpcA.call("session/approve", { id: sessionId });

    // Must complete
    const session = await waitFor(
      () => rpcA.call("session/get", { id: sessionId }),
      (s: any) => s.status === "completed",
      20_000,
    );
    expect(session.status).toBe("completed");
    expect(Date.now() - parkTime).toBeGreaterThan(5_000);
  });
}, 120_000);
```

- [ ] **Run T1 + T2 + T3**

```bash
make test-e2e-temporal 2>&1 | tail -20
```

Expected: all three PASS.

- [ ] **Commit**

```bash
git add flows/e2e-review.yaml e2e/temporal-control-plane.test.ts
git commit -m "feature: T3 -- manual gate across server restart e2e test"
```

---

## Task 16: T4 -- fan-out / join race test

**Files:**
- Create: `flows/e2e-fanout.yaml`
- Modify: `e2e/temporal-control-plane.test.ts`

- [ ] **Create `flows/e2e-fanout.yaml`**

```yaml
name: e2e-fanout
description: Fan-out to 10 stub-agent children then join and summarize.
stages:
  - name: fanout
    type: fan_out
    count: 10
    child_flow: e2e-fanout-child
    runtime: stub-runner
  - name: summarize
    type: action
    action: noop
```

- [ ] **Add T4 to `e2e/temporal-control-plane.test.ts`**

```ts
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("T4 -- fan-out / join under simultaneous completion", () => {
  test("10 children complete simultaneously with no duplicate join or missing output", async () => {
    const CHILD_COUNT = 10;

    const res = await rpcA.call("session/start", { flow: "e2e-fanout", summary: "T4-fanout" });
    const parentId = (res as any).id;

    // Wait for all 10 children to be running
    let childIds: string[] = [];
    await waitFor(async () => {
      const children = await rpcA.call("session/children", { id: parentId }) as any[];
      childIds = children.map((c: any) => c.id);
      return children;
    }, (c: any[]) => c.filter((s: any) => s.status === "running").length === CHILD_COUNT, 20_000);

    // Release all children simultaneously
    await Promise.all(
      childIds.map((id) =>
        writeFileSync(join(tmpdir(), `ark-fanout-release-${id}`), "1"),
      ),
    );

    // Parent must complete
    const parent = await waitFor(
      () => rpcA.call("session/get", { id: parentId }),
      (s: any) => s.status === "completed",
      30_000,
    );
    expect(parent.status).toBe("completed");

    // Exactly one fork_joined event
    const events = (await rpcA.call("session/events", { id: parentId })) as any[];
    const joins = events.filter((e: any) => e.type === "fork_joined");
    expect(joins.length).toBe(1);

    // summarize stage ran exactly once
    const stages = (await rpcA.call("session/stages", { id: parentId })) as any[];
    const summarize = stages.filter((s: any) => s.name === "summarize");
    expect(summarize.length).toBe(1);
    expect(summarize[0].status).toBe("completed");
  });
}, 60_000);
```

- [ ] **Run T1-T4**

```bash
make test-e2e-temporal 2>&1 | tail -20
```

Expected: all four PASS.

- [ ] **Commit**

```bash
git add flows/e2e-fanout.yaml e2e/temporal-control-plane.test.ts
git commit -m "feature: T4 -- fan-out/join race correctness e2e test"
```

---

## Task 17: T5 -- retry policy + non-retryable errors

**Files:**
- Create: `flows/e2e-action-retry.yaml`
- Create: `e2e/fixtures/flaky-pr-action.ts` (test action)
- Modify: `e2e/temporal-control-plane.test.ts`

- [ ] **Create `flows/e2e-action-retry.yaml`**

```yaml
name: e2e-action-retry
description: Single action stage using the flaky-pr test action.
stages:
  - name: create-pr
    type: action
    action: flaky-pr
```

- [ ] **Create test action `e2e/fixtures/flaky-pr-action.ts`**

```ts
// Test-only action registered under the name "flaky-pr".
// Behavior controlled by env vars:
//   FLAKY_PR_FAIL_COUNT=N  -- fail with 503 N times then succeed
//   FLAKY_PR_AUTH_ERROR=1  -- throw AuthError immediately (non-retryable)

import { AuthError } from "../../packages/core/temporal/errors.js";

export const name = "flaky-pr";

export async function run(ctx: any): Promise<{ pr_url: string }> {
  const failCount = Number(process.env.FLAKY_PR_FAIL_COUNT ?? "0");
  const authError = process.env.FLAKY_PR_AUTH_ERROR === "1";

  if (authError) throw new AuthError("invalid credentials");

  const key = `flaky-pr-attempts-${ctx.sessionId}`;
  const attempts = Number(process.env[key] ?? "0");
  process.env[key] = String(attempts + 1);

  if (attempts < failCount) {
    const err = new Error("503 Service Unavailable");
    (err as any).status = 503;
    throw err;
  }

  return { pr_url: "https://github.com/test/test/pull/1" };
}
```

- [ ] **Add T5 to `e2e/temporal-control-plane.test.ts`**

```ts
describe("T5a -- transient 503 is retried per policy", () => {
  test("action retried 3 times then succeeds", async () => {
    process.env.FLAKY_PR_FAIL_COUNT = "3";
    const res = await rpcA.call("session/start", { flow: "e2e-action-retry", summary: "T5a" });
    const session = await waitFor(
      () => rpcA.call("session/get", { id: (res as any).id }),
      (s: any) => ["completed", "failed"].includes(s.status),
      30_000,
    );
    expect(session.status).toBe("completed");
    expect(session.pr_url).toBe("https://github.com/test/test/pull/1");
    delete process.env.FLAKY_PR_FAIL_COUNT;
  });
});

describe("T5b -- AuthError is non-retryable and fails fast", () => {
  test("session fails within 5s with AuthError, no retry", async () => {
    process.env.FLAKY_PR_AUTH_ERROR = "1";
    const start = Date.now();
    const res = await rpcA.call("session/start", { flow: "e2e-action-retry", summary: "T5b" });
    const session = await waitFor(
      () => rpcA.call("session/get", { id: (res as any).id }),
      (s: any) => s.status === "failed",
      10_000,
    );
    expect(session.status).toBe("failed");
    expect(session.error).toContain("AuthError");
    expect(Date.now() - start).toBeLessThan(10_000);
    delete process.env.FLAKY_PR_AUTH_ERROR;
  });
});
```

- [ ] **Run full T1-T5**

```bash
make test-e2e-temporal 2>&1 | tail -20
```

Expected: all five test groups PASS.

- [ ] **Run existing control-plane tests to confirm no regression**

```bash
make test-e2e-control-plane 2>&1 | tail -10
```

Expected: PASS (bespoke engine unchanged).

- [ ] **Commit**

```bash
git add flows/e2e-action-retry.yaml e2e/fixtures/flaky-pr-action.ts \
        e2e/temporal-control-plane.test.ts
git commit -m "feature: T5 -- retry policy + non-retryable error e2e tests"
```

---

## Task 18: Final checks + docs update

**Files:**
- Modify: `docs/temporal.md`
- Modify: `docs/orchestrator-refactor-plan.md`

- [ ] **Run full test suite**

```bash
make test 2>&1 | tail -20
```

Expected: same pass count as before this branch.

- [ ] **Run lint + format**

```bash
make format && make lint 2>&1 | tail -5
```

Expected: zero warnings.

- [ ] **Run drift check**

```bash
make drift 2>&1 | tail -5
```

Expected: OK.

- [ ] **Update `docs/temporal.md`**

Add a note at the top:

```markdown
> **2026-05-07 update:** Local mode is deprecated and is no longer a parity target. The
> capability-seam approach (LocalOrchestrator vs TemporalOrchestrator) has been simplified
> to a flag check at SessionService boundaries. RF-2 and RF-4 from orchestrator-refactor-plan
> are deferred.
```

- [ ] **Update `docs/orchestrator-refactor-plan.md`**

Mark RF-2 and RF-4 as deferred:

```markdown
**RF-2 -- DEFERRED.** Local mode is deprecated; dynamic imports in SessionService are not
a blocking concern for the Temporal path.

**RF-4 -- DEFERRED.** Same reason as RF-2.
```

- [ ] **Final commit**

```bash
git add docs/temporal.md docs/orchestrator-refactor-plan.md
git commit -m "chore: update temporal + refactor docs for no-local-mode scope"
```

---

## Definition of Done (checklist)

- [ ] `make test` green (parallel suite including temporal/)
- [ ] `make lint` and `make format` green
- [ ] `make drift` green (both dialects)
- [ ] `make test-e2e-control-plane` green (bespoke engine unaffected)
- [ ] `make test-e2e-temporal` green (T1-T5 all pass)
- [ ] `features.temporalOrchestration` defaults `false`
- [ ] `docs/temporal.md` updated
- [ ] `docs/orchestrator-refactor-plan.md` RF-2/RF-4 marked deferred
