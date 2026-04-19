# Agent 1 -- SOLID / Hex Layering Audit

## Summary

Ark's `packages/core` is the "domain" in name only: it is a procedural, I/O-drenched transaction script. Services take `AppContext` as a first argument (a functional service-locator), reach directly into `fs`, subprocess spawning, `bun:sqlite`, tmux, and SSH, and make tenant scheduling decisions inline with local-mode worktree logic. There is no hex boundary -- primary adapters (`packages/server/handlers/*`) import orchestrator functions by dynamic path, secondary adapters (providers, tmux, fs) are called directly from "services," and the web client redeclares every RPC shape as `any`. SOLID scores are uniformly poor in `core`/`server`; `types` and `protocol` are clean but unused on the client edge. The two most urgent architectural bets: (1) extract a `Workspace` port to decouple worktree/fs/shell from domain, and (2) eliminate `AppContext` as a god-argument by injecting narrow per-use-case ports.

## Severity Distribution

Critical: 9 · High: 14 · Medium: 11 · Low: 5

## Hex Classification Map

| File | Current Layer | Should Be | Mixes |
|---|---|---|---|
| `packages/core/app.ts` | composition + adapter | composition | `bun:sqlite`, `fs`, tmux, signal handlers, OTLP config all in one 1082-LOC class |
| `packages/core/services/session.ts` | application (thin) | application | calls `events.log` directly -- OK |
| `packages/core/services/session-orchestration.ts` | application (barrel) | application | re-export only -- clean |
| `packages/core/services/session-lifecycle.ts` | mixed | application | imports subprocess spawners and runs `git` inline (L8–10, 42–46) |
| `packages/core/services/stage-orchestrator.ts` | mixed | application + adapter split | `fs.mkdirSync`, subprocess spawns, `git clone`, ArkdClient HTTP, knowledge mutation, OTLP spans, telemetry (L7–28, 193–195) |
| `packages/core/services/workspace-service.ts` | adapter dressed as service | secondary adapter (`GitWorktree` port) | `fs`, subprocess spawns, worktree mgmt, attachment writing (L7–17, 106–121) |
| `packages/core/services/agent-launcher.ts` | adapter | secondary adapter (`AgentLaunch` port) | `fs`, tmux, provider selection, dynamic ssh/ec2 import (L7, 31–33) |
| `packages/core/services/session-hooks.ts` | mixed | domain (policy) + adapter | Pure status policy muddied with subprocess git peek (L9, 109–122) -- policy must not read git |
| `packages/core/services/session-output.ts` | application | application | OK; delegates to provider port |
| `packages/core/services/task-builder.ts` | mixed | domain (builder) | `fs` + subprocess spawns in a prompt builder (L7, 10) |
| `packages/core/services/compute.ts` | middleman | delete or absorb | 44 LOC of pure pass-through to repo |
| `packages/core/services/history.ts` | adapter (SQL literal) | repo-layer | Raw `LIKE ?` SQL inside a "service" |
| `packages/core/repositories/session.ts` | secondary adapter | secondary adapter | OK, except dynamic column whitelist = schema drift risk |
| `packages/core/repositories/schema.ts` | secondary adapter | secondary adapter | OK |
| `packages/core/repositories/schema-postgres.ts` | secondary adapter | secondary adapter | OK; duplicated DDL w/ sqlite schema -- divergent change risk |
| `packages/core/ledger.ts`, `tools.ts`, `recordings.ts`, `notify.ts`, `sandbox.ts`, `theme.ts` | mixed | secondary adapters | all touch `fs`/subprocess from `core` top-level |
| `packages/core/mcp-pool.ts` | adapter | secondary adapter (`McpTransport` port) | spawns subprocesses + net sockets from `core` (L13–15) |
| `packages/core/prereqs.ts` | adapter | secondary adapter | subprocess spawn from `core` |
| `packages/server/handlers/session.ts` | primary adapter | primary adapter | OK, but dynamic `await import("../../core/services/session-orchestration.js")` on L37, 344 -- leaks composition into the handler |
| `packages/server/handlers/resource.ts` | primary adapter | primary adapter | 445 LOC -- god handler |
| `packages/server/handlers/web.ts` | primary adapter | primary adapter | 231 LOC; uses inline `extract<{...}>` types (bypasses `packages/types`) |

## SOLID Scorecard

| Package | SRP | OCP | LSP | ISP | DIP | Worst Offender (file:line) |
|---|---|---|---|---|---|---|
| core | 1 | 2 | 3 | 1 | 1 | `services/stage-orchestrator.ts:1-1255` |
| server | 2 | 3 | 4 | 2 | 2 | `handlers/session.ts:37,344` (dynamic composition import in handler) |
| router | 3 | 3 | 4 | 3 | 3 | `core/router/tensorzero.ts:12-13` (spawns sidecar, writes fs) |
| arkd | 3 | 3 | 4 | 3 | 3 | (daemon -- ambient system calls by design) |
| compute | 3 | 4 | 4 | 3 | 3 | Provider interface is decent but `session-orchestrator` bypasses it |
| protocol | 4 | 4 | 5 | 4 | 4 | `protocol/client.ts` -- solid |
| web | 2 | 2 | 4 | 2 | 1 | `web/src/hooks/useApi.ts:64-256` -- 70× `rpc<any>` |
| desktop | 3 | 3 | 4 | 3 | 3 | Electron shell, minimal logic |

## Findings

| ID | Severity | File:Line | Category | Title | Evidence | Proposed Fix | Effort | Depends On |
|---|---|---|---|---|---|---|---|---|
| A1-001 | critical | `packages/core/services/workspace-service.ts:7-17` | control-plane-leak | Worktree service does raw fs + git in core | Raw fs imports (`existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync`) + subprocess spawns for `git` directly in an 845-LOC "service" | Introduce `Workspace` port (`create/remove/diff/copy/pr`) in domain; move current impl to `infra/git-worktree-adapter.ts`. Hosted mode supplies a remote-backed adapter. | L | none |
| A1-002 | critical | `packages/core/services/session-hooks.ts:109-122` | layer-mixing | Pure hook-status policy shells out to `git` | Synchronous subprocess `git rev-parse HEAD` inside `applyHookStatus` | Take `hasNewCommits: boolean` as an input computed by the caller via a `CommitInspector` port | M | A1-001 |
| A1-003 | critical | `packages/core/services/stage-orchestrator.ts:8-12, 193-195` | control-plane-leak | Stage dispatch does `git clone` and `mkdirSync` | Inline async subprocess spawn for `git clone` + `mkdirSync(tmpDir)` | Replace with `WorkspaceProvisioner` port | L | A1-001 |
| A1-004 | critical | `packages/core/services/agent-launcher.ts:7, 33, 67` | control-plane-leak | Agent launcher imports ec2 ssh from core | `await import("../../compute/providers/ec2/ssh.js")` to run ssh against tenant hosts | Launcher depends on a `RemoteExec` port; ec2 ssh lives as adapter | M | A1-001 |
| A1-005 | critical | `packages/core/app.ts:9-10` | boundary-violation | Composition root hardcodes `bun:sqlite` | `import { Database } from "bun:sqlite"` in `app.ts` | Move sqlite construction to a bootstrap module; `app.ts` accepts an `IDatabase` | S | none |
| A1-006 | critical | `packages/web/src/hooks/useApi.ts:64-256` | type-drift | 70× `rpc<any>` on client; zero imports from `packages/types` or `packages/protocol` | Example `deleteSession: (id: string) => rpc<any>(...)`; grep of `web/src` for imports of `types` or `protocol` returns 0 hits | Generate a typed client from `types/rpc.ts`; replace `any` with the `SessionStartParams`/`Result` pairs that already exist | M | none |
| A1-007 | critical | `packages/server/handlers/session.ts:37, 344` | layer-mixing | Handler dynamically imports orchestrator module path | `await import("../../core/services/session-orchestration.js")` | Inject `sessionOrchestrator` via `AppContext`; ban dynamic imports in handlers | S | none |
| A1-008 | critical | `packages/core/services/stage-orchestrator.ts:1-1255` | code-smell | God file: 1255 LOC with dispatch, advance, fork/join, fan-out, subagents, actions, OTLP, knowledge ingest | `ingestRemoteIndex`, `dispatchFork`, `dispatchFanOut`, `executeAction`, `spawnSubagent`, OTLP all colocated | Split into `DispatchUseCase`, `AdvanceUseCase`, `ForkJoinService`, `FanOutService`, `ActionRunner`, `RemoteIndexIngester` | L | A1-001, A1-003 |
| A1-009 | critical | `packages/core/services/*.ts` | anemic-domain | `Session` has zero behavior | `types/session.ts` is a record; all transitions live in services (`applyHookStatus`, `advance`, `dispatch`, `stop`, `pause`). `status === "running"` branching across 5 files | Introduce `Session` aggregate with `start()/dispatch()/advance()/pause()/stop()` returning domain events | L | A1-001 |
| A1-010 | high | `packages/core/repositories/session.ts:63-80` | code-smell | Column whitelist duplicates schema | Hand-maintained `SESSION_COLUMNS` set; drift from `schema.ts`/`schema-postgres.ts` is silent | Derive from a single schema source or use a thin query-builder | S | none |
| A1-011 | high | `packages/core/services/session-orchestration.ts:1-102` | code-smell | Barrel + runtime DI injection | Calls `injectWorktreeDeps({...})` at module load -- temporal coupling masked as "break circular imports" | Replace with explicit DI container (awilix is already present) | M | A1-001 |
| A1-012 | high | top-level `packages/core/*.ts` | boundary-violation | 40+ core modules import `fs`/subprocess APIs | `ledger.ts`, `tools.ts`, `recordings.ts`, `notify.ts`, `theme.ts`, `sandbox.ts`, `prereqs.ts`, `config.ts`, `mcp-pool.ts`, `worktree-merge.ts` all import fs/exec from `core` root | Reclassify as adapters under `core/infra/` or move to a new `@ark/infra` package | L | none |
| A1-013 | high | `packages/core/services/session.ts:20-45` | solid-violation | `SessionService` requires `AppContext` setter to sidestep DIP | `setApp(app)` after construction; `this.app` throws if unset | Constructor-inject only the narrow ports needed (sessions repo, dispatcher, lifecycle) | S | A1-009 |
| A1-014 | high | `packages/core/services/workspace-service.ts:106-121` | solid-violation | Worktree writer writes user attachments inline | Attachment base64 decode + `writeFileSync` mid-function | Extract `AttachmentWriter` service; test independently | S | A1-001 |
| A1-015 | high | everywhere | primitive-obsession | `SessionId`, `TenantId`, `Stage`, `Workdir`, `RepoPath` are raw `string` | `id: string`, `tenant_id: string`, `stage: string | null`, `workdir: string | null` in `types/session.ts` | Introduce branded types: `type SessionId = string & {readonly _: unique symbol}` with smart constructors | M | none |
| A1-016 | high | `types/session.ts:60` | primitive-obsession | `SessionConfig` uses open index signature | Bag-of-props interface -- no invariants (`[key: string]: unknown`) | Split into `RuntimeConfig`, `LifecycleConfig`, `ProcessTracking`; lock index signature | M | A1-015 |
| A1-017 | high | `packages/server/handlers/resource.ts:1-445` | code-smell | 445-LOC god handler | 8 RPC methods in one file | Split per-resource | S | none |
| A1-018 | high | `packages/core/services/stage-orchestrator.ts:158-186` | control-plane-leak | Hosted-mode scheduler selection inside dispatch | `try { app.scheduler.schedule(...) } catch { /* fall-through to local */ }` -- hosted vs local path chosen by try/catch | Polymorphic `Dispatcher` port: `LocalDispatcher` or `HostedDispatcher` chosen at composition time | M | A1-001 |
| A1-019 | high | `packages/core/services/session-hooks.ts:1-826` | code-smell | 826 LOC of policy branching on strings | `if (hookEvent === "SessionEnd" && isAutoGate ...)` repeated; `statusMap` + overrides + overrides | Replace with state-machine table + Stage/Hook value objects | M | A1-015 |
| A1-020 | high | `packages/core/services/task-builder.ts:7, 10` | layer-mixing | Prompt builder imports `fs` + subprocess APIs | A template builder should be pure | Pass file content / git context as args | S | A1-001 |
| A1-021 | high | `packages/server/handlers/session.ts` | type-drift | Inline `extract<{sessionId: string; base?: string}>` shapes | L184, L290, L325, L351, L365 declare request types inline instead of pulling from `types/rpc.ts` | Add missing types to `types/rpc.ts`; forbid inline `extract<{...}>` | S | A1-006 |
| A1-022 | high | `types/session.ts:105` | solid-violation | `CreateSessionOpts.attachments` bleeds UI concern | `attachments: Array<{name,content,type}>` in domain create type | Attachments are a transport/adapter concern; strip from `CreateSessionOpts` | S | none |
| A1-023 | high | `packages/core/services/compute.ts:1-44` | code-smell | Pure middleman | Every method delegates 1:1 to `ComputeRepository` | Delete class; handlers can use repo directly, or flesh out service w/ provisioning | S | none |
| A1-024 | high | `packages/core/services/stage-orchestrator.ts:37-74` | layer-mixing | Knowledge graph ingestion inside stage orchestrator | `ingestRemoteIndex(app, data, log)` mutates `app.knowledge` | Move to `KnowledgeIngestionService`; dispatcher publishes an event | S | A1-008 |
| A1-025 | medium | `packages/core/services/session-lifecycle.ts:38-62` | layer-mixing | `resolveGitHubUrl` uses subprocess `execFileSync` inside lifecycle | Should be a pure URL transformer given a remote string | Split fetch (adapter) from parse (pure) | S | -- |
| A1-026 | medium | `packages/core/services/session-orchestration.ts:97-101` | code-smell | Runtime cross-module injection | `injectWorktreeDeps({deleteSessionAsync, stop, runVerification})` at import time | Replace with explicit function wiring at composition root | S | A1-011 |
| A1-027 | medium | `handlers/session.ts:33-75` | code-smell | Shotgun surgery risk: every mutation triggers `notify("session/updated", {session})` | 13 copies of the same 3-line block | Extract `withSessionNotify()` helper in router | S | -- |
| A1-028 | medium | `types/rpc.ts` | type-drift | Not re-exported through `packages/protocol` | `client.ts` defines its own method strings | Single source of truth for method name ↔ param ↔ result triple | M | A1-006 |
| A1-029 | medium | `packages/core/repositories/schema.ts` vs `schema-postgres.ts` | code-smell | Divergent-change schema | Two DDL files hand-kept in sync | Generate both from a schema DSL | M | -- |
| A1-030 | medium | `packages/core/app.ts:81-120` | code-smell | 1082-LOC AppContext god class | Phases, container, providers, launcher, workerRegistry, scheduler, tensorZero, router, signalHandlers, purgeInterval, notifyDaemon all on one class | Split: `Composition`, `Lifecycle`, `SignalHub`, `ProviderResolver` | M | A1-005 |
| A1-031 | medium | `packages/core/services/session-hooks.ts:69-72` | temporal-coupling | "Mostly pure, but..." comment acknowledging async side effects | Document says handoff detection fires asynchronously from a policy fn | Return an event; let caller execute | S | A1-009 |
| A1-032 | medium | `packages/core/services/stage-orchestrator.ts` all functions | solid-violation | Long parameter list / feature envy via `app: AppContext` | Every function's first arg is `AppContext`, reaching across repos, events, computes, sessions, scheduler, knowledge, flows | Replace with per-UC request object carrying only needed ports | M | A1-009 |
| A1-033 | medium | `packages/web/src/hooks/useApi.ts:1-3` | boundary-violation | UI reads auth token from `window.location.search` globally | Module-scoped `TOKEN` constant | Pass via `ApiClient` constructor; testable | S | -- |
| A1-034 | medium | `packages/core/services/session-output.ts:30` | temporal-coupling | Live capture then dynamic `import("../recordings.js")` fallback | Behavior depends on tmux liveness at call time | Abstract behind a `SessionOutputSource` that already knows the strategy | S | A1-001 |
| A1-035 | medium | `packages/server/handlers/session.ts:201-206` | layer-mixing | Handler dynamically imports `recordings.js` | Direct fs read from handler via dynamic import | Inject reader | S | A1-007 |
| A1-036 | low | `packages/types/session.ts:26-61` | anemic-domain | `SessionConfig` mixes runtime, lifecycle, process-tracking | Single flat interface | Namespace via nested types | S | -- |
| A1-037 | low | `packages/core/services/history.ts:33-62` | layer-mixing | Raw SQL LIKE in a service | Belongs to repo | Move to `SessionRepository.searchByMeta()` | S | -- |
| A1-038 | low | `packages/server/handlers/web.ts` | code-smell | Inline `extract<{...}>` across 5 handlers | Same pattern as session.ts | Factor into request DTOs | S | A1-021 |
| A1-039 | low | `packages/core/services/session-output.ts:34-75` | solid-violation | `send()` does validation + audit log + persistence + transport | 4 responsibilities in one function | Split into `validate/record/transport` pipeline | S | -- |

## Top 5 Architectural Bets

1. **Introduce a `Workspace` port.** Encapsulates git worktree, fs copy, attachments, diff, PR creation, cleanup. Local-mode adapter uses `fs`+subprocess; hosted-mode adapter calls `arkd`. Kills A1-001/003/004/014/020 and unblocks tenant isolation (memory note: orchestrator refactor already flagged).
2. **Retire `AppContext`-as-arg.** Replace procedural services taking `(app, ...)` with use-case classes that receive only the ports they need. Eliminates feature envy, makes `session-hooks` testable without booting sqlite.
3. **Branded value objects for ids + stages.** Single change kills a whole class of primitive-obsession bugs (tenant leakage, wrong stage names) and makes schema ↔ RPC drift compile-time.
4. **Generate the web API client from `types/rpc.ts`.** 70× `rpc<any>` is actively hostile; the types already exist. A codegen step removes the single largest correctness gap between server and UI.
5. **Promote `Session` from record to aggregate.** Move state transitions (`dispatch/advance/pause/stop/fail`) onto the entity; services become thin application coordinators. Collapses `session-hooks.ts` from 826 LOC of string-switching to a table-driven transition set.
