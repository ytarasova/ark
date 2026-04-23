# Code Quality Audit — Round 2 (2026-04-23)

Follows on from `docs/2026-04-22-code-quality-audit.md` + the 7-batch remediation that landed between 2026-04-22 and 2026-04-23 (commits `2cfb1547` / `06779c23` / `94d86970` / `5ec77b6f` / `571a0135` / Batch-6 starting `2325cb42` / Batch-3 starting `bfa93670`).

**Read-only audit, no code changes.** 6 parallel sub-agents, grouped by layer. Calibrated against prior findings so the report focuses on regressions + new-code since 2026-04-20.

---

## Executive summary

**2 P0 · 17 P1 · 24 P2 + 6 backend DI gaps. 5 regressions.**

Two of the finding categories the prior round marked "fixed" are **not actually fixed** — which changes the threat model. One new P0 introduced by the terminal-attach polish wave.

### Fix NOW (security-critical)

1. **Tenant-scope services still run as root singletons.** Batch 1's `createScope()` rewrite moved **repos** to `Lifetime.SCOPED` but left **services** (`dispatchService`, `sessionLifecycle`, `sessionService`, `sessionHooks`, `stageAdvance`, `historyService`) at `Lifetime.SINGLETON`. Awilix with `strict: true` resolves singleton deps through the root container. So `tenantApp.dispatchService === app.dispatchService` — both bound to default-tenant repos at first resolution. Three live code paths are already broken (core P0-1).

2. **Terminal-attach WS bypasses tenant ownership check.** `packages/server/index.ts:210-247` captures the Authorization header into `TerminalData` but never validates it before upgrading the WebSocket. A viewer-role token from tenant A can open `/terminal/:sessionId` for tenant B's session id, receive live pane bytes via arkd's attach stream, and send keystrokes via `send-keys -l`. Cross-tenant read + injection (server P0-1).

These two together mean **hosted multi-tenant is STILL not safe.** The prior audit closed the visible parts of the tenant-isolation crisis; these two are the residuals.

### Other regressions

- **Admin apikey handler double-registration** was claimed fixed in the prior round. It isn't. `admin.ts` + `admin-apikey.ts` both still register `admin/apikey/list`; registration order silently shadows admin.ts's `include_deleted` support (server P1-1).
- **`compute?.provider ?? "local"` name-fallback in 4 sites.** Batch 4 closed two (dispatch-claude-auth, session-snapshot) but missed four executors + agent-launcher, including net-new code in `executors/agent-sdk.ts` (core P1-1).
- **`config.databaseUrl` sniffing at `app.ts:162`** still there from prior P1-5 (core P1-4).
- **Test ports still hardcoded** in `daemon.test.ts:15` (19360-19362) — will collide under `--concurrency 4` (CLI/tests P1-1).

### New findings from code added since 2026-04-20

- **`session/inject` has no Zod schema** (server P1-2).
- **`SessionInteractClient.sessionInterrupt(sessionId)` missing required `content` arg** — server Zod schema requires it, client doesn't send it → any caller gets INVALID_PARAMS (server P1-3).
- **Anthropic streaming emits `input_json_delta` as `delta.content`** instead of `delta.tool_calls[].function.arguments` — UIs rendering tool calls see raw JSON fragments as chat text (router P1-A).
- **Stream errors bypass retry budget** — `fetchWithRetry` wraps only the header round-trip; mid-stream 5xx / socket reset throws without retry (router P1-B).
- **for_each budget check undercounts on resume** — `sumPriorIterationCosts` only sums over children spawned **this daemon run**; iterations from before a crash are skipped. A `$10` budget with 50 iters × $0.25 each that crashes at iter 30 ($7.50 spent) resumes with `cumulative = 0` and ends at $12.50 — 25% overrun with no error (core P1-2).

---

## Top 5 recommended remediation batches

| # | Batch | Layer | Severity | Files |
|---|---|---|---|---|
| 1 | **Tenant-scope service tree** — promote `dispatchService`, `sessionLifecycle`, `sessionService`, `sessionHooks`, `stageAdvance`, `historyService` to SCOPED; re-register in `tenant-scope.ts`. Add regression test: `app.forTenant("acme").dispatchService !== app.dispatchService` | core | **P0** | `tenant-scope.ts`, `di/services.ts` |
| 2 | **Terminal-attach WS tenant + auth gate** — call `resolveContext()` at upgrade time, validate `session.tenant_id === ctx.tenantId \|\| ctx.isAdmin`, 403 otherwise | server | **P0** | `packages/server/index.ts:210-247` |
| 3 | **Hosted-services DI refactor** — `registerHosted(container)` gated on `mode.kind === "hosted"`. Drop `app.setWorkerRegistry()` / `setScheduler()` / `setTenantPolicyManager()` bolt-ons. Register 5 missing auth managers (`TenantManager`, `TeamManager`, `UserManager`, `TenantClaudeAuthManager`, `TenantPolicyManager`) in `di/persistence.ts` | core+server | P1 | `hosted/server.ts`, `app.ts`, `di/persistence.ts`, 6 handlers |
| 4 | **Capability-fallback generalization** — replace `compute?.provider ?? "local"` in 4 executor sites + `agent-launcher.ts` with `app.resolveProvider(session)` polymorphic helper | core | P1 | 5 files |
| 5 | **Remove admin apikey double-registration + wire `runAction()` CLI helper** — consolidate `admin/apikey/*` into one file; extract ~57 CLI try/catch sites into shared helper (`~200` LOC deletion) | server+cli | P1 | `admin.ts`, `admin-apikey.ts`, `register.ts`, 12 CLI files |

---

## Findings by layer

### Core (1 P0 / 3 P1 / 3 P2, 1 regression)

#### P0-1: Tenant-scope services still singletons, bound to root

`packages/core/tenant-scope.ts:48-156` + `di/services.ts:59-286` + `container.ts:193 (strict: true)`.

Three broken paths:
- `app.ts:266-268` — boot reconciler dispatches via `tenantApp.dispatchService` → root's DispatchService → `deps.sessions.get()` filters by `tenant_id='default'` → null → session never resumes.
- `triggers/dispatcher.ts:71-72` — `tenantApp.sessionLifecycle.start(createOpts)` → root's lifecycle → INSERTs with `tenant_id='default'` regardless of `config.tenant`.
- `conductor/conductor.ts:336` — `app.sessionHooks.applyHookStatus(...)` with a per-tenant app → root's SessionHooks → writes to default-tenant event log.

**Fix:** re-register each service as `Lifetime.SCOPED` inside `tenant-scope.ts` with factories that resolve their deps from the child cradle. OR add a regression test that `tenant-scope.ts` fails CI if a service that closes over a tenant-sensitive repo is not SCOPED.

#### P1-1: `compute?.provider ?? "local"` at 5 sites

`executors/{agent-sdk,claude-code,goose}.ts`, `services/agent-launcher.ts:123`. A k8s compute row with a missing `provider` would get its worktree provisioned by `LocalProvider` on the control plane. `agent-sdk.ts:81` is net-new code (Apr-23) — regression of the pattern the prior remediation generalized-away in two other sites.

**Fix:** `app.resolveProvider(session)` polymorphic helper. Deprecate `getProvider(string)` for session-scoped callers.

#### P1-2: for_each budget undercount on resume

`services/dispatch/dispatch-foreach.ts:396-415`. `spawnedChildIds` only tracks children spawned this daemon run. On resume, iterations from before the crash are skipped. 25% overrun demonstrated.

**Fix:** read events across ALL children found in `buildCompletedSetFromChildren`, or store running cumulative in the checkpoint struct.

#### P1-3: `sumPriorIterationCosts` O(N²) per iteration

Same file, lines 50-74, called at 398/518/708/733/798. Full event list scan per call; inline mode calls it twice per iteration. 100 iters × 10 events = ~400+ full scans.

**Fix:** `EventRepository.sumHookCost(sessionId, types)` pushing SUM to SQL; keep running sum in memory across the loop.

#### P1-4: `app.ts:162` still sniffs `config.databaseUrl`

Prior P1-5 unchanged. Laptop user with Postgres silently gets hosted-only seed behavior. **Fix:** `if (this.mode.kind === "hosted")`.

#### P2s

- `mcp-pool.ts:388 _poolCache` module singleton lingering (back-compat shim only; tests can use container).
- `agent/agent.ts:173-180` mutates cached agent via `Object.assign` (aliasing smell).
- Em-dashes at `app.ts:377`, `migrations/runner.ts:49/180` (CLAUDE.md forbids U+2014).

---

### Server + arkd + protocol (1 P0 / 5 P1 / 4 P2, 1 regression)

#### P0-1: Terminal WS tenant bypass

`packages/server/index.ts:210-247`. Auth header captured into `TerminalData` but never validated before upgrade. Viewer token from tenant A reads pane bytes + injects keys into tenant B's session.

**Fix:** materialize `TenantContext` via `resolveContext({credentials: {...}})`, check `session.tenant_id === ctx.tenantId || ctx.isAdmin`, 403 otherwise.

#### P1-1: Admin apikey double-registration (regression)

`admin.ts:263-281` and `admin-apikey.ts:52-95` both register `admin/apikey/list`. `register.ts:107,111` calls admin then admin-apikey — admin-apikey wins, silently shadowing admin's `include_deleted` support. **Fix:** consolidate into one file.

#### P1-2: `session/inject` no Zod schema

Registered at `session.ts:616`, zero entries in `rpc-schemas.ts`. Per #276, every new RPC needs a schema. **Fix:** `sessionInjectRequest = z.object({ sessionId: z.string().min(1), content: z.string() })`.

#### P1-3: Client/server contract broken on `sessionInterrupt`

`SessionInteractClient.sessionInterrupt(sessionId)` sends only `{sessionId}`. Server Zod (`rpc-schemas.ts:832-846`) requires `content`. Any caller hits INVALID_PARAMS.

#### P1-4: `compute/clean` still host-wide

`resource.ts:522-528` reads `name`, does existence check, then runs `cleanZombieSessions(app)` which enumerates tmux host-wide. Prior P1-4 unchanged.

#### P1-5: ~80 RPC methods lack Zod

Gap between handler registrations and `rpc-schemas.ts`. Highest-value misses all added since Apr 20: `session/inject`, `compute/ping/reboot/clean/provision`, admin/tenant/*, admin/team/*, admin/user/*, admin/apikey/*, cluster/list, costs/*, code-intel/*.

#### P2s

- 27 `throw new Error` sites remain (resource.ts, metrics, tools, web, messaging) — collapse to `INTERNAL_ERROR` instead of typed `NOT_FOUND`/`INVALID_PARAMS`.
- `ARK_VERSION` drift: `protocol/types.ts:123 = 0.8.0`, `arkd/internal.ts:11 = 0.1.0`, neither wired to package.json.
- 7 near-identical `resolveTenantId` helpers scattered — extract.
- `handleAttachRoutes` (arkd) takes no `RouteCtx` — inconsistency with every other arkd route.

---

### Compute + router (0 P0 / 2 P1 / 7 P2, 0 regressions)

Batch 3/4/5 remediations hold. Every of 12 providers declares all 7 capability flags. `PolicyRegistry.register()` extensibility proven end-to-end by `policies.test.ts:110-132`.

#### P1-A: Anthropic streaming serializes tool-call args as `delta.content`

`router/adapters/anthropic-adapter.ts:83-90`. `input_json_delta` emitted as `choices[0].delta.content`; non-streaming path on same adapter (lines 228-236) correctly emits `tool_calls[].function.arguments`. Streaming/non-streaming produce divergent shapes. UIs render raw JSON fragments as chat text.

**Fix:** accumulate `input_json_delta` per tool-use block index; emit `delta.tool_calls[...]` matching OpenAI's streaming spec. Requires tracking `content_block_start` for tool_use id/name.

#### P1-B: Stream errors bypass retry budget

`providers.ts:107-122` + `retry.ts:136-141`. `fetchWithRetry` wraps the header round-trip only. Body-side 5xx or mid-stream socket drop throws outside retry scope. Transient drops during long completions appear as hard failures even though Batch 3 added retry.

**Fix:** retry full stream call on classified failure, OR document limitation.

#### P2s (shortened)

- SSE parser rejects `data:` without space (spec-valid) — 4 files.
- Same-provider fallback still possible via different model id (breaker threshold 5).
- TensorZero bypasses Strategy pattern + has no retry/timeout/CB.
- Legacy `DockerProvider` + `LocalProvider` (deprecated) still ship capability flags.
- `PolicyRegistry` silently falls back on typo'd policy name.
- Anthropic adapter defaults `x-api-key` to empty string on missing key.
- Google adapter API key in URL (logged on retry).

---

### Web + frontend DI (0 P0 / 2 P1 / 3 P2, 0 regressions)

Cleanest layer post-remediation. Verified zero regressions via greps:
- `grep "import.*\{.*\bapi\b.*\}.*useApi"` → 0 hits
- `grep "setTransport\|getTransport\|fetchApi\|_transport"` → 0 hits
- `grep "instanceof HttpTransport"` → 0 hits

#### P1-1 + P1-2: Polling holdouts

`useMessages.ts:27-124` hand-rolls `useState + useRef + setInterval(2s)` AND `useSessionStream.ts:83-91` polls the SAME `message/list` via TanStack at 5s. Double-polling active sessions + bespoke optimistic merge.

`ComputeView.tsx:44-125` same pattern for compute snapshots — hand-rolled instead of `useComputeSnapshotQuery()`.

#### Frontend DI re-assessment: unchanged recommendation

3 contexts total (`TransportContext`, `AppModeContext`, `ThemeContext`). Zero feature-flag code. `AppModeBinding` pattern is textbook DI without the runtime. Prior recommendation stands: no new library.

---

### CLI + tests (0 P0 / 5 P1 / 7 P2, 0 regressions)

Batch 7 closed the big-ticket items. Residuals are duplication + one structural test smell.

#### P1-1: `try/catch → console.log(chalk.red)` boilerplate at 57 sites

Across 12 CLI files (`tenant.ts` alone has 13). Three diverging shapes. **Fix:** `runAction(fn, { label })` helper in `_shared.ts`. **~200 LOC deletion + unified error formatting.**

#### P1-2: `--tenant` deprecation warning copy-pasted 6× in `workspace.ts`

Either extract to helper or remove the option entirely (server ignores it).

#### P1-3: `spawn-wiring.test.ts` tests source-code text via regex

Structural test masquerading as behavioral. Reflow breaks it; real bugs pass. **Fix:** instantiate `Command` in-memory + `parseAsync()` with fake `ArkClient` injected.

#### Tests P1-1: hardcoded ports in `daemon.test.ts:15`

19360-19362. Will collide under `--concurrency 4`. **Fix:** `allocatePort()`.

#### P2s (abbreviated)

- Status icons + color map hardcoded in `session/view.ts` (opportunity for shared formatter).
- `secrets.ts promptMasked` (88 lines of TTY handling) belongs in `cli/helpers.ts`.
- 5 test files >700 LOC (`agent-sdk-launch.test.ts` 1027 LOC notable).
- `withTestContext()` adoption partial — ~40 of 126 test files.
- 2 Postgres-env-gated `.skip` sites without issue references.

---

### Backend DI (6 gaps)

#### High-severity gaps

**DI-1** — **Hosted services via setter bolt-on.** `hosted/server.ts:29/33/37` constructs `WorkerRegistry` / `TenantPolicyManager` / `SessionScheduler` manually; `app.setXxx()` does `asValue` registration *after* `buildContainer` returned. Classic post-hoc bolt-on. **Fix:** `registerHosted(container)` gated on `mode.kind === "hosted"`, resolve from cradle.

**DI-2** — **5 auth managers still per-request constructs.** `TenantManager`, `TeamManager`, `UserManager`, `TenantClaudeAuthManager`, `TenantPolicyManager` all get `new X(app.db)` inline in every handler (6+ files). Only `ApiKeyManager` got containerized in Batch 4. Test doubling blocked. **Fix:** 5 `asFunction` factories in `di/persistence.ts`.

#### Medium-severity gaps

**DI-3** — `SessionLauncher = new TmuxLauncher()` constructor-default in `app.ts:96`. Should be DI factory.

**DI-4** — `executor.ts` + `tools/registry.ts` module-level `Map`s populated at import time. Fallback `getExecutor(runtime)` reads them. Same pattern PR #251 moved out for triggers.

**DI-5** — `webhooks.ts`, `triggers.ts`, `connectors/resolve.ts` use `WeakMap<AppContext, Registry>` per-handler caches. Exact anti-pattern `TicketProviderRegistry` was moved out of in Batch 7.

#### Low-severity

**DI-6** — Clean small-scope case within DI-5 cluster.

#### Tenant-scope verified clean (repo layer)

Every repo runs through `childContainer.register(asFunction(...))`; no manual `new Repo(db)` inside `forTenant()`. The gap is SERVICES, not repos (covered by core P0-1).

---

## Cross-cutting patterns

### 1. Tenant scoping is partially applied — services still bound to root

Prior-round P0 closed the RPC transport + repo layers. Services remain SINGLETON. Three code paths broken today (boot reconcile, trigger dispatch, conductor hooks). The prior remediation should have included service-tree scoping; it didn't. **This is the single largest piece of residual work.**

### 2. Default-fallback idioms as the implicit "null provider" handler

`compute?.provider ?? "local"` appears 4× in executors + `agent-launcher.ts`. One `resolveProvider(session | compute | null)` helper, polymorphic via AppMode, fixes the family. Deprecate `getProvider(string)` for session-scoped callers.

### 3. Zod coverage is ~40%

~80 RPC methods have handlers but no `rpc-schemas.ts` entry. Prior #276 unification wanted full coverage; new code since 2026-04-20 is adding handlers without schemas. Every unschema'd handler is an `INVALID_PARAMS` → `INTERNAL_ERROR` downgrade surface.

### 4. Client/server drift catching is manual

`compute-template-list` earlier, `sessionInterrupt` now. No check that `SessionInteractClient.X(args)` matches `rpc-schemas.ts:X.request`. Pre-commit or type-level check would catch the pattern.

### 5. WeakMap-per-AppContext caching recurring

`connectors/resolve.ts`, `triggers.ts`, `webhooks.ts` all do the same thing. Container already provides singleton registration — these three call sites should resolve from `app.container.cradle.*`.

### 6. `throw new Error` cleanup stalled at ~50%

`session.ts` + new handlers use `RpcError(msg, ErrorCodes.X)`. Older `resource.ts` / `metrics.ts` / `tools.ts` / `web.ts` / `messaging.ts` still use bare Error (27 sites). Collapses to `INTERNAL_ERROR`. Mechanical replacement.

---

## Remediation-order guidance

Grouped by priority + file-set overlap:

**Batch 1 (security-critical, ship same day):**
- Core P0-1: tenant-scope services → SCOPED
- Server P0-1: terminal-attach WS tenant gate

**Batch 2 (DI + regression cleanup):**
- DI-1 + DI-2: hosted services + 5 auth managers into container
- Core P1-1: `compute?.provider ?? "local"` → polymorphic helper at 5 sites
- Server P1-1: admin apikey double-registration

**Batch 3 (protocol correctness):**
- Server P1-2: `session/inject` Zod schema
- Server P1-3: `sessionInterrupt` client/server contract
- Router P1-A: Anthropic streaming tool-call serialization
- Router P1-B: stream retry budget

**Batch 4 (performance + resilience):**
- Core P1-2: for_each budget on resume
- Core P1-3: `sumPriorIterationCosts` O(N²) → SQL SUM
- Web P1-1 + P1-2: TanStack Query migration for useMessages + ComputeView

**Batch 5 (hygiene):**
- CLI P1-1: `runAction()` helper (~200 LOC deletion)
- Tests P1-1: `allocatePort()` in daemon.test.ts
- Core P1-4: `app.ts:162` AppMode.kind instead of databaseUrl sniff
- P2 cleanup: em-dashes, `throw new Error` → RpcError, scattered `resolveTenantId`, `PolicyRegistry` fail-fast

---

## Out of scope for this audit

- Performance tuning beyond smells (some perf smells flagged in core P1-3; comprehensive perf is out).
- Security deep-dive beyond tenant-isolation + credential handling (no full threat model).
- Feature work.
- Build / infra / CI concerns.

---

## Files referenced (critical)

- `packages/core/tenant-scope.ts:48-156` — P0-1
- `packages/core/di/services.ts:59-286` — P0-1
- `packages/server/index.ts:210-247` — server P0-1
- `packages/core/app.ts:162` — core P1-4
- `packages/core/app.ts:266-268` — core P0-1 reachability
- `packages/core/triggers/dispatcher.ts:71-72` — core P0-1 reachability
- `packages/core/conductor/conductor.ts:336` — core P0-1 reachability
- `packages/core/executors/{agent-sdk,claude-code,goose}.ts` — core P1-1
- `packages/core/services/dispatch/dispatch-foreach.ts:396-415` — core P1-2
- `packages/server/handlers/admin.ts:263-281` + `admin-apikey.ts:52-95` — server P1-1
- `packages/protocol/clients/session-interact.ts:115-117` — server P1-3
- `packages/router/adapters/anthropic-adapter.ts:83-90` — router P1-A
- `packages/router/providers.ts:107-122` — router P1-B
- `packages/core/hosted/server.ts:29/33/37` — DI-1
- `packages/server/handlers/{admin,tenant-auth,clusters,admin-policy}.ts` — DI-2
- `packages/cli/commands/tenant.ts` + 11 others — CLI P1-1
- `packages/cli/__tests__/daemon.test.ts:15` — tests P1-1
