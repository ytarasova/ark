# Agent 7 -- Observability Audit

## Summary
Ark has three partial observability surfaces -- a JSONL logger (`structured-log.ts`), a minimal OTLP span exporter (`otlp.ts`), and two disjoint "telemetry"/"observability" buffers -- but **no metrics layer, no hexagonal Logger/Tracer/Metrics ports, no correlation-id propagation at the JSON-RPC boundary, and no dashboards or alerting**. Logging is bypassed by 50+ production sites that call `console.error` directly. Tracing covers only the happy-path session/stage lifecycle; RPC handlers, SSH adapters, arkd probes, compute provisioning, and LLM router calls emit no spans. Multi-tenant correlation is not enforced: no `logWarn`/`logError` call in production carries `tenantId`, and metric-like state is buffered in module globals, so control-plane deployment will lose signal across replicas. This is v0.5-appropriate for a single-tenant dev tool but insufficient for a multi-tenant control plane.

## Severity Distribution
Critical: 3 · High: 9 · Medium: 8 · Low: 4

## Logging

### Taxonomy
No taxonomy / registry. Components are a fixed union (`session | conductor | mcp | status | web | bridge | pool | compute | general`) at `packages/core/observability/structured-log.ts:8-17`, but message strings are ad-hoc free-form (e.g. `"stage handoff failed for <id>: ..."`, `"instance-lock: heartbeat update failed: ..."`). There is no event-name enum, no schema for the `data` payload, and callers mix template strings with structured `data` inconsistently (`stage-orchestrator.ts:939` uses structured fields, `conductor.ts:835` interpolates into the message). The `LogComponent` union does not include `"plugins"` or `"handoff"` even though callers pass those strings (`app.ts:609`, `session-hooks.ts:665`) -- TypeScript permits this only because `strict: false`.

### Findings
| ID | Severity | File:Line | Issue | Fix |
|----|----------|-----------|-------|-----|
| L1 | Critical | `packages/core/observability/structured-log.ts:86-106` | Singleton module state (`_level`, `_components`, `_arkDir`). Not injectable; tests can't swap; multi-tenant deployments share one log file. Violates hex. | Define `Logger` port; inject via `AppContext`; JSONL/console adapters. |
| L2 | High | 50+ sites -- e.g. `packages/core/claude/claude.ts:154,176,406,485,586,620,735,757,854`; `claude/sessions.ts:187,250,278,311,328,342,351,370,381`; `mcp-pool.ts:119,127,234,298,353`; `integrations/bridge.ts:56,81,98,114,204,237`; `tools.ts:49`; `hooks.ts:66,84,91`; `state/ui-state.ts:52`; `stores/skill-store.ts:43`; `stores/recipe-store.ts:44`; `router/tensorzero.ts:161,166`; `infra/notify-daemon.ts:98`; `hosted/web.ts:452-455`; `hosted/sse-bus.ts:88`; `observability.ts:55`; `compute/providers/ec2/*.ts`; `protocol/transport.ts:172,187`; `router/server.ts:67-194`; `router/dispatch.ts:36-168` | `console.error` / `console.warn` in production code. Bypasses `_level`/`_components` filters, never reaches `ark.jsonl`, not correlated by session/tenant. | Replace each site with `logError(component, msg, {sessionId, tenantId, err})`; add ESLint `no-console` rule with exceptions for CLI entry. |
| L3 | Critical | Every `logError`/`logWarn` in `services/*`, `conductor/conductor.ts`, `infra/instance-lock.ts`, `executors/status-poller.ts` | **No `tenantId` ever passed to the logger** (grep confirms zero matches in log call sites). Session id passed only as free-form string interpolation in message, not in the `data` field. Unsearchable in a multi-tenant log aggregator. | Add mandatory `{tenantId, sessionId}` to all log calls; enforce via wrapper `logForSession(session, level, msg, data)`. |
| L4 | High | `packages/core/observability/structured-log.ts:102` | `appendFileSync` on every log entry -- sync I/O on the hot path of conductor + stage orchestrator. | Buffered async write or background flusher. |
| L5 | High | `packages/core/conductor/conductor.ts:835,899,912`; `services/workspace-service.ts:150,162,173,683,732`; `services/session-lifecycle.ts:191,260,265,531,536` | Errors logged as `${e?.message ?? e}` -- loses stack trace, and if the error includes env dumps (e.g. git/ssh child_process errors) may leak secrets. | `err: {message, stack, code}`; strip env; structured fields only. |
| L6 | Medium | `packages/core/services/workspace-service.ts:460,513,683,732` | Git rebase/worktree errors stringified -- may include file paths under `/Users/<username>/…`, branch names, remote URLs (PII / repo leakage in shared log). | Redact home dir; log repo id instead of path. |
| L7 | Medium | `packages/compute/providers/ec2/provision.ts:320-342`, `remote-setup.ts:135`, `ssh.ts:99-109` | EC2 provisioning errors `console.error`'d with full message -- may surface AWS credentials, security-group ids, instance ids, IPs. | Route through logger; redact IPs / instance ids in non-debug mode. |
| L8 | Medium | `packages/core/observability/structured-log.ts:8-17` | `LogComponent` union is closed; callers pass `"plugins"`, `"handoff"`, `"session_id"` (`app.ts:609`, `session-hooks.ts:665,730,739`) -- slips past because of `strict: false`. | Open-ended `string` with registry, or extend union; document taxonomy. |
| L9 | Medium | Whole codebase | No request-id / correlation-id concept. `JsonRpcRequest.id` exists but is never stamped into logs or spans. | Generate `correlationId` on RPC ingress, thread through `AsyncLocalStorage`. |
| L10 | Low | `packages/core/observability/structured-log.ts:103-105` | `catch {}` swallows log errors silently -- can't detect disk-full / permission issues. | Emit once to `process.stderr` via `console.error` if write fails (ok here). |

## Tracing

### Current spans
- `startSpan` / `endSpan` -- low-level OTLP primitives (`packages/core/observability/otlp.ts:65,85`).
- `emitSessionSpanStart` / `emitSessionSpanEnd` -- session root span (`otlp.ts:168,190`), callers: `services/session-lifecycle.ts:146,285`.
- `emitStageSpanStart` / `emitStageSpanEnd` -- stage child span (`otlp.ts:214,238`), callers: `services/stage-orchestrator.ts:584-736` (5 sites), `services/session-lifecycle.ts:153,284`, `conductor/conductor.ts:204`.
- `getSessionTraceId` read -- zero callers in non-test code. Trace id is generated but never propagated to logs, RPC responses, or children.

### Gaps
| ID | Severity | File:Line | Missing Span / Attribute | Fix |
|----|----------|-----------|--------------------------|-----|
| T1 | Critical | `packages/server/router.ts:19-50` | **No span per RPC dispatch.** Every handler call in `server/handlers/*` executes unspanned. P95 latency, error rate per method -- invisible. | Wrap `Router.dispatch` with a span; attributes: `rpc.method`, `rpc.id`, `tenant.id`, `session.id` from params. |
| T2 | High | `packages/server/index.ts:31-145` | No trace-context extraction from the JSON-RPC envelope. `traceparent` is never read or injected. Traces dropped at client→server boundary. | Accept optional `traceparent` in request meta; use as parent when starting RPC span. |
| T3 | High | `packages/compute/providers/ec2/*.ts`, `arkd/client.ts`, `compute/providers/arkd-backed.ts` | arkd probes, SSH exec, rsync push/pull, EC2 provision/terminate -- none spanned. Adapter calls are the #1 source of latency in remote compute (see MEMORY `project_remote_channel.md`). | Span each `arkd` request, each `ssh.exec`, each `provision`/`terminate`; attributes: `compute.id`, `compute.provider`, `arkd.endpoint`. |
| T4 | High | `packages/core/executors/status-poller.ts`, `packages/core/conductor/channel.ts` | Status polling and channel message delivery -- no spans. Hard to trace "why did the session hang". | Span per poll tick with `session.id`; span per channel receive. |
| T5 | High | `packages/router/dispatch.ts:36-168` | LLM router (cascade, fallback) emits `console.error` only. Each upstream call should be a span with `llm.model`, `llm.provider`, `llm.tokens.in/out`. | Wrap dispatch + each provider attempt in spans. |
| T6 | High | `packages/core/observability/otlp.ts:28-32` | **All span state lives in module globals** (`_config`, `_active`, `_buffer`, `_sessionTraces`). Not injectable; multi-tenant control-plane replicas share state; tests leak. | Define `Tracer` port; `AppContext.tracer`; implement in-memory + OTLP adapters. |
| T7 | High | `packages/core/observability/otlp.ts`, all callers | No async context propagation -- `AsyncLocalStorage` not used, so spans started in one async chain can't be picked up by children. `startSpan` requires explicit `parentSpanId`. | Introduce `tracer.withSpan(name, attrs, fn)` that sets ALS context. |
| T8 | Medium | `packages/core/observability/otlp.ts:140-158` | `flushSpans` is fire-and-forget (`catch {}`), no retry, no backpressure, no shutdown hook. Spans lost on crash. | Flush on `app.shutdown()`; retry once with jitter. |
| T9 | Medium | `otlp.ts:168-186` | Session span has no `tenant.id` attribute. Stage spans have no `compute.id`, `runtime`, `flow`. | Add attributes from `Session` at emit time. |
| T10 | Medium | `otlp.ts:58-60`, `:176` | Trace id = `genId() + genId()` (16 hex bytes). Spec-compliant but opaque -- no session-id encoding -- cannot reverse to session for log correlation. | Log the trace id alongside `session_id` in `session/updated` notifications. |
| T11 | Low | `otlp.ts:214-236` | `emitStageSpanStart` silently ends the previous stage span without a status -- looks "completed" even if it was abandoned. | Require explicit status; warn if auto-closing. |

## Metrics

### Current state
**Missing as a first-class layer.** No counter / histogram / gauge primitive in `packages/core/observability/`. The name "metrics" appears only as a compute-provider method `getMetrics(compute)` returning a one-shot CPU/mem snapshot (`server/handlers/metrics.ts:13-22`) and a UI sparkline (`packages/web/src/components/compute/MetricSparkline.tsx`). Cost tracking (`UsageRecorder`, `PricingRegistry`) is the closest thing to time-series -- per-session token usage is recorded to SQLite (`observability/usage.ts`) -- but it is not exposed to a scrape endpoint and is not labelled for Prometheus. `telemetry.ts` is a 100-event in-memory ring buffer, opt-in, never flushed in prod.

No `/metrics` Prometheus endpoint anywhere. No histograms. No counters.

### Proposed SLO candidates
| SLO | Target | Metric | Source |
|-----|--------|--------|--------|
| RPC p95 latency | < 250ms | `ark_rpc_duration_seconds{method,code}` histogram | `server/router.ts:dispatch` |
| Session dispatch latency | p95 < 5s | `ark_session_dispatch_seconds{flow,provider}` histogram | `session-lifecycle.ts:spawn` → first stage ready |
| Stage success rate | > 97% rolling 1h | `ark_stage_total{stage,status}` counter | `stage-orchestrator.ts` |
| Arkd probe success | > 99% | `ark_arkd_probe_total{result,provider}` counter | `arkd/client.ts` |
| Handler error rate | < 1% | `ark_rpc_errors_total{method,code}` counter | `server/router.ts` |
| Queue depth | < 50 per provider | `ark_compute_queue_depth{provider}` gauge | `compute/providers/ec2/queue.ts` |
| Compute provisioning time | p95 < 90s | `ark_compute_provision_seconds{provider,result}` histogram | `compute/providers/*/provision` |
| SSH pool reuse | > 80% | `ark_ssh_pool_hits_total{result}` counter | SSH pool (per MEMORY `project_ssh_pool.md`) |
| OTLP export success | > 99% | `ark_otlp_export_total{result}` counter | `otlp.ts:flushSpans` |

Label hygiene rule: **never** label with `sessionId`, `tenantId`, `traceId`, user strings. Use them as exemplars / trace links instead.

## Correlation IDs
- **`tenantId`** flows through `AppContext`, usage records, API-keys auth (`auth/middleware.ts:27`), schema (`schema.ts`) -- but **never** into `logError`/`logWarn` data or span attributes. Evidence: zero grep hits for `tenantId` in any log call site in `services/`, `conductor/`, `infra/`.
- **`sessionId`** appears in log messages as free-form interpolation (`conductor.ts:835`: `` `stuck recovery advance failed for ${s.id}: ...` ``) -- not searchable as a structured field except in 3 call sites (`stage-orchestrator.ts:939,958`, `session-hooks.ts:286`, `session-lifecycle.ts:191`). Dropped in ~90% of error paths.
- **Trace id → session id**: `_sessionTraces` map (`otlp.ts:162`) keyed by sessionId, but trace id is never exposed to the log line, the RPC response, or the `session.events` stream. Impossible to pivot from a Grafana trace back to a log or vice versa.
- **JSON-RPC request id**: never logged, never propagated to downstream spans.
- **Cross-process**: conductor ↔ server daemon ↔ arkd -- no `traceparent` header. Each hop starts a fresh, disconnected trace.

## Findings (rolled up)
| ID | Severity | File:Line | Category | Title | Evidence | Proposed Fix | Effort |
|----|----------|-----------|----------|-------|----------|--------------|--------|
| F1 | Critical | `observability/structured-log.ts:86` | `observability-gap` | No Logger port | Module singleton, not injected | Define `Logger` interface, inject via `AppContext` | M |
| F2 | Critical | 50+ sites (see L2) | `console-log` | `console.*` in production | grep above | ESLint `no-console` + replace calls | M |
| F3 | Critical | All `log*` sites in services/conductor | `correlation-missing` | No `tenantId`/`sessionId` in structured data | grep: 0 hits for tenantId in log data | `logForSession` helper; lint rule | M |
| F4 | Critical | `server/router.ts:31` | `span-drop` | RPC boundary unspanned | Dispatch has no span; no traceparent | Wrap dispatch; accept/emit W3C traceparent | M |
| F5 | Critical | Whole repo | `no-metrics` | No metrics layer | No counter/histogram/gauge exists | Introduce `Metrics` port + Prometheus `/metrics` | L |
| F6 | High | `otlp.ts:28-32` | `observability-gap` | Tracer state in module globals | `_active`, `_buffer`, `_sessionTraces` | `Tracer` port; per-AppContext instance | M |
| F7 | High | `otlp.ts` + callers | `span-drop` | No AsyncLocalStorage context | All spans need explicit parent | Add ALS-based `withSpan` | M |
| F8 | High | `arkd/client.ts`, `compute/providers/ec2/*`, `router/dispatch.ts` | `span-drop` | Adapter calls unspanned | No `startSpan` in these files | Instrument each adapter call | L |
| F9 | High | `workspace-service.ts:150+`, `ec2/provision.ts:320+` | `secret-in-log` | Raw `${err.message}` may leak secrets/paths | Stringified errors, no redaction | Redact; structured `err` field | S |
| F10 | High | `hosted/web.ts:452-455`, `hosted/sse-bus.ts:88` | `console-log` | `console.warn` in hosted control-plane | Lines above | Use logger | S |
| F11 | Medium | `observability/structured-log.ts:102` | `observability-gap` | Sync I/O on log hot path | `appendFileSync` | Async buffered writer | M |
| F12 | Medium | Whole repo | `observability-gap` | No event-name registry | Free-form log messages | Add `events.ts` enum | S |
| F13 | Medium | `.infra/helm`, `.infra/k8s` | `observability-gap` | No dashboards / alert rules checked in | Chart has deployment/service only | Add Grafana JSON + PrometheusRule CRDs | M |
| F14 | Medium | `otlp.ts:140-158` | `observability-gap` | Spans lost on crash; no shutdown flush | `catch {}`, no hook | Flush on shutdown; retry once | S |
| F15 | Medium | `otlp.ts:168-186` | `correlation-missing` | Session span missing `tenant.id` | Attributes list | Add to emit call | S |
| F16 | Medium | `protocol/transport.ts:172,187` | `console-log` | Parse errors gated on `ARK_DEBUG` only | Two lines | Logger at debug level | S |
| F17 | Medium | `observability.ts:55` vs `telemetry.ts` vs `otlp.ts` | `observability-gap` | Three parallel "observability" buffers with no unified API | Three files, three shapes | Collapse behind one `Tracer`/`Events` port | M |
| F18 | Low | `structured-log.ts:103-105` | `observability-gap` | Silent `catch {}` on log write | Line 103 | Fallback to stderr | S |
| F19 | Low | `otlp.ts:58-60` | `observability-gap` | 16-hex traceId not linked back to session id anywhere surfaced | `genId() + genId()` | Include traceId in `session/updated` notification | S |
| F20 | Low | `otlp.ts:214-236` | `observability-gap` | `emitStageSpanStart` silently auto-closes prior span | Lines 224 | Require explicit end | S |
| F21 | Low | e2e path | `observability-gap` | e2e failures hard to reconstruct -- no structured log dump, no trace artifact | Tests in `packages/compute/__tests__/e2e-compute.test.ts` rely on console + sqlite | Collect `ark.jsonl` + span buffer as test artifact on failure | S |

## Top 5 Observability Bets
1. **Define Logger / Tracer / Metrics ports** in `packages/types` and inject via `AppContext`. Implement 3 adapters each (console/noop/jsonl for logger; in-memory/otlp for tracer; in-memory/prometheus for metrics). Unblocks every other finding. Effort: M.
2. **Make every log line multi-tenant searchable.** Introduce `logForSession(session, level, event, data)` that auto-stamps `{tenantId, sessionId, correlationId}`. Add ESLint rule banning `console.*` outside `packages/cli/*` and test files. Retrofit the 50+ offenders. Effort: M.
3. **Span the RPC boundary + W3C traceparent propagation.** Wrap `Router.dispatch`; read `traceparent` from an optional request meta field; emit it in responses. Instrument `arkd/client.ts`, `router/dispatch.ts`, `ssh` exec, `ec2/provision`. One end-to-end trace from CLI → conductor → arkd → provider. Effort: M.
4. **Ship a real metrics layer.** `/metrics` Prometheus endpoint on the server daemon. Ten SLO-candidate series (table above), zero high-cardinality labels, session/tenant as trace exemplars only. Effort: L -- but unblocks the SLO column.
5. **Ship Grafana dashboards + Prometheus alert rules in `.infra/helm/ark/templates/`.** Even minimal ones (RPC error rate, arkd probe success, session dispatch p95) transform v0.5 into something the on-call can defend. Effort: S once #4 lands.
