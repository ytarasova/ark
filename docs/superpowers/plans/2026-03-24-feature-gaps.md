# Ark Feature Gap Analysis & Roadmap

> **Based on:** Competitive research across 8 tools -- DeerFlow (ByteDance), Conductor.build (Melty Labs), Agent-Deck, OpenCode, E2B, Factory AI, Pi (badlogic), Goose (Block) -- plus Claude Code settings/hooks documentation.

**Goal:** Identify the highest-impact feature gaps between Ark and the competitive landscape, then prioritize them into actionable work.

---

## Executive Summary

Ark is already strong in areas most tools lack: **remote compute dispatch** (local/Docker/EC2), **declarative YAML pipelines with gates**, **conductor-based agent communication via MCP**, and **live compute metrics**. No single competitor covers all of these.

The gaps fall into 4 tiers:

| Tier | Theme | Impact |
|------|-------|--------|
| **P0 -- Do Now** | Agent status via hooks, context compaction | Fixes critical fragility |
| **P1 -- High Value** | Session persistence, headless CI mode, OTEL observability, sub-agent fan-out, cost tracking | Unlocks new use cases |
| **P2 -- Differentiators** | Checkpoints, recipe templating, plugin/skill system, session forking, structured review, cron scheduling, tiered autonomy, guardrails | Polish and extensibility |
| **P3 -- Future** | Web UI, MicroVM sandboxing, multi-provider LLM, MCP socket pool, chat bridges, in-VM daemon | Larger architectural shifts |

---

## P0 -- Do Now (Critical)

### 1. Hook-Based Agent Status Detection

**Gap:** Ark polls tmux pane output to detect agent status -- fragile, high-latency, unreliable.

**Solution (from agent-deck + Claude Code docs):**

Use `.claude/settings.local.json` in the **session working directory** (not global `~/.claude/settings.json`). Claude Code merges hook arrays additively across scopes -- no clobbering.

**Architecture:**

```
claude.writeHooksConfig() called at dispatch time (next to writeChannelConfig)
  → Writes .claude/settings.local.json to session working directory
    → Merges with any existing user settings (array concat, no clobbering)
      → Claude Code auto-discovers on session start
        → Hook fires HTTP POST to conductor on each event
          → Conductor updates session status in SQLite
            → TUI refreshes via existing poll cycle
```

**This belongs in `claude.ts` as a new `writeHooksConfig()` function** -- the same module that already handles `writeChannelConfig()`, `buildLauncher()`, and `trustDirectory()`. It's called from `launchAgentTmux()` in `session.ts` right after `writeChannelConfig()` (line 345).

**Important: Hooks are ONLY for agent status detection.** They are NOT part of the channel/conductor communication system. The conductor already handles agent↔human messaging via MCP channels. Hooks solve a different, narrower problem: knowing when the agent's status changes (running/idle/error/done) without polling tmux output. The hook HTTP endpoint is a simple status receiver, completely separate from the channel protocol.

**The function must handle all compute targets:**

| Compute Target | Conductor URL | Notes |
|---|---|---|
| **Local** | `http://localhost:19100` | Direct |
| **EC2 bare metal** | `http://localhost:19100` | SSH reverse tunnel maps back |
| **Docker/devcontainer** | `http://host.docker.internal:19100` | Docker bridge |
| **Worktree** | Same as parent | Writes to worktree's `.claude/` dir |

The `conductorUrl` logic already exists in `launchAgentTmux` (lines 339-341) -- reuse it.

**Settings merge strategy:**

`.claude/settings.local.json` arrays merge additively with user's `~/.claude/settings.json`. The function should:
1. Read existing `.claude/settings.local.json` in workdir if present (user may have project-local settings)
2. Deep-merge the `hooks` key (concat hook arrays per event, dedup by command URL)
3. Preserve all non-hook keys untouched
4. Write atomically (tmp + rename)

**Events to hook:**

| Claude Event | Ark Status | Matcher |
|-------------|------------|---------|
| `SessionStart` (startup) | `running` | `startup` |
| `SessionStart` (resume) | `running` | `resume` |
| `UserPromptSubmit` | `running` | -- |
| `Stop` | `idle` (turn complete) | -- |
| `StopFailure` | `error` | -- |
| `SessionEnd` | `completed` or `failed` | -- |
| `Notification` | `waiting` | `permission_prompt\|idle_prompt` |

**Hook format (HTTP type -- no shell scripts needed):**

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [{ "type": "http", "url": "http://localhost:19100/hooks/status", "timeout": 5, "async": true }]
    }],
    "Stop": [{
      "hooks": [{ "type": "http", "url": "http://localhost:19100/hooks/status", "timeout": 5, "async": true }]
    }],
    "StopFailure": [{
      "hooks": [{ "type": "http", "url": "http://localhost:19100/hooks/status", "timeout": 5, "async": true }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "http", "url": "http://localhost:19100/hooks/status", "timeout": 5, "async": true }]
    }],
    "Notification": [{
      "matcher": "permission_prompt|idle_prompt",
      "hooks": [{ "type": "http", "url": "http://localhost:19100/hooks/status", "timeout": 5, "async": true }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "http", "url": "http://localhost:19100/hooks/status", "timeout": 5, "async": true }]
    }]
  }
}
```

**Key details:**
- `type: "http"` hooks POST the full hook payload (session_id, transcript_path, hook_event_name, event-specific fields) directly to the conductor -- no shell scripts, no file watchers
- Conductor URL varies by compute target (local vs docker vs EC2) -- same logic as channel config
- `ARK_SESSION_ID` set as tmux env var for correlation (already done for channel)
- Fallback: keep tmux polling as degraded path (agent-deck pattern -- 2-min freshness window)
- Atomic write (write to `.tmp`, rename) to avoid partial reads
- Cleanup: remove ark hooks from settings.local.json on session delete (like `writeChannelConfig` writes `.mcp.json`)

**Files to touch:**
- `claude.ts` -- new `writeHooksConfig(sessionId, statusUrl, workdir)` + `removeHooksConfig(workdir)`. This is purely a Claude config writer, like `writeChannelConfig()` is for MCP.
- `session.ts:launchAgentTmux()` -- call `writeHooksConfig()` after `writeChannelConfig()` (line 345)
- `conductor.ts` -- new `POST /hooks/status` endpoint. This is a **tiny** status receiver (parse event → update session status in SQLite). It is NOT part of the channel protocol -- channels handle agent↔human messaging via MCP; hooks just report agent busy/idle/error/done.
- `store.ts` -- no changes (existing `updateSession` handles status)

**Effort:** ~2 days.

---

### 2. Context Compaction / Long Session Support

**Gap:** Ark agents hit context window limits on long sessions. No compaction, no summarization, no recovery.

**Found in:** Goose (auto-summarize at 80% context), DeerFlow (configurable summarization with retention policies).

**Solution:** This is primarily a Claude Code feature (Claude Code has `PreCompact`/`PostCompact` hooks and automatic compaction). Ark should:
- Hook into `PreCompact`/`PostCompact` events to log compaction in the audit trail
- For headless agents: pass `--max-turns` appropriately and handle the `StopFailure` (max_output_tokens) event
- Consider session branching for long-running work (split into sub-sessions)

**Effort:** ~1 day for hook integration. Session branching is P2.

---

## P1 -- High Value

### 3. Headless CI/CD Execution Mode

**Gap:** Ark's conductor advances pipelines but there's no `ark exec` command for CI systems to call directly.

**Found in:** Factory AI (`droid exec` with tiered autonomy, structured JSON output), Goose (recipe execution with `--headless`).

**Solution:** `ark exec --flow quick --ticket ABC-123 --compute local --output json`
- Non-interactive one-shot runner
- Structured output: json, stream-json
- Tiered autonomy levels (read-only, edit, execute, deploy) instead of binary bypass
- Exit code reflects pipeline outcome
- Usable in GitHub Actions, Jenkins, etc.

**Effort:** ~3 days. New CLI command, wraps existing session/dispatch/conductor flow.

---

### 4. OpenTelemetry Observability

**Gap:** Ark has no telemetry, tracing, or metrics export. Live TUI metrics are display-only.

**Found in:** Factory AI (13 OTEL metrics), Goose (Langfuse + MLflow integration).

**Recommended metrics (OTEL):
- `ark.session.duration` -- per session
- `ark.session.count` -- by status
- `ark.stage.duration` -- per pipeline stage
- `ark.agent.tokens` -- per model/session
- `ark.compute.cost` -- per provider
- `ark.tool.invocations` -- per tool name

**Effort:** ~2 days. Add OTLP HTTP exporter, instrument conductor and session lifecycle.

---

### 5. SQLite Session Conversation Persistence

**Gap:** Ark sessions are tmux-based. Conversation history lives in Claude Code's internal storage, not Ark's database. Can't query, fork, or analyze conversations.

**Found in:** Goose (full conversation + tool calls in SQLite), Pi (JSONL with tree structure for branching).

**Solution:** Use `Stop` and `PostToolUse` hooks to capture key events into Ark's SQLite store. Or parse the `transcript_path` (provided in hook payloads) after session ends. This enables:
- Session conversation history in TUI
- Fork/branch sessions
- Token usage tracking
- Search across conversations

**Effort:** ~3 days. Hook integration + store schema extension + TUI display.

---

### 6. Sub-Agent Fan-Out (Parallel Task Decomposition)

**Gap:** Ark runs one agent per session. No within-session task decomposition or parallel agent execution. The `fork` stage type exists in flow definitions but only splits into separate sessions.

**Found in:** DeerFlow (lead agent spawns up to 3 concurrent sub-agents, synthesizes results), Goose (subagents via `summon` extension + Goosetown multi-agent orchestration with shared coordination log), Pi (subagent extension spawning separate processes).

**Solution:** Enhance the existing `fork` stage type:
- Lead agent in the current stage can request sub-agent spawning via channel
- Conductor creates child tmux sessions with shared worktree (or separate worktrees)
- Children report back via channels; conductor collects results
- Lead agent receives synthesized output and continues
- `max_parallel` already defined in flow YAML (default 4)
- Goosetown's `gtwall` (append-only shared log) pattern for coordination state

**Effort:** ~5 days. Extends existing fork infrastructure in session.ts + conductor.ts.

---

### 7. Cost Tracking from Transcripts

**Gap:** Ark has EC2 cost tracking (hourly rate + Cost Explorer) but no token/LLM cost tracking per session.

**Found in:** Agent-Deck (parses Claude transcript JSONL on Stop hooks for token usage), Factory AI (token consumption per model via OTEL), Goose (token metrics in SQLite).

**Solution:** On `Stop` and `SessionEnd` hooks, read `transcript_path` from the hook payload. Parse the last entry of the JSONL file for `usage` fields (input_tokens, output_tokens, cache_read_tokens). Store per-session token counts in SQLite. Display in TUI session detail.

**Effort:** ~1 day. Hook handler + transcript parser + store column + TUI display.

---

## P2 -- Differentiators

### 8. Turn-Level Checkpoints (Git Refs)

**Gap:** No way to roll back an agent's work to a specific turn.

**Found in:** Conductor.build (private git refs per turn, revert to any point).

**Solution:** Hook into `PostToolUse` for write/edit operations. After each turn that modifies files, create a lightweight git ref: `refs/ark/sessions/{session-id}/turn-{n}`. Enables:
- `ark session revert <id> --turn 5`
- TUI timeline view with rollback
- Diff between any two turns

**Effort:** ~2 days. Git operations in session working directory.

---

### 9. Recipe/Pipeline Templating

**Gap:** Ark's YAML pipelines are static. No variable substitution, no parameterization.

**Found in:** Goose (Jinja2 templates in recipes), Factory AI (parameterized missions), Ark's own `resolveAgent` already does `{ticket}`, `{repo}` substitution in agent prompts.

**Solution:** Extend the existing `{variable}` substitution pattern from agent prompts to flow definitions. Allow flow stages to reference session variables:

```yaml
stages:
  - name: implement
    agent: implementer
    gate: auto
    task: "Implement {ticket}: {summary}"
```

**Effort:** ~1 day. Extend flow.ts to call the same substitution logic as resolveAgent.

---

### 10. Plugin/Extension System

**Gap:** Ark has no plugin architecture. Agent definitions and flows are the only extension points.

**Found in:** Pi (full extension lifecycle with event hooks, custom tools, UI components), Goose (MCP-native extensions), Factory AI (plugin registry), DeerFlow (middleware pipeline).

**Solution (phased):**
- **Phase 1:** Implement the Agent Skills standard (agentskills.io) -- SKILL.md discovery from `.ark/skills/`, `~/.ark/skills/`, and walking up directories. Ark already references "Pi-style SKILL.md discovery" in agent.ts.
- **Phase 2:** Hook-based lifecycle events (pre/post stage transition, pre/post tool use) for custom validation, formatting, notification.
- **Phase 3:** Custom tool registration via MCP servers declared in agent definitions (already partially supported).

**Effort:** Phase 1: ~2 days. Phase 2: ~3 days. Phase 3: already works.

---

### 11. Repo-Scoped Configuration

**Gap:** Ark config lives outside the target repo. Team members cloning a repo don't get Ark configuration automatically.

**Found in:** Conductor.build (`conductor.json`), Factory AI (`AGENTS.md` walk-up-tree), E2B (`e2b.toml`).

**Solution:** Support `.ark.yaml` or `ark.json` in the target repo root:

```yaml
agents:
  - planner.yaml    # relative to .ark/agents/
flow: default
compute: local
sync: [".env", "config/local.yml"]
ports:
  - { port: 3000, name: web }
```

This complements the existing `arc.json` (which handles ports/sync/compose/devcontainer). Could merge the two or keep them separate (arc.json = compute config, .ark.yaml = orchestration config).

**Effort:** ~1 day. Loader in session.ts that reads .ark.yaml from session repo.

---

### 12. Session Forking

**Gap:** Can't fork a running session to explore parallel approaches or split a conversation.

**Found in:** Agent-Deck (fork Claude conversation with instance ID propagation), Pi (JSONL tree structure with `/fork` and `/tree` navigation), Conductor.build (workspace duplication).

**Solution:**
- `ark session fork <id>` creates a new session from the current point
- Clone worktree state (git branch or stash)
- Pass `--resume` with the original Claude session ID to the fork
- Both sessions continue independently from the branch point
- TUI shows parent-child relationship

**Effort:** ~2 days. New session.ts function + CLI command + TUI indicator.

---

### 13. Structured Review Output

**Gap:** Ark's reviewer agent produces freeform text. Results aren't machine-parseable for the conductor.

**Found in:** Factory AI (P0-P3 severity classification with file+line references and suggested fixes as structured output).

**Solution:** Define a review output schema that the reviewer agent must emit:

```json
{
  "verdict": "approve" | "request_changes",
  "issues": [
    { "severity": "P0", "file": "src/foo.ts", "line": 42, "message": "SQL injection", "suggestion": "..." }
  ]
}
```

Conductor parses this on stage completion. P0 issues auto-block the pipeline (like a `condition` gate). Lower severity issues get logged but don't block.

**Effort:** ~2 days. Schema definition + reviewer agent prompt update + conductor parsing.

---

### 14. Cron Scheduling

**Gap:** No way to schedule recurring agent work (nightly code review, daily report generation).

**Found in:** Goose (`goose schedule add` with cron expressions), Pi Mom (cron/one-shot/immediate scheduled events).

**Solution:** `ark schedule add --cron "0 2 * * *" --flow quick --repo /path --summary "Nightly review"`
- SQLite table for schedules
- Background scheduler in conductor (or system cron that calls `ark exec`)
- `ark schedule list`, `ark schedule delete`

**Effort:** ~2 days. Schedule store + cron runner + CLI commands.

---

### 15. Tiered Autonomy Controls

**Gap:** Ark uses `permission_mode: bypassPermissions` -- all or nothing. No granular control.

**Found in:** Factory AI (read-only/low/medium/high/unsafe levels with fail-fast), Goose (4 permission modes: auto/approve/smart_approve/chat with per-tool granularity).

**Solution:** Define autonomy levels that map to Claude Code permission modes + tool restrictions:

| Level | Can Read | Can Edit | Can Execute | Can Deploy |
|---|---|---|---|---|
| `read-only` | yes | no | no | no |
| `edit` | yes | yes | no | no |
| `execute` | yes | yes | yes | no |
| `full` | yes | yes | yes | yes |

Set per-stage in flow definitions: `autonomy: edit`. Conductor enforces via Claude Code flags and hook-based tool inspection.

**Effort:** ~2 days. Flow schema extension + launcher flag mapping.

---

### 16. Guardrails / Tool Authorization

**Gap:** No pre-execution validation of agent tool calls. Agents run with full permissions.

**Found in:** DeerFlow (pluggable GuardrailProvider with allowlist/OAP policy), Goose (ToolInspectionManager with chained inspectors: security, adversary, permission, repetition), Factory AI (Droid Shield for secret detection + prompt injection).

**Solution:** Use Claude Code's `PreToolUse` hook to inspect tool calls before execution:
- Hook fires before each tool use
- Ark validates against per-agent tool allowlist (already in AgentDefinition.tools)
- Exit code 2 blocks the tool call, stderr fed back to Claude
- Could check for dangerous patterns (rm -rf, secret leakage, etc.)

**Effort:** ~2 days. PreToolUse hook handler + validation rules.

---

## P3 -- Future / Larger Efforts

### 17. Session Search (Conversations, Memories, Events)

**Gap:** No way to search across session conversations, event history, or agent memories. Finding "what did the agent do about the auth bug?" requires manual digging.

**Found in:** Agent-Deck (fuzzy + regex search across all Claude JSONL transcripts), Goose (SQLite-backed conversation persistence with query).

**Solution:** Two approaches (can do both):
- **Simple (grep-style):** `ark search "auth bug"` -- scans Claude transcript JSONL files in `~/.claude/projects/*/` and Ark's event log in SQLite. Fast, no indexing needed. Filter by session, date range, role (agent/user).
- **Fancy (embeddings):** Index conversation chunks with embeddings, store in SQLite (or a vector extension). Semantic search across all sessions. Higher effort, better recall.

Start with grep-style -- it's immediate and covers 90% of use cases. Add semantic search later if needed.

Also searchable: Ark's event audit trail (`store.logEvent` entries), agent definitions, flow definitions.

**TUI integration:** Add search to the Sessions tab -- `/` key opens search, results filter the session list or show matching conversation excerpts.

**Effort:** ~2 days for grep-style. ~5 days with embeddings.

---

### 18. Create Ark Session from Existing Claude Session

**Gap:** Claude Code stores sessions locally (`~/.claude/projects/`). If you had a productive Claude conversation, there's no way to "promote" it into an Ark-managed session with pipeline tracking, compute, and conductor oversight.

**Solution:** `ark session import --claude-session <id> --repo /path/to/repo`

1. List available Claude sessions: `ark claude sessions` -- reads from Claude's local storage, shows session IDs, dates, repos, summaries
2. Import a session: creates an Ark session bound to:
   - The Claude session ID (for `--resume`)
   - The repo/workdir where the Claude session was created
   - Optionally a flow/pipeline for continued work
3. The Ark session picks up from where Claude left off:
   - `dispatch` uses `--resume <claude-session-id>` in the launcher
   - Hooks get installed for status tracking
   - Channel MCP gets wired up for conductor communication
   - Full Ark lifecycle applies from this point forward

**Discovery:** Claude stores sessions as JSONL in `~/.claude/projects/<encoded-path>/`. Each file has a session UUID. Parse the JSONL to extract: session ID, model, project path, message count, last activity timestamp, first user message (as summary).

**Binding:** The imported session stores both `session.claude_session_id` (already in Ark's schema) and `session.repo` / `session.workdir`. The `prevClaudeSessionId` field in `buildLauncher()` already supports `--resume`.

**Effort:** ~3 days. Claude session discovery + import CLI command + TUI integration.

---

### 19. Web UI

**Found in:** DeerFlow (Next.js), Factory AI, Goose (Electron), Agent-Deck (PWA at :8420).

Ark's TUI is powerful but limits accessibility. A web UI would enable:
- Team visibility into running sessions
- Mobile monitoring
- Diff review in browser
- No tmux/terminal requirement

**Effort:** Large. Separate project.

---

### 20. Multi-Provider LLM Support

**Found in:** Pi (20+ providers), Goose (20+ providers with trait abstraction), Factory AI (BYOK).

Ark currently delegates to Claude Code exclusively. Supporting Goose, Codex, or other agents would require abstracting the launch layer.

**Effort:** Large. Architectural change to session dispatch.

---

### 21. MicroVM Sandboxing (Firecracker)

**Found in:** E2B (sub-second Firecracker VMs with pause/resume and memory snapshots).

Ark's Docker provider gives container isolation. Firecracker would add hardware-level isolation with better performance. Only relevant for multi-tenant or enterprise deployments.

**Effort:** Very large. New provider implementation + infrastructure.

---

### 22. MCP Socket Pool (Shared MCP Servers)

**Found in:** Agent-Deck (Unix socket proxying, claims 85-90% memory reduction when sharing MCP server processes across sessions).

Ark launches separate MCP server processes per session. With many concurrent sessions, this wastes memory. A shared pool would proxy MCP requests from multiple sessions through a single server instance.

**Effort:** Medium. New MCP proxy layer.

---

### 23. In-VM Daemon with gRPC (envd pattern)

**Found in:** E2B (lightweight `envd` daemon inside each sandbox, exposes file I/O, process control, PTY over gRPC/ConnectRPC).

Replace SSH + tmux for remote compute interaction with a purpose-built daemon. Faster, more programmatic, typed RPC interface. ConnectRPC works over HTTP/2 with good TypeScript support.

**Effort:** Large. New daemon + protocol + provider integration.

---

### 24. Persistent Cross-Session Memory

**Found in:** DeerFlow (LLM-powered fact extraction), Goose (memory extension), Pi (MEMORY.md).

An organizational knowledge base that persists across sessions -- user preferences, repo conventions, past decisions. Currently Ark has per-agent `memories` references but no extraction or persistence system.

**Effort:** Medium. Memory extraction hook + SQLite storage + system prompt injection.

---

### 25. Chat Platform Bridges (Slack/Telegram/Discord)

**Found in:** Agent-Deck (Telegram/Slack/Discord), DeerFlow (Telegram/Slack/Feishu), Pi (Mom Slack bot).

Remote agent monitoring and control via messaging platforms.

**Effort:** Medium per platform. Express middleware or standalone bridge service.

---

## Immediate Next Steps

The recommended execution order for maximum impact:

1. **Hook-based status detection** (#1, P0) -- eliminates the biggest fragility
2. **Cost tracking from transcripts** (#7, P1) -- quick win once hooks exist
3. **Session search** (#17, P2) -- grep-style, immediate value
4. **Import Claude sessions** (#18, P2) -- bridges existing Claude work into Ark
5. **Pipeline templating** (#9, P2) -- quick win, extends existing pattern
6. **Headless CI mode** (#3, P1) -- unlocks automation use cases
7. **OTEL observability** (#4, P1) -- visibility into pipeline execution
8. **Session conversation persistence** (#5, P1) -- enables search/fork/analytics
9. **SKILL.md discovery** (#10 Phase 1, P2) -- foundational for extensibility
10. **Sub-agent fan-out** (#6, P1) -- enhances existing fork infrastructure

---

## Full Gap Inventory (25 items)

| # | Gap | Source Tool(s) | Priority | Effort |
|---|-----|---------------|----------|--------|
| 1 | Hook-based agent status | Agent-Deck, Claude Code | P0 | 2d |
| 2 | Context compaction hooks | Goose, DeerFlow | P0 | 1d |
| 3 | Headless CI mode | Factory AI, Goose | P1 | 3d |
| 4 | OTEL observability | Factory AI, Goose | P1 | 2d |
| 5 | Session conversation persistence | Goose, Pi | P1 | 3d |
| 6 | Sub-agent fan-out | DeerFlow, Goose, Pi | P1 | 5d |
| 7 | Cost tracking from transcripts | Agent-Deck, Factory AI | P1 | 1d |
| 8 | Turn-level checkpoints | Conductor.build | P2 | 2d |
| 9 | Pipeline templating | Goose, Factory AI | P2 | 1d |
| 10 | Plugin/extension system (SKILL.md) | Pi, DeerFlow, Goose | P2 | 2-5d |
| 11 | Repo-scoped config | Conductor.build, Factory AI, E2B | P2 | 1d |
| 12 | Session forking | Agent-Deck, Pi, Conductor.build | P2 | 2d |
| 13 | Structured review output | Factory AI | P2 | 2d |
| 14 | Cron scheduling | Goose, Pi | P2 | 2d |
| 15 | Tiered autonomy controls | Factory AI, Goose | P2 | 2d |
| 16 | Guardrails / tool authorization | DeerFlow, Goose, Factory AI | P2 | 2d |
| 17 | Session search | Agent-Deck, Goose | P2 | 2d |
| 18 | Import Claude sessions | (user request) | P2 | 3d |
| 19 | Web UI | DeerFlow, Agent-Deck, Goose, Factory AI | P3 | Large |
| 20 | Multi-provider LLM | Pi, Goose, Factory AI | P3 | Large |
| 21 | MicroVM sandboxing | E2B | P3 | V.Large |
| 22 | MCP socket pool | Agent-Deck | P3 | Medium |
| 23 | In-VM daemon (envd) | E2B | P3 | Large |
| 24 | Cross-session memory | DeerFlow, Goose, Pi | P3 | Medium |
| 25 | Chat platform bridges | Agent-Deck, DeerFlow, Pi | P3 | Medium |

---

## Tool-by-Tool Reference

| Tool | Key Takeaways for Ark |
|------|---------------------|
| **DeerFlow** | Sub-agent fan-out with lead/worker pattern, persistent LLM-powered memory, 17 skills as markdown modules, pluggable guardrails, Kubernetes sandbox provisioner, middleware pipeline |
| **Conductor.build** | Turn-level checkpoints via private git refs (clever + low-cost), `conductor.json` repo-scoped config, built-in diff viewer with merge recommendations, pre-merge todo checklists |
| **Agent-Deck** | Hook-based status detection via Claude Code hooks (THE pattern to adopt), MCP socket pool for memory savings, session forking with instance ID propagation, cost tracking from transcript parsing, fsnotify-based file watcher for status, hybrid hook+tmux fallback |
| **E2B** | Firecracker MicroVM sandboxing with sub-second boot, pause/resume with full memory snapshot, in-VM `envd` daemon with gRPC for programmatic file/process/PTY control, Dockerfile-based sandbox templates, per-second metering |
| **Factory AI** | Headless CI mode (`droid exec`) with tiered autonomy and structured JSON output, 13 OTEL metrics export, P0-P3 structured review output, HyperCode codebase indexing + ByteRank retrieval, organizational memory layer, Markdown-as-agent-definition format |
| **Pi** | Agent Skills standard (agentskills.io) with progressive disclosure, full extension system (tools + UI + lifecycle hooks + keyboard shortcuts), session tree branching with JSONL storage, package manager for skill/extension distribution, `pi-pods` for self-hosted GPU models |
| **Goose** | Auto context compaction at 80% window, Jinja2 recipe templating, cron scheduling, 4-tier permission system with per-tool granularity, Goosetown multi-agent coordination (gtwall shared log + Beads crash recovery), prompt injection detection, ACP protocol for IDE embedding |
| **Claude Code** | Settings hierarchy (local > project > user), hook arrays merge additively (no clobbering), 24 hook event types, HTTP hook type (POST directly, no shell scripts), `transcript_path` in hook payloads, `PreToolUse` for tool-call inspection |
