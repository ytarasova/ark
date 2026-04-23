# Code Quality Audit — 2026-04-22

**Scope:** full-codebase audit across 5 layer dispatches (core, server+arkd+protocol, compute+router, web+DI-frontend, CLI+tests+DI-backend). Read-only, no code changes. Output format: findings at P0/P1/P2 with `file:line` references + fix shape.

**Assessment lenses:** SOLID, TDD, Clean Code, Fowler refactoring smells, MVC / layering, Ark-specific invariants (tenant isolation, AppMode polymorphism, no em-dashes, `strict: false` TS).

**Session context:** follows on from `docs/2026-04-21-architectural-audit-hardcoded-rules.md` (capability-driven rules remediation, closed in #394). Re-checks for regression + widens scope beyond the compute layer.

---

## Executive summary

**65 findings: 12 P0, 31 P1, 22 P2.**

### Top cross-cutting findings (fix these first)

1. **Hosted-mode tenant isolation is broken across three layers simultaneously.** Admin methods are callable cross-tenant because the hosted RPC dispatcher drops `TenantContext` (server P0-1). Triggers accept tenant from the request body (server P0-2). Schedules have no ownership check (server P0-3). Boot reconcilers query only the default tenant (core P0-2). Seeded templates only land for default (core P0-3). Any one of these is shippable-blocking on hosted; together they mean hosted mode is NOT safe for multi-tenant use today.

2. **Capability-flag anti-pattern is regressing outside compute/.** The Apr 21 audit closed the compute-layer offenders, but the same shape reappears in `services/session-snapshot.ts` (name-prefix matching), `services/dispatch-claude-auth.ts` (hardcoded `"k8s" | "k8s-kata"` check), `services/agent-launcher.ts` (`compute?.provider ?? "local"`), and `core/services/compute-lifecycle.ts:80` which bypasses the service's `canDelete` guard. The remediation pattern needs to generalize: capability flags on every interface that crosses a polymorphism boundary.

3. **Router policies + provider adapters are switch-over-name, not Strategy.** `router/engine.ts:149-163` dispatches by `policy` enum in a switch; `router/providers.ts:82-120` picks provider adapters by name string. Adding a fourth policy or a fourth provider backend means editing the switch in N places. OCP violation.

4. **DI container has a tenant-scoping hole.** `core/tenant-scope.ts:32-59` manually instantiates 11 repositories + 1 service with `new Repo(db)` instead of using `container.createScope()`. Any repo that gains a new dependency silently loses it on tenant scope. **Security-adjacent** because this is the exact path hosted tenants go through.

5. **Router never retries despite `max_retries` being wired.** `router/types.ts:137` declares the field, `router/config.ts` reads it, nothing consults it. A single transient 503 → circuit breaker opens → whole provider offline for 30s. P0.

6. **Streaming has no back-pressure.** `router/server.ts:437-519` constructs `ReadableStream` with only `start()`, no `pull()`; `controller.enqueue()` fires in a tight loop without checking `desiredSize`. Slow clients cause unbounded in-memory buffering of provider SSE output.

7. **DI assessment for frontend: no new container needed.** The existing React-context transport has a singleton leak bug (`useApi.ts:209` `let _transport`) that a DI library wouldn't fix; fixing the singleton IS the DI work.

### Remediation order (ranked by blast radius + reversibility)

| # | Fix | Severity | Lines | Blast if skipped |
|---|---|---|---|---|
| 1 | Server P0-1 — thread `tenantCtx` through `rpcRouter.dispatch` in hosted | P0 | ~20 | Cross-tenant admin escalation |
| 2 | Core P0-2 — cross-tenant boot reconcilers | P0 | ~60 | Hosted for_each never resumes |
| 3 | Server P0-2/P0-3 — tenant-ownership on triggers + schedules | P0 | ~40 | Cross-tenant write |
| 4 | Server P0-4 — arkd `/codegraph/index` workspace confinement | P0 | ~5 | Path traversal |
| 5 | Core P0-1 — route GC through `ComputeService.delete` | P0 | ~10 | Capability-guard regression |
| 6 | Core P0-3 — system-wide templates visible to every tenant | P0 | ~15 | Hosted templates invisible |
| 7 | Router P0-1 — add retry/backoff wrapper | P0 | ~40 | Transient 503 → SLA pain |
| 8 | Router P0-2 — collapse duplicate `docker stats` | P0 | ~10 | CPU starvation |
| 9 | DI backend #2 — rewrite `tenant-scope.ts` with `createScope()` | P0 | ~80 | Silent tenant-isolation drift |
| 10 | DI backend #1 — register `ApiKeyManager` in container | P0 | ~10 | Test-doubles blocked |
| ... | P1s per layer | | | (tracked below) |

**Recommend: Waves 1-6 are "hosted tenant-isolation crisis mode" — dispatch as one high-priority batch. Waves 7-10 follow. P1s batch by layer.**

---

## Findings by layer

### Server + arkd + protocol (4 P0 / 6 P1 / 3 P2)

#### P0

- **P0-1 Hosted RPC dispatch discards TenantContext.** `packages/core/hosted/web.ts:351` calls `rpcRouter.dispatch(body)` with only the request. Router falls back to `localAdminContext(null)` for every hosted call, neutering every `requireAdmin(ctx)` gate (`admin.ts`, `admin-apikey.ts`, `admin-policy.ts`, `tenant-auth.ts`, `clusters.ts` admin). Any tenant-admin/member token can call `admin/tenant/create`, `admin/tenant/auth/set`, `admin/apikey/create`, `admin/tenant/policy/set` across tenants. Audit trails record `ctx.userId ?? null` → always null. **Fix:** thread `tenantCtx` into `rpcRouter.dispatch(req, notify, tenantCtx)`. Add regression test asserting viewer role gets `FORBIDDEN` from `admin/tenant/list`.

- **P0-2 `triggers/*` ignores caller tenant.** `packages/server/handlers/triggers.ts:146-149` reads a hardcoded `"default"` via `currentTenant()` AND accepts `tenant` from the request body. Any authenticated caller can pass `{ tenant: "other-tenant" }` to `trigger/disable` or `trigger/test` and manipulate other tenants' triggers (including dispatching sessions into them). **Fix:** take tenant from `ctx.tenantId`, ignore body override.

- **P0-3 `schedule/*` has no tenant ownership check.** `packages/server/handlers/schedule.ts:25-40` — `core.deleteSchedule(app, id)`, `enableSchedule(app, id, ...)` receive only an id, no tenant scope. `schedule/list` returns every tenant's schedules. **Fix:** resolve `app.forTenant(ctx.tenantId)` before calling, or pass `tenantId` and enforce ownership.

- **P0-4 arkd `/codegraph/index` bypasses workspace confinement.** `packages/arkd/routes/misc.ts:14-60` — `repoPath` from JSON body flows straight into `Bun.spawn({ cwd: repoPath })` + `new Database(join(repoPath, ".codegraph", "graph.db"))`. No `ctx.confine()`. **Fix:** `const safe = ctx.confine(body.repoPath)` before spawn + db open.

#### P1

- **P1-1 Admin apikey handlers double-registered.** `admin.ts:263-281` (soft-delete with audit) vs `admin-apikey.ts:52-84` (hard revoke). `registerAdminApiKeyHandlers` runs after `registerAdminHandlers` and silently overrides. **Fix:** pick one, delete the other. Add `Router.handle` duplicate-registration detection.

- **P1-2 Handlers skip tenant scoping.** `memory.ts`, `messaging.ts`, `web.ts`, `session.ts` use `app.knowledge`/`app.events`/`app.messages`/`app.artifacts` directly instead of `scoped(app, ctx)`. `knowledge-rpc.ts`, `workspace.ts`, `conductor.ts`, `costs.ts`, `sage.ts` do it correctly. The inconsistency means hosted-mode default-tenant requests (`tenantCtx.tenantId === "default"`) read/write the global store. **Fix:** make `scoped(app, ctx)` house style; enforce at handler entry OR materialize `app.forTenant` at router time.

- **P1-3 Hosted per-request `new Router()` is O(handlers) per call.** `hosted/web.ts:347-350` builds a fresh router + runs ~40 register functions every non-default-tenant RPC. **Fix:** cache router-per-tenant (WeakMap).

- **P1-4 `compute/clean` ignores `name` scope.** `resource.ts:521-527` extracts `name`, looks up compute, then calls `cleanZombieSessions(app)` which enumerates `tmux list-sessions` host-wide. **Fix:** scope to `compute.name` or rename to `host/clean` admin-gated.

- **P1-5 `sage/analyze` writes to un-tenant-scoped arkDir path.** `sage.ts:92-95` → `join(scoped.config.arkDir, "sage", "${jira_id}.analysis.json")`. Two tenants with same `jira_id` overwrite each other. **Fix:** include `tenant_id` in path; `0o600` perms.

- **P1-6 arkd `/agent/launch` doesn't confine workdir.** `agent.ts:22-54` writes `/tmp/arkd-launcher-${sessionName}.sh` + uses attacker-provided `workdir` in `tmux new-session -c`. Only NUL-byte check, no confinement. **Fix:** `ctx.confine(req.workdir)`; launcher script → `join(workspaceRoot, ".ark", "launchers", ...)`.

#### P2

- **P2-1 47 `throw new Error` sites** collapse to `INTERNAL_ERROR` instead of `NOT_FOUND`/`INVALID_PARAMS`/`UNSUPPORTED` (`resource.ts`, `metrics.ts`, `tools.ts`, `web.ts`). Blanket grep+replace with typed `RpcError`.
- **P2-2 `ARK_VERSION` drift** — `protocol/types.ts:123` = 0.8.0; `arkd/internal.ts:11` = 0.1.0. Neither wired to `package.json`.
- **P2-3 7 near-identical `resolveTenantId` helpers** across `costs.ts`, `code-intel.ts`, `workspace.ts`, `sage.ts`, `conductor.ts`, `secrets.ts`, `knowledge-rpc.ts`. Extract.

---

### Core (3 P0 / 6 P1 / 4 P2)

#### P0

- **P0-1 `garbageCollectComputeIfTemplate` bypasses `ComputeService.delete()`.** `services/compute-lifecycle.ts:80` calls `app.computes.delete()` directly, skipping the `canDelete` guard installed in Apr 21 remediation. Any future provider shipping `canDelete=false` gets its rows silently destroyed by GC. **Fix:** route through `ComputeService.delete()`. If GC needs a bypass for clones, add explicit `ComputeService.forceDeleteClone(name)` that asserts `cloned_from !== null`.

- **P0-2 Cross-tenant sessions silently dropped by boot reconcilers.** 5 sites use root `app.sessions.list(...)` bound to `tenantId="default"`: `app.ts:251` (`_reconcileForEachSessions`), `app.ts:294` (`_rehydrateInlineFlows`), `infra/stale-state-detector.ts:82`, `services/compute-lifecycle.ts:51`, `session/checkpoint.ts:81-82`. In hosted mode, a crashed for_each for tenant `acme-42` never resumes; stale-state detector can't see it; GC undercounts references and can delete templates still in use. **Fix:** add `SessionRepository.listAcrossTenants()` privileged query (guard-tested to only be called from boot) OR iterate known tenants and call `app.forTenant(id).sessions.list(...)` per.

- **P0-3 `_seedComputeTemplates` writes templates to default tenant only.** `app.ts:350-362` instantiates `new ComputeTemplateRepositoryCtor(db)` without `setTenant()` → everything under `tenant_id='default'`. Hosted tenants never see them. **Fix:** sentinel tenant `__system__` that every tenant-scoped query unions in, OR hosted-only provisioning path.

#### P1

- **P1-1 `inferComputeKind` string-prefix matching.** `services/session-snapshot.ts:77-86` — `name.startsWith("k8s-kata") ? "k8s-kata" : ...`. Compute row already has authoritative `compute_kind` column. A user-named `"kata-prod"` compute (pointing at k8s-kata) infers `local`. **Fix:** read `compute.compute_kind`. Delete `inferComputeKind()`.

- **P1-2 `dispatch-claude-auth.ts` name-gates Secret creation.** `services/dispatch-claude-auth.ts:101` — `if (providerName !== "k8s" && providerName !== "k8s-kata") return EMPTY;`. The capability being checked is "supports per-session Secret mount". **Fix:** add `ComputeProvider.supportsSecretMount: boolean` or a typed `isK8sFamily(kind)` helper.

- **P1-3 `session/create.ts:111` hardcoded `"local"` fallback.** Event data says `compute: "local"` when dispatcher hasn't yet filled `compute_name`. Lies about reality. **Fix:** `compute: mergedOpts.compute_name ?? null`.

- **P1-4 `SessionRepository.getChannelBounds` reads env vars directly.** `repositories/session.ts:413-427` — when `setChannelBounds()` hasn't been called, reaches for `process.env.ARK_CHANNEL_BASE_PORT` with own parseInt + hardcoded 19200/10000 fallbacks. **Fix:** make bounds required constructor arg; throw when unset.

- **P1-5 `app.ts:166` branches on `config.databaseUrl` violating AppMode.** `modes/app-mode.ts:22` comment is explicit: "no handler body contains `isHostedMode(...)`". Sniffing `databaseUrl` is morally identical. Laptop user with Postgres becomes "hosted" silently. **Fix:** use `this.mode.kind === "hosted"` or add `BuiltinResourceSeederCapability` to AppMode.

- **P1-6 Boot reconcile kicks dispatch without tenant scope.** `app.ts:267` — `this.dispatchService.dispatch(session.id)` uses root's default-tenant service. **Fix:** after P0-2 lands, route via `this.forTenant(session.tenant_id).dispatchService`.

#### P2

- **P2-1** Em-dashes in `app.ts:377`, `migrations/runner.ts:49/180` — CLAUDE.md forbids U+2014.
- **P2-2** `ledger.ts:200` ⚠ emoji in prompt output. `compute.ts:271-273` voids imports to silence lint → dead code.
- **P2-3** `SessionService.stop` swallows missing AppContext with `logDebug` (`services/session.ts:92-97`). Comment says "e.g. unit tests" — hostile to production debugging.
- **P2-4** `ComputeTemplateRepository` constructs its own `new ComputeRepository(db)` (`repositories/compute-template.ts:42-44`). Feature-envy; DI already registers one.

---

### Compute + router (2 P0 / 8 P1 / 5 P2)

#### P0

- **P0-1 Router no retry/backoff despite `max_retries` wired.** `router/types.ts:137`, `router/config.ts:116/129/142`, `router/providers.ts:130-164/175-209`. `complete()` / `stream()` issue one fetch and fail hard. No `Retry-After` honoring, no 429/503 classifier. Single transient 503 pops circuit breaker 5 requests later → provider tier offline 30s. **Fix:** `withRetry(fn, { retries, classify })` wrapper using expo+jitter; classify 408/429/5xx/ECONN* as retryable.

- **P0-2 Docker metrics poll runs two blocking `docker stats --no-stream`** (`providers/docker/index.ts:257-362`, esp line 266). Each docker compute pays ~2s wall-clock per 5s tick. N docker computes × 2s = event-loop starvation + arkd heartbeat misses. The two stats calls are redundant. **Fix:** collapse to one stats call, or use engine API `/containers/{id}/stats?stream=false`.

#### P1 (abbreviated — see sub-agent report for full text)

- **P1-1 Router policy selection is a `switch` over names.** `engine.ts:149-163, 240-248`, `providers.ts:82-93, 109-120`. Adding a policy or adapter forks the engine. **Fix:** `PolicySelector` interface + registry.
- **P1-2 Dispatcher fallback duplicated verbatim** between `dispatch` and `dispatchStream`; `findProviderForModel` can re-enter the failed provider (`dispatch.ts:46-66, 99-117`). **Fix:** extract `selectFallbacks(...)`, exclude-by-provider-identity.
- **P1-3 Streaming has no back-pressure.** `router/server.ts:327-368, 437-519`; `providers.ts:353-452, 483-548, 627-658`. `ReadableStream` with only `start()`, no `pull()`; `controller.enqueue()` in tight loop. Slow client → unbounded buffering of SSE. **Fix:** `pull()`-based stream OR gate `enqueue` on `desiredSize`.
- **P1-4 `assessConfidence` magic numbers.** `dispatch.ts:179-222` — `/I think/i`, `/perhaps/i` fire on every long reasoning response, each subtracting 0.05. Cascade escalates correct answers. **Fix:** remove or base on `finish_reason === "length"` only.
- **P1-5 Worktree cleanup duplicated verbatim** between `LocalProvider` (legacy) and `LocalWorktreeProvider` (`providers/local/index.ts:105-122` vs `local-arkd.ts:118-136`). `local-arkd.ts:60` hardcodes `"tmux"` while legacy path correctly uses `tmuxBin()`. **Fix:** move to `core/infra/worktree.ts`; delete dupes.
- **P1-6 `ec2/provision.ts` `destroyStack` swallows AWS errors** into `console.error`. Caller can't distinguish success from SG-orphan (`provision.ts:317-344`). **Fix:** `DestroyResult { terminated, sgDeleted, keyDeleted, errors }`.
- **P1-7 `RemoteFirecrackerProvider.postProvision`** embeds fragile bash heredoc with unescaped vars + unversioned `curl | grep` (`remote-arkd.ts:462-500`). Exit code ignored. **Fix:** pin version, check exit code, move to cloud-init.
- **P1-8 `K8sProvider.kubeApi: any` cached across computes.** `k8s.ts:186` — second compute gets first compute's client. Silent swallows in 11 `catch {}` blocks (`captureOutput` returns `""` on failure). **Fix:** key cache by cluster; surface errors via sibling `last_error` field.

#### P2 (listed in sub-agent report; see full file for details)

---

### Web (0 P0 / 6 P1 / 7 P2) + Frontend DI assessment

#### P1

- **P1-1 Module-level transport singleton.** `hooks/useApi.ts:209` `let _transport: WebTransport = new HttpTransport()`. `TransportProvider` uses a side-effecting setter. Any concurrent SSR / multiple-provider subtree / test-mounting leaks last-set transport into unrelated trees. `useEffect` at `TransportContext.tsx:30` is gratuitous. **Fix:** delete `_transport`; rewrite `api` as hook returning object closed over `useTransport()`.
- **P1-2 Three parallel transport pipelines** — `api.*` (module singleton), `adminApi.*` (context-reading), direct `fetch("/api/rpc")` in `LoginPage.tsx:23`. **Fix:** one pipeline; per-domain files consuming injected transport.
- **P1-3 LoginPage bypasses transport entirely.** Builds own JSON-RPC envelope + stores token in `localStorage` that `HttpTransport.ts:20` only reads from URL query. Reads and writes disagree.
- **P1-4 `fetchApi` pokes transport via `instanceof HttpTransport`** (`useApi.ts:247`). Breaks the abstraction; MockTransport callers silently skip auth headers.
- **P1-5 Client re-encodes `providerToPair` table.** `NewComputeForm.tsx:23-37` — 10-row local copy with "keep in sync" comment. Backend exposes `compute/kinds` + `runtime/kinds` + templates already carry the pair. Exact recurrence of Apr 21 P1-5 pattern.
- **P1-6 `useApi.ts` is a 646-line god module with 140+ methods** mixing every domain. 5 inline `any` return types. **Fix:** feature-slice by domain, parallels backend split.

#### P2 (7 items — see sub-agent report)

Notable: `ComputeView.tsx:82` branches on `name === "local"` (small P1-3 regression); widespread `any` typing on components where protocol types already exist.

#### Frontend DI assessment

**Recommendation: no new DI library.** The pain that would justify InversifyJS/awilix-browser/Context container doesn't exist. Concrete evidence:

- **One** actually-swapped dep in tests (transport) — already handled by context + `WebTransport` interface.
- **One** compile-time binding swap (`AppModeProvider` picks LocalBinding vs HostedBinding) — polymorphism via React context, works well.
- **Zero** evidence of tenant-auth plumbing needs, feature-flag injection needs, or multiple parallel service implementations.
- Actual pain is the *opposite* — transport escapes context and lives on module singleton (P1-1/2/3/4). A DI library wouldn't fix this; removing the singleton does.

**Proposed work (if any):** tighten the existing React-context injection.
1. Delete module-level `_transport`; rewrite `api` as a hook (or take transport arg).
2. Route `LoginPage` through injected transport.
3. Delete `fetchApi` or reimplement on top of `WebTransport`.
4. Fold `adminApi.ts` into per-domain pattern.

This is refactor inside existing shape, not a new dependency.

---

### CLI (2 P0 / 5 P1 / 3 P2) + Tests (1 P0) + Backend DI

#### CLI P0

- **P0-1 `misc.ts:11-536`** is a 536-LOC grab-bag: `pr`, `watch`, `doctor`, `arkd`, `channel`, `web`, `openapi`, `mcp-proxy`, `repo-map`, `init`. SRP violation. `web` action alone is 150 lines of mixed watchdog + proxy + startup probing. **Fix:** extract per-verb commands; `WebCommand` delegates probe+startup to a service.
- **P0-2 `session/start.ts:68-257`** — 190-LOC action handler (transaction-script smell). Flow-input validation at `:171-205` is business logic that belongs server-side. **Fix:** `SessionStartService.plan(opts)` returning validated DTO.

#### CLI P1

- Duplicated CRUD scaffolding across `agent.ts`, `flow.ts`, `skill.ts`, `recipe.ts` (~620 LOC total). Extract `ResourceCommand<T>` factory.
- Status icons + color maps duplicated across `session/view.ts:29-46`, `misc.ts:27`, `session/lifecycle.ts:16-18`.
- `session/view.ts:87-197` — 110 lines of `for_each` rollup rendering in the command; belongs in a `session/forEachSummary` RPC.
- Inconsistent error handling: `process.exit(1)`, `process.exitCode = 1`, silent swallows across files.
- Interactive prompts only wrapped for k8s; extract to shared helper.

#### Tests P0

- **`packages/core/__tests__/lifecycle.test.ts`** — 11 sync `AppContext.forTest()` sites (lines 38, 57, 68, 78, 88, 97, 105, 113, 135, 216). CLAUDE.md flags as legacy. **Fix:** convert to `forTestAsync()`.

#### Tests P1 (abbreviated)

- Silent `.skip` without issue tags (`migrations/__tests__/runner.test.ts:108`).
- Hardcoded ports in `arkd/__tests__/server.test.ts:528/538/572/575`, `session-pause-resume.test.ts:65`, `router/__tests__/engine.test.ts:84/89`. Use `allocatePort()`.
- 5 test files >700 LOC (`agent-sdk-launch.test.ts` 1027, `search.test.ts` 778, etc.); splittable.
- `Bun.spawn` global spy in `agent-sdk-dispatch.test.ts:134` — fragile across concurrent workers.

#### Backend DI coverage + remediation plan

Container-coverage audit: `packages/core/di/` has 6 modules, every core repo/service registered. 3 subsystems NOT in container; 7 module singletons total (5 grandfathered, 2 genuine misses).

**Ranked offenders:**

1. **`ApiKeyManager` not in container.** `app.ts:141` — `new ApiKeyManager(db)` in `boot()`, held in `_apiKeys` field, getter-exposed. Cannot test-double. **P0.** Fix: `apiKeys: asFunction(c => new ApiKeyManager(c.db), { lifetime: SINGLETON })` in `persistence.ts`.

2. **`tenant-scope.ts:32-59` bypasses container entirely.** Manually instantiates 11 repos + 1 service with `new X(db)`. If any repo gains a new dep, tenant contexts silently miss it. **P0 (security-relevant).** Fix: `forTenant()` should build child awilix container via `createScope()` with tenant-scoped overrides.

3. **`observability/costs.ts:16` `_registry = new PricingRegistry()`** — module singleton duplicating the container's `pricing`. Two price tables; the module copy never gets `refreshFromRemote()`. **P1.** Fix: delete `_registry`; take `pricing` as arg or method-on-registry.

4. **`tickets/registry.ts:157-168` `_singleton: TicketProviderRegistry | null`** — service locator, not container-registered. **P1.** Fix: register as `ticketProviderRegistry` in `di/runtime.ts`.

5. **`mcp-pool.ts:386 _pool: McpPool | null`** with `getMcpPool(socketDir)` factory. **P1.** Fix: register in `di/runtime.ts` with `socketDir` from config.

6. **`integrations/{pr-poller,pr-merge-poller,issue-poller}.ts` `_ghExec: GhExecFn`** module variable with `setGhExec(fn)` for test injection. Test leakage risk. **P2.** Fix: `GithubClient` class with constructor-injected `ghExec`.

7. **`compute/index.ts:38-48 _app: AppContext | null`** service locator. CLAUDE.md grandfathers. **P2 (grandfathered).**

**Non-gaps (correctly grandfathered per CLAUDE.md):** `structured-log.ts` (`_level`/`_components`/`_arkDir`), `hooks.eventBus`, `provider-registry.ts` cycle-breaker.

**Recommended DI remediation order:**
1. Migrate `ApiKeyManager` into `registerPersistence` (10-line change, unblocks doubles).
2. Rewrite `tenant-scope.ts` to use `container.createScope()` (highest correctness impact, security-load-bearing).
3. Delete `costs.ts _registry`.
4. Register `TicketProviderRegistry` + `McpPool`.
5. Convert `_ghExec` singletons to `GithubClient` class.

---

## Cross-cutting patterns

### 1. Multi-tenant isolation is opt-in per handler + broken in hosted (P0, spans server + core)

The audit precedent #275 wants `ctx.tenantId` everywhere. Today enforcement happens only at the hosted transport (`web.ts:277`) for non-default tenants, and not at all for default tenant. Handlers that correctly use `scoped(app, ctx)`: `knowledge-rpc`, `workspace`, `conductor`, `costs`, `sage`. Handlers that skip: `memory`, `messaging`, `web`, `session`, `triggers`, `schedule`. Plus: **boot reconcilers** (5 sites) only query default tenant; hosted crashes for non-default tenants never recover.

Combined with P0-1 (router drops `tenantCtx`), hosted mode is NOT safe for multi-tenant use today.

### 2. Name-based capability checks re-emerging outside compute/

The Apr 21 audit closed `SINGLETON_PROVIDERS` / `canDelete` / `initialStatus` in the compute repo. Same shape survives in:
- `services/session-snapshot.ts:78-86` (infer compute kind by name prefix)
- `services/dispatch-claude-auth.ts:101` (name-gate k8s Secret creation)
- `services/session/create.ts:111` (hardcoded `"local"` fallback)
- `services/agent-launcher.ts:123` (`compute?.provider ?? "local"`)
- `services/compute-lifecycle.ts:80` (bypasses service's `canDelete` guard in GC path)

Needs generalization: capability flags on every interface that crosses a polymorphism boundary; a typed helper (`isK8sFamily(kind)`) for genuine family checks; provider capability query to feed UI (already done for compute).

### 3. Router lacks strategy/OCP structure

Policies, provider adapters, and `higherTiers()` are all switch-over-string. Adding Bedrock / Azure / a latency-optimized policy forks these switches. Strategy pattern with registries would decouple.

### 4. DI coverage strong at class boundary, weak at subsystem seams

`ApiKeyManager`, `costs._registry`, `TicketProviderRegistry`, `McpPool`, `_ghExec`, and `tenant-scope.ts` are the surviving module-level seams. Tenant-scope is the highest-risk because hosted tenants go through it every request.

### 5. Silent defaults covering missing data

`SessionRepository.getChannelBounds` env-var fallback. `_reconcileForEachSessions` default-tenant fallback. `ComputeView.tsx:82` `name === "local" ? undefined` sentinel. `silent catches with only logDebug` in 5+ places. Needs `safeAsync(label, fn)` helper adoption + explicit "intentional swallow" markers.

### 6. Test isolation is otherwise excellent

`forTestAsync()` adoption nearly complete (only `lifecycle.test.ts` lags). Mocking discipline: at process/file boundaries (Bun.spawn, gh CLI), not on internal calls. Fixture hygiene: per-test boot+teardown, no cross-test leak.

---

## Recommended remediation batches

**Batch 1 (hosted-multi-tenant crisis) — dispatch as one high-priority wave:**
- Server P0-1 (thread `tenantCtx` through hosted dispatch)
- Server P0-2 (triggers use `ctx.tenantId`)
- Server P0-3 (schedule ownership checks)
- Core P0-2 (cross-tenant boot reconcilers)
- Core P0-3 (system-wide template visibility)
- DI #2 (rewrite tenant-scope with `createScope()`)

**Batch 2 (security hardening):**
- Server P0-4 (codegraph confinement)
- Server P1-6 (agent/launch workdir confinement)
- Server P1-5 (tenant-scope sage paths)
- Core P0-1 (GC through ComputeService.delete)

**Batch 3 (router reliability):**
- Router P0-1 (retry/backoff)
- Router P0-2 (docker metrics collapse)
- Router P1-3 (back-pressure)

**Batch 4 (DI + capability-flag regression cleanup):**
- DI #1 (ApiKeyManager in container)
- Core P1-2 (`supportsSecretMount` capability)
- Core P1-1 (snapshot reads `compute_kind` column)
- Web P1-5 (delete client `providerToPair`)

**Batch 5 (architectural seams — OCP):**
- Router P1-1 (Strategy pattern for policies + adapters)

**Batch 6 (web transport cleanup):**
- Web P1-1/2/3/4 (delete transport singleton; one pipeline; LoginPage through transport)

**Batch 7 (CLI/test/DI hygiene):**
- CLI P0-1, P0-2 (misc.ts + session/start.ts splits)
- Tests P0 (lifecycle.test.ts sync → async)
- DI #3/4/5 (costs, tickets, mcp-pool registrations)

P1s remaining after Batch 7 can batch by owner / domain at discretion. P2s are cosmetic — defer.

---

## Out of scope for this audit (deliberate)

- Performance tuning beyond obvious smells (router backpressure is in; general perf is out).
- Security deep-dive beyond what the lenses surface (no threat model, no dep audit).
- Build/CI/infra concerns.
- Feature work.

Each sub-agent stayed within 1500 words; this aggregate is longer because it consolidates 5 reports + adds cross-cutting analysis.
