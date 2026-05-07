# Conductor + server daemon merge

**Status:** approved (spec)
**Date:** 2026-05-06
**Owner:** yana.tarasova@paytm.com
**Supersedes:** `2026-05-01-arkd-conductor-ws-design.md` (the proposed outbound WS protocol from arkd to conductor is replaced by the unified JSON-RPC WS introduced here)
**Related:** `2026-03-28-arkd-conductor-merge.md` (established the agent->arkd->conductor topology), `2026-05-05-arkd-separation-design.md` (recently split `packages/arkd/` into client/server/common)

## Goal

Collapse the two control-plane HTTP listeners - conductor (`:19100`, REST + SSE) and server daemon (`:19400`, JSON-RPC + WS) - into a single HTTP service hosted by a renamed `packages/conductor/` package on one port. While merging, retire the protocols that are not forced by external compatibility: conductor's internal REST and the SSE event stream both fold into the existing JSON-RPC + WebSocket layer. arkd, CLI, and web all become clients of one unified WS endpoint.

The result is one port, one process role, one typed-RPC stack for everything Ark controls, and the same external adapters (OpenAI proxy, GitHub webhooks, MCP, terminal WS, health) re-mounted on the merged service.

## Why

The current split is an organic artifact, not an architectural decision:

1. **Conductor and server are not actually separate services.** They live in the same process today (`make dev-daemon` literally bundles them: "server daemon (conductor + arkd + WS)"). They share `AppContext`, the same DB, the same repos, the same `app.apiKeys` tenant resolver. The only distinction is audience - conductor handles workload-inbound traffic from arkd, server handles user-facing traffic from CLI + web. That distinction is a logical concern handled by auth roles, not a transport concern that justifies two ports.

2. **`packages/server/handlers/conductor.ts` already exists.** The 69-LOC bridge means the server already has JSON-RPC handlers wrapping conductor functionality - the line is fuzzy in current code, and the bridge file is itself evidence that the split costs more than it earns.

3. **The internal protocol surface has four protocols where two suffice.** REST (conductor) + JSON-RPC (server) + SSE (conductor) + WS (server) coexist. Of these, only REST and WS are forced by external callers (OpenAI clients speak REST, GitHub webhooks post REST, MCP is REST-shaped, terminal pty is raw bidi WS). Internal traffic (CLI, web, arkd) does not need REST or SSE - JSON-RPC over WebSocket already supports both request/response and server-push via the existing `notify` callback in handler signatures.

4. **Two ports double the operational surface for no architectural reason.** One port means one TLS cert, one ingress rule, one health check, one auth surface. The "different audiences" argument is preserved by per-method auth role gating, not by separate listeners.

The merge plus the protocol collapse is strictly simpler than today and avoids introducing any new tooling.

## Non-goals

- **Connect-RPC / Protobuf migration.** Considered and explicitly deferred. The merge stands on its own; adopting a schema-defined RPC surface is a separable future project that becomes smaller after this merge (single protocol stack to migrate instead of three).
- **arkd's own server-side surface.** `packages/arkd/server/` (the `:19300` per-compute daemon API) stays on its current REST shape. Only arkd's *client* side (`packages/arkd/client/`) changes - it swaps from fetch-against-conductor-REST to ArkClient-over-WS.
- **Backwards compatibility / deprecation tooling.** Hard cutover. No transition period, no warn-and-ignore phase for `ARK_CONDUCTOR_PORT`, no parallel old-and-new endpoints. CI will catch lingering references; runtime will fail loudly if a caller is missed.
- **Renaming `ArkServer` class internals.** The package renames to `packages/conductor/` but internal class names can stay (`ArkServer` -> rename optional, low value).
- **Multi-tenant authentication redesign.** Auth uses the existing `app.apiKeys.validate()` machinery. Roles (worker / user / admin) are encoded in the token type and gated per-method.

## Decisions (locked from brainstorming)

- **Scope:** alternative D - merge ports AND collapse internal protocols to JSON-RPC. Reject (A) "just merge, keep all four protocols" (incomplete cleanup); reject (B) "merge + Connect-RPC" (over-scoped, separable); reject (C) "phase A then Connect-RPC later" (worse intermediate state than D); reject any half-migration that keeps SSE or conductor's internal REST.
- **Surface:** single port, mixed surfaces. Connect-RPC explicitly out of scope. JSON-RPC over WS for everything Ark controls; REST for forced external compatibility (OpenAI proxy, GitHub webhooks, MCP, health); raw WS for terminal pty.
- **Rollout:** big-bang cutover. No dual surfaces, no transition period.
- **Package layout:** rename `packages/server/` -> `packages/conductor/`. The conductor IS the merged service; "server" is a generic term that already produced confusion ("why do we have daemon and conductor?") and "daemon" terminology retires entirely.
- **Port:** retain `:19400`. Retire `:19100`.
- **Config field rename:** the old `config.ports.conductor` field (held 19100) deletes. The old `config.ports.server` field (holds 19400) renames to `config.ports.conductor`. End state: a single `config.ports.conductor` field holding the merged service port.
- **Env var rename:** the old `ARK_CONDUCTOR_PORT` (mapped to 19100) deletes. `ARK_SERVER_PORT` renames to `ARK_CONDUCTOR_PORT` (mapped to the merged service port). End state: a single `ARK_CONDUCTOR_PORT` env var. Anyone setting `ARK_CONDUCTOR_PORT=19100` in an existing environment will need to update or hit a port mismatch loud failure on boot.
- **Constant rename:** `DEFAULT_CONDUCTOR_PORT` (=19100) deletes. `DEFAULT_SERVER_PORT` (=19400) renames to `DEFAULT_CONDUCTOR_PORT`.
- **CLI:** `ark daemon` command consolidates into `ark conductor`. Both today coexist redundantly.

## Architecture

### Topology after merge

```
   [CLI]   [web]                              external (REST):
     \      /                                  - OpenAI SDK clients (/v1/*)
      \    /                                   - GitHub webhooks (/hooks/github/*)
       \  /                                    - MCP clients (/mcp)
        \/                                     - liveness probes (/health)
   [conductor :19400]   <-- WS -->  [arkd :19300] <----> [agent]
   (the merged service)             (per compute target)   (claude-agent or tmux pane)
        ^
        |
        +--- terminal WS attach (/terminal/:sessionId)
```

The conductor is one HTTP service with URL-prefix dispatch:

```
/ark.api.* (JSON-RPC over WS)   <-- typed RPC for everything Ark controls
                                    (CLI, web, arkd-as-client all use this)
/v1/chat/completions, /v1/models <-- OpenAI-compat REST (untouched)
/mcp                             <-- MCP server (untouched)
/hooks/github/merge, /hooks/status <-- external REST webhooks (untouched)
/terminal/:sessionId             <-- raw bidi WS pty stream (untouched)
/health                          <-- REST liveness probe
```

### Auth and tenant resolution

Single path for all internal traffic: bearer token (header or `?token=` query) -> `app.apiKeys.validate()` -> `TenantContext` populated on the JSON-RPC connection -> carried into every handler invocation via the existing `ctx` parameter. The token's role (user / worker / admin) gates which methods can succeed, with mismatch returning a JSON-RPC error. This collapses today's split (server's user-token validation + conductor's worker-token validation, both already calling the *same* `app.apiKeys` machinery from two places) into one validation path.

External REST surfaces keep their existing per-route auth (OpenAI proxy bearer, webhook signature verification, MCP OAuth if configured).

### What dissolves

- `packages/core/conductor/` - whole subdirectory. ~1.6k LOC of REST handlers, SSE streamer, tenant resolver wrapper, report pipeline. Business logic (report pipeline, channel relay, worker registry) ports to `packages/conductor/handlers/` as JSON-RPC methods. The HTTP shell deletes.
- `packages/server/handlers/conductor.ts` - the 69-LOC bridge. Three methods (`conductor/status`, `conductor/bridge`, `conductor/notify`) either become direct `daemon/*` handlers or delete entirely.
- `packages/core/infra/conductor-launcher.ts` - the second `Bun.serve` launcher. Single launcher in the merged conductor replaces it.
- `packages/cli/commands/daemon.ts` - "daemon" terminology retires. `ark conductor start` owns lifecycle.
- The old conductor port (19100) and its config: the `:19100` listener stops, the old `config.ports.conductor` field (=19100), the old `ARK_CONDUCTOR_PORT` env var (=19100), and the old `DEFAULT_CONDUCTOR_PORT` constant (=19100) all delete. The names `config.ports.conductor` / `ARK_CONDUCTOR_PORT` / `DEFAULT_CONDUCTOR_PORT` are then re-used for the merged service port (formerly the `server` slot, =19400) - see Decisions for the rename.

### What this supersedes

The May 1 design (`2026-05-01-arkd-conductor-ws-design.md`) proposed an arkd -> conductor outbound WebSocket with a custom JSON envelope (`{type, ...}` frames: `hook_event`, `agent_message`, `term_frame`, `log_chunk`, etc.) on a dedicated `/arkd` endpoint. That design is replaced by this merge:

- The "arkd dials WS to conductor" architecture is preserved - it was the right idea.
- The custom envelope is replaced by JSON-RPC method calls + notifications. `hook_event` becomes `hook/forward` (request/response) or a notification on a subscription. `term_frame` becomes a `notify` message on a `terminal/subscribe` subscription. `log_chunk` becomes `notify` on `log/subscribe`.
- The endpoint is the unified JSON-RPC WS, not a separate `/arkd` path.
- Auth uses the same worker-token gating as the May 1 design (`ARK_ARKD_TOKEN` shared secret); just enforced through the conductor's auth interceptor rather than a dedicated `/arkd` upgrade handler.

## Components

### Changed: `packages/conductor/` (renamed from `packages/server/`)

- New `packages/conductor/launcher.ts`: single `Bun.serve` with URL-prefix dispatch. Replaces the existing `ArkServer.startWebSocket()` setup AND `ConductorLauncher.start()`. Branches: `/v1/*` -> OpenAI proxy adapter, `/mcp` -> MCP server, `/hooks/*` -> webhook handlers, `/terminal/:id` -> terminal WS, `/health` -> liveness, root `/` (with `Upgrade: websocket` header) -> JSON-RPC over WS handshake (the existing `ArkServer` WS upgrade path, preserved). All other paths return `404`.
- New JSON-RPC handlers in `packages/conductor/handlers/`:
  - `worker/register`, `worker/heartbeat`, `worker/deregister`, `worker/list`
  - `channel/deliver`, `channel/relay`
  - `hook/forward`
  - `session/tree-stream` (subscription)
  - `session/forensics/stdio`, `session/forensics/transcript`
  - `terminal/subscribe`, `terminal/input` (forwarded to arkd)
  - `log/subscribe`
- The existing `notify` callback in handler signatures handles all server-push: tree updates, channel deliveries to subscribed sessions, hook forwarding to listeners, terminal frame and log chunk delivery.
- Internal class names (`ArkServer`, `Router`) stay as-is. Class renames are out of scope; the package directory rename and import-path updates are sufficient.

### Changed: `packages/protocol/` (ArkClient)

- Gains worker-facing methods: `workerRegister`, `workerHeartbeat`, `channelDeliver`, `hookForward`, `terminalSubscribe`, `logSubscribe`, etc. Same client class, wider method surface.
- Stays JSON-RPC over WS. No transport change.
- Auth at client construction time still takes a bearer token; the role determines which methods succeed server-side (no client-side role check).

### Changed: `packages/arkd/client/`

- The current 348-LOC fetch-based REST client used by arkd to call back into the conductor is replaced by a thin wrapper around `ArkClient` (with worker-token auth).
- Connection model: persistent WS to `:19400` instead of per-call HTTP to `:19100`. arkd reuses the connection across heartbeats, channel deliveries, hook forwards, terminal frames, and log chunks.
- arkd already has WS-reconnect machinery for `/events/stream`; the same pattern handles the control-plane WS (exponential backoff, hello-on-resume, re-issue `worker/register` on reconnect).
- Public method names on the client object stay compatible with arkd's existing call sites so `packages/arkd/server/` code does not need to change beyond client construction.

### Changed: `packages/web/`

- The SSE consumer for `/api/sessions/:id/tree/stream` (`new EventSource(...)`) is replaced by a JSON-RPC subscription via the existing ArkClient WS. Tree updates arrive as typed `notify` messages on the same WS the rest of the web UI already uses.
- That is the only web change. Everything else is already on JSON-RPC.

### Changed: `packages/core/`

- `app.ts` boots only the merged conductor. `ConductorLauncher` reference deletes.
- `config.ts`, `config/profiles.ts`, `config/env-source.ts`:
  - The old `config.ports.conductor` field, `ARK_CONDUCTOR_PORT` env mapping, and `DEFAULT_CONDUCTOR_PORT` constant (all =19100) delete.
  - The old `config.ports.server` field renames to `config.ports.conductor`. `ARK_SERVER_PORT` env var renames to `ARK_CONDUCTOR_PORT`. `DEFAULT_SERVER_PORT` constant renames to `DEFAULT_CONDUCTOR_PORT`. End state holds the merged port (19400).
  - Profile defaults updated to match.
- `infra/conductor-launcher.ts`: deletes.
- `infra/arkd-launcher.ts`: `conductorUrl` template literal updates from `config.ports.conductor` (old) to the post-rename `config.ports.conductor` field (new value 19400) - same identifier name, different port. Compute adapters (`packages/compute/core/{ec2,local,...}.ts`) that inject conductor URL at provision time update similarly.

### Changed: `packages/cli/`

- `commands/daemon.ts`: deletes. Lifecycle commands (start / stop / status) consolidate under `commands/conductor.ts`.
- All other CLI call sites already use `ArkClient` and continue to work without change.

### LOC delta (rough)

- Deletes: ~1.6k LOC (`packages/core/conductor/`) + ~70 (`server/handlers/conductor.ts`) + ~85 (conductor-launcher + config glue) + ~150 (arkd client thinning) + ~100 (CLI daemon command). **~2k LOC deleted.**
- Adds: ~600-800 LOC of new JSON-RPC handlers in `packages/conductor/handlers/` + ~80 LOC for the merged launcher + ~150 LOC for new ArkClient worker methods. **~830-1030 LOC added.**
- Net: **~1k LOC simpler.**

## Data flow

Six representative flows. Most are "the same as today, with the conductor hop removed."

**1. CLI dispatching a session.** CLI opens a JSON-RPC WS to `:19400` with user bearer token. `ArkClient.sessionStart(...)` sends a JSON-RPC request; auth interceptor resolves `TenantContext`; handler runs in `packages/conductor/handlers/session.ts`. Identical to today.

**2. Web UI subscribing to session tree updates.** Web opens its existing JSON-RPC WS to `:19400`. Calls `session/tree-stream` (new method). Handler registers the connection as a subscriber on the session's tree event bus and returns. Subsequent tree changes inside `AppContext` push notifications via `notify` - one JSON-RPC notification per delta. Replaces SSE on `:19100/api/sessions/:id/tree/stream`.

**3. arkd heartbeat / worker registration.** arkd boots, opens persistent WS to `:19400` with worker bearer token. On connect, calls `worker/register` once. Then sends `worker/heartbeat` on the same connection on a timer. WS reconnect re-issues `worker/register` automatically. Replaces per-heartbeat HTTP POST to `:19100/api/workers/heartbeat`.

**4. arkd forwarding a hook event.** Agent emits a hook event. arkd calls `hook/forward` on the existing WS to `:19400`. Handler routes through the existing report-pipeline machinery (ported from `packages/core/conductor/`) - same downstream consumers (event bus, persistence, web subscribers via `notify`). Replaces `:19100/hooks/forward`.

**5. arkd delivering a channel message between sessions.** arkd's session A wants to send to session B's channel. arkd calls `channel/deliver({ targetSession, payload })` on the WS. Handler looks up session B's channel subscribers (other arkds + web UI listeners) and pushes via existing channel-bus + `notify`. Replaces `:19100/api/channel/:sessionId`.

**6. External caller hitting OpenAI proxy.** External SDK POSTs to `:19400/v1/chat/completions`. URL-prefix dispatcher in `launcher.ts` routes to `/v1/*` branch BEFORE the JSON-RPC router. Existing OpenAI-compat adapter runs unchanged. Same pattern for `/hooks/github/merge`, `/mcp`, `/terminal/:id`, `/health`.

### Connection lifecycle

- One persistent WS per arkd instance to conductor. Long-lived, reconnect with backoff.
- One WS per CLI invocation (one-shot connection per `ark` command).
- One WS per web tab.
- External REST callers (OpenAI / webhooks / MCP / health) are stateless per request.
- Terminal WS at `/terminal/:id` is a separate short-lived connection per attach.

## Error handling

### Auth failures

- Invalid or missing bearer token on JSON-RPC handshake: WS upgrade returns `401`. Connection never opens.
- Token valid but role insufficient for the called method (e.g. user token calls `worker/heartbeat`): JSON-RPC error response, code `-32001` ("forbidden"), connection stays open. Should not occur in practice; indicates a token-issuance bug.
- Tenant mismatch (token's tenant differs from request's `X-Ark-Tenant-Id`): JSON-RPC error, code `-32002`. Same handling pattern as today's conductor `tenant.ts`, executed once in the unified path.

### Schema / request validation

JSON-RPC params don't match expected shape: standard JSON-RPC error `-32602` ("invalid params"). Existing `Router.dispatch()` already handles this; new ported handlers adopt the same validation pattern as the surrounding handlers in `packages/conductor/handlers/`.

### Connection drops

- arkd WS drops: arkd reconnects with exponential backoff (existing machinery). On reconnect, arkd re-issues `worker/register` before resuming heartbeat. Heartbeats missed during reconnect contribute to conductor's existing "stale worker" detection (worker not seen in N seconds -> mark dead).
- Web UI WS drops: web reconnects and re-subscribes to active streams. Conductor cleans up the dead WS's subscriptions on close; web's resubscribe is idempotent.
- CLI WS drops mid-call: error surfaces to user, CLI exits non-zero. CLI does not auto-reconnect for one-shot invocations.

### Worker-state inconsistencies

- Heartbeat for unknown worker (e.g. conductor restarted, in-memory registry empty): conductor returns `-32003` ("worker not registered"); arkd re-issues `worker/register`. Stateless recovery, no DB consistency issue.
- arkd sends `channel/deliver` for a session conductor doesn't know about (race during session shutdown): conductor returns `-32004` ("unknown session"); message drops. Existing behavior, not a new failure mode.

### Notification subscription leaks

Web subscribes to `session/tree-stream` then closes the WS without explicit unsubscribe: conductor's `notify` machinery already handles this - the close handler tears down subscriptions. New subscription methods (`session/tree-stream`, `terminal/subscribe`, `log/subscribe`, channel subscribers) must hook into the same cleanup pattern. **Verified by an explicit subscription-leak test (see Testing).**

### What we do not need to invent

No new error taxonomy, no new validation framework, no new circuit-breaker logic. Everything reuses existing JSON-RPC error conventions on the server side and existing reconnect logic on the client side. The merge removes one error surface (conductor REST), it does not add any.

## Testing

### Existing tests that port

- Tests in `packages/server/__tests__/` (now `packages/conductor/__tests__/`) hitting JSON-RPC handlers via `app.dispatch()` or test-mode `ArkServer` survive untouched once the package import path updates.
- `packages/core/__tests__/` tests targeting conductor-side flows migrate from "POST to conductor REST" to "call JSON-RPC method." Same business logic, different invocation shape.
- Integration tests using `ArkClient` keep working - the client surface stays compatible, just gains worker-facing methods.

### New test coverage

1. **JSON-RPC methods that replaced REST endpoints.** Each new handler (`worker/register`, `worker/heartbeat`, `worker/deregister`, `worker/list`, `channel/deliver`, `channel/relay`, `hook/forward`, `session/tree-stream`, `session/forensics/*`, `terminal/subscribe`, `log/subscribe`) gets a unit test. Pattern: boot test `AppContext` via `forTestAsync()`, dispatch through router, assert response and side effects on AppContext.
2. **Notification subscriptions.** Tests for `session/tree-stream` and other subscription methods verify (a) initial response includes current state, (b) state changes produce notifications, (c) WS close cleans up the subscription so AppContext does not leak listeners.
3. **Auth role gating.** Single integration test file: open WS with worker token and try a user-only method (and vice versa), assert the right error code.
4. **End-to-end: arkd -> conductor.** Test that boots in-process arkd via existing `forTestAsync()` machinery and verifies arkd registers, heartbeats, forwards a hook event, and delivers a channel message - all over the new WS.

### Tests that delete

- HTTP fetch tests against `:19100` REST endpoints.
- Tests of `packages/server/handlers/conductor.ts` bridge methods.
- Tests asserting two-port topology on boot.

### Test infrastructure

`AppContext.forTestAsync()` already allocates ephemeral ports per test profile. The `config/profiles.ts` test profile drops one port allocation. No new test infra needed. `--concurrency 4` continues to work.

### What we deliberately don't test

- URL-prefix dispatcher routing for OpenAI / webhook / MCP / terminal / health paths beyond a single smoke test per prefix. Those handlers are unchanged from today.
- WS reconnect behavior in arkd's client - already exercised by the existing `/events/stream` reconnect tests.

### CI gates

`make test`, `make lint`, `make format` - same as today. No new CI gates (no proto-drift, no codegen-drift, no schema-drift). The only new pre-merge check worth adding is a `grep` for `19100` / `ARK_CONDUCTOR_PORT` / `ports.conductor` in `packages/`, failing if any remain.
