# Domain Model Refactor

**Date:** 2026-04-06
**Status:** Approved
**Approach:** C -- Full repository/service rewrite with shared types package

## Problem

The codebase has no proper domain model layer. Types decay across boundaries:

- `Session.config` and `Compute.config` are `Record<string, unknown>` -- every access requires `as any`
- `ArkClient` returns `Promise<any>` from all 40+ methods
- Server handlers cast `params as any` on every entry point
- TUI stores all entities as `any[]`
- SQL column names differ from TS field names (`jira_key`/`ticket`, `jira_summary`/`summary`, `pipeline`/`flow`), requiring a `fieldMap` hack duplicated in 3 places
- ~80 `as any` casts across non-test source files
- ~10 Ink `Color` type mismatches in TUI components

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DB column rename vs mapping layer | Rename columns directly | Not live yet, no migration needed |
| Config typing | Flat `SessionConfig`, discriminated `ComputeConfig` by provider | Matches current access patterns, minimal migration |
| Type location | New `packages/types/` package | Single source of truth across all layers |
| RPC param validation | Lightweight `extract<T>` helper, no Zod | Runtime safety at boundary, zero deps |
| TUI Ink color casts | Fix alongside domain types | Same pass, small scope |
| Store layer | Replace with repository classes | Clean SQL encapsulation, typed inputs/outputs |
| Session.ts | Replace with SessionService class | Services own mutations, repos own SQL |
| Test organization | Reorganize to match new structure, add new tests | Tests colocated with the code they test |

## Architecture

### Package Layout

```
packages/
  types/              single source of truth for all domain interfaces
    index.ts          barrel export
    session.ts        Session, SessionConfig, SessionStatus, CreateSessionOpts
    compute.ts        Compute, ComputeConfig variants, ComputeStatus, ComputeProvider
    event.ts          Event
    message.ts        Message, MessageRole, MessageType
    rpc.ts            RPC param/result pairs for all ~40 methods
    agent.ts          AgentDefinition
    flow.ts           FlowDefinition, StageDef, GateType
    common.ts         SessionOpResult, PortDecl, ComputeSnapshot, etc.

  core/
    repositories/     SQL layer -- one class per entity
      session.ts      SessionRepository
      compute.ts      ComputeRepository
      event.ts        EventRepository
      message.ts      MessageRepository
      schema.ts       CREATE TABLE statements, initSchema()
      __tests__/      repository-level tests (SQL correctness)
    services/         business logic layer
      session.ts      SessionService
      compute.ts      ComputeService
      history.ts      HistoryService
      __tests__/      service-level tests (state transitions, orchestration)
    app.ts            AppContext wires repos + services
    config.ts         unchanged
    hooks.ts          eventBus, unchanged
    index.ts          re-exports services + repos + types

  server/
    validate.ts       extract<T> param validation helper
    handlers/         thin delegates to services via AppContext
    __tests__/        handler tests (RPC contract, validation)

  protocol/
    client.ts         typed returns using packages/types
    __tests__/        client typing tests

  compute/            providers unchanged, import from packages/types
  tui/                typed StoreData, Ink color fix
  cli/                typed via ArkClient
```

### Types Package (`packages/types/`)

No logic, no dependencies. Pure TypeScript interfaces and string literal unions.

**String literal unions replace bare `string`:**

```ts
type SessionStatus = "pending" | "ready" | "running" | "waiting" | "stopped"
                   | "blocked" | "completed" | "failed" | "deleting";
type ComputeStatus = "stopped" | "running" | "provisioning" | "destroyed";
type ComputeProviderName = "local" | "docker" | "ec2" | "remote-arkd";
type MessageRole = "user" | "agent" | "system";
type MessageType = "text" | "progress" | "question" | "completed" | "error";
type GateType = "manual" | "auto" | "condition";
```

**Session with typed config:**

```ts
interface SessionConfig {
  // Runtime state
  usage?: { input_tokens?: number; output_tokens?: number; total_cost?: number };
  turns?: number;
  model_override?: string;
  completion_summary?: string;
  filesChanged?: string[];
  commits?: string[];
  github_url?: string;
  ports?: PortDecl[];
  // Compute/infra
  remoteWorkdir?: string;
  worktree?: string;
  // Lifecycle
  _pre_delete_status?: string;
  _deleted_at?: string;
  _pending_handoff?: { agent: string; instructions?: string };
}

interface Session {
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
```

**Compute with discriminated config:**

```ts
interface LocalComputeConfig {}

interface EC2ComputeConfig {
  ip?: string;
  key_path?: string;
  instance_id?: string;
  size?: string;
  region?: string;
  ami?: string;
}

interface DockerComputeConfig {
  image?: string;
  container_id?: string;
}

interface RemoteArkdConfig {
  ip?: string;
  key_path?: string;
  ssh_user?: string;
  arkd_port?: number;
}

type ComputeConfig =
  | LocalComputeConfig
  | EC2ComputeConfig
  | DockerComputeConfig
  | RemoteArkdConfig;

interface Compute {
  name: string;
  provider: ComputeProviderName;
  status: ComputeStatus;
  config: ComputeConfig;
  created_at: string;
  updated_at: string;
}
```

**Event and Message:**

```ts
interface Event {
  id: number;
  track_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

interface Message {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  type: MessageType;
  read: boolean;
  created_at: string;
}
```

**RPC param/result types -- one pair per method:**

```ts
// Session
interface SessionStartParams { summary: string; repo?: string; flow?: string; agent?: string; compute_name?: string; workdir?: string; group_name?: string; config?: Partial<SessionConfig> }
interface SessionStartResult { session: Session }
interface SessionStopParams { sessionId: string }
interface SessionListParams { status?: SessionStatus; repo?: string; group_name?: string; limit?: number }
interface SessionListResult { sessions: Session[] }
interface SessionReadParams { sessionId: string; include?: string[] }
interface SessionReadResult { session: Session; events?: Event[]; messages?: Message[] }
interface SessionUpdateParams { sessionId: string; fields: Partial<Session> }
interface SessionDispatchParams { sessionId: string }
interface SessionOpResult { ok: boolean; message: string }
// ... all ~40 methods follow same pattern
```

### Repository Layer (`packages/core/repositories/`)

Each repository owns one entity's SQL. Column names match TS field names (no mapping).

**Schema** (`schema.ts`): `CREATE TABLE sessions` uses `ticket`, `summary`, `flow` directly. All `fieldMap` code deleted.

**SessionRepository:**

```ts
class SessionRepository {
  constructor(private db: Database) {}

  create(opts: CreateSessionOpts): Session
  get(id: string): Session | null
  list(filters?: SessionListFilters): Session[]
  update(id: string, fields: Partial<Session>): Session | null
  delete(id: string): boolean
  softDelete(id: string): boolean
  undelete(id: string): Session | null
  claim(id: string, expected: SessionStatus, next: SessionStatus, extra?: Partial<Session>): boolean
  search(query: string, opts?: { limit?: number }): Session[]
  purgeDeleted(olderThanMs?: number): number
  channelPort(sessionId: string): number
}
```

Column whitelist enforced internally -- `update()` skips unknown keys, no SQL injection possible.

**ComputeRepository:**

```ts
class ComputeRepository {
  constructor(private db: Database) {}

  create(opts: CreateComputeOpts): Compute
  get(name: string): Compute | null
  list(filters?: { status?: ComputeStatus; provider?: ComputeProviderName }): Compute[]
  update(name: string, fields: Partial<Compute>): Compute | null
  delete(name: string): boolean
  mergeConfig(name: string, patch: Partial<ComputeConfig>): Compute | null
}
```

`mergeConfig` uses a transaction (SELECT + UPDATE) for atomicity.

**EventRepository:**

```ts
class EventRepository {
  constructor(private db: Database) {}

  log(trackId: string, type: string, opts?: { stage?: string; actor?: string; data?: Record<string, unknown> }): void
  list(trackId: string, opts?: { type?: string; limit?: number }): Event[]
  deleteForTrack(trackId: string): void
}
```

**MessageRepository:**

```ts
class MessageRepository {
  constructor(private db: Database) {}

  send(sessionId: string, role: MessageRole, content: string, type?: MessageType): Message
  list(sessionId: string, opts?: { limit?: number; unreadOnly?: boolean }): Message[]
  markRead(sessionId: string): void
  unreadCount(sessionId: string): number
}
```

### Service Layer (`packages/core/services/`)

Services own domain orchestration. They depend on repositories and providers, never on raw SQL.

**SessionService** (replaces `session.ts`):

```ts
class SessionService {
  constructor(
    private sessions: SessionRepository,
    private events: EventRepository,
    private messages: MessageRepository,
    private providers: ProviderRegistry,
    private eventBus: EventBus,
  ) {}

  start(opts: CreateSessionOpts): Session
  dispatch(id: string): Promise<SessionOpResult>
  stop(id: string): Promise<SessionOpResult>
  resume(id: string): Promise<SessionOpResult>
  advance(id: string, force?: boolean): Promise<SessionOpResult>
  complete(id: string): Promise<SessionOpResult>
  pause(id: string, reason?: string): SessionOpResult
  delete(id: string): Promise<SessionOpResult>
  undelete(id: string): Promise<SessionOpResult>
  fork(id: string, name?: string, groupName?: string): Session
  clone(id: string, name?: string): Session
  spawn(parentId: string, opts: SpawnOpts): Session
  handoff(id: string, agent: string, instructions?: string): Promise<SessionOpResult>
  send(id: string, message: string): Promise<SessionOpResult>
  getOutput(id: string, opts?: { lines?: number }): Promise<string>
  waitForCompletion(id: string, opts?: WaitOpts): Promise<{ session: Session | null; timedOut: boolean }>
  finishWorktree(id: string, opts?: WorktreeFinishOpts): Promise<SessionOpResult>
  applyHookStatus(id: string, hookEvent: string, payload: HookPayload): ApplyResult
  applyReport(id: string, report: AgentReport): ApplyResult
}
```

**ComputeService:**

```ts
class ComputeService {
  constructor(
    private computes: ComputeRepository,
    private providers: ProviderRegistry,
    private eventBus: EventBus,
  ) {}

  create(opts: CreateComputeOpts): Compute
  provision(name: string): Promise<void>
  destroy(name: string): Promise<void>
  startInstance(name: string): Promise<void>
  stopInstance(name: string): Promise<void>
  reboot(name: string): Promise<void>
  clean(name: string): Promise<void>
  cleanZombies(): Promise<{ cleaned: number }>
  ping(name: string): Promise<{ reachable: boolean; message: string }>
  getMetrics(name: string): Promise<ComputeSnapshot>
}
```

**HistoryService** (takes raw `db` for FTS5 queries that don't fit the repository pattern):

```ts
class HistoryService {
  constructor(private sessions: SessionRepository, private db: Database) {}

  list(limit?: number): ClaudeSession[]
  refresh(opts?: { onProgress?: ProgressFn }): Promise<number>
  index(opts?: { transcriptsDir?: string }): Promise<number>
  search(query: string, limit?: number): SearchResult[]
  getConversation(sessionId: string, opts?: { limit?: number }): ConversationTurn[]
  indexStats(): IndexStats
}
```

**AppContext wiring:**

```ts
class AppContext {
  // Repositories
  readonly sessions: SessionRepository;
  readonly computes: ComputeRepository;
  readonly events: EventRepository;
  readonly messages: MessageRepository;

  // Services
  readonly sessionService: SessionService;
  readonly computeService: ComputeService;
  readonly historyService: HistoryService;

  async boot() {
    this._db = new Database(this.config.dbPath);
    initSchema(this._db);

    this.sessions = new SessionRepository(this._db);
    this.computes = new ComputeRepository(this._db);
    this.events = new EventRepository(this._db);
    this.messages = new MessageRepository(this._db);

    this.registerProvider(new LocalProvider());
    this.registerProvider(new EC2Provider());
    this.registerProvider(new DockerProvider());

    this.sessionService = new SessionService(this.sessions, this.events, this.messages, this._providers, this._eventBus);
    this.computeService = new ComputeService(this.computes, this._providers, this._eventBus);
    this.historyService = new HistoryService(this.sessions, this._db);
  }
}
```

### Server Handlers

**Param validation** (`packages/server/validate.ts`):

```ts
function extract<T>(params: Record<string, unknown> | undefined, required: (keyof T)[]): T {
  if (!params) throw rpcError(-32602, "Missing params");
  for (const key of required) {
    if (params[key as string] === undefined) {
      throw rpcError(-32602, `Missing required param: ${String(key)}`);
    }
  }
  return params as T;
}
```

**Handlers become thin delegates:**

```ts
export function registerSessionHandlers(router: Router, app: AppContext): void {
  router.handle("session/start", async (params, notify) => {
    const opts = extract<SessionStartParams>(params, ["summary"]);
    const session = app.sessionService.start(opts);
    notify("session/created", { session });
    return { session };
  });

  router.handle("session/stop", async (params, notify) => {
    const { sessionId } = extract<SessionStopParams>(params, ["sessionId"]);
    const result = await app.sessionService.stop(sessionId);
    if (result.ok) notify("session/updated", { session: app.sessions.get(sessionId) });
    return result;
  });
}
```

`registerAllHandlers(router)` becomes `registerAllHandlers(router, app)`.

### Protocol Client

`ArkClient.rpc` becomes private generic. All public methods get typed returns:

```ts
class ArkClient {
  private rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> { ... }

  async sessionStart(opts: SessionStartParams): Promise<Session> {
    const { session } = await this.rpc<SessionStartResult>("session/start", opts);
    return session;
  }

  async sessionList(filters?: SessionListParams): Promise<Session[]> {
    const { sessions } = await this.rpc<SessionListResult>("session/list", filters);
    return sessions;
  }

  async sessionStop(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/stop", { sessionId });
  }

  async agentRead(name: string): Promise<AgentDefinition> {
    const { agent } = await this.rpc<{ agent: AgentDefinition }>("agent/read", { name });
    return agent;
  }
  // ... all ~40 methods typed
}
```

### TUI Layer

**StoreData typed:**

```ts
interface StoreData {
  sessions: Session[];
  computes: Compute[];
  agents: AgentDefinition[];
  flows: FlowDefinition[];
  unreadCounts: Map<string, number>;
  snapshots: Map<string, ComputeSnapshot>;
  // ...
}
```

**SessionConfig access becomes direct** (no `as any`):

```ts
// Before
const usage = (session.config as any)?.usage;
// After
const usage = session.config.usage;
```

**Ink Color fix:**

```ts
// packages/tui/helpers/colors.ts
import type { LiteralUnion } from "ink";
type InkColor = LiteralUnion<"black"|"red"|"green"|"yellow"|"blue"|"magenta"|"cyan"|"white", string>;

function getStatusColor(status: SessionStatus): InkColor { ... }
```

Eliminates ~10 `color as any` casts across TUI components.

### Test Organization

Tests reorganize to match the new structure:

```
packages/
  types/__tests__/             type guard / narrowing tests
  core/
    repositories/__tests__/    SQL correctness, CRUD, constraints
      session.test.ts
      compute.test.ts
      event.test.ts
      message.test.ts
    services/__tests__/        state transitions, orchestration, side effects
      session.test.ts          dispatch/stop/resume/advance/complete flows
      compute.test.ts          provision/destroy/metrics
      history.test.ts          index/search/refresh
    __tests__/                 integration tests (service + repo + AppContext)
      e2e-session-lifecycle.test.ts
      e2e-rollback.test.ts
  server/__tests__/            RPC contract tests, param validation
    handlers.test.ts
    validate.test.ts
  protocol/__tests__/          client typing, round-trip tests
  compute/__tests__/           provider tests (unchanged, updated imports)
  tui/__tests__/               component tests (unchanged, updated imports)
```

**New tests added for:**
- Each repository class (CRUD, edge cases, column whitelist enforcement)
- `extract<T>` validation helper (missing params, extra params, type coercion)
- Service state transitions (dispatch from wrong status, stop idempotency, etc.)
- Typed ArkClient round-trip (response shapes match types)

**Existing tests:** Updated imports, same behavioral assertions. The 2021 passing tests are the safety net.

## Deleted Files

- `packages/core/store.ts` -- replaced by repositories + schema.ts
- `packages/core/session.ts` -- replaced by SessionService
- `packages/core/context.ts` -- DB lifecycle fully owned by AppContext
- `packages/core/compute.ts` -- replaced by ComputeService

## Migration Order

Each step compiles and tests pass before proceeding:

1. Create `packages/types/` with all interfaces
2. Create `packages/core/repositories/` -- port SQL from store.ts, rename columns
3. Create `packages/core/services/` -- port logic from session.ts
4. Wire into AppContext, update `core/index.ts` re-exports
5. Update server handlers -- AppContext injection + `extract<T>`
6. Update protocol client -- typed returns
7. Update TUI -- typed StoreData + Ink color fix
8. Delete old files, clean up imports
9. Reorganize tests to match new structure
