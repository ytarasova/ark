# ACP Support Analysis: Scope, Impact, and Blast Radius

> **Date:** 2026-04-16
> **Author:** Abhimanyu Singh Rathore
> **Status:** Analysis / RFC
> **Context:** HANDOFF.md (April 14 meeting) -- ACP POC authorized as parallel interface

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture: Channels](#2-current-architecture-channels)
3. [What is ACP](#3-what-is-acp)
4. [Scope of Changes](#4-scope-of-changes)
5. [Impact Analysis by Package](#5-impact-analysis-by-package)
6. [Blast Radius](#6-blast-radius)
7. [Dual-Mode Strategy: Channels + ACP](#7-dual-mode-strategy-channels--acp)
8. [Benefits of ACP for Agent Communication](#8-benefits-of-acp-for-agent-communication)
9. [Risks and Mitigations](#9-risks-and-mitigations)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Executive Summary

Ark currently uses a custom **MCP-based channel protocol** for all agent communication. The channel system is tightly coupled to Claude Code's `claude/channel` experimental capability, with the `ark-channel` MCP server acting as the bridge between agents and the conductor. Adding ACP (Agent Communication Protocol) support means introducing a **second, standards-based communication path** alongside channels -- not replacing them.

**Key findings:**

- **22 files** directly reference channel ports/communication and would need awareness of the new transport
- **3 packages** are in the critical blast radius: `core`, `compute`, `arkd`
- The `Executor` interface is the natural abstraction boundary -- ACP can be introduced as a transport strategy without changing the executor contract
- Claude Code does NOT natively support ACP -- it would need an adapter (MCP server wrapping ACP client)
- Goose already supports ACP via extensions; Gemini has native support
- The existing `acp.ts` (headless session management) is **unrelated** to the industry ACP standard and should be renamed to avoid confusion

---

## 2. Current Architecture: Channels

### 2.1 Communication Flow

```
                    INBOUND (Conductor --> Agent)
  ┌───────────┐     HTTP POST      ┌──────┐    HTTP 127.0.0.1:PORT    ┌─────────────┐
  │ Conductor │ ──────────────────> │ arkd │ ───────────────────────> │ ark-channel │
  │ :19100    │                     │:19300│                           │ (MCP stdio) │
  └───────────┘                     └──────┘                           └──────┬──────┘
                                                                              │
                                                          notifications/claude/channel
                                                                              │
                                                                              v
                                                                     ┌──────────────┐
                                                                     │  Claude Code  │
                                                                     └──────┬───────┘
                                                                            │
                    OUTBOUND (Agent --> Conductor)                   MCP tool call
                                                                    report() / send_to_agent()
  ┌───────────┐    /api/channel/:id  ┌──────┐   /channel/:id        │
  │ Conductor │ <─────────────────── │ arkd │ <─────────────────────┘
  └───────────┘                      └──────┘
```

### 2.2 Key Components

| Component | File | Role |
|-----------|------|------|
| Channel MCP Server | `packages/core/conductor/channel.ts` | stdio MCP server + HTTP inbound listener |
| Channel Types | `packages/core/conductor/channel-types.ts` | Message schemas (Task, Steer, Abort, Progress, Completion, Question, Error) |
| Conductor | `packages/core/conductor/conductor.ts` | HTTP server routing reports, relay, session orchestration |
| Arkd | `packages/arkd/server.ts` | Relay daemon on every compute target |
| Claude Config | `packages/core/claude/claude.ts` | Generates `.mcp.json`, settings, launcher scripts |
| Claude Executor | `packages/core/executors/claude-code.ts` | Orchestrates channel config + tmux launch |
| Goose Executor | `packages/core/executors/goose.ts` | Passes channel as `--with-extension` |
| Session Hooks | `packages/core/services/session-hooks.ts` | Report validation, gate logic, stage handoff |
| Session Repo | `packages/core/repositories/session.ts` | Channel port allocation: `19200 + (hex(id) % 10000)` |

### 2.3 Protocol Details

- **Transport:** MCP over stdio (agent <-> channel), HTTP (channel <-> arkd <-> conductor)
- **Inbound messages:** `TaskAssignment`, `SteerMessage`, `AbortMessage`
- **Outbound messages:** `ProgressReport`, `CompletionReport`, `QuestionReport`, `ErrorReport`
- **Port range:** 19200-29199 (deterministic per session)
- **Agent tools:** `report` (progress/completed/question/error), `send_to_agent` (relay)

---

## 3. What is ACP

### 3.1 Protocol Overview

ACP (Agent Communication Protocol) is an open standard (Linux Foundation / AAIF) for agent-to-agent communication. As of early 2026, it is converging with Google's A2A protocol into a unified standard.

**Core concepts:**
- **REST-based:** HTTP endpoints with OpenAPI spec definitions
- **Agent Cards:** JSON metadata describing agent capabilities, endpoints, and supported message types
- **Tasks:** First-class primitive -- create, update, query tasks with structured lifecycle
- **Messages:** Rich content (text, images, structured data) with sender/receiver roles
- **Streaming:** SSE-based real-time updates for long-running tasks
- **Push notifications:** Webhook-based callbacks for async completion

### 3.2 ACP vs Current Channels

| Dimension | Ark Channels (MCP) | ACP Standard |
|-----------|-------------------|--------------|
| Protocol | Custom MCP + `claude/channel` | REST (HTTP) + OpenAPI |
| Transport | stdio + HTTP notifications | HTTP + SSE + webhooks |
| Discovery | Hardcoded in `.mcp.json` | Agent Cards (/.well-known/agent.json) |
| Message format | Custom TypeScript types | Standardized JSON schema |
| Agent-to-agent | Relay via conductor | Direct (agent card resolution) |
| Async model | MCP notifications | SSE streams + push notifications |
| Auth | Tenant header injection | OAuth2 / API keys (spec-defined) |
| Runtime support | Claude Code (native), others via adapter | Gemini (native), Goose (via adapter) |
| Maturity | Production-proven in Ark | Emerging standard, SDKs available |

### 3.3 What ACP is NOT

- **Not a replacement for MCP.** MCP connects agents to tools/resources; ACP connects agents to agents.
- **Not natively supported by Claude Code.** Claude Code uses MCP channels, not ACP.
- **Not incompatible with channels.** Both can coexist -- channels for Claude, ACP for Goose/Gemini.

---

## 4. Scope of Changes

### 4.1 New Components Required

```
packages/
  core/
    acp/                          # NEW: ACP transport layer
      acp-server.ts               # ACP HTTP server (agent card, task endpoints)
      acp-client.ts               # ACP client for conductor --> agent delivery
      acp-adapter.ts              # MCP-to-ACP bridge for Claude Code
      acp-types.ts                # ACP message/task schemas
      agent-card.ts               # Agent card generation per session
    conductor/
      channel-types.ts            # MODIFY: add transport discriminator
      conductor.ts                # MODIFY: accept ACP task updates alongside channel reports
    executors/
      claude-code.ts              # MODIFY: optionally use ACP adapter instead of channel
      goose.ts                    # MODIFY: use native ACP instead of channel extension
    executor.ts                   # MODIFY: add transport preference to LaunchOpts
  arkd/
    server.ts                     # MODIFY: add ACP relay endpoints
  compute/
    providers/*.ts                # MODIFY: port allocation for ACP server
```

### 4.2 Components That Stay Unchanged

- `packages/core/services/session-hooks.ts` -- report validation logic is transport-agnostic
- `packages/core/services/session-orchestration.ts` -- dispatch delegates to executors
- `packages/web/` -- web UI consumes session/event data, not transport details
- `packages/server/` -- JSON-RPC handlers are above the transport layer
- `packages/types/` -- domain interfaces are transport-agnostic
- `packages/router/` -- LLM routing is orthogonal to agent communication
- `agents/`, `flows/`, `skills/`, `recipes/` -- YAML definitions unchanged

### 4.3 Change Categories

**Category A: New code (additive, zero blast radius)**
- ACP server implementation
- ACP client library
- Agent card generation
- ACP-to-channel message mapping

**Category B: Modified code (controlled blast radius)**
- Executor launch flow (transport selection)
- Conductor report ingestion (accept ACP format)
- Arkd relay (new ACP endpoints)
- Channel port allocation (share or separate port range for ACP)

**Category C: Rename/cleanup (cosmetic, low risk)**
- Rename existing `acp.ts` (headless session protocol) to `headless-rpc.ts` to avoid naming collision

---

## 5. Impact Analysis by Package

### 5.1 `packages/core` (HIGH IMPACT)

**Files affected: ~12**

| File | Change | Risk |
|------|--------|------|
| `conductor/conductor.ts` | Add ACP task update endpoint (`POST /api/acp/tasks/:id`) | Medium -- new route, existing handler pattern |
| `conductor/channel-types.ts` | Add `transport: "channel" \| "acp"` discriminator to messages | Low -- additive field |
| `executors/claude-code.ts` | Select transport based on agent/runtime config | Medium -- branching in launch() |
| `executors/goose.ts` | Use ACP natively instead of channel-as-extension | Medium -- changes how goose receives tasks |
| `executor.ts` | Add `transport?: "channel" \| "acp"` to `LaunchOpts` | Low -- optional field |
| `claude/claude.ts` | Generate ACP adapter MCP config as alternative | Medium -- parallel config path |
| `repositories/session.ts` | Track transport type per session | Low -- new column |
| `app.ts` | Boot ACP server alongside conductor | Low -- additive |
| `acp.ts` --> `headless-rpc.ts` | Rename to avoid collision | Low -- find-replace |
| `mcp-pool.ts` | Pool ACP adapter MCP process | Low -- existing pattern |
| `services/session-hooks.ts` | Zero change -- report logic is transport-agnostic | None |
| `services/session-orchestration.ts` | Pass transport preference through dispatch | Low -- threading a parameter |

### 5.2 `packages/arkd` (MEDIUM IMPACT)

**Files affected: ~2**

| File | Change | Risk |
|------|--------|------|
| `server.ts` | Add ACP relay endpoints (forward ACP task updates to conductor) | Medium |
| `types.ts` | Add ACP request/response types | Low |

### 5.3 `packages/compute` (LOW IMPACT)

**Files affected: ~3**

| File | Change | Risk |
|------|--------|------|
| `types.ts` | Add `buildAcpConfig()` to provider interface | Low |
| `providers/local/index.ts` | Implement ACP config builder | Low |
| `providers/docker/index.ts` | Implement ACP config for containerized agents | Low |

### 5.4 Other packages (NO IMPACT)

- `packages/web/` -- No change. Web UI reads session/event data, not transport.
- `packages/server/` -- No change. JSON-RPC handlers are above transport.
- `packages/protocol/` -- No change. ArkClient talks to server, not agents.
- `packages/cli/` -- Minimal: rename `ark acp` command to `ark headless-rpc` or keep as alias.
- `packages/desktop/` -- No change.
- `packages/router/` -- No change.

---

## 6. Blast Radius

### 6.1 Risk Matrix

```
                        LIKELIHOOD OF REGRESSION
                    Low         Medium        High
               ┌───────────┬───────────┬───────────┐
         High  │           │ Conductor │           │
  SEVERITY     │           │ report    │           │
               │           │ ingestion │           │
               ├───────────┼───────────┼───────────┤
         Med   │ Port      │ Executor  │           │
               │ allocation│ launch    │           │
               │           │ flow      │           │
               ├───────────┼───────────┼───────────┤
         Low   │ Session   │ Arkd      │           │
               │ repo      │ relay     │           │
               └───────────┴───────────┴───────────┘
```

### 6.2 Critical Path Analysis

The **most dangerous change** is modifying the conductor's report handling (`conductor.ts:744-876`). This is the single funnel through which ALL agent reports flow. If the ACP adapter introduces a malformed report, it could:
- Trigger premature stage advancement
- Corrupt session state
- Break commit validation

**Mitigation:** The report handler already calls `applyReport()` which is a pure function with strict validation. ACP messages should be mapped to the existing `OutboundMessage` types BEFORE reaching `applyReport()`, keeping the validation layer untouched.

### 6.3 What Could Break

| Scenario | Cause | Impact | Mitigation |
|----------|-------|--------|------------|
| Channel sessions break | Accidental change to channel code path | All Claude sessions fail | Feature flag: `transport: "channel"` default |
| Port collision | ACP server uses port in channel range | Session dispatch failure | Separate port range for ACP (29200+) |
| Report format mismatch | ACP message not mapped correctly | Silent stage failures | Integration test with all 4 report types |
| Arkd relay regression | New endpoint breaks existing routes | All remote compute fails | Additive routes only, no changes to existing |
| Goose extension conflict | Changing from channel extension to ACP | Goose sessions fail | Keep channel-as-extension as fallback |

### 6.4 Blast Radius by Runtime

| Runtime | Current Transport | ACP Impact | Migration Risk |
|---------|-------------------|------------|----------------|
| Claude Code | MCP channel (native) | Needs MCP-to-ACP adapter | Medium -- adapter adds complexity |
| Goose | MCP channel (as extension) | Native ACP support available | Low -- simpler integration |
| Gemini CLI | MCP channel (as extension) | Native ACP support available | Low -- simpler integration |
| Codex | MCP channel (as extension) | No known ACP support | N/A -- keep on channels |

---

## 7. Dual-Mode Strategy: Channels + ACP

### 7.1 Architecture

```
                         ┌────────────────────────────┐
                         │       Conductor :19100     │
                         │                            │
                         │  POST /api/channel/:id     │  <-- channel reports (existing)
                         │  POST /api/acp/tasks/:id   │  <-- ACP task updates (new)
                         │  POST /api/relay            │  <-- agent relay (existing)
                         │                            │
                         │  ┌────────────────────────┐│
                         │  │   Report Normalizer    ││  <-- maps both formats to OutboundMessage
                         │  └──────────┬─────────────┘│
                         │             │              │
                         │  ┌──────────v─────────────┐│
                         │  │    applyReport()       ││  <-- unchanged business logic
                         │  │    mediateHandoff()    ││
                         │  └────────────────────────┘│
                         └────────────────────────────┘
                                    │           │
                    ┌───────────────┘           └───────────────┐
                    │ channel transport                         │ ACP transport
                    v                                          v
            ┌───────────────┐                          ┌───────────────┐
            │  ark-channel  │                          │  ACP Server   │
            │  (MCP stdio)  │                          │  (HTTP REST)  │
            └───────┬───────┘                          └───────┬───────┘
                    │                                          │
            ┌───────v───────┐                          ┌───────v───────┐
            │  Claude Code  │                          │ Goose/Gemini  │
            │  Codex        │                          │ (ACP-native)  │
            └───────────────┘                          └───────────────┘
```

### 7.2 Transport Selection Logic

```typescript
// In executor.ts or session-orchestration.ts
function resolveTransport(runtime: string, agent: AgentConfig): "channel" | "acp" {
  // Explicit override in agent YAML
  if (agent.transport) return agent.transport;

  // Runtime defaults
  switch (runtime) {
    case "claude-code":
    case "codex":
      return "channel";       // MCP channel is native
    case "goose":
    case "gemini-cli":
      return "acp";           // ACP is native/preferred
    default:
      return "channel";       // safe default
  }
}
```

### 7.3 Agent YAML Extension

```yaml
# agents/reviewer.yml
name: reviewer
runtime: goose
transport: acp          # NEW: explicit transport selection
model: claude-sonnet-4-5-20250514
tools: [Read, Grep, Glob]
```

### 7.4 Session Schema Extension

```sql
-- In repositories/schema.ts (remember: no migrations, rm ~/.ark/ark.db)
ALTER TABLE sessions ADD COLUMN transport TEXT DEFAULT 'channel';
```

### 7.5 What Changes Per Transport

| Concern | Channel Mode | ACP Mode |
|---------|-------------|----------|
| Config generation | `.mcp.json` with ark-channel | Agent card JSON + ACP server URL |
| Port allocation | `19200 + hash` | `29200 + hash` (separate range) |
| Task delivery | HTTP POST to channel port | ACP `POST /tasks` with message |
| Report reception | `POST /api/channel/:id` | ACP `POST /tasks/:id` (status update) |
| Steering | `notifications/claude/channel` | ACP `POST /tasks/:id/messages` |
| Agent-to-agent | `send_to_agent` via relay | ACP direct task creation |
| Hooks/settings | Claude settings.local.json | N/A (ACP agents self-configure) |
| Transcript parsing | Runtime-specific parsers | Same -- independent of transport |

---

## 8. Benefits of ACP for Agent Communication

### 8.1 Standards Compliance

- **Interoperability:** Any ACP-compliant agent (from any vendor/framework) can join an Ark flow without custom integration work.
- **Future-proofing:** As A2A/ACP converges under Linux Foundation governance, Ark stays aligned with the industry direction.
- **Ecosystem leverage:** ACP SDKs (Python, TypeScript) handle serialization, validation, streaming -- less custom code to maintain.

### 8.2 Simplified Multi-Runtime Support

Currently, every runtime needs custom channel integration:
- Claude Code: native `claude/channel` MCP capability
- Goose: `--with-extension` wrapping the MCP channel server
- Gemini: custom extension wiring
- Codex: custom extension wiring

With ACP:
- Goose: native ACP support (already has Claude SDP adapter)
- Gemini: native ACP support
- New runtimes: just implement ACP agent card, done

**Reduction in per-runtime glue code:** ~60% for non-Claude runtimes.

### 8.3 Better Agent-to-Agent Communication

Current relay model:
```
Agent A --> channel --> arkd --> conductor --> arkd --> channel --> Agent B
```

ACP model:
```
Agent A --> ACP client --> Agent B's ACP endpoint
```

Benefits:
- **Lower latency:** No conductor hop for agent-to-agent messages
- **Richer messages:** ACP supports structured data, images, embeddings -- not just text
- **Discovery:** Agent cards enable dynamic discovery instead of hardcoded session IDs
- **Decoupled:** Agents can communicate without conductor being online

### 8.4 Async-First Design

ACP is built for long-running tasks:
- **SSE streaming:** Real-time progress without polling
- **Push notifications:** Webhook callbacks when tasks complete
- **Task lifecycle:** Explicit states (submitted, working, input-required, completed, failed, canceled)

This maps cleanly to Ark's session states (`ready`, `running`, `waiting`, `completed`, `failed`, `blocked`).

### 8.5 Observability

ACP's structured task model gives free observability:
- Each task has a unique ID, creation time, and state history
- Messages are timestamped and attributed to sender/receiver
- Agent cards declare capabilities -- useful for the web UI

### 8.6 Reduced Infrastructure Complexity

Channel system requires:
- Per-session MCP process (ark-channel)
- Per-session HTTP listener on ephemeral port
- Arkd relay for port forwarding in remote compute
- `.mcp.json` generation and management
- `settings.local.json` hook wiring

ACP requires:
- One ACP server per compute target (or per session)
- Standard HTTP -- no special port scheme needed
- Agent card at well-known URL

### 8.7 Cost Comparison (Maintenance Burden)

| Concern | Channel Maintenance | ACP Maintenance |
|---------|--------------------|-----------------| 
| Protocol evolution | We own the spec, we maintain it | Community/LF maintains the spec |
| SDK updates | Manual `@modelcontextprotocol/sdk` tracking | Community SDK releases |
| New runtime support | Custom integration per runtime | Implement agent card interface |
| Message format changes | Manual schema updates | OpenAPI spec-driven |
| Security patches | Our responsibility | Shared community responsibility |

---

## 9. Risks and Mitigations

### 9.1 Technical Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Claude Code doesn't support ACP natively | High | Certain | MCP-to-ACP adapter; keep channels as primary for Claude |
| ACP standard changes (A2A merger) | Medium | Likely | Abstract behind Ark-specific interface; adapter pattern |
| Performance overhead (HTTP vs stdio) | Low | Possible | Benchmark; ACP server is localhost HTTP, latency ~1ms |
| Port exhaustion with two port ranges | Low | Unlikely | Use single ACP server per compute, not per session |
| Existing `acp.ts` naming collision | Low | Certain | Rename to `headless-rpc.ts` before starting |

### 9.2 Organizational Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Maintaining two transport paths | Medium | Clean abstraction at executor + conductor layer |
| Team cognitive load | Medium | Clear docs on when to use which transport |
| Testing matrix doubles | Medium | Shared report validation tests; transport-specific integration tests |

### 9.3 What We Must NOT Change

To keep the blast radius contained, these components must remain untouched:

1. **`applyReport()` in session-hooks.ts** -- the pure business logic for report validation, gate checking, and advancement decisions. ACP messages must be normalized to `OutboundMessage` before reaching this function.

2. **`mediateStageHandoff()` in session-hooks.ts** -- the stage advancement orchestration. It operates on session state, not transport.

3. **`dispatch()` in session-orchestration.ts** -- the top-level dispatch function. Transport selection should be resolved before it's called, or threaded through `LaunchOpts`.

4. **Session event/message storage** -- events and messages are transport-agnostic. Both transports should produce identical event and message records.

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Week 1)

1. **Rename `acp.ts` to `headless-rpc.ts`** -- avoid naming collision
2. **Add `transport` column to sessions** -- `"channel"` (default) or `"acp"`
3. **Add `transport` to agent YAML schema** -- optional field
4. **Create `packages/core/acp/` directory** -- skeleton types and interfaces
5. **Define ACP-to-OutboundMessage mapping** -- pure functions, fully testable

### Phase 2: ACP Server (Week 2)

1. **Implement ACP HTTP server** -- agent card endpoint, task CRUD, message append
2. **Implement report normalizer** -- ACP task updates --> `OutboundMessage`
3. **Add ACP route to conductor** -- `POST /api/acp/tasks/:id` alongside existing channel route
4. **Integration test** -- ACP task update flows through `applyReport()` correctly

### Phase 3: Goose Native ACP (Week 3)

1. **Modify goose executor** -- launch with ACP endpoint URL instead of channel extension
2. **Test Goose + ACP end-to-end** -- dispatch, progress, completion, stage handoff
3. **Benchmark** -- latency comparison with channel transport

### Phase 4: Claude Code ACP Adapter (Week 4)

1. **Build MCP-to-ACP adapter** -- MCP server that translates `report`/`send_to_agent` calls to ACP HTTP requests
2. **Modify claude-code executor** -- optionally use ACP adapter instead of ark-channel
3. **Test Claude Code + ACP adapter** -- full lifecycle test
4. **Feature-flag** -- `transport: "acp"` in agent YAML to opt in

### Phase 5: Hardening (Week 5)

1. **Dual-mode integration tests** -- same flow runs with both transports, same outcomes
2. **Web UI transport indicator** -- show which transport each session uses
3. **Documentation** -- update architecture docs, agent YAML reference
4. **Performance benchmarks** -- compare channel vs ACP for all report types

---

## Appendix A: File Impact Summary

**New files (~6):**
- `packages/core/acp/acp-server.ts`
- `packages/core/acp/acp-client.ts`
- `packages/core/acp/acp-adapter.ts`
- `packages/core/acp/acp-types.ts`
- `packages/core/acp/agent-card.ts`
- `packages/core/acp/__tests__/acp.test.ts`

**Modified files (~10):**
- `packages/core/conductor/conductor.ts` -- new ACP route
- `packages/core/conductor/channel-types.ts` -- transport discriminator
- `packages/core/executors/claude-code.ts` -- transport selection
- `packages/core/executors/goose.ts` -- native ACP launch
- `packages/core/executor.ts` -- transport in LaunchOpts
- `packages/core/repositories/session.ts` -- transport column
- `packages/core/repositories/schema.ts` -- schema update
- `packages/core/app.ts` -- boot ACP server
- `packages/core/acp.ts` --> rename to `headless-rpc.ts`
- `packages/cli/commands/misc.ts` -- update ACP command reference

**Unchanged files (everything else):**
- `session-hooks.ts`, `session-orchestration.ts` -- transport-agnostic
- `packages/web/` -- consumes data, not transport
- `packages/server/` -- above transport layer
- `packages/router/` -- orthogonal
- All YAML definitions -- unless adding `transport` field

## Appendix B: Message Mapping (ACP <--> Channel)

```
ACP Task Status          -->  Ark Channel Message
─────────────────────────────────────────────────
task.status = "working"  -->  ProgressReport { type: "progress" }
task.status = "completed"-->  CompletionReport { type: "completed" }
task.status = "failed"   -->  ErrorReport { type: "error" }
task.status = "input-required" --> QuestionReport { type: "question" }
task.status = "canceled" -->  (no mapping -- handle as error)

Ark Channel Message      -->  ACP Task Update
─────────────────────────────────────────────────
TaskAssignment           -->  POST /tasks (create new task)
SteerMessage             -->  POST /tasks/:id/messages (append message)
AbortMessage             -->  POST /tasks/:id (status: "canceled")
```

## Appendix C: Existing `acp.ts` Rename Impact

The current `acp.ts` implements a **headless JSON-RPC protocol** for CI/CD session management -- completely unrelated to the industry ACP standard. References to rename:

| File | Reference |
|------|-----------|
| `packages/core/acp.ts` | The module itself |
| `packages/cli/commands/misc.ts` | `ark acp` command (keep as CLI alias) |
| `CHANGELOG.md` | Historical references (leave as-is) |
| `docs/ROADMAP.md` | Context note (clarify distinction) |

**Recommendation:** Rename module to `headless-rpc.ts`, keep `ark acp` CLI command as alias for backwards compatibility, add `ark headless` as preferred command name.
