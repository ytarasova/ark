# Ark Codebase Audit -- Consolidated Plan

Synthesizes the 8 parallel agent reports (1–8 in this directory). Read the
per-agent files for full evidence; this doc is the prioritized action plan.

## Headline

Ark has a solid skeleton (Awilix already present, provider interfaces in place,
working e2e/smoke CI, `SessionLauncher` port as a precedent) but the flesh
betrays years of expedient choices: core "services" are thin procedural wrappers
around direct `fs`/`child_process`/`tmux`/`ssh`, the domain is anemic, tenant
isolation has **critical holes** (spoofable tenant header, path traversal,
arkd exposes host-wide file I/O), observability is three disjoint fragments
with no metrics layer, and the web bundle ships at **449 KB gz** -- 50% over
budget -- because nothing is code-split. The hex-architecture migration the
stack already wants is the correct unifying move; it is also the only move
that makes the control-plane deployment genuinely safe.

## Severity Roll-up

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| 1 -- SOLID / hex | 9 | 14 | 11 | 5 |
| 2 -- tests | (see report) | | | |
| 3 -- security | 3 | ~6 | ~10 | ~6 |
| 6 -- build-vs-buy | -- | 3 adopt | 2 hybrid | 9 keep |
| 7 -- observability | 3 | 9 | 8 | 4 |
| 8 -- a11y | 3 | ~8 | ~10 | ~5 |

**Top cross-cutting themes (appear in 3+ reports):**
1. **Unabstracted I/O in `packages/core/services/*`** -- Agents 1, 3, 4, 7 all flag it.
2. **No correlation IDs end-to-end** -- Agents 3, 7 (tenant/session scoping missing from logs, events, metrics).
3. **Tests that don't test behavior** -- Agent 2 (source-grep asserts), Agent 4 (forTest() boots real fs/SQLite), Agent 8 (zero a11y e2e).
4. **Primitive obsession + anemic domain** -- Agents 1, 4 (SessionId/TenantId/Workdir as `string`; Session as record).

## Priority 1 -- Security / tenant isolation (SHIP THIS WEEK)

These are live vulnerabilities, not tech debt. Cannot merge more features until addressed.

| # | Finding | Location | Fix Scope |
|---|---|---|---|
| P1-1 | **Spoofable tenant identity.** `extractTenantId` accepts `X-Ark-Tenant-Id` header or Bearer token prefix without validating against `api_keys`. | `packages/core/conductor/conductor.ts:73-82` | S -- reject unauthenticated tenant headers; require token-to-tenant lookup. |
| P1-2 | **Cross-tenant leak in REST fallback.** `handleRestApi` reads `_app.sessions.list()` (module-global, default tenant) with no scoping. | `packages/core/conductor/conductor.ts:247-268` | S -- route through tenant-scoped context. |
| P1-3 | **Attachment path traversal.** `writeFileSync(join(attachDir, att.name), ...)` with user-controlled name. | `packages/core/services/workspace-service.ts:110-120` | S -- `basename()` the name and reject any `..`. |
| P1-4 | **arkd exposes host FS.** `/file/read`, `/file/write`, `/file/mkdir`, `/file/list`, `/exec` accept absolute paths; only a shared bearer token auths. | `packages/arkd/server.ts:229-284` | M -- confine to a per-session root; reject escapes. |
| P1-5 | **SSH command injection.** Seven sites in `compute/providers/ec2/sync.ts` + `agent-launcher.ts` interpolate vars into shell strings. | `packages/compute/providers/ec2/*` | M -- switch interpolation to `execFile`-style arg arrays; ban template strings in `sshExec`. |
| P1-6 | **yaml CVE affects runtime.** `yaml@2.0.0–2.8.2` parses agent/flow configs. | `bun.lock` | S -- bump via `npm audit fix`; verify no breaking changes. |

**Add deny-path e2e tests alongside each fix** (Agent 3 flagged the absence of deny-path coverage; every P1 fix ships with one).

## Priority 2 -- Hex migration Slice 1 (foundational)

This is the single highest-leverage architectural move. It unblocks almost every
finding in Agents 1, 4, 7. **Start next week, one vertical slice at a time** --
do not try to boil the ocean.

1. **Define `ProcessRunner` + `Workspace` ports** in `packages/core/ports/`.
2. **Write `LocalProcessRunner` + `LocalWorkspace` adapters.** Move direct spawn/fs calls out of `session-lifecycle.ts`, `stage-orchestrator.ts`, `workspace-service.ts` behind these ports.
3. **Introduce `LocalBindings` / `ControlPlaneBindings` / `TestBindings` modules.** Replace the `!!config.databaseUrl` branch in `app.ts:490` with a composition-root swap.
4. **Add ESLint `no-restricted-imports`** on `packages/core/domain/**` and `packages/core/services/**` to block `fs` / `child_process` / `bun:sqlite` / `../infra/tmux*`. Makes the next regression impossible rather than just catchable.
5. **Replace `AppContext.forTest()`** with `buildTestContainer()` -- tests stop needing a real filesystem and real SQLite.

Agent 4's `4-di-adr.md` + `4-di-plan.md` is the implementation spec. PR size per slice: 200–400 LOC.

## Priority 3 -- Quick wins (parallel track with P2)

Low effort, high user-visible value. Don't block on P2.

| # | Finding | Action | Effort |
|---|---|---|---|
| P3-1 | Web bundle 449 KB gz over 300 KB budget | `React.lazy` + dynamic imports for `@xyflow/react`, `recharts`, `@xterm/xterm` -- should drop to ~200 KB gz. Agent 6. | S |
| P3-2 | `Math.random().toString(36).slice(2,6)` for ledger IDs (collision-prone, non-crypto) | `nanoid(10)`; also widen session-ID entropy (currently 6 hex). Agent 6. | S |
| P3-3 | Toasts invisible to screen readers | Add `role="alert"` + `aria-live="polite"` in `Toast.tsx:23`. Agent 8. | S |
| P3-4 | No focus trap / focus restore in any overlay | Adopt `@radix-ui/react-dialog` primitives (already used elsewhere) on `modal.tsx`, `DetailDrawer.tsx`, `ComputeDrawer.tsx`, `CommandPalette.tsx`, `NewSessionModal.tsx`. Agent 8. | M |
| P3-5 | Primary button contrast fails WCAG AA on warm-obsidian light theme (2.7:1) | Recompute fg/bg in `tokens.ts:327-330`. Agent 8. | S |
| P3-6 | MarkdownContent regex parser -- XSS-adjacent, lacks tables/blockquotes | Swap for `react-markdown` + `rehype-sanitize`. Agent 6. | M |
| P3-7 | 26 `api.*` call sites import a module-level fetch singleton | Introduce `WebTransport` interface + `TransportProvider` context (no DI library). Agent 5. | M |
| P3-8 | Zero test mocks on frontend | Add `MockTransport` alongside the context above. Agent 5. | S |
| P3-9 | JSON-RPC boundary validation is ad-hoc, handlers typed `any` | Adopt Zod; register per-method schemas; interlocks with P2 and with frontend type imports from `packages/protocol`. Agent 1, 6. | M |

## Priority 4 -- Architectural depth (medium-term)

These belong on a quarter-level roadmap. Each depends on P2 landing first.

- **Branded value objects.** `SessionId`, `TenantId`, `Workdir`, `RepoPath`, `Stage` as branded types with validation at adapter boundaries. Agent 1.
- **Domain extraction.** Promote `Session` from record to aggregate -- state machine, invariants, transitions as methods. Agents 1, 4.
- **Logger / Tracer / Metrics ports.** Replace module-singleton `structured-log.ts` + `otlp.ts`. Introduce a real metrics layer (Prometheus-compatible, bounded cardinality). Propagate `traceparent` across RPC boundaries. Agent 7.
- **Correlation IDs everywhere.** `logForSession(sessionId, ...)` helper; every log line carries `{tenantId, sessionId, traceId}`. Agent 7.
- **Continue hex slices 2–5.** `agent-launcher` + `SessionLauncher`; `stage-orchestrator` + Clock/Logger; composition root; SecretStore. Agent 4.

## Priority 5 -- Testing discipline (continuous)

- **Delete the source-grep tests** in `packages/web/src/__tests__/`. They pass on broken refactors. Replace with DOM render tests using `MockTransport` where genuine behavior matters; let e2e carry user-facing behavior. Agent 2.
- **Add direct tests for the 7 decomposed services** (`session-lifecycle`, `stage-orchestrator`, `agent-launcher`, `workspace-service`, `task-builder`, `session-hooks`, `session-output`). Today zero direct coverage; all reachable only through tmux+fs integration. Blocked until P2 Slice 1 lands (need port mocks). Agent 2.
- **Tag `@integration` tests** that need real tmux / real fs; split from the default CI run. Agent 2, 4.
- **Add a11y e2e invariants** (3): overlay focus discipline, keyboard-only nav with `aria-current`, toast `role="alert"`. Agent 8.
- **Fix untracked `test.skip()`.** 4+ skipped without issue links. Agent 2.
- **Kill the duplicate e2e dir** `packages/web/e2e/session-view.spec.ts` (hard-codes :5173, uses runtime `test.skip(true, ...)` for missing fixtures). Migrate into `packages/e2e/web/` using `setupWebServer` fixture. Agent 2.

## Priority 6 -- Observability follow-up

- Metrics layer (Prometheus endpoint on conductor, SLO-candidate series per Agent 7's proposal).
- Checked-in Grafana dashboards + PrometheusRules under `.infra/helm/ark/`.
- 50+ raw `console.error` sites → structured logger with correlation fields. Agent 7.
- Dispatch path (`server/router.ts:31`) unspanned -- add span. Agent 7.
- No W3C `traceparent` propagation across JSON-RPC boundary -- add on both client and server. Agent 7.

## What NOT to do

- **Do not introduce a frontend DI library.** Context + `WebTransport` is enough. Agent 5.
- **Do not rewrite the flow runner.** Home-brew semantics don't map to off-the-shelf DAG libs. Agent 6.
- **Do not swap `ssh2` for the current `ssh` CLI wrapper.** Stack is already fragile; migration risk > upside. Agent 6.
- **Do not boil the hex migration in one PR.** Slice 1 first, end-to-end (domain + port + adapter + tests in one vertical). Agent 4.
- **Do not `admin --merge` past red e2e / smoke again.** This is now a non-negotiable per the mandate.

## Dependency Graph

```
P1 (security) ─────────────────────────────────► ship anytime
    │
    ▼
P2 (hex Slice 1) ─► P3-7 (WebTransport) ─► P3-8 (MockTransport)
    │            ─► P3-9 (Zod at boundary)
    │            ─► P4 (branded types, domain, Logger/Tracer ports)
    ▼
P5 (real service unit tests)

P3 quick wins (1..6) run in parallel with everything
P6 observability mostly depends on P4 Logger/Tracer ports
```

## Suggested Sprint Breakdown

**Sprint 1 (this week):** P1-1 .. P1-6. No other work.
**Sprint 2:** P2 Slice 1 (session-lifecycle + ProcessRunner + Workspace ports + TestBindings). Parallel: P3-1, P3-2, P3-3, P3-5.
**Sprint 3:** P2 Slice 2 (agent-launcher + SessionLauncher consolidation). Parallel: P3-4, P3-6, P3-7, P3-8, P3-9.
**Sprint 4:** P2 Slice 3 (stage-orchestrator + Clock + Logger ports). Parallel: P5 test cleanup, P6 correlation IDs.
**Sprint 5:** P2 Slice 4 (composition root + binding modules). Parallel: P4 branded types + domain extraction kickoff.
**Sprint 6:** P2 Slice 5 (SecretStore + Tracer). Parallel: P6 metrics layer, dashboards, alerts.

## Done Criteria

Audit "complete" when:
- All P1 findings have PRs merged with deny-path e2e tests.
- ESLint boundary rules are in place; no file in `packages/core/domain/**` or `services/**` imports `fs` / `child_process` / `bun:sqlite`.
- `AppContext.forTest()` is a deprecated shim over `buildTestContainer()`.
- `ControlPlaneBindings` exists with stubs tracked by issue; hosted CI exercises every stub path.
- Web bundle initial JS < 300 KB gz (verified by bundle analyzer in CI).
- Every log line in `services/` carries `tenantId` + `sessionId`.
- `packages/web/src/__tests__/*.test.ts` source-grep tests are gone.
- Overlay focus-trap e2e invariant is green in CI.
