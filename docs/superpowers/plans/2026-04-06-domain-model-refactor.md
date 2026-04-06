# Domain Model Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the untyped store/session layer with a typed repository/service architecture, eliminating ~80 `as any` casts and establishing type safety from SQL to React.

**Architecture:** New `packages/types/` defines all domain interfaces. `packages/core/repositories/` encapsulates SQL. `packages/core/services/` owns business logic. Server handlers delegate to services via AppContext. ArkClient returns typed results. TUI consumes typed data.

**Tech Stack:** TypeScript (strict-ish, no external validation libs), bun:sqlite, bun:test, React/Ink

**Spec:** `docs/superpowers/specs/2026-04-06-domain-model-refactor-design.md`

---

## File Map

### New files to create

```
packages/types/
  index.ts                    barrel export
  session.ts                  Session, SessionConfig, SessionStatus, CreateSessionOpts, SessionListFilters
  compute.ts                  Compute, ComputeConfig variants, ComputeStatus, ComputeProviderName, CreateComputeOpts
  event.ts                    Event
  message.ts                  Message, MessageRole, MessageType
  rpc.ts                      all RPC param/result pairs (~40 methods)
  agent.ts                    AgentDefinition
  flow.ts                     FlowDefinition, StageDef, GateType
  common.ts                   SessionOpResult, PortDecl, ComputeSnapshot, HookPayload, AgentReport, etc.

packages/core/
  repositories/
    schema.ts                 initSchema(), column definitions (renamed: ticket, summary, flow)
    session.ts                SessionRepository class
    compute.ts                ComputeRepository class
    event.ts                  EventRepository class
    message.ts                MessageRepository class
    index.ts                  barrel export
    __tests__/
      session.test.ts         SessionRepository CRUD + edge cases
      compute.test.ts         ComputeRepository CRUD + mergeConfig atomicity
      event.test.ts           EventRepository log/list/delete
      message.test.ts         MessageRepository send/list/markRead/unreadCount
  services/
    session.ts                SessionService class
    compute.ts                ComputeService class
    history.ts                HistoryService class
    index.ts                  barrel export
    __tests__/
      session.test.ts         state transitions, dispatch/stop/resume/advance/complete
      compute.test.ts         provision/destroy/metrics
      history.test.ts         index/search/refresh

packages/server/
  validate.ts                 extract<T> helper

packages/tui/
  helpers/colors.ts           InkColor type, getStatusColor returns InkColor
```

### Files to modify (major changes)

```
packages/core/app.ts          wire repos + services onto AppContext
packages/core/index.ts        re-export from repos/services/types instead of store/session
packages/core/conductor.ts    use app.sessionService instead of import * as session
packages/core/web.ts          use app services
packages/core/acp.ts          use app services
packages/core/search.ts       minor: import types from packages/types
packages/core/rollback.ts     minor: import types from packages/types
packages/core/costs.ts        minor: import Session from packages/types

packages/server/register.ts   registerAllHandlers(router, app) signature
packages/server/handlers/*.ts  all 9 handlers: use app + extract<T>

packages/protocol/client.ts   typed returns on all 88 methods, rpc becomes private

packages/tui/hooks/useArkStore.ts     StoreData: Session[], Compute[], etc.
packages/tui/helpers/sessionFormatting.ts  session: Session (not any)
packages/tui/tabs/*.tsx        remove as any casts for colors + config
packages/tui/components/*.tsx  remove color as any casts

packages/compute/types.ts     import from packages/types instead of core/store
packages/compute/providers/*/index.ts  import from packages/types
```

### Files to delete

```
packages/core/store.ts        replaced by repositories/ + schema.ts
packages/core/session.ts      replaced by services/session.ts
packages/core/context.ts      DB lifecycle owned by AppContext
```

### Test files to reorganize

```
packages/core/__tests__/      existing tests update imports, some move to repos/__tests__/ or services/__tests__/
packages/server/__tests__/    update handler test signatures
packages/compute/__tests__/   update store imports
packages/tui/__tests__/       update store imports
```

---

## Task 1: Create `packages/types/` — Domain Interfaces

All domain types in one dependency-free package.

**Files:**
- Create: `packages/types/session.ts`
- Create: `packages/types/compute.ts`
- Create: `packages/types/event.ts`
- Create: `packages/types/message.ts`
- Create: `packages/types/agent.ts`
- Create: `packages/types/flow.ts`
- Create: `packages/types/common.ts`
- Create: `packages/types/rpc.ts`
- Create: `packages/types/index.ts`

- [ ] **Step 1: Create `packages/types/session.ts`**

```ts
export type SessionStatus =
  | "pending" | "ready" | "running" | "waiting"
  | "stopped" | "blocked" | "completed" | "failed" | "deleting";

export interface SessionUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_cost?: number;
}

export interface SessionConfig {
  // Runtime
  usage?: SessionUsage;
  turns?: number;
  model_override?: string;
  completion_summary?: string;
  filesChanged?: string[];
  commits?: string[];
  github_url?: string;
  ports?: Array<{ port: number; name?: string; source?: string }>;
  // Compute/infra
  remoteWorkdir?: string;
  worktree?: string;
  // Lifecycle
  _pre_delete_status?: string;
  _deleted_at?: string;
  _pending_handoff?: { agent: string; instructions?: string };
  // Skills attached to session
  skills?: string[];
  // Extensible for provider-specific state
  [key: string]: unknown;
}

export interface Session {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  stage: string | null;
  status: SessionStatus;
  flow: string;
  agent: string | null;
  workdir: string | null;
  pr_url: string | null;
  pr_id: string | null;
  error: string | null;
  parent_id: string | null;
  fork_group: string | null;
  group_name: string | null;
  breakpoint_reason: string | null;
  attached_by: string | null;
  config: SessionConfig;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionOpts {
  ticket?: string;
  summary?: string;
  repo?: string;
  flow?: string;
  agent?: string | null;
  compute_name?: string;
  workdir?: string;
  group_name?: string;
  config?: Partial<SessionConfig>;
}

export interface SessionListFilters {
  status?: SessionStatus;
  repo?: string;
  group_name?: string;
  parent_id?: string;
  flow?: string;
  limit?: number;
}
```

- [ ] **Step 2: Create `packages/types/compute.ts`**

```ts
export type ComputeStatus = "stopped" | "running" | "provisioning" | "destroyed";
export type ComputeProviderName = "local" | "docker" | "ec2" | "remote-arkd";

export interface LocalComputeConfig {
  [key: string]: unknown;
}

export interface EC2ComputeConfig {
  ip?: string;
  key_path?: string;
  instance_id?: string;
  size?: string;
  region?: string;
  ami?: string;
  ssh_user?: string;
  [key: string]: unknown;
}

export interface DockerComputeConfig {
  image?: string;
  container_id?: string;
  [key: string]: unknown;
}

export interface RemoteArkdConfig {
  ip?: string;
  key_path?: string;
  ssh_user?: string;
  arkd_port?: number;
  [key: string]: unknown;
}

export type ComputeConfig =
  | LocalComputeConfig
  | EC2ComputeConfig
  | DockerComputeConfig
  | RemoteArkdConfig;

export interface Compute {
  name: string;
  provider: ComputeProviderName;
  status: ComputeStatus;
  config: ComputeConfig;
  created_at: string;
  updated_at: string;
}

export interface CreateComputeOpts {
  name: string;
  provider?: ComputeProviderName;
  config?: Partial<ComputeConfig>;
}
```

- [ ] **Step 3: Create `packages/types/event.ts`**

```ts
export interface Event {
  id: number;
  track_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}
```

- [ ] **Step 4: Create `packages/types/message.ts`**

```ts
export type MessageRole = "user" | "agent" | "system";
export type MessageType = "text" | "progress" | "question" | "completed" | "error";

export interface Message {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  type: MessageType;
  read: boolean;
  created_at: string;
}
```

- [ ] **Step 5: Create `packages/types/agent.ts`**

Read the current `AgentDefinition` from `packages/core/agent.ts` and replicate it here. The interface should match the YAML agent schema.

```ts
export interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  max_turns: number;
  system_prompt: string;
  tools: string[];
  permission_mode: string;
  mcp_servers: string[];
  skills: string[];
  memories: string[];
  _source?: "builtin" | "project" | "global";
}
```

- [ ] **Step 6: Create `packages/types/flow.ts`**

Read the current `FlowDefinition` and `StageDefinition` from `packages/core/flow.ts` and replicate here.

```ts
export type GateType = "manual" | "auto" | "condition";

export interface StageDef {
  name: string;
  agent: string;
  gate: GateType;
  condition?: string;
  on_fail?: string;
}

export interface FlowDefinition {
  name: string;
  description?: string;
  stages: StageDef[];
  _source?: "builtin" | "project" | "global";
}
```

- [ ] **Step 7: Create `packages/types/common.ts`**

Shared types used across layers.

```ts
export interface SessionOpResult {
  ok: boolean;
  message: string;
}

export interface PortDecl {
  port: number;
  name?: string;
  source?: string;
}

export interface PortStatus extends PortDecl {
  listening: boolean;
}

export interface ComputeMetrics {
  cpu: number;
  memTotalGb: number;
  memUsedGb: number;
  memPct: number;
  diskPct: number;
  uptime: string;
}

export interface ComputeSnapshot {
  metrics: ComputeMetrics;
  sessions: Array<{ name: string; status: string }>;
  processes: Array<{ pid: number; name: string; cpu: number; mem: number }>;
  docker: Array<{ name: string; status: string; image: string }>;
}

export interface HookPayload {
  event?: string;
  session_id?: string;
  matcher?: string;
  tool_name?: string;
  [key: string]: unknown;
}

export interface AgentReport {
  type: "progress" | "completed" | "error" | "question";
  message?: string;
  summary?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost?: number };
  [key: string]: unknown;
}

export interface SpawnOpts {
  task: string;
  agent?: string;
  model?: string;
  group_name?: string;
}

export interface WaitOpts {
  timeoutMs?: number;
  pollMs?: number;
  onStatus?: (status: string) => void;
}

export interface WorktreeFinishOpts {
  into?: string;
  noMerge?: boolean;
  keepBranch?: boolean;
}
```

- [ ] **Step 8: Create `packages/types/rpc.ts`**

RPC param/result pairs for all server methods. Import types from sibling files.

```ts
import type { Session, CreateSessionOpts, SessionListFilters, SessionStatus, SessionConfig } from "./session.js";
import type { Compute, CreateComputeOpts, ComputeProviderName } from "./compute.js";
import type { Event } from "./event.js";
import type { Message } from "./message.js";
import type { AgentDefinition } from "./agent.js";
import type { FlowDefinition } from "./flow.js";
import type { SessionOpResult, ComputeSnapshot, SpawnOpts, WorktreeFinishOpts } from "./common.js";

// ── Session ─────────────────────────────────────────────────────────────────

export interface SessionStartParams extends CreateSessionOpts {}
export interface SessionStartResult { session: Session }

export interface SessionIdParams { sessionId: string }

export interface SessionListParams extends SessionListFilters {}
export interface SessionListResult { sessions: Session[] }

export interface SessionReadParams { sessionId: string; include?: string[] }
export interface SessionReadResult { session: Session; events?: Event[]; messages?: Message[] }

export interface SessionUpdateParams { sessionId: string; fields: Partial<Session> }
export interface SessionUpdateResult { session: Session }

export interface SessionDispatchParams { sessionId: string }
export interface SessionAdvanceParams { sessionId: string; force?: boolean }
export interface SessionPauseParams { sessionId: string; reason?: string }

export interface SessionForkParams { sessionId: string; name?: string; group_name?: string }
export interface SessionForkResult { session: Session }

export interface SessionCloneParams { sessionId: string; name?: string }
export interface SessionCloneResult { session: Session }

export interface SessionOutputParams { sessionId: string; lines?: number }
export interface SessionOutputResult { output: string }

export interface SessionHandoffParams { sessionId: string; agent: string; instructions?: string }
export interface SessionJoinParams { sessionId: string; force?: boolean }
export interface SessionSpawnParams { sessionId: string; task: string; agent?: string; model?: string; group_name?: string }

export interface SessionEventsParams { sessionId: string; limit?: number }
export interface SessionEventsResult { events: Event[] }

export interface SessionMessagesParams { sessionId: string; limit?: number }
export interface SessionMessagesResult { messages: Message[] }

export interface SessionSearchParams { query: string }
export interface SessionSearchResult { results: Session[] }

export interface SessionResumeParams { sessionId: string }

// ── Messaging ───────────────────────────────────────────────────────────────

export interface MessageSendParams { sessionId: string; content: string }

// ── Compute ─────────────────────────────────────────────────────────────────

export interface ComputeCreateParams extends CreateComputeOpts {}
export interface ComputeCreateResult { compute: Compute }

export interface ComputeNameParams { name: string }
export interface ComputeReadResult { compute: Compute }
export interface ComputeListResult { targets: Compute[] }
export interface ComputeUpdateParams { name: string; fields: Partial<Compute> }
export interface ComputePingResult { reachable: boolean; message: string }
export interface ComputeCleanZombiesResult { cleaned: number }

// ── Resources ───────────────────────────────────────────────────────────────

export interface AgentListResult { agents: AgentDefinition[] }
export interface AgentReadParams { name: string }
export interface AgentReadResult { agent: AgentDefinition }

export interface FlowListResult { flows: FlowDefinition[] }
export interface FlowReadParams { name: string }
export interface FlowReadResult { flow: FlowDefinition }

export interface SkillListResult { skills: any[] }
export interface SkillReadParams { name: string }
export interface SkillReadResult { skill: any }

export interface RecipeListResult { recipes: any[] }
export interface RecipeReadParams { name: string }
export interface RecipeReadResult { recipe: any }
export interface RecipeUseParams { name: string; variables?: Record<string, string> }
export interface RecipeUseResult { session: Session }

// ── Groups ──────────────────────────────────────────────────────────────────

export interface GroupListResult { groups: Array<{ name: string; created_at: string }> }
export interface GroupCreateParams { name: string }
export interface GroupCreateResult { group: { name: string; created_at: string } }
export interface GroupDeleteParams { name: string }

// ── Config ──────────────────────────────────────────────────────────────────

export interface ConfigReadResult { config: Record<string, unknown> }
export interface ConfigWriteParams extends Record<string, unknown> {}

export interface ProfileListResult { profiles: any[]; active: string | null }
export interface ProfileCreateParams { name: string; description?: string }
export interface ProfileCreateResult { profile: any }
export interface ProfileSetParams { name: string }
export interface ProfileDeleteParams { name: string }

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryListParams { limit?: number }
export interface HistoryListResult { items: any[] }
export interface HistoryImportParams { claudeSessionId: string; name?: string; repo?: string }
export interface HistoryImportResult { session: Session }
export interface HistoryRefreshResult { ok: boolean; count: number; sessionCount?: number }
export interface HistoryIndexResult { ok: boolean; count: number }
export interface HistorySearchParams { query: string; limit?: number }
export interface HistorySearchResult { results: any[] }
export interface HistoryRebuildFtsResult { ok: boolean; sessionCount: number; indexCount: number; items: any[] }
export interface IndexStatsResult { stats: Record<string, unknown> }

// ── Tools ───────────────────────────────────────────────────────────────────

export interface ToolsListParams { projectRoot?: string }
export interface ToolsListResult { tools: any[] }
export interface ToolsDeleteParams { name?: string; kind?: string; source?: string; scope?: string; id?: string; projectRoot?: string }
export interface ToolsReadParams { name: string; kind: string; projectRoot?: string }

export interface McpAttachParams { sessionId: string; server: Record<string, unknown> }
export interface McpDetachParams { sessionId: string; serverName: string }

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricsSnapshotParams { computeName?: string }
export interface MetricsSnapshotResult { snapshot: ComputeSnapshot }

export interface CostsReadResult { costs: any[]; total: number }

// ── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryListParams { scope?: string }
export interface MemoryListResult { memories: any[] }
export interface MemoryRecallParams { query: string; scope?: string; limit?: number }
export interface MemoryRecallResult { results: any[] }
export interface MemoryForgetParams { id: string }
export interface MemoryForgetResult { ok: boolean }
export interface MemoryAddParams { content: string; tags?: string[]; scope?: string; importance?: number }
export interface MemoryAddResult { memory: any }
export interface MemoryClearParams { scope?: string }
export interface MemoryClearResult { count: number }

// ── Schedule ────────────────────────────────────────────────────────────────

export interface ScheduleListResult { schedules: any[] }
export interface ScheduleCreateParams extends Record<string, unknown> {}
export interface ScheduleCreateResult { schedule: any }
export interface ScheduleDeleteParams { id: string }
export interface ScheduleDeleteResult { ok: boolean }
export interface ScheduleIdParams { id: string }

// ── Worktree ────────────────────────────────────────────────────────────────

export interface WorktreeFinishParams { sessionId: string; noMerge?: boolean }
```

- [ ] **Step 9: Create `packages/types/index.ts`**

```ts
export * from "./session.js";
export * from "./compute.js";
export * from "./event.js";
export * from "./message.js";
export * from "./agent.js";
export * from "./flow.js";
export * from "./common.js";
export * from "./rpc.js";
```

- [ ] **Step 10: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors from packages/types/

- [ ] **Step 11: Commit**

```bash
git add packages/types/
git commit -m "feat: add packages/types — shared domain interfaces"
```

---

## Task 2: Create `packages/core/repositories/schema.ts` — Renamed Schema

Port `initSchema()` from `store.ts` with column renames: `jira_key` -> `ticket`, `jira_summary` -> `summary`, `pipeline` -> `flow`.

**Files:**
- Create: `packages/core/repositories/schema.ts`

- [ ] **Step 1: Create schema.ts with renamed columns**

Port the `initSchema` function from `packages/core/store.ts:226-341`, changing the three column names. Also move the `seedLocalCompute` helper. Import `Database` from `bun:sqlite`.

The CREATE TABLE sessions statement must use `ticket TEXT` (not `jira_key`), `summary TEXT` (not `jira_summary`), `flow TEXT NOT NULL DEFAULT 'default'` (not `pipeline`).

All other tables (events, compute, messages, groups, claude_sessions_cache, transcript_index, schedules, memories, knowledge) remain the same.

- [ ] **Step 2: Commit**

```bash
git add packages/core/repositories/schema.ts
git commit -m "feat: schema.ts with renamed columns (ticket, summary, flow)"
```

---

## Task 3: Create Repository Classes

Port SQL operations from `store.ts` into focused repository classes. Each repository takes a `Database` in its constructor. No fieldMap — columns match TS fields.

**Files:**
- Create: `packages/core/repositories/session.ts`
- Create: `packages/core/repositories/compute.ts`
- Create: `packages/core/repositories/event.ts`
- Create: `packages/core/repositories/message.ts`
- Create: `packages/core/repositories/index.ts`
- Create: `packages/core/repositories/__tests__/session.test.ts`
- Create: `packages/core/repositories/__tests__/compute.test.ts`
- Create: `packages/core/repositories/__tests__/event.test.ts`
- Create: `packages/core/repositories/__tests__/message.test.ts`

- [ ] **Step 1: Write SessionRepository test**

Test `create`, `get`, `list`, `update`, `delete`, `softDelete`, `undelete`, `claim`, `purgeDeleted`, `channelPort`. Use `AppContext.forTest()` for isolation. Verify column whitelist enforcement (unknown keys are silently skipped). Verify `config` is stored as JSON and parsed back as `SessionConfig`.

- [ ] **Step 2: Write SessionRepository implementation**

Port from `store.ts` functions: `createSession` (L351-390), `getSession` (L391-397), `listSessions` (L398-434), `updateSession` (L435-461 — remove fieldMap, use SESSION_COLUMNS whitelist), `deleteSession` (L462-469), `softDeleteSession` (L470-478), `undeleteSession` (L479-488), `claimSession` (L515-541 — remove fieldMap), `purgeDeleted` (L489-497), `sessionChannelPort` (L712-714).

No `rowToSession()` needed — SQL columns already match TS fields. Just `JSON.parse(row.config)` for the config field.

- [ ] **Step 3: Run SessionRepository tests**

Run: `bun test packages/core/repositories/__tests__/session.test.ts`
Expected: all pass

- [ ] **Step 4: Write ComputeRepository test**

Test `create`, `get`, `list`, `update`, `delete`, `mergeConfig`. Verify `mergeConfig` uses a transaction. Verify column whitelist. Verify config is stored as JSON.

- [ ] **Step 5: Write ComputeRepository implementation**

Port from `store.ts`: `createCompute` (L586-615), `getCompute` (L616-622), `listCompute` (L623-641), `updateCompute` (L642-667 — use COMPUTE_COLUMNS whitelist), `deleteCompute` (L697-705), `mergeComputeConfig` (L668-684 — wrap in transaction), `mergeSessionConfig` (L685-696 — moved to SessionRepository as `mergeConfig`).

- [ ] **Step 6: Run ComputeRepository tests**

Run: `bun test packages/core/repositories/__tests__/compute.test.ts`
Expected: all pass

- [ ] **Step 7: Write EventRepository test + implementation**

Test `log`, `list` (with type filter and limit), `deleteForTrack`. Port from `store.ts`: `logEvent` (L542-555), `getEvents` (L556-573).

- [ ] **Step 8: Write MessageRepository test + implementation**

Test `send`, `list`, `markRead`, `unreadCount`. Port from `store.ts`: `addMessage` (L759-773), `getMessages` (L774-781), `markMessagesRead` (L790-793), `getUnreadCount` (L782-789).

- [ ] **Step 9: Run all repository tests**

Run: `bun test packages/core/repositories/`
Expected: all pass

- [ ] **Step 10: Create repositories/index.ts barrel**

```ts
export { SessionRepository } from "./session.js";
export { ComputeRepository } from "./compute.js";
export { EventRepository } from "./event.js";
export { MessageRepository } from "./message.js";
export { initSchema, seedLocalCompute } from "./schema.js";
```

- [ ] **Step 11: Commit**

```bash
git add packages/core/repositories/
git commit -m "feat: repository classes — SessionRepository, ComputeRepository, EventRepository, MessageRepository"
```

---

## Task 4: Create Service Classes

Port business logic from `session.ts` into `SessionService`, `ComputeService`, `HistoryService`. Services depend on repositories and providers.

**Files:**
- Create: `packages/core/services/session.ts`
- Create: `packages/core/services/compute.ts`
- Create: `packages/core/services/history.ts`
- Create: `packages/core/services/index.ts`
- Create: `packages/core/services/__tests__/session.test.ts`
- Create: `packages/core/services/__tests__/compute.test.ts`
- Create: `packages/core/services/__tests__/history.test.ts`

- [ ] **Step 1: Write SessionService tests**

Test the core state machine: `start` creates a session in `ready`, `dispatch` transitions `ready` -> `running`, `stop` transitions `running` -> `stopped`, `resume` transitions `stopped` -> `running`, `advance` processes gates, `complete` handles flow completion, `pause` sets breakpoint. Test guards: dispatch on non-ready fails, resume on completed fails, stop on stopped is idempotent. Test `applyHookStatus` guards for completed/failed/stopped.

Use `AppContext.forTest()`. Tests should create repos + service manually to test in isolation.

- [ ] **Step 2: Write SessionService implementation**

Port all 34 exported functions from `packages/core/session.ts` into methods on `SessionService`. The constructor takes `SessionRepository`, `EventRepository`, `MessageRepository`, `ProviderRegistry`, `EventBus`.

Key changes vs old code:
- `store.getSession(id)` becomes `this.sessions.get(id)`
- `store.updateSession(id, fields)` becomes `this.sessions.update(id, fields)`
- `store.logEvent(...)` becomes `this.events.log(...)`
- `store.claimSession(...)` becomes `this.sessions.claim(...)`
- Provider resolution via `this.providers` instead of global `getApp().resolveProvider()`

The `applyHookStatus` and `applyReport` methods must preserve the stopped-status guard added in the bugfix phase.

- [ ] **Step 3: Run SessionService tests**

Run: `bun test packages/core/services/__tests__/session.test.ts`
Expected: all pass

- [ ] **Step 4: Write ComputeService tests + implementation**

Port compute orchestration logic. Test `create`, `provision`, `destroy`, `startInstance`, `stopInstance`. The service delegates to `ComputeRepository` for CRUD and to `ProviderRegistry` for provider-specific operations.

- [ ] **Step 5: Write HistoryService tests + implementation**

Port from `packages/core/claude-sessions.ts` and `packages/core/search.ts`. The service wraps `refreshClaudeSessionsCache`, `indexTranscripts`, `searchTranscripts`, `getSessionConversation`, `getIndexStats`. Takes raw `Database` for FTS5 queries.

- [ ] **Step 6: Create services/index.ts barrel**

```ts
export { SessionService } from "./session.js";
export { ComputeService } from "./compute.js";
export { HistoryService } from "./history.js";
```

- [ ] **Step 7: Run all service tests**

Run: `bun test packages/core/services/`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add packages/core/services/
git commit -m "feat: service classes — SessionService, ComputeService, HistoryService"
```

---

## Task 5: Wire AppContext + Update `core/index.ts`

Connect repositories and services to AppContext. Update the barrel export.

**Files:**
- Modify: `packages/core/app.ts`
- Modify: `packages/core/index.ts`

- [ ] **Step 1: Update AppContext to create repos + services in boot()**

Add repository and service fields to `AppContext`. In `boot()`, after opening the DB and calling `initSchema()`, instantiate all repos and all services. Wire dependencies.

Import `initSchema` from `./repositories/schema.js` instead of the old inline call.

- [ ] **Step 2: Update `core/index.ts` barrel**

Re-export types from `packages/types/`, repositories from `./repositories/index.js`, services from `./services/index.js`. Keep backward-compat re-exports of functions that haven't moved yet (agent, flow, skill, recipe, config, etc.).

- [ ] **Step 3: Run full core tests**

Run: `bun test packages/core/ --concurrency 1`
Expected: existing tests still pass (they still import from old paths which re-export from new)

- [ ] **Step 4: Commit**

```bash
git add packages/core/app.ts packages/core/index.ts
git commit -m "feat: wire repos + services into AppContext"
```

---

## Task 6: Update Server Handlers

All handlers switch from `import * as core` to `AppContext` injection with `extract<T>` validation.

**Files:**
- Create: `packages/server/validate.ts`
- Modify: `packages/server/register.ts`
- Modify: `packages/server/handlers/session.ts`
- Modify: `packages/server/handlers/resource.ts`
- Modify: `packages/server/handlers/messaging.ts`
- Modify: `packages/server/handlers/config.ts`
- Modify: `packages/server/handlers/history.ts`
- Modify: `packages/server/handlers/tools.ts`
- Modify: `packages/server/handlers/metrics.ts`
- Modify: `packages/server/handlers/memory.ts`
- Modify: `packages/server/handlers/schedule.ts`
- Create: `packages/server/__tests__/validate.test.ts`

- [ ] **Step 1: Create `packages/server/validate.ts`**

```ts
export function rpcError(code: number, message: string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

export function extract<T>(
  params: Record<string, unknown> | undefined,
  required: (keyof T)[],
): T {
  if (!params) throw rpcError(-32602, "Missing params");
  for (const key of required) {
    if (params[key as string] === undefined) {
      throw rpcError(-32602, `Missing required param: ${String(key)}`);
    }
  }
  return params as T;
}
```

- [ ] **Step 2: Write validate.test.ts**

Test: returns params when all required keys present; throws with code -32602 when params missing; throws when required key missing; passes through extra keys.

- [ ] **Step 3: Update `register.ts` signature**

Change `registerAllHandlers(router: Router)` to `registerAllHandlers(router: Router, app: AppContext)`. Pass `app` to each handler registration function.

- [ ] **Step 4: Update all 9 handler files**

Each handler function signature changes from `(router: Router)` to `(router: Router, app: AppContext)`. Replace `import * as core` with typed `extract<T>` calls and `app.sessionService.*` / `app.sessions.*` calls.

Example for `session/stop`:
```ts
// Before:
const { sessionId } = params as { sessionId: string };
const result = await core.stop(sessionId);

// After:
const { sessionId } = extract<SessionStopParams>(params, ["sessionId"]);
const result = await app.sessionService.stop(sessionId);
```

- [ ] **Step 5: Update callers of `registerAllHandlers`**

Update all 5 call sites:
- `packages/server/register.ts` (definition)
- `packages/protocol/__tests__/client.test.ts`
- `packages/server/__tests__/integration.test.ts`
- `packages/cli/client.ts`
- `packages/tui/context/ArkClientProvider.tsx`

Each now passes `app` (or creates one via `AppContext.forTest()` for tests).

- [ ] **Step 6: Run server + protocol tests**

Run: `bun test packages/server packages/protocol --concurrency 1`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add packages/server/
git commit -m "feat: server handlers use AppContext + extract<T> validation"
```

---

## Task 7: Type the Protocol Client

Make `rpc` private, add typed returns to all public methods.

**Files:**
- Modify: `packages/protocol/client.ts`

- [ ] **Step 1: Import types and make rpc private**

Add imports from `../../types/index.js`. Change `rpc` from public to `private rpc<T = unknown>(...)`.

- [ ] **Step 2: Add typed returns to all session methods**

Change each method to use `this.rpc<ResultType>(...)` and return the concrete type. Example:

```ts
async sessionList(filters?: SessionListParams): Promise<Session[]> {
  const { sessions } = await this.rpc<SessionListResult>("session/list", filters as Record<string, unknown>);
  return sessions;
}
```

- [ ] **Step 3: Add typed returns to all compute, resource, history, memory, schedule methods**

Same pattern for all remaining methods. Add `agentRead(name: string): Promise<AgentDefinition>` as a new method (currently missing).

- [ ] **Step 4: Run protocol tests**

Run: `bun test packages/protocol/`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/client.ts
git commit -m "feat: typed ArkClient — all methods return concrete types"
```

---

## Task 8: TUI Layer Cleanup

Type StoreData, fix Ink colors, remove `as any` casts.

**Files:**
- Create: `packages/tui/helpers/colors.ts`
- Modify: `packages/tui/hooks/useArkStore.ts`
- Modify: `packages/tui/helpers/sessionFormatting.ts`
- Modify: `packages/tui/tabs/SessionDetail.tsx`
- Modify: `packages/tui/tabs/SessionsTab.tsx`
- Modify: `packages/tui/tabs/ComputeTab.tsx`
- Modify: `packages/tui/tabs/SessionReplay.tsx`
- Modify: `packages/tui/tabs/TalkToSession.tsx`
- Modify: `packages/tui/components/EventLog.tsx`
- Modify: `packages/tui/components/ThreadsPanel.tsx`
- Modify: `packages/tui/components/Link.tsx`
- Modify: `packages/tui/components/SettingsPanel.tsx`

- [ ] **Step 1: Create `packages/tui/helpers/colors.ts`**

Define `InkColor` type and update `getStatusColor`, `getComputeStatusColor` to return it.

```ts
// Ink's Color type for <Text color={...}>
export type InkColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "gray" | "grey" | "blackBright" | "redBright" | "greenBright" | "yellowBright"
  | "blueBright" | "magentaBright" | "cyanBright" | "whiteBright"
  | `#${string}`;

// Re-export existing color functions with correct return type
import type { SessionStatus, ComputeStatus } from "../../types/index.js";

export function getStatusColor(status: SessionStatus): InkColor { ... }
export function getComputeStatusColor(status: ComputeStatus): InkColor { ... }
```

Move existing color functions from wherever they currently live into this file.

- [ ] **Step 2: Type `useArkStore`**

Change `StoreData` to use typed arrays:
```ts
import type { Session, Compute, AgentDefinition, FlowDefinition } from "../../types/index.js";

export interface StoreData {
  sessions: Session[];
  computes: Compute[];
  agents: AgentDefinition[];
  flows: FlowDefinition[];
  ...
}
```

Update all `useState<any[]>([])` to `useState<Session[]>([])`, etc.

- [ ] **Step 3: Fix sessionFormatting.ts**

Change function signatures from `session: any` to `session: Session`. Remove all `(session.config as any)` — access `session.config.usage`, `session.config.filesChanged` etc. directly.

- [ ] **Step 4: Fix color casts across TUI components**

In each of the ~10 files with `color as any`, import `InkColor` and `getStatusColor` from `../helpers/colors.js`. Remove the `as any` casts.

- [ ] **Step 5: Run TUI tests**

Run: `bun test packages/tui/ --concurrency 1`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add packages/tui/
git commit -m "feat: typed TUI — StoreData, SessionConfig, InkColor"
```

---

## Task 9: Delete Old Files + Clean Up Imports + Reorganize Tests

Remove `store.ts`, `session.ts`, `context.ts`. Update all remaining imports. Move tests to match new structure.

**Files:**
- Delete: `packages/core/store.ts`
- Delete: `packages/core/session.ts`
- Delete: `packages/core/context.ts`
- Modify: all files with old imports (see file map above)
- Move/update: test files

- [ ] **Step 1: Update `core/index.ts` to remove old re-exports**

Remove re-exports from `./store.js` and `./session.js`. All exports now come from `./repositories/index.js`, `./services/index.js`, and `../../types/index.js`.

- [ ] **Step 2: Update conductor.ts**

Replace `import * as session from "./session.js"` with access through `getApp().sessionService`. Replace `import * as store from "./store.js"` with access through `getApp().sessions` / `getApp().events`.

- [ ] **Step 3: Update web.ts**

Same pattern — replace store/session imports with AppContext service access.

- [ ] **Step 4: Update acp.ts, recipe-eval.ts, github-webhook.ts**

Replace session function imports with service access.

- [ ] **Step 5: Update compute providers**

Replace `import { ... } from "../../core/store.js"` with imports from `../../types/index.js` for types and `../../core/index.js` for runtime functions (or access through the provider's compute argument).

- [ ] **Step 6: Update CLI**

Replace any direct store/session imports in `packages/cli/index.ts` with ArkClient calls (which are now typed).

- [ ] **Step 7: Delete old files**

```bash
rm packages/core/store.ts packages/core/session.ts packages/core/context.ts
```

- [ ] **Step 8: Reorganize tests**

Move test files to match new structure:
- Tests that test SQL/CRUD behavior → `packages/core/repositories/__tests__/`
- Tests that test state transitions/orchestration → `packages/core/services/__tests__/`
- Tests that test RPC handlers → `packages/server/__tests__/`
- Integration/e2e tests stay in `packages/core/__tests__/`

Update all test imports to use new paths. Ensure tests use `AppContext.forTest()` consistently (no more `createTestContext`/`setContext` from deleted `context.ts`).

- [ ] **Step 9: Run full test suite**

Run: `bun test packages/ --concurrency 1`
Expected: all 2021+ tests pass, 0 fail

- [ ] **Step 10: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: delete store.ts/session.ts/context.ts, all imports updated"
```

---

## Verification Checklist

After all 9 tasks are complete:

- [ ] `bun test packages/ --concurrency 1` — 0 failures
- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `grep -rn "as any" packages/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v __tests__ | wc -l` — significantly reduced from ~80
- [ ] `grep -rn "fieldMap" packages/ | grep -v node_modules` — 0 results
- [ ] `grep -rn "jira_key\|jira_summary\|pipeline" packages/ --include='*.ts' | grep -v node_modules` — 0 results (except maybe CLAUDE.md references)
- [ ] `grep -rn "Record<string, unknown>" packages/types/ | wc -l` — minimal (only in Event.data and extensible configs)
- [ ] CLI works: `bun packages/cli/index.ts --version`
- [ ] TUI starts: `bun packages/tui/index.tsx` (with TTY)
