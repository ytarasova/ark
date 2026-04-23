# Code Quality Audit — Round 3 (2026-04-24)

Follows on from `docs/2026-04-21-architectural-audit-hardcoded-rules.md` and `docs/2026-04-22-code-quality-audit.md`, the 7-batch round-2 remediation, and the 20+ commits between `d33c6e7a` (tenant-scope SCOPED) and `9073523e` (admin apikey dedup). Audited against branch `round-2-remediation-2026-04-23`.

**Read-only audit, no code changes.** 7 parallel sub-agents, each layer-scoped. Calibrated against both prior audits + the round-2 remediation so findings focus on **regressions, new-code-since-2026-04-23 gaps, and runtime correctness of the SCOPED DI fix**.

---

## Executive summary

**1 P0, 5 P1, 15+ P2.** Round 2's major closures mostly hold. Two gaps became visible this round that round 2 couldn't see because its focus was structural, not runtime:

### Fix NOW

**P0-1 — `compute-resolver.ts:28-33` bypasses tenant filter with raw SQL.** `resolveProvider` does `SELECT * FROM compute WHERE name = ?` with **no tenant predicate**. Compute PK is `(name, tenant_id)`, so two tenants holding the same compute name (`prod-gpu`, `ci-runner`) hit arbitrary row-order resolution. The downstream call exposes tenant A's provider + credentials + k8s config to tenant B's session. This is a **regression of round-2 P1-1**: batch 2's `a46f2737` moved executor fallback through `app.resolveProvider(session)`, but the underlying resolver itself was never promoted to go through the tenant-scoped repo.

### Top regressions / carry-overs worth calling out

- **Legacy `LocalProvider` is alive in production** (compute P1-1, new). `compute-providers-boot.ts:21` registers `new compute.LocalProvider()` — the legacy class at `packages/compute/providers/local/index.ts:52` whose `@deprecated` JSDoc claims `LocalWorktreeProvider` has taken over. `LocalWorktreeProvider` (also `name="local"`) isn't registered anywhere in production. Round 2's "dead deprecated providers" P2 triage silently invalidates.
- **Local-daemon WS doesn't rebuild router per tenant** (DI-backend P1-1, new). Hosted HTTP path at `packages/core/hosted/web.ts:347-351` rebuilds `Router + registerAllHandlers(rpcRouter, requestApp)` per non-default-tenant request, so handlers correctly close over the tenant-scoped `requestApp`. The local-daemon WS path at `packages/server/index.ts:84-110` dispatches through `this.router` whose handlers closed over root `app` at registration. In local single-user mode this is fine, but if any deployment points a multi-tenant client at the WS daemon, `session/*` RPCs write to default-tenant repos silently despite the SCOPED DI fix. Asymmetric.
- **`provider-registry._providerResolver` still root-bound** (core P1-1). Module-level singleton bound once to root app in `infra/service-wiring.ts:31`. Callers of the free `resolveProvider` from `provider-registry.ts` (currently `services/session-output.ts:22`) resolve through root regardless of tenant.
- **Duplicate `ApiKeyManager` import** in `packages/core/di/persistence.ts:27` and `:39` — introduced by batch 2's DI-2 refactor (`84c7837e`). Should have tripped an ESLint `no-duplicate-imports` rule; worth checking whether that rule is enabled.

### Healthy signals

- **Backend DI: healthy verdict.** Zero new module singletons, service-locators, or inline constructions since 2026-04-23. Runtime SCOPED verification — `tenant-scoping.test.ts` has all three required assertions and passes 31/31 (service identity per scope, `sessionLifecycle.start()` writes correct `tenant_id`, `sessionHooks` injected events repo carries scope's tenant).
- **Web transport cleanup: zero regressions.** All three greps for the deleted singleton patterns return 0.
- **Router Strategy pattern: zero `switch(provider.name)` in router code.** Custom policy + adapter registration proven end-to-end by tests.
- **Zod coverage 45%** (up from 33%). `admin/apikey/list` dedup + `session/inject` Zod + `sessionInterrupt` client/server contract all still in.

---

## Fitness scorecard

| Layer | SOLID | Tests | Clean | Layering | Ark inv. | **Overall** |
|---|---:|---:|---:|---:|---:|---:|
| Core + services | 4 | 4 | 4 | 4 | 3 | **4** |
| Server + arkd + protocol | 4 | 4 | 4 | 4 | 5 | **4** |
| Compute + router | 4 | 4 | 4 | 4 | 4 | **4** |
| Web | 4 | 2 | 4 | 4 | 5 | **4** |
| CLI | 3 | — | 4 | 4 | 5 | **3.5** |
| Tests | — | 4 | 3 | 4 | 5 | **3.8** |
| Backend DI (runtime) | — | 5 (31/31 pass) | — | 5 | 5 | **5** |
| Dependency hygiene | — | — | 2 | 3 | 4 | **3.0** |

Core drops to 3 on Ark invariants specifically because of P0-1 (tenant-isolation promise broken in one raw-SQL site). Web drops to 2 on test coverage (still 10 test files vs. 229 source files; design-system rebuild shipped zero tests).

---

## Findings by layer

### Core (1 P0 / 2 P1 / 2 P2)

**P0-1 — `compute-resolver.ts:28-33` cross-tenant provider resolution.** Details above. Fix: route through `app.computes.get(name)` (already tenant-scoped on `tenantApp`); drop the raw `app.db?.prepare` escape hatch. The `setProviderResolver(...)` bridge should pass the tenant-scoped `app` per call. **Regression of round-2 P1-1.**

**P1-1 — `provider-registry._providerResolver` root-bound.** `packages/core/provider-registry.ts:16` + `infra/service-wiring.ts:31`. Module singleton closes over root `AppContext`. Current sole reader: `services/session-output.ts:22`. Fix: delete the module singleton; have callers go through `app.resolveProvider(session)` with `app = app.forTenant(session.tenant_id)`. **Partial regression of round 2.**

**P1-2 — Duplicate `ApiKeyManager` import** in `packages/core/di/persistence.ts:27` and `:39`. Introduced in `84c7837e` (DI-2 batch). Fix: delete line 39; verify ESLint `no-duplicate-imports` is on.

**P2-1** — `packages/core/runtimes/agent-sdk/launch.ts:19-29` function declared mid-import-block. Cosmetic.

**P2-2** — `tenant-scope.ts:163-165` comment references a runtime check that has moved. Cosmetic doc drift.

**Healthy signal:** the new for_each dispatcher (`services/dispatch/dispatch-foreach.ts`) takes narrow `Pick<DispatchDeps, ...>`, writes checkpoints before side effects, restores via child-row scan. Uses injected (SCOPED) `sessions`/`events` repos. Example of the layer done right.

### Server + arkd + protocol (0 P0 / 0 P1 / 4 P2 — all pre-existing)

**P2-1** — Per-request `Router` allocation in hosted mode (`hosted/web.ts:347-351`). 242 handlers re-registered per HTTP call for non-default tenant. Cache per-tenant Routers in a bounded LRU (or push the scoped app down into `router.dispatch(req, notify, ctx, app)`). Pre-existing.

**P2-2** — `metrics-local.ts` has 8 `throw new Error` sites (lines 33, 38, 46, 54, 63, 65, 70) that `8ce7e536` RpcError sweep missed. Same in `scope-helpers.ts:68,70`. Local-only surface so blast radius is single-user boxes.

**P2-3** — `code-intel/health` returns global `tenantCount` regardless of caller (code-intel.ts:42-54). Inconsistency with peer handlers.

**P2-4** — `compute/provision` is 60 LOC of inline orchestration (`resource.ts:402-462`). Candidate for `computeService.provision(name)`.

Nothing new since 2026-04-23. Zod coverage **109/242 methods (45%)**, up from 33%. Biggest remaining uncovered families: admin/apikey/*, admin/team/*, admin/tenant/*, code-intel/*, session/* residual.

### Compute + router (0 P0 / 2 P1 / 9 P2)

**P1-1 (NEW) — Legacy `LocalProvider` is the live production "local" provider.** Details above. `compute-providers-boot.ts:21` registers it; `LocalWorktreeProvider` (the "replacement") isn't registered anywhere. Fix: promote `LocalWorktreeProvider` into boot and delete `LocalProvider`, OR strip the deprecation notice.

**P1-2 (carry-over, still open) — Dispatcher same-provider re-entry.** `packages/router/dispatch.ts:51-66` + `:104-117`. After primary fails (1 failure, breaker still closed — threshold 5), fallback filters by `m.tier === tier && m.id !== selected_model` only. Does not exclude `selected_provider`. Anthropic sonnet fails → fallback retries Anthropic haiku on the same breaker-closed Provider. Fix: add `provider.config.name !== selected_provider`.

**P2 findings (9)** — `Provider.doFetch` under-counts retry failures into breaker; `isRetryableStreamError` regex too permissive (matches "expected 500 tokens"); TensorZero bypasses Strategy + retry + breaker; Anthropic tool-call with zero arguments never emits `{id,type,name}`; `stripRouting` inconsistently called; `PolicyRegistry.resolve` silently falls back on typo; Google adapter key-in-URL log leak risk; SSE parsers reject `data:foo` no-space form; Anthropic adapter defaults `x-api-key` to empty string.

**Capability matrix verified:** all 12 concrete providers declare all 7 capability flags explicitly. `ArkdBackedProvider` sets `supportsSecretMount=false` default; `K8sProvider` overrides to `true`. Inheritance chain clean.

### Web (0 P0 / 2 P1 / 3 P2)

**P1-1 (NEW) — A11y regression propagated.** Prior audit flagged ComputeView only. Design-system rebuild propagated `<div onClick>` without keyboard into:
- `FlowsView.tsx:103-116`
- `AgentsView.tsx:120-140, 142-163`
- `ComputeView.tsx:208-226` (has role/aria-selected but no tabIndex/onKeyDown)
- `session/ErrorRow.tsx`

`SessionList.tsx:326-336` is the correct template (`role="button"`, `tabIndex={0}`, `onKeyDown`). Proposal: shared `<ListRow>` atom that bakes in keyboard semantics.

**P1-2 — `SessionsPage.tsx:56-78,89-118` hand-rolled polling.** Unread counts on `setInterval(10_000)`; flow-stage fan-out in imperative `useEffect`. Both should be TanStack queries with `refetchInterval`. Straggler from Batch 4 TanStack migration.

**P2-1 — Test surface stagnant.** 10 test files for 229 source files. Design-system rebuild (commits `535a675a`, `084031f4`, `3073acf1`, `1bfec85e`, `8a0d0468`, `c2f1f603` — ~17 new components) shipped zero tests. Zero render coverage for Dashboard, SessionsPage, ComputeView, FlowsView, AgentsView, KpiCard, FlowDag, DiffViewer.

**P2-2 — `useSmartPoll.ts` orphaned.** ComputeView migrated off it; no other reader. Delete.

**P2-3 — Mixed `api` source** in `SessionsPage.tsx:60-69` (pulls via `useSessions()` chain but also direct `useApi()`).

**Regression greps all return 0** (module `api` imports, singleton-transport patterns, `instanceof` transport). Batch 6 work locked in.

**Frontend DI reassessment:** unchanged — no new library. `TransportContext` + `AppModeProvider` + theme + `QueryProvider` cover all DI needs.

### CLI + Tests

**P1 CLI-1 — Status-icon/color map duplicated** in 4 sites (`session/view.ts:29-46`, `misc/pr.ts:24`, `conductor.ts:56`, ad-hoc `PASS/FAIL` strings). Round-2 P2; extract to `cli/formatters.ts`.

**P1 CLI-2 — `runAction` holdouts.** 42 sites migrated in round 2. ~12 holdouts remain: `agent.ts` (5), `recipe.ts` (3), `skill.ts` (2), `session/start.ts` (2), `session/view.ts` (2), `knowledge.ts` (2). All use `console.error + process.exit(1)` pattern. Blocker: `runAction` uses `exitCode=1` but some sites need immediate `process.exit(1)`. Needs a `runActionStrict()` variant.

**P1 TEST-1 — `withTestContext()` half-migrated.** 73 test files use the helper; 45 still hand-roll `forTestAsync+setApp+clearApp`. Miss the tmux snapshot/kill safety net in `test-helpers.ts:126,140`.

**P1 TEST-2 — 5 test files >700 LOC.** `agent-sdk-launch.test.ts` 1027, `search.test.ts` 778, `stage-validation-e2e.test.ts` 770, `rpc-validation.test.ts` 751, `claude.test.ts` 751. All above or near the 800-LOC soft ceiling.

**Regression greps:** 0 sync `AppContext.forTest()` live call sites, 0 port-binding collisions from hardcoded ports (62 string-literal fixtures are all legitimate assertion-expected defaults, not port-binding).

**Cross-cutting pattern:** partial migrations stall at 50-70%. `runAction` hit 42/~90, `withTestContext` hit 73/~120. Closing requires either extending the helper to cover remaining idiosyncratic cases, or opening a tracking issue per file.

### Backend DI (runtime verification)

**Verdict: healthy.**

- Zero new module singletons / service-locators / inline constructions since 2026-04-23.
- `tenant-scoping.test.ts` has all three required round-3 assertions; 31/31 tests pass.
- Hosted HTTP path verified to rebuild router against tenant-scoped `requestApp` for non-default tenants.
- No SINGLETONs that should be SCOPED. No SCOPED leaks across scopes.

**P1-1 — Local-daemon WS doesn't rebuild router per tenant.** Details above. Latent until a multi-tenant client connects to the WS daemon; hosted path is clean. Fix: either apply per-request router-rebuild to `ArkServer.addConnection`, or migrate handlers in `session.ts`, `history.ts`, `messaging.ts`, `conductor.ts` to `resolveTenantApp(app, ctx)`. `sage.ts`, `costs.ts`, `schedule.ts`, `triggers.ts`, `knowledge-rpc.ts` already follow the right pattern.

### Dependency hygiene (3.0/5)

**9 unused deps:** `e2b`, `liquidglass-tailwind`, `autoprefixer`, `mdast-util-gfm-table`, plus 8 unused `@radix-ui/react-*` primitives.

**Out-of-date pins:** `@types/react@^18.3.0` vs `react@^19.2.4` — major mismatch. `commander@^12` vs transitive `14`. Electron 33 vs current 34+.

**Dev/prod miscategorization:** `vite`, `@tailwindcss/vite`, `@vitejs/plugin-react` in `dependencies` — should be `devDependencies`.

**Stale `package-lock.json`** from 2025-03-21 (Bun-only repo). Delete.

**No `packageManager` field** despite CLAUDE.md Bun-only policy.

**Deps worth `bun audit`:** `nunjucks`, `postgres`, `@kubernetes/client-node`, `electron`, `redis`, `nodemailer`.

---

## Cross-cutting patterns

1. **Raw-SQL escapes bypass tenant scope** (P0-1). The DI `asFunction` factories in `tenant-scope.ts` scope `app.computes` correctly, but any caller that reaches for `app.db.prepare(...)` defeats the machinery. A grep-based CI rule (e.g. "no `db.prepare` outside `packages/core/repositories/` and `migrations/`") would catch this class of regression mechanically. This is the highest-leverage structural fix to add.

2. **Local vs. hosted dispatch asymmetry** (DI P1-1). Hosted HTTP rebuilds the router per request and threads tenant-scoped `app` into handlers. Local-daemon WS doesn't. Fine today because local = one tenant, but the asymmetry means the SCOPED DI tree is only consulted on the hosted path. Document the invariant explicitly, or make the two paths symmetrical.

3. **Root-singleton bridges (`provider-registry`, `hooks.eventBus`) remain as back-compat seams.** Surviving only because callers happen to be tenant-homogeneous or use tenant-id args. Any new caller with cross-tenant traffic needs the scoped `app` instead.

4. **"Deprecated but still used" classes.** `LocalProvider` is the canonical case: JSDoc says "replaced by LocalWorktreeProvider," production boot still registers it. Follow-up: run a grep for every `@deprecated` marker and verify the replacement actually took the seat.

5. **Partial migrations stall at 50-70%.** `runAction` 42/~90, `withTestContext` 73/~120, TanStack query 90%+ but `SessionsPage` stragglers. Each has a clear closure path; the stall is usually one-off idiosyncratic cases that need a variant helper (e.g. `runActionStrict`).

6. **A11y regressions propagate through design-system rebuilds.** Prior audit flagged ComputeView; rebuild spread the `<div onClick>` pattern into FlowsView, AgentsView, ErrorRow. Shared `<ListRow>` atom is the fix; without it, every new list repeats the bug.

7. **Test coverage growing O(1) while views grow O(N).** Web is the headline (10 test files, 229 sources, 17+ new components shipped without tests). CLI shows the opposite pattern (test count scaling with new commands). Worth explicit per-layer coverage targets.

---

## Recommended remediation batches

**Batch 1 (security-critical, ship today):**
- Core P0-1 — route `compute-resolver` through `app.computes.get(...)`, drop raw SQL
- Add CI grep rule: no `db.prepare` outside `packages/core/repositories/` and `migrations/`

**Batch 2 (DI tightening):**
- Core P1-1 — delete `provider-registry._providerResolver`; callers go through `app.forTenant(...).resolveProvider(session)`
- Core P1-2 — delete duplicate `ApiKeyManager` import; verify/add `no-duplicate-imports` ESLint rule
- DI-backend P1-1 — decide: rebuild router per-request in WS path, OR migrate remaining `session.ts`/`history.ts`/etc. handlers to `resolveTenantApp(app, ctx)`

**Batch 3 (compute correctness):**
- Compute P1-1 — promote `LocalWorktreeProvider` into boot; delete `LocalProvider` or strip deprecation marker
- Compute P1-2 — dispatcher fallback excludes same-provider

**Batch 4 (web resilience + a11y):**
- Web P1-1 — shared `<ListRow>` atom; migrate FlowsView/AgentsView/ComputeView/ErrorRow
- Web P1-2 — `SessionsPage` unread-counts + flow-stage to TanStack
- Web P2-1 — render tests for at least the 5 top-level views (Dashboard, Sessions, Compute, Flows, Agents)

**Batch 5 (migration closure):**
- CLI P1-2 — `runActionStrict()` variant + close the 12 remaining holdouts
- Tests P1-1 — migrate the 45 hand-rolled tests to `withTestContext()`
- Tests P1-2 — split the 5 >700-LOC test files

**Batch 6 (dep hygiene):**
- Bump `@types/react` to `^19`
- Delete 9 unused deps + stale `package-lock.json`
- Move `vite` + plugins to `devDependencies`
- Add `packageManager` field

**Batch 7 (hygiene finish):**
- Server P2-2 — `metrics-local.ts` + `scope-helpers.ts` `throw new Error` → `RpcError`
- Compute P2-* — SSE parser `data:` no-space, `isRetryableStreamError` tightening, `PolicyRegistry` fail-fast
- Core P2-1 + P2-2 — move mid-import function, fix comment drift

---

## Out of scope (deliberate)

- Performance tuning beyond smells.
- Security deep-dive beyond tenant-isolation + credential handling.
- Feature work.
- Build / infra / CI concerns (CI-grep rule addition IS in-scope — small hygiene improvement).

---

## Files referenced (the short list)

- `packages/core/compute-resolver.ts:28-33` — P0-1
- `packages/core/provider-registry.ts:16`, `infra/service-wiring.ts:31`, `services/session-output.ts:22` — P1-1 core
- `packages/core/di/persistence.ts:27,39` — P1-2 core
- `packages/compute/providers/local/index.ts:44-51,52` — P1-1 compute
- `packages/core/infra/compute-providers-boot.ts:21` — P1-1 compute
- `packages/router/dispatch.ts:51-66,104-117,143-170` — P1-2 compute
- `packages/server/index.ts:84-110,328-366` — P1-1 DI backend
- `packages/web/src/components/FlowsView.tsx:103-116`, `AgentsView.tsx:120-163`, `session/ErrorRow.tsx` — P1-1 web
- `packages/web/src/pages/SessionsPage.tsx:56-78,89-118` — P1-2 web
- `package.json:58,59,50,62` (unused deps) + `:70,90` (React version mismatch) — dep P1

---

## Sub-agent sign-off

All 7 audit agents completed:
- `audit-core` (core services + DI)
- `audit-server-arkd` (server handlers, arkd, protocol)
- `audit-compute-router` (compute providers, router post-Strategy)
- `audit-web` (React, hooks, contexts, TanStack adoption, a11y)
- `audit-cli-tests` (CLI structure, test design, fixture hygiene)
- `audit-di-backend` (DI coverage + runtime SCOPED verification)
- `audit-deps-fitness` (package.json hygiene, unused deps, version pins, CVE surface)

Every report followed the prescribed format; no agent failed to complete.
