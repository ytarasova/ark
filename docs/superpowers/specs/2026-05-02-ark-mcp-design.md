# Ark MCP Server Design

**Date:** 2026-05-02
**Status:** Approved (brainstorm) — pending implementation plan

## Goal

Expose Ark's full read + write surface to Claude (and any MCP-aware
client) over a single HTTP MCP endpoint, so agents can dispatch
sessions, steer running work, and define new agents/flows/skills/recipes
without dropping into the CLI or web UI.

## Context

Today Ark has three control surfaces:

1. **CLI** (`./ark ...`) — talks to the server daemon over JSON-RPC
2. **Web UI** (Vite at `:5173` / `:8420`) — same JSON-RPC, browser-side
3. **Channel MCP** (`packages/core/conductor/channel.ts`) — stdio MCP
   embedded *inside* dispatched sessions, used by the agent itself to
   call `report` / `send_to_agent` back to the conductor

There is no path for an *external* AI client to drive Ark. A user
working with Claude Code on their laptop has to context-switch to the
CLI or web UI to start a session, even when Claude is the natural
operator (e.g. "kick off the autonomous-sdlc flow against this repo
on my ec2-ssm box").

This spec adds a fourth surface — Ark MCP — that wraps the same
services CLI/web already use, scoped per-tenant for the hosted control
plane, single-tenant for the laptop binary.

## Architecture

```
                  ┌────────────── Claude Code ──────────────┐
                  │  ~/.claude/claude.json  (mcp config)     │
                  │  { type: "http", url: ".../mcp",         │
                  │    headers: { Authorization: "Bearer …"}}│
                  └──────────────────┬───────────────────────┘
                                     │ POST /mcp  (JSON-RPC over HTTP,
                                     │             Streamable HTTP transport)
                                     ▼
   ┌──────────────────────── Server daemon (:19400) ─────────────────────┐
   │   Existing routes:                                                  │
   │     GET  /                  — health                                │
   │     POST /jsonrpc           — CLI / web UI                          │
   │     WS   /jsonrpc           — push events to web UI                 │
   │   New route:                                                        │
   │     POST /mcp               — MCP tool calls (this spec)            │
   │                                                                     │
   │   /mcp handler:                                                     │
   │     1. Auth: bearer → tenantId (local: arkd.token; hosted: api_keys)│
   │     2. Resolve scoped AppContext: app.forTenant(tenantId)           │
   │     3. Dispatch to MCP tool registry → existing services            │
   │     4. Return JSON                                                  │
   └─────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                            existing services
                  (sessionService, flows, agents, skills,
                   recipes, computes, secrets — unchanged)
```

The MCP handler is a thin shell. It does NOT contain business logic —
every tool delegates to the same service the CLI/web UI use today.
This is critical: the MCP cannot drift from the rest of Ark, and bug
fixes / features added to the existing surface automatically apply.

## Transport

Streamable HTTP (MCP 2025-03-26 spec):
- Single endpoint, both POST (request) and SSE (server push) supported
  by the same URL
- For MVP, all tools return one-shot JSON responses (no SSE streaming)
- Future: long-running tools (`session_watch`, `events_subscribe`)
  would use SSE on the same endpoint — additive, no breaking change

We use `@modelcontextprotocol/sdk` (already a direct dep, used by
`packages/core/conductor/channel.ts`) for the protocol layer.
Specifically `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`,
which is the Web-Fetch-API variant — slots directly into Bun's
`Request` → `Response` model the daemon already uses, no Express
adapter needed.

## Auth

### Local mode (single-tenant binary on a laptop)

- Token: `~/.ark/arkd.token` (auto-generated on first daemon boot —
  same file `./ark` and the web UI already read)
- Tenant: implicit single-tenant, `app.tenantId = null` (matches
  current local-mode behaviour)
- `auth.requireToken=false` profile default → MCP requests with NO
  bearer header are accepted and bound to the lone tenant
- `auth.requireToken=true` overlay → bearer must match arkd.token

### Hosted mode (control plane, multi-tenant)

- Token: per-user API token, generated via web UI ("Settings → MCP
  tokens → Generate"). Persisted in existing `api_keys` table
  (already used for control-plane auth).
- Tenant: derived from the api_keys row's tenant_id
- `auth.requireToken=true` (control-plane profile default) → bearer
  required, missing/invalid → 401
- All subsequent service calls go through `app.forTenant(tenantId)`
  — same tenant scoping the web UI already enforces

The MCP handler does not introduce a new auth model. It reuses
`packages/core/auth/` helpers so a token revoked in the web UI is
revoked everywhere.

## Tool Surface

All tools are scoped under no namespace prefix (just snake_case names)
because Claude lists tools by full server name + tool name and an
extra `ark.` prefix would be redundant. All tools take JSON params,
return JSON results. Schemas defined inline below; auto-generated from
`packages/types/` in implementation.

### Read tools (14)

| Tool | Params | Returns |
|------|--------|---------|
| `session_list` | `{status?, flow?, limit?}` | `Session[]` |
| `session_show` | `{sessionId}` | `Session` |
| `session_events` | `{sessionId, type?, limit?}` | `Event[]` |
| `flow_list` | `{}` | `Flow[]` |
| `flow_show` | `{name}` | `Flow` |
| `agent_list` | `{}` | `Agent[]` |
| `agent_show` | `{name}` | `Agent` |
| `skill_list` | `{}` | `Skill[]` |
| `skill_show` | `{name}` | `Skill` |
| `recipe_list` | `{}` | `Recipe[]` |
| `recipe_show` | `{name}` | `Recipe` |
| `compute_list` | `{}` | `Compute[]` (omit secret fields) |
| `compute_show` | `{name}` | `Compute` |
| `secrets_list` | `{}` | `{name, type, updated_at}[]` (NO values) |

### Write — Tier 1 (dispatch & runtime, 5)

| Tool | Params | Returns |
|------|--------|---------|
| `session_start` | `{compute, flow, agent?, summary, repo?, branch?, prompt?, parent?}` | `{sessionId}` |
| `session_steer` | `{sessionId, message}` | `{ok}` |
| `session_kill` | `{sessionId}` | `{ok}` |
| `compute_start` | `{name}` | `{status}` |
| `compute_stop` | `{name}` | `{status}` |

### Write — Tier 2 (definition CRUD, 8)

All Tier 2 tools take **structured JSON params** that map 1:1 to the
existing TypeScript types (`AgentDefinition`, `FlowDefinition`, etc.).
Server serializes to YAML and writes to the standard locations
(`agents/*.yaml`, `flows/*.yaml`, `skills/*.yaml`, `recipes/*.yaml`).

| Tool | Params | Returns |
|------|--------|---------|
| `agent_create` | `AgentDefinition` (no `id`) | `{name}` |
| `agent_update` | `{name, patch: Partial<AgentDefinition>}` | `{name}` |
| `flow_create` | `FlowDefinition` | `{name}` |
| `flow_update` | `{name, patch: Partial<FlowDefinition>}` | `{name}` |
| `skill_create` | `SkillDefinition` | `{name}` |
| `skill_update` | `{name, patch: Partial<SkillDefinition>}` | `{name}` |
| `recipe_create` | `RecipeDefinition` | `{name}` |
| `recipe_update` | `{name, patch: Partial<RecipeDefinition>}` | `{name}` |

### Excluded from MVP

- Deletion tools (`*_delete`, `compute_destroy`, `secret_delete`) —
  destructive, deferred until a confirmation/audit story is designed
- Live event streaming (`session_watch`) — defer until polling proves
  insufficient
- `secret_create` / `secret_update` — unclear how to safely transit
  raw secret values via Claude's transcript; deferred
- Agent-to-agent relay from outside a session

## Definition serialization

Tier 2 writes follow this path:

```
Claude → JSON params → MCP handler
       ↓
  Validate against TS-derived JSON Schema (zod or ajv at handler boundary)
       ↓
  Existing service: app.agents.set(name, def)
       ↓
  Existing serializer: writes ~/.ark/agents/<name>.yaml
       ↓
  Existing watcher: hot-reloads in-memory store
```

Crucially: **no new persistence path**. The MCP handler does not write
files directly. It calls the same `app.agents.set()` etc. that the
CLI's `./ark agent create` already calls. This guarantees the MCP can
only do what the CLI can do.

Validation happens once, at the MCP boundary, using JSON Schema
generated from the TS types. We DO NOT trust the body — it is
client-supplied JSON. Invalid params → MCP error response, no service
call.

## File Layout

```
packages/server/mcp/
  index.ts          — module entry, exports handleMcpRequest
  server.ts         — MCP server setup (capabilities, listTools, callTool)
  auth.ts           — bearer token → tenantId resolution
  schemas.ts        — JSON Schema generation from packages/types/*
  tools/
    session.ts      — session_list, session_show, session_events,
                      session_start, session_steer, session_kill
    flow.ts         — flow_list, flow_show, flow_create, flow_update
    agent.ts        — agent_list, agent_show, agent_create, agent_update
    skill.ts        — skill_list, skill_show, skill_create, skill_update
    recipe.ts       — recipe_list, recipe_show, recipe_create, recipe_update
    compute.ts      — compute_list, compute_show, compute_start, compute_stop
    secrets.ts      — secrets_list (read-only)
  __tests__/
    auth.test.ts
    session.test.ts
    flow.test.ts
    agent.test.ts
    ...
```

`packages/server/index.ts` adds:
```ts
if (req.method === "POST" && url.pathname === "/mcp") {
  return handleMcpRequest(req, ctx);
}
```

## Testing strategy

- **Unit**: each tool has a test that boots `AppContext.forTestAsync()`,
  calls the tool's handler directly with a fake MCP request, asserts
  the right service was called and the response shape matches the
  declared schema.
- **Integration**: one e2e test that spins up the daemon on an
  ephemeral port, posts a real MCP `initialize` + `tools/list` +
  `tools/call` sequence, and validates the round-trip against a
  real session_start → session_show flow.
- **Auth**: dedicated test for bearer-required mode, missing token
  → 401, wrong token → 401, valid token → 200.
- **Tenant isolation**: hosted-mode test where two tenants' API
  tokens see disjoint resources.

Reuse the existing test harness — no new test infra.

## Open questions (deferred to plan)

- Exact JSON Schema generator (zod vs ajv vs hand-rolled). Both deps
  exist; pick whichever is already on the critical path.
- Whether `session_steer` blocks until the message is delivered or
  fire-and-forget. Probably async-fire-and-forget to match CLI
  behaviour.
- Where the per-user API token UI lives in the web app. Spec the
  backend table additions; defer the UI to a follow-up PR.

## Out of scope

- Streaming/SSE responses (defer until needed)
- Deletion tools
- Secret value writes
- Multi-version MCP protocol negotiation (we target the latest spec
  Claude Code supports as of 2026-05; revisit if older clients
  appear)

## Success criteria

1. `curl -X POST http://localhost:19400/mcp` with the right MCP
   headers + a valid bearer returns the tool list (27 tools).
2. From a fresh Claude Code with this MCP configured, the user can
   say "start a bare flow on ec2-ssm" and Claude's `session_start`
   call lands a session that completes end-to-end (verified by
   subsequent `session_show` reporting `status=completed`).
3. From the same Claude session, "create an agent named foo with
   model claude-opus" results in `~/.ark/agents/foo.yaml` containing
   the right YAML, and `./ark agent list` shows it.
4. In control-plane mode, two users with different API tokens cannot
   see each other's sessions via `session_list`.
