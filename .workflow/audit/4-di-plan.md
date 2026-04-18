# Backend DI + Hex Migration Plan

## Container Choice

**Awilix** -- already present at `packages/core/container.ts:11`. Decorator-free,
CLASSIC injection, `createScope()` for child containers, MIT. No new dependency.
Extend by adding scoped lifetime registrations and three binding modules instead
of the current monolithic `_registerContainer` in `app.ts:490`.

---

## Port Catalog

All port interfaces live in `packages/core/ports/`. Adapters live under
`packages/core/adapters/{local,control-plane,test}/`.

### SessionStore
**Owner:** session bounded context.
**Methods:** `get(id)`, `create(opts)`, `update(id, patch)`, `delete(id)`, `list(filters)`, `listDeleted()`, `channelPort(id)`, `setTenant(tenantId)`.
**Current adapter(s):** `SessionRepository` (`repositories/session.ts`) backed by SQLite/Postgres via `IDatabase`.
**Local binding:** `SessionRepository(db)` -- existing class.
**Control-plane binding:** same class against Postgres; tenant row-filtering via `setTenant()` already implemented.
**Test binding:** in-memory `Map<string, Session>` -- no SQLite needed.

### ComputeStore
**Owner:** compute bounded context.
**Methods:** `get(name)`, `create(opts)`, `update(name, patch)`, `list(filters?)`, `setTenant(tenantId)`.
**Current adapter(s):** `ComputeRepository` (`repositories/compute.ts`).
**Local/control-plane binding:** existing class against SQLite / Postgres.
**Test binding:** in-memory map.

### EventBus
**Owner:** session bounded context.
**Methods:** `emit(type, sessionId, data?)`, `on(type, handler)`, `onAll(handler)`, `replay(sinceId)`, `clear()`.
**Current adapter(s):** module-level `EventBus` singleton in `hooks.ts:110`.
**Local binding:** existing `EventBus` class wrapped as injected value.
**Control-plane binding:** Redis pub/sub adapter (stub -- throws NotImplemented).
**Test binding:** same in-process `EventBus` instance; `clear()` called in `afterEach`.

### Workspace
**Owner:** workspace bounded context.
**Methods:** `setup(session, opts)`, `teardown(session)`, `createPR(session, opts)`, `mergePR(session, prId)`, `copyFiles(src, dst, globs)`.
**Current adapter(s):** free functions in `workspace-service.ts` -- direct process + fs calls.
**Local binding:** `LocalWorkspace` wrapping existing free functions.
**Control-plane binding:** `ObjectStoreWorkspace` -- S3/GCS for file sync; git worktree replaced by clone-on-demand (stub for now).
**Test binding:** `InMemoryWorkspace` -- no-op setup, returns tmp path.

### ProcessRunner
**Owner:** session bounded context.
**Methods:** `exec(cmd, args, opts?)`, `execSync(cmd, args, opts?)`.
**Current adapter(s):** direct process-spawn calls in `session-lifecycle.ts`, `stage-orchestrator.ts`, `workspace-service.ts`.
**Local binding:** `LocalProcessRunner` -- thin wrapper around the node spawn APIs.
**Control-plane binding:** `RemoteProcessRunner` -- SSH exec via existing `sshExecAsync` (stub otherwise).
**Test binding:** `MockProcessRunner` -- returns pre-configured results; records calls for assertion.

### SessionLauncher (already a port)
**Owner:** session bounded context.
**Methods:** defined in `session-launcher.ts:17-44`.
**Current adapter(s):** `TmuxLauncher` (`launchers/tmux.ts`).
**Control-plane binding:** `ArkdLauncher` (`launchers/arkd.ts` -- exists but partially wired).
**Test binding:** `MockSessionLauncher`.

### ComputeProvider (already close to a port)
**Owner:** compute bounded context.
**Methods:** `packages/compute/types.ts` -- `launch`, `start`, `stop`, `syncEnvironment`, `buildChannelConfig`, `buildLaunchEnv`, `supportsWorktree`.
**Adapters:** 11 providers in `packages/compute/providers/`.
**Test binding:** `MockComputeProvider`.

### EventStore (audit log)
**Methods:** `log(sessionId, type, data)`, `list(sessionId, opts)`.
**Current adapter(s):** `EventRepository` (`repositories/event.ts`).
**Test binding:** in-memory array.

### FlowStore / AgentStore / SkillStore / RecipeStore / RuntimeStore
**Methods:** `get(name)`, `list()`, `save(name, def)`, `delete(name)`.
**Current adapter(s):** `File*Store` (local) and `DbResourceStore` (hosted) -- both implement the same interfaces in `packages/core/stores/*.ts`.
**Test binding:** in-memory map wrapped in the same interface.

### Clock
**Methods:** `now(): number`, `iso(): string`.
**Adapters:** `SystemClock` for prod; `MockClock` (settable) for tests.

### Logger
**Methods:** `info/warn/error/debug(component, msg, data?)`.
**Current adapter(s):** `structured-log.ts` module-level functions with global state (`_arkDir`, `_level`).
**Local binding:** `FileLogger` wrapping existing functions.
**Control-plane binding:** `CloudLogger` (stdout JSON).
**Test binding:** `NoopLogger` or `MemoryLogger`.

### Tracer
**Methods:** `startSpan(name, attrs)`, `endSpan(id)`, `flush()`.
**Current adapter(s):** `observability/otlp.ts` -- module-level state.
**Adapters:** `OtlpTracer` (local + CP); `NoopTracer` (test).

### SecretStore
**Methods:** `get(key: string): string | null`.
**Current adapter(s):** `process.env` reads in `app.ts:630-637` and `compute/providers/*`.
**Local binding:** `EnvSecretStore`.
**Control-plane binding:** `VaultSecretStore` (stub).
**Test binding:** `MapSecretStore`.

---

## Adapter Registry

### LocalBindings
File: `packages/core/adapters/local/index.ts`. Registers real adapters: `SessionRepository`, `ComputeRepository`, in-process `EventBus`, `EventRepository`, `LocalWorkspace`, `LocalProcessRunner`, `TmuxLauncher`, `File*Store` per resource, `SystemClock`, `FileLogger`, `OtlpTracer`, `EnvSecretStore`.

### ControlPlaneBindings
File: `packages/core/adapters/control-plane/index.ts`. Substitutes:
- `Workspace` → `ObjectStoreWorkspace` (STUB -- throws NotImplemented)
- `ProcessRunner` → `RemoteProcessRunner` (STUB for non-SSH paths)
- `FlowStore` → `DbResourceStore(db, "flow")` (implemented)
- `SecretStore` → `VaultSecretStore` (STUB)
- `Logger` → `CloudLogger` (stdout JSON)

Gaps to implement before production: `ObjectStoreWorkspace.setup()`, `RemoteProcessRunner.exec()`, `VaultSecretStore.get()`.

### TestBindings
File: `packages/core/adapters/test/index.ts`. Replaces `AppContext.forTest()`. Usage:
```ts
import { buildTestContainer } from "@ark/core/adapters/test";
const container = buildTestContainer({ /* overrides */ });
const app = new AppContext(container);
```

---

## Boundary Enforcement

### ESLint no-restricted-imports
Add rules under `packages/core/domain/**` and `packages/core/services/**`:
- `fs` → "Use Workspace or ProcessRunner port"
- `child_process` → "Use ProcessRunner port"
- `bun:sqlite` → "Use SessionStore / EventStore port"
- pattern `../infra/tmux*` → "Use SessionLauncher port"

Under `packages/core/adapters/**`:
- pattern `../adapters/**` → "Adapters must not import each other"

### dependency-cruiser rule (optional, high signal)
```js
{
  name: "no-domain-to-infra",
  severity: "error",
  from: { path: "^packages/core/(domain|services)" },
  to: { path: "^packages/core/infra" }
}
```

---

## Migration Order

### Slice 1: session-lifecycle + ProcessRunner + Workspace
**Why first:** highest-churn file, directly spawns processes, and the extracted ports unblock slices 2 and 3.
- Define `ProcessRunner` + `Workspace` in `packages/core/ports/`.
- Write `LocalWorkspace` (wraps existing free functions) and `LocalProcessRunner`.
- Register in `LocalBindings`; inject via explicit interface parameter (no more `app: AppContext` first arg).
- Replace `AppContext.forTest()` in `packages/core/services/__tests__/session.test.ts` with `buildTestContainer()` + `MockProcessRunner`.
- **PR size:** ~400 LOC changed, 3 new files, 2 modified services.

### Slice 2: agent-launcher + SessionLauncher wire-up
- Port already exists; consolidate direct tmux imports out of `agent-launcher.ts:12`.
- Add `MockSessionLauncher` for tests.
- **PR size:** ~200 LOC.

### Slice 3: stage-orchestrator + Clock + Logger
- Extract `Clock` and `Logger` ports; replace `Date.now()` and `structured-log.ts` module-level calls.
- **PR size:** ~300 LOC.

### Slice 4: Composition root + binding modules
- Introduce `LocalBindings` / `ControlPlaneBindings` / `TestBindings`.
- Replace `_registerContainer` branch in `app.ts:490-548` with binding module dispatch.
- Replace `forTenant()` `Object.defineProperty` hacks with Awilix `createScope()`.
- **PR size:** ~250 LOC, AppContext shrinks by ~150 LOC.

### Slice 5: SecretStore + Tracer cleanup
- Move remaining `process.env` reads to `SecretStore`; replace module-level OTLP state with injected `Tracer`.
- **PR size:** ~150 LOC.

---

## Risks & Open Questions

1. **Awilix CLASSIC mode and `bun build --compile`:** constructor parameter names must match cradle keys. New `asClass()` registrations must be tested against the compiled binary before merging.
2. **Global eventBus singleton in `hooks.ts:110`:** delegated by the injected `IEventBus` during migration; internalize after all callers migrate.
3. **`forTenant()` prototype override (`app.ts:302`):** 11 `Object.defineProperty` calls are fragile. Migrating to Awilix child scopes is cleaner but breaks the surface -- keep the shim during migration.
4. **Tmux in integration tests:** `MockSessionLauncher` skips tmux paths. Real-tmux tests need an `@integration` tag and must not run in CI without tmux.
5. **`app.ts` module-global `_app`:** `getApp()`/`setApp()` are called by flow.ts and other modules without an AppContext reference. Migrate these callers last or keep the singleton as a shim.
6. **ControlPlaneBindings stubs:** any throwing stub hit in production surfaces as a 500. Tag every stub `// TODO(cp):` and run a smoke test in the hosted CI that exercises each stub path.
7. **Test isolation with real `EventBus`:** `TestBindings` must call `bus.clear()` in `afterEach`. Failing to do this produces the kind of globalThis cross-test pollution already documented in CLAUDE.md.
