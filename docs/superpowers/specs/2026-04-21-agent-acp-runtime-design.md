# Agent Client Protocol (ACP) runtime integration

Design spec for adding ACP (https://agentclientprotocol.com) as a new runtime type in Ark and upgrading the chat UI to render ACP-native conversations.

Status: approved, pre-implementation
Owner: Abhimanyu Singh Rathore
Date: 2026-04-21

---

## 1. Problem

Ark today runs agents as CLI subprocesses inside tmux panes. The `SessionLauncher` abstraction (`launch/kill/send/capture`) shoves prompt text into the pane's stdin and scrapes pane output with `tmux capture-pane`. Events reaching the chat UI are a mix of lifecycle transitions from the conductor plus messages reconstructed post-hoc from agent-specific transcript files.

This model does not work for agents that speak the Agent Client Protocol. ACP is bidirectional JSON-RPC over stdio: the host (Ark) spawns the agent, calls `initialize`, `session/new`, `session/prompt`, receives typed streaming `session/update` notifications, and serves host-side method calls (`fs/*`, `terminal/*`, `session/request_permission`). Terminal scrollback is meaningless; structured events are the signal. Several agents the team cares about (Gemini CLI's `--experimental-acp`, Claude Code ACP mode, Zed's agents) already expose an ACP interface.

We need a first-class ACP runtime alongside the existing ones, with a chat UI that renders the richer event vocabulary correctly.

## 2. Goals

- New runtime type `agent-acp` that coexists with existing runtimes. Users opt in per runtime definition; existing runtimes are untouched.
- Ark plays the ACP **client** role. ACP agent runs as a child subprocess owned by arkd (local or remote -- one uniform code path).
- Full host-side ACP surface: `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `session/request_permission`. Permission requests surface as an inline approve/deny card in the chat UI; trusted runtimes can set `grant_all_permissions: true` to auto-approve.
- Chat UI renders ACP session updates as a proper conversation (streaming text, thoughts, plans, tool calls with diff/terminal content, mode pill, permission prompts, turn-end badges). Partial/interrupted messages are first-class, not silently lost.
- Session resume via ACP `session/load` with a clean fallback when the agent does not advertise `loadSession` capability (matches parity with existing runtimes' resume behavior).
- Existing MCP plumbing (`mcp-configs/`, agent/runtime/project `.mcp.json`, flow connectors, `${ENV}` expansion, socket pool) continues to work unchanged -- ACP receives the aggregated MCP list via the protocol rather than a filesystem convention.

## 3. Non-goals (explicitly deferred)

- ACP `authenticate` method (no target runtime requires it in P1).
- Audio content blocks in messages.
- Live PTY streaming into the browser (we render the terminal *result* via `TerminalResultBlock`; live PTY is a separate feature that stands on its own merit).
- Mid-session MCP reload via `session/set_session_mcps` (ACP draft extension).
- Rewriting or deprecating the existing CLI/tmux runtimes.

## 4. Key decisions

| Decision | Chosen | Why |
|---|---|---|
| Ark's role in ACP | Client | Running ACP-speaking agents is the immediate need; server mode (exposing Ark over ACP) is a separable, later concern. |
| Where ACP subprocess lives | arkd (local + remote, same code) | Stateful stdio pipe requires a host that can hold it. arkd already sits on every compute target; `local-arkd` provider already runs arkd locally, so local ACP and remote ACP share one code path. |
| How host-side ACP methods reply | arkd answers locally (`fs/*`, `terminal/*`, most permission decisions); only non-trusted permission prompts hop to conductor → UI → back | Host-side calls are synchronous (agent blocks on reply). Round-tripping every `fs/read` through the conductor would be painful. |
| How events flow to UI | arkd translates each `session/update` into a channel report and POSTs to the conductor's existing `/api/channel/<sid>` | Zero new buffering or cursor state; mirrors exactly how tmux-era agents report events today. Conductor + SSE stays as-is. |
| ACP client implementation | Roll our own (~300-500 LoC) | ACP wire format is small; Ark's house style is explicit and minimal on deps; easy to swap to an official library later without touching executor or UI code. |
| UI component naming | Protocol-agnostic (`AgentThought`, `AgentPlan`, `PermissionPrompt`, …) except one debug view (`AgentAcpFrameLog`) | Concepts like "plan" and "thought" may apply to non-ACP structured runtimes in the future. |
| Streaming message persistence | In-place upsert with `streaming: boolean` + `turn_id` + `stop_reason` + `partial` on the `messages` table | Survives browser refresh, single source of truth, tiny schema delta. |
| Permission default for trusted runtimes | `grant_all_permissions: true` flag on the runtime YAML; arkd auto-grants and emits audit events | Mirrors existing `permission_mode: bypassPermissions` pattern for Claude Code. |
| Session resume | ACP `session/load` in P1 with capability-gated fallback to `session/new` | Parity with existing runtimes (Claude Code `--resume`, Gemini `--resume`). |

## 5. Naming and namespace collisions

There is already a `packages/core/acp.ts` in the codebase that claims the name "Agent Client Protocol" but is actually Ark's own internal JSON-RPC control API for headless/CI use (methods: `session/create`, `session/stop`, `session/output`, `session/send`). It is not the real ACP.

**Decision:** keep the existing file as-is (user-facing CI integrations depend on it; disruptive to rename). Use `agent-acp` everywhere for the real protocol so there is no code-level collision.

| Concern | Name |
|---|---|
| Existing `packages/core/acp.ts` | Unchanged |
| Runtime type value in YAML | `"agent-acp"` |
| Core protocol code directory | `packages/core/agent-acp/` (`types.ts`, `codec.ts`, `updates.ts`, `mcp-adapter.ts`) |
| Core executor file | `packages/core/executors/agent-acp.ts` |
| Arkd code directory | `packages/arkd/agent-acp/` (`client.ts`, `host.ts`, `transport.ts`, `pty-manager.ts`) |
| Arkd HTTP endpoints | `POST /agent-acp/{launch,send,cancel,permission-reply,close}` |
| DB columns | `sessions.agent_acp_session_id`, `sessions.agent_acp_capabilities_json`, `messages.streaming`, `messages.turn_id`, `messages.stop_reason`, `messages.partial` |
| Event type strings | `agent_acp_ready`, `agent_acp_message_chunk`, `agent_acp_thought_chunk`, `agent_acp_plan`, `agent_acp_tool_call`, `agent_acp_tool_call_update`, `agent_acp_mode_change`, `agent_acp_permission_request`, `agent_acp_permission_resolved`, `agent_acp_turn_completed`, `agent_acp_agent_exited`, `agent_acp_fs_write`, `agent_acp_protocol_violation`, `agent_acp_resume_fallback`, `agent_acp_frame` (debug-only) |
| UI components (new) | `AgentThought`, `AgentPlan`, `PermissionPrompt`, `TerminalResultBlock`, `ModePill`, `AgentAcpFrameLog` |
| UI components (upgraded) | `AgentMessage`, `ToolCallRow`, `ChatInput` |

## 6. Architecture overview

```
┌──────────────────┐          SSE "sessions" channel          ┌────────────────────┐
│     Browser      │◄──────────────────────────────────────── │     Conductor      │
│  SessionDetail   │            messages + events              │   (19100)          │
│  + ChatInput     │ ────────── JSON-RPC send / cancel ──────► │                    │
└──────────────────┘                                            └──────────┬─────────┘
                                                                           │ HTTP
                                                                           │ /agent-acp/launch|send|cancel|…
                                                                           │ /api/channel/<sid>  ◄── push forward
                                                                           ▼
                                                                ┌────────────────────┐
                                                                │       arkd         │
                                                                │  (local or remote) │
                                                                │  ┌──────────────┐  │
                                                                │  │   host.ts    │  │ ◄ answers fs/*, terminal/*,
                                                                │  │   client.ts  │  │   permission (grant_all or park)
                                                                │  │   transport  │  │
                                                                │  └──────┬───────┘  │
                                                                │         │ stdio    │
                                                                │         ▼          │
                                                                │   ACP agent proc   │
                                                                │  (gemini, zed,…)   │
                                                                └────────────────────┘
```

Single uniform path: local sessions hit `local-arkd`, remote sessions hit the remote arkd. No conditionals on "local vs remote" anywhere above the arkd layer.

## 7. Runtime definition schema

Extension to `packages/types/agent.ts`:

```ts
type RuntimeType = "claude-code" | "cli-agent" | "subprocess" | "goose" | "agent-acp";  // added

interface RuntimeDefinition {
  // … existing fields …
  /**
   * Configuration specific to type === "agent-acp". Ignored otherwise.
   */
  agent_acp?: {
    /** Subprocess invocation. Absolute path or a name resolvable on PATH. */
    command: string[];
    /** Extra flags to put the agent in ACP mode (e.g. ["--experimental-acp"]). */
    acp_flags?: string[];
    /**
     * When true, arkd auto-approves every session/request_permission without
     * surfacing a prompt in the UI. Allowed only for runtimes loaded from
     * _source: "builtin" or "project". Never honored for _source: "global"
     * (user-installed) runtimes -- those must prompt.
     */
    grant_all_permissions?: boolean;
    /** Capabilities advertised during initialize. Defaults shown. */
    host_capabilities?: {
      fs?: { read_text_file?: boolean; write_text_file?: boolean };  // default: both true
      terminal?: boolean;                                              // default: true
    };
    /** ACP protocol version pin. Defaults to latest known. */
    protocol_version?: string;
    /** Soft ceiling on concurrent terminals this session may spawn. Default 4. */
    max_terminals_per_session?: number;
    /** Watchdog -- no-update timeout while turn is active. Default 900s. */
    inactivity_timeout_seconds?: number;
    /** Watchdog -- silence before first update after session/prompt. Default 60s. */
    pre_first_update_timeout_seconds?: number;
  };
}
```

Two reference runtime YAMLs ship with the change:

```yaml
# runtimes/gemini-acp.yaml
name: gemini-acp
description: "Gemini CLI via Agent Client Protocol"
type: agent-acp
agent_acp:
  command: ["gemini"]
  acp_flags: ["--experimental-acp"]
  grant_all_permissions: true
  host_capabilities:
    fs: { read_text_file: true, write_text_file: true }
    terminal: true
models:
  - { id: gemini-2.5-pro, label: "Gemini 2.5 Pro" }
default_model: gemini-2.5-pro
billing: { mode: api, transcript_parser: gemini }
```

```yaml
# runtimes/zed-acp.yaml  -- generic template
name: zed-acp
description: "Any Zed-compatible ACP agent (user-configurable)"
type: agent-acp
agent_acp:
  command: ["${ACP_AGENT_CMD}"]
  grant_all_permissions: false   # surfaces permission prompts in chat
  host_capabilities:
    fs: { read_text_file: true, write_text_file: true }
    terminal: true
billing: { mode: api }
```

## 8. Executor and arkd layout

### 8.1. `packages/core/agent-acp/`

- `types.ts` -- JSON-RPC envelopes + ACP method/notification param shapes. Hand-typed from the ACP spec.
- `codec.ts` -- line-delimited JSON-RPC framing. Encode/decode, ID generation, request-response pairing, multi-frame buffering.
- `updates.ts` -- `mapAcpUpdateToArkEvent(update)`: takes an inbound `session/update` variant and returns `{ type, data }` in the Ark event shape. Each kind (`agent_message_chunk`, `agent_thought_chunk`, `plan`, `tool_call`, `tool_call_update`, `available_commands_update`, `current_mode_update`) gets a deterministic mapping.
- `mcp-adapter.ts` -- `toAcpMcpServers(entries)`: converts an aggregated MCP entry list (from the existing `collectMcpEntries` pipeline) into ACP's `mcpServers` params shape. Covers stdio (`command/args/env`) and HTTP (`type: "http", url, headers`) flavors; headers receive OAuth tokens from flow connectors.

### 8.2. `packages/core/executors/agent-acp.ts`

Implements the existing `Executor` contract. Key differences from the tmux-era executors:

- **No tmux, no SessionLauncher.** ACP sessions bypass the `SessionLauncher` abstraction entirely -- there is no pane to launch. The executor holds a tiny `AgentAcpClient` (HTTP wrapper for `/agent-acp/*` on the arkd of record) and delegates all lifecycle operations through it.
- **Launch** -- resolve compute → pick arkd URL → call `collectMcpEntries()` → `toAcpMcpServers()` → `POST /agent-acp/launch` with `{ sessionId, command, acpFlags, workdir, env, hostCapabilities, grantAllPermissions, modelSettings, mcpServers, acpSessionId? (on resume) }`. On success, persist `agent_acp_session_id` and `agent_acp_capabilities_json` on the session row.
- **Send** -- `POST /agent-acp/send { sessionId, text, turnId }` (conductor generates `turnId`). arkd translates to `session/prompt` with a text content block.
- **Cancel** -- `POST /agent-acp/cancel { sessionId, turnId }` → arkd sends `session/cancel` notification.
- **Resume** -- on the orchestration `resume()` path, executor re-launches with the existing `acp_session_id`; arkd uses it to call `session/load` instead of `session/new` when the agent's cached capabilities include `loadSession: true`. On fallback, arkd emits `agent_acp_resume_fallback: context_lost` and falls through to `session/new`.
- **Close** -- `POST /agent-acp/close { sessionId }` on stop/delete/archive.

### 8.3. `packages/arkd/agent-acp/`

- `transport.ts` -- line-delimited JSON-RPC reader/writer over a Bun subprocess's stdio. Bidirectional: reads frames from stdout, writes frames to stdin, handles back-pressure via a bounded write queue.
- `client.ts` -- owns the per-session state: the subprocess, the transport, a request-id map for pending ACP requests from arkd to the agent, a parked-permission-requests map, the cached agent capabilities from `initialize`. Exposes `launch`, `sendPrompt`, `cancel`, `respondPermission`, `close`.
- `host.ts` -- implements the host-side ACP surface. Receives incoming requests from the agent (`fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`, `session/request_permission`) and dispatches:
  - `fs/*` → reuses `confineToWorkspace` and the existing file helpers from `packages/arkd/server.ts`. Refuses symlink writes and paths outside `workspaceRoot`.
  - `terminal/*` → delegated to `pty-manager.ts`.
  - `session/request_permission` → if `grantAllPermissions` → synchronous grant + emit `agent_acp_permission_request` and `agent_acp_permission_resolved{outcome: granted, actor: auto}` channel reports. Otherwise → emit `agent_acp_permission_request`, park the reply promise in the per-session map keyed by request id, wait for conductor's `/agent-acp/permission-reply` to resolve it.
- `pty-manager.ts` -- one per arkd process. Wraps a PTY library (`node-pty`-equivalent; verify Bun compat, fall back to `@homebridge/node-pty-prebuilt-multiarch` if needed). Owns a `Map<terminalId, Pty>` bounded per session by `max_terminals_per_session`. Buffers PTY output locally to answer `terminal/output` and `terminal/wait_for_exit` method calls; does not stream PTY bytes into the UI (live PTY rendering is an explicit non-goal per §3 -- the UI sees terminal results via the agent's `tool_call_update` containing a `type: terminal` content block).

### 8.4. Arkd HTTP surface (new)

All require the existing bearer-token auth (`ARK_ARKD_TOKEN`) and propagate `X-Ark-Tenant-Id` in channel reports.

- `POST /agent-acp/launch` -- start subprocess, `initialize`, `session/new` or `session/load`. Idempotent per `sessionId`: if already running, returns the existing state.
- `POST /agent-acp/send` -- forward a user prompt as `session/prompt`.
- `POST /agent-acp/cancel` -- send `session/cancel` notif.
- `POST /agent-acp/permission-reply` -- resolve a parked permission request. Body: `{ sessionId, requestId, outcome: "granted" | "denied" | "cancelled", selectedOptionId? }`.
- `POST /agent-acp/close` -- shut down the subprocess gracefully (send any final notif then kill).

Resource cap: `ARK_AGENT_ACP_MAX_SESSIONS` (default 10) gates `/launch`. Beyond it, 503 with `Retry-After` hint.

### 8.5. Frame Log transport

When the session has the debug flag `frame_log: true` (per-session runtime toggle, defaults off in prod profiles, on in `local`), arkd emits a truncated copy of every inbound/outbound JSON-RPC frame as a channel report of type `agent_acp_frame { direction: "in"|"out", method, id?, payload_preview (<= 4 KiB) }`. Conductor keeps a per-session ring buffer of the last 1000 such events in memory; the `AgentAcpFrameLog` component fetches from a dedicated read-only endpoint. Never persisted to disk (PII risk).

## 9. Data and event flow: one prompt turn end-to-end

### 9.1. Setup (once per session)

1. User creates a session backed by an `agent-acp` runtime.
2. `session-orchestration.startSession` routes to `executors/agent-acp.ts`.
3. Executor resolves arkd URL + gathers MCPs + calls `arkdClient.acpLaunch(…)`.
4. arkd spawns the subprocess with stdio piped, sends `initialize` (protocol version + host capabilities), receives capabilities, then `session/new` (or `session/load` on resume). Receives `acpSessionId`.
5. arkd POSTs channel report `agent_acp_ready { acp_session_id, agent_capabilities }` to the conductor. Conductor updates the session row and publishes via SSE.

### 9.2. Active turn

```
browser ──RPC send(sid, text)──► conductor ──POST /agent-acp/send──► arkd
                                                                       │
                                                session/prompt(text) ──┤
                                                                       ▼
                                                            ACP agent proc
```

For every `session/update` the agent emits, arkd:

1. Maps the update to an Ark event type and structured payload via `updates.ts`.
2. POSTs a channel report to `http://<conductor>/api/channel/<sid>` (existing endpoint, unchanged).
3. Conductor persists in `events`. For streaming content (`agent_acp_message_chunk`, `agent_acp_thought_chunk`), it upserts the in-progress row in `messages` matched by `(turn_id, role, streaming=true)`, appending the chunk.
4. Conductor publishes via SSE. Browser's `useSse` receives, TanStack cache updates, UI re-renders.

### 9.3. Host-side method calls (mid-turn, agent → arkd)

| Agent call | arkd response path |
|---|---|
| `fs/read_text_file { path, line?, limit? }` | Confine `path` to workspaceRoot. Read file. Reply synchronously. |
| `fs/write_text_file { path, content }` | Confine. Refuse symlink writes. Write. Reply synchronously. Emit `agent_acp_fs_write` audit event. |
| `terminal/create { command, args, cwd?, env? }` | pty-manager spawns PTY, returns `terminalId`. No UI streaming; bytes buffered locally for subsequent method calls. |
| `terminal/output { terminalId, truncateLineCount? }` | Return buffered output + exit status if known. |
| `terminal/wait_for_exit { terminalId }` | Resolve when process exits; return exit code + signal. |
| `terminal/kill { terminalId }` | SIGTERM; wait a grace window; SIGKILL. |
| `terminal/release { terminalId }` | Remove from map. |
| `session/request_permission { request_id, tool_call, options }` | If `grantAllPermissions`: reply granted immediately; emit both `agent_acp_permission_request` and `…_resolved{actor: auto}`. Else: emit `…_request`, park promise, wait for `/agent-acp/permission-reply`. |

### 9.4. Turn end

Agent responds to the original `session/prompt` with a `stopReason`. arkd emits `agent_acp_turn_completed { turn_id, stop_reason }`. Conductor flips all `streaming=true` rows for this `turn_id` to `streaming=false`, tags them with the `stop_reason`. UI collapses the live caret; shows the stop-reason badge if non-trivial.

### 9.5. Cancellation

User clicks cancel → conductor RPC → `POST /agent-acp/cancel` → arkd sends `session/cancel` notif → agent halts, responds to `session/prompt` with `stopReason: cancelled`. Per ACP spec, all parked `session/request_permission` promises get resolved with `cancelled` outcome.

### 9.6. Session teardown

User stops/deletes the session → conductor → `POST /agent-acp/close` → arkd closes transport, kills subprocess, removes map entry. An unexpected subprocess exit at any time fires the agent-exit watchdog (§11).

## 10. Database schema changes

### 10.1. `sessions` table

Additive nullable columns:

```
agent_acp_session_id          TEXT      -- ACP sessionId from session/new or session/load
agent_acp_capabilities_json   TEXT      -- JSON blob of agent capabilities from initialize
```

### 10.2. `messages` table

Additive columns:

```
streaming    INTEGER  NOT NULL DEFAULT 0   -- 1 while chunks are arriving; 0 once finalized
turn_id      TEXT                           -- groups chunks belonging to one prompt turn
stop_reason  TEXT                           -- end_turn | max_tokens | max_turn_requests |
                                            --  refusal | cancelled | timeout | interrupted
partial      INTEGER  NOT NULL DEFAULT 0   -- 1 iff the turn ended abnormally (watchdog/cancel/crash)
```

### 10.3. Migration

- **SQLite (local / dev):** `packages/core/repositories/schema.ts` is authoritative per `CLAUDE.md`. Add the columns; users `rm ~/.ark/ark.db` when updating from an older build -- existing convention.
- **Postgres (control plane / hosted):** ship a real migration file through the polymorphic migration runner (landed in commit `06ae8f2b feat(migrations): polymorphic migration runner via AppMode`). Purely additive, all nullable, no backfill needed.
- Update the session-field whitelist in `packages/core/repositories/session.ts` per the CLAUDE.md gotcha for new session columns.

## 11. Partial messages, watchdogs, recovery

Invariant: every `streaming=true` row becomes `streaming=false` in bounded time, via exactly one of four paths.

| Path | Trigger | Final row state |
|---|---|---|
| 1. Natural | Agent replies to `session/prompt` with a `stopReason` | `streaming=false`, `stop_reason` from agent, `partial=false` |
| 2. User cancel | User cancels → `session/cancel` sent | `streaming=false`, `stop_reason="cancelled"`, `partial=true` |
| 3. Agent-exit watchdog | Subprocess dies while turn is active | `streaming=false`, `stop_reason="interrupted"`, `partial=true` |
| 4. Inactivity watchdog | No updates for `inactivity_timeout_seconds` (default 900s) after first update, or `pre_first_update_timeout_seconds` (default 60s) before first update | `streaming=false`, `stop_reason="timeout"`, `partial=true` |

### 11.1. Watchdog placement

- **Agent-exit watchdog** lives in arkd. On subprocess exit, for each in-flight turn, arkd synthesizes `agent_acp_turn_completed { stop_reason: "interrupted", partial: true, exit_code, signal }` plus `agent_acp_agent_exited`. Conductor processes the completion exactly like a natural one.
- **Inactivity watchdog** lives in the conductor. Per-session timer; reset on every incoming `agent_acp_*` event. On fire: synthesize `agent_acp_turn_completed { stop_reason: "timeout", partial: true }`, finalize rows, and best-effort POST `/agent-acp/cancel` to arkd.
- **Conductor-crash recovery** runs on conductor boot: scan for sessions with `status=running` and `streaming=true` messages whose runtime is `agent-acp`. Ping arkd for each; if the arkd-side session is absent, finalize with `stop_reason="interrupted"`.
- **Arkd-crash** loses all subprocesses; recovery is automatic via the mechanism above (conductor's next HTTP call fails, falls into the interrupted path).

### 11.2. Ordering

JSON-RPC over stdio is a single ordered connection. For a given `turn_id`, every `session/update` arrives strictly before the `session/prompt` response. arkd's reader processes frames in order; late chunks after turn end (agent bug) are dropped with a `agent_acp_protocol_violation` log.

### 11.3. UI render matrix

`AgentMessage` gets streaming-aware props. Terminal states render as:

| `stop_reason` | Visual |
|---|---|
| `end_turn` | Normal, no badge |
| `refusal` | Neutral "agent declined" badge |
| `max_tokens` | Amber "truncated: token limit" badge + Continue button (sends empty prompt to resume) |
| `max_turn_requests` | Amber "truncated: turn step limit" badge |
| `cancelled` | Gray "(cancelled)" marker; message dimmed |
| `timeout` | Red "agent did not respond" banner + Retry |
| `interrupted` | Red "agent process exited" banner (shows exit code if available) + Retry |

Retry sends a new turn carrying the same user prompt text. Conductor stores the original prompt text keyed by `turn_id` to make this work.

### 11.4. Browser refresh mid-stream

- `useSessionStream` refetches messages on mount; any `streaming=true` rows render with the typing indicator even on a fresh mount.
- SSE reconnects; further chunks append to the same row matched by `turn_id`.
- If `streaming=true` but no SSE updates arrive for 5s, UI triggers a one-shot refetch. Conductor's 60-900s watchdogs are the hard ceiling; the 5s re-check is a soft liveness signal.

## 12. Chat UI changes

### 12.1. Files touched

- `packages/web/src/components/session/event-builder.tsx` -- extend the switch with `agent_acp_*` handlers (see dispatch block below).
- `packages/web/src/components/session/timeline-builder.ts` -- merge ACP events + messages into a unified chronological timeline.
- `packages/web/src/pages/SessionsPage.tsx` (or session-detail entry) -- conditional tab layout for ACP sessions.
- `packages/web/src/hooks/useSessionStream.ts` -- add a message-chunk upsert reducer (~20 LoC) matched by `turn_id`.
- `packages/web/src/components/ui/` -- upgrade existing components + add new ones (see inventory).

### 12.2. Component inventory

| Component | Status | Responsibility |
|---|---|---|
| `AgentMessage` | upgrade | Adds `streaming`, `partial`, `stopReason` props. Blinking caret while streaming; copy/edit disabled. Partial → dimmed + banner per §11.3. |
| `ToolCallRow` | upgrade | Today: one-line. Upgrade to an expandable card with status dot (`pending` / `in_progress` / `completed`), title, kind badge, and a stack of content children. Children dispatch by block type: text → `MarkdownContent`, diff → existing `DiffViewer`, terminal → `TerminalResultBlock`, resource_link → file-path chip. |
| `ChatInput` | upgrade | Slash-command autocomplete from `available_commands_update`. `/` triggers; Tab/Enter to accept. |
| `AgentThought` | new | Collapsed-by-default "Thinking…" block under the assistant bubble. Streams `agent_acp_thought_chunk`. One-line collapsed summary; click to expand. |
| `AgentPlan` | new | Live checklist. Entries with priority pill + status icon. Plans are whole-object replacements in ACP; render the most recent. Inline card when short; right-drawer when long. |
| `PermissionPrompt` | new | Inline card triggered by `agent_acp_permission_request`. Shows the pending tool call + approve/deny buttons. One-click lock. Listens for `agent_acp_permission_resolved` to settle. Never rendered when runtime has `grant_all_permissions: true` (events still land in the Frame Log for audit). |
| `TerminalResultBlock` | new | Fixed-height (≤15 lines default, expandable) output box for content-block `type: terminal`. Renders stdout/stderr with ANSI + exit-code badge. Not a live PTY. |
| `ModePill` | new | Session-header pill. Click → menu of modes from `available_modes`; selection → `session/set_mode` via conductor. |
| `AgentAcpFrameLog` | new | Debug-only replacement for the Terminal tab. Raw JSON-RPC frames with direction arrows, timestamps, collapsible bodies. Populated by the `agent_acp_frame` channel-report stream described in §8.5; bounded 1000-entry ring buffer in conductor memory. |

### 12.3. Event dispatch in `event-builder.tsx`

```ts
// Conceptual, not literal:
switch (event.type) {
  case "agent_acp_message_chunk":       upsertMessage(turn_id, role, chunkText, { streaming: true })
  case "agent_acp_thought_chunk":       upsertThought(turn_id, chunkText, { streaming: true })
  case "agent_acp_plan":                setPlan(turn_id, entries)
  case "agent_acp_tool_call":           upsertToolCall(tool_call_id, { title, kind, status: "pending" })
  case "agent_acp_tool_call_update":    patchToolCall(tool_call_id, { status, content, locations })
  case "agent_acp_mode_change":         setMode(current, available)
  case "agent_acp_permission_request":  renderPermissionPrompt(request_id, tool_call)
  case "agent_acp_permission_resolved": resolvePermissionPrompt(request_id, outcome, actor)
  case "agent_acp_turn_completed":      finalizeTurn(turn_id, stop_reason, partial)
  case "agent_acp_agent_exited":        markSessionCrashed(exit_code, signal)
  case "agent_acp_resume_fallback":     showSystemDivider("resumed -- prior context not preserved")
  // existing cases preserved
}
```

### 12.4. Tab layout

- Non-ACP session: unchanged (Timeline | Terminal | Output | …).
- ACP session: Timeline (chat) | Frame Log (replaces Terminal) | Output (hidden, retained only for post-mortem recording compatibility) | Cost | …
- Runtime type already lives on the session row, so the conditional is trivial.

## 13. MCP handling

ACP has first-class MCP support: `session/new` accepts `mcpServers: [...]` directly in params. The ACP agent internally manages MCP client connections -- the host passes the config through the protocol rather than through `.mcp.json` files.

### 13.1. Reuse existing pipeline

- `agent-acp` executor calls the existing `collectMcpEntries(app, session, { runtimeName, flowConnectors })` -- aggregates from project `.mcp.json`, agent YAML, runtime YAML, flow connectors, and `mcp-configs/*.json`.
- `${ENV_VAR}` placeholder expansion runs against `process.env` (of the arkd host).
- Flow connectors (OAuth-backed) inject fresh tokens at session start via the existing `flowConnectors` resolution.

### 13.2. `toAcpMcpServers` adapter

New in `packages/core/agent-acp/mcp-adapter.ts` (~40 LoC):

- stdio entry → `{ name, command, args, env }` (post-expansion)
- URL entry → `{ name, type: "http", url, headers }` (headers carry OAuth tokens when present)

### 13.3. Wire through arkd

Executor includes the resolved `mcpServers` array in the `/agent-acp/launch` body. arkd passes it straight into `session/new` params. Secrets are already expanded host-side, so arkd just forwards bytes.

### 13.4. Socket pool compatibility

When `mcp-pool.ts` is enabled, `collectMcpEntries` returns entries that spawn `ark mcp-proxy /tmp/ark-mcp-<name>.sock`. ACP treats them as ordinary stdio MCPs -- no ACP-side awareness needed.

### 13.5. Remote compute note

MCP subprocesses spawn on the arkd host (local or remote). `${ENV}` references must exist on that host -- identical constraint to existing runtimes.

### 13.6. Deferred

`session/set_session_mcps` (mid-session MCP reload, ACP draft) is not in P1. Connectors that re-auth mid-session require a fresh ACP session today.

## 14. Error handling, security, resource limits

### 14.1. Agent misbehavior

| Risk | Mitigation |
|---|---|
| `fs/read_text_file` outside workspace | Existing `confineToWorkspace` guard; return JSON-RPC error `-32602`. |
| `fs/write_text_file` outside workspace or to symlink | Same confinement guard; refuse symlink writes. |
| `terminal/create` with dangerous command | No allowlist (user opted in by installing the runtime). CWD confined to `workspaceRoot`. Refuse argv values containing unescaped shell metacharacters (defensive only -- ACP passes argv directly to exec, so shell expansion is not the usual vector). |
| Enormous `tool_call` content | Per-content-block cap: 256 KiB default. arkd truncates with a marker `...[truncated, N bytes dropped]` before forwarding. |
| Malformed frames | arkd logs warning, drops frame, emits `agent_acp_protocol_violation` (visible in Frame Log). Session continues. |
| Agent hangs on `session/prompt` | Inactivity watchdog (§11). |
| Agent process crash | Agent-exit watchdog (§11). Session → `failed`; resume spawns a fresh subprocess + fresh ACP session (no implicit `session/load` on a crash-recovered row; user triggers that via explicit resume). |

### 14.2. Permission guardrails

- `grant_all_permissions: true` is honored only for runtimes from `_source: builtin` or `_source: project`. Never for `_source: global`.
- Every permission decision emits `agent_acp_permission_resolved { outcome, actor: user | auto | cancelled, runtime_source }` -- complete audit trail.
- When `grant_all_permissions: false` and no browser is subscribed, the inactivity watchdog eventually fires so the agent does not hang forever.

### 14.3. Prompt injection

Existing `detectInjection` in `session-output.ts` is currently applied only to the `send()` path. Extend: conductor's `POST /agent-acp/send` forwarder runs the same guard on the user-provided prompt text before forwarding. Same `prompt_injection_blocked` / `prompt_injection_warning` events.

Do **not** run injection detection on `fs/read_text_file` responses. Agents are expected to read untrusted files; the LLM-side injection risk is the agent's concern.

### 14.4. Auth and tenancy

- `/agent-acp/*` endpoints use the existing bearer-token auth (`ARK_ARKD_TOKEN`).
- Executor sets `X-Ark-Tenant-Id` on arkd calls. arkd includes the same header on outbound channel reports (matches existing `channelReport()` behavior).

### 14.5. Resource caps (per arkd)

- `ARK_AGENT_ACP_MAX_SESSIONS` (default 10): gates `/launch`. Beyond the cap, 503 + `Retry-After`. Conductor retries with backoff; marks session `failed` after a ceiling.
- `agent_acp.max_terminals_per_session` (default 4): guards against fork-bomb misuse.
- Per-session chunk buffer: 1 MiB bounded ring before channel-reporting. If conductor falls behind, arkd applies back-pressure by pausing the subprocess's stdout read -- better than silent drops.

### 14.6. Observability

- All `agent_acp_*` events land in the existing event stream → timeline + Frame Log.
- arkd logs every state transition via `structured-log` at `info`; protocol violations at `warn`.
- OTLP traces: span per turn (`agent-acp.turn`) with child spans `session.prompt`, `fs.read`, `fs.write`, `terminal.*`, `permission.request`. Wired through the existing `ARK_OTLP_ENDPOINT`.

## 15. Testing strategy

### 15.1. Mock ACP agent fixture

`packages/core/agent-acp/__tests__/fixtures/mock-agent.ts` -- a standalone Bun script that reads JSON-RPC frames from stdin and emits scripted responses. Configurable via env/flags:

- Well-behaved turn (prompt → chunks → `end_turn`)
- Long tool call with `tool_call_update` progression
- `session/request_permission` (both grant_all and non-grant-all)
- Malformed frames (protocol-violation path)
- Mid-turn crash (non-zero exit)
- Agent that hangs forever (inactivity watchdog)
- Capability variants (with/without `loadSession`)

Reused across every downstream test -- matches how Ark tests existing launchers with `NoopLauncher`.

### 15.2. Test layers

| Layer | File | Covers |
|---|---|---|
| Codec unit | `agent-acp/__tests__/codec.test.ts` | Frame encode/decode, id tracking, notifications vs requests, truncation cap |
| Executor unit | `executors/__tests__/agent-acp.test.ts` | launch → initialize → session/new happy path; session/prompt dispatch; cancel translation; update → event mapping; session/load resume; fallback when capability missing |
| Arkd host unit | `packages/arkd/__tests__/agent-acp-host.test.ts` | `fs/*` confinement (including symlink refusal), `terminal/*` PTY lifecycle, permission auto-grant and park-reply paths, resource caps |
| Watchdogs | `core/__tests__/agent-acp-watchdogs.test.ts` | 900s inactivity, 60s pre-first-update, agent-exit, conductor-restart recovery -- verify rows finalize with correct `stop_reason` + `partial=true` |
| End-to-end (local-arkd) | `core/__tests__/agent-acp-e2e.test.ts` | Full stack through local-arkd with the mock agent: launch, prompt, stream chunks, tool call with diff content, permission request, turn completion, resume, delete |
| Web components | `packages/web/src/components/ui/__tests__/` | `AgentMessage` streaming + partial states, `AgentPlan` in-place updates, `PermissionPrompt` one-click lock, `ChatInput` slash-command autocomplete, `AgentAcpFrameLog` frame ordering |

All tests use `AppContext.forTestAsync()` per CLAUDE.md. `make test --concurrency 4` must pass.

## 16. Phasing

### 16.1. P1 (this spec)

1. Naming discipline: `agent-acp` everywhere for the real protocol; existing `packages/core/acp.ts` unchanged.
2. New `agent-acp` runtime type in YAML schema (existing runtimes untouched).
3. `packages/core/agent-acp/` -- types, codec, updates, mcp-adapter.
4. `packages/core/executors/agent-acp.ts` -- launch, send, cancel, resume, close, event forwarding.
5. `packages/arkd/agent-acp/` -- client, host, transport, pty-manager.
6. New arkd endpoints `/agent-acp/{launch,send,cancel,permission-reply,close}`.
7. Local PTY manager in arkd for `terminal/*` (reusable beyond ACP).
8. Permission flow: grant-all fast path + park/reply path with UI prompt.
9. Schema changes + streaming message upsert in conductor + `turn_id` threading.
10. Three watchdogs (agent-exit, pre-first-update 60s, inactivity 900s) with conductor restart recovery.
11. `session/load` resume with capability-gated fallback.
12. UI: extend `event-builder.tsx`; upgrade `AgentMessage` / `ToolCallRow` / `ChatInput`; ship new components (`AgentThought`, `AgentPlan`, `PermissionPrompt`, `TerminalResultBlock`, `ModePill`, `AgentAcpFrameLog`); conditional tab layout for ACP sessions.
13. Two reference runtime YAMLs: `gemini-acp.yaml` (grant_all=true), `zed-acp.yaml` (grant_all=false template).
14. Full test coverage per §15.2.
15. Docs: short "adding an ACP runtime" guide in `docs/`.

### 16.2. P2 (follow-up, not in this spec)

- `authenticate` method (for agents requiring explicit auth).
- Audio content blocks.
- Live PTY streaming into the browser (separate feature, standalone value).
- `session/set_session_mcps` (ACP draft: mid-session MCP reload).
- MCP server delegation paths not yet defined in ACP spec.

## 17. Open questions

- PTY library choice under Bun: `node-pty` may not compile cleanly; `@homebridge/node-pty-prebuilt-multiarch` is the usual fallback. Verify at implementation time. If neither works, `terminal/*` capability advertises false in P1 and the feature moves to P2 -- the rest of the design still ships.
- Whether `session/set_session_mcps` is stable enough to include in P1. Current read: no. Re-check before starting work.
- Cost/token accounting for ACP sessions: ACP does not currently carry structured token usage in notifications. For P1 we rely on the runtime's existing `billing.transcript_parser` when the ACP agent also happens to write a transcript file on disk (Claude Code ACP mode does; Gemini may not). If no transcript exists, session cost is `0` until P2 introduces a richer cost path.
