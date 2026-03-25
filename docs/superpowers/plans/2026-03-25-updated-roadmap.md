# Ark Roadmap — Updated March 25, 2026

> Integrates original 25-item gap analysis + Mission Control (Autensa) research findings.

## Status Summary

**Shipped (12 of 25 original items):**
1. ✅ Hook-based agent status
2. ✅ Context compaction hooks
3. ✅ Headless CI mode (`ark exec`)
5. ✅ Session conversation persistence (via FTS5)
7. ✅ Cost tracking from transcripts
9. ✅ Flow templating (`{variable}` substitution)
11. ✅ Repo-scoped config (`.ark.yaml`)
14. ✅ Cron scheduling
15. ✅ Tiered autonomy (full/execute/edit/read-only)
17. ✅ Session search + FTS5 indexing
18. ✅ Import Claude sessions

**Also shipped (not in original plan):**
- Tab restructure (6 tabs: Sessions|Agents|Tools|Flows|History|Compute)
- History tab with unified conversation view
- TUI design system (status bar owns hints, async everything)
- ScrollBox for all lists with page/home/end
- Full async conversion (EC2, Docker, local, tmux providers)
- Provider-driven isolation modes
- Session name sanitization
- Preserved claude_session_id on stop

---

## Remaining Items + New Items from Mission Control

### Tier 1 — High Impact (P1)

| # | Item | Source | Effort | Description |
|---|------|--------|--------|-------------|
| 4 | **OTEL observability** | Factory AI, Goose | 2d | Export metrics (session duration, token usage, stage timing) to any OTLP collector |
| 6 | **Sub-agent fan-out** | DeerFlow, Goose, Mission Control (Convoy) | 5d | Parallel task decomposition with dependency DAG. Extends existing fork stage type. Mission Control's "Convoy Mode" is the reference implementation |
| 26 | **Fail-loopback** | Mission Control | 2d | When test/review stage fails, automatically re-dispatch to the previous stage with the exact error. Not just "retry" — inject specific failure context. Conditional gate that re-enters previous stage |
| 27 | **Skill extraction** | Mission Control | 3d | After task completion, LLM analyzes the session and extracts reusable procedures (build steps, deploy scripts, config patterns). Store in SQLite with confidence scoring. Inject into future dispatches of same agent/repo |

### Tier 2 — Important (P2)

| # | Item | Source | Effort | Description |
|---|------|--------|--------|-------------|
| 10 | **Plugin system (SKILL.md)** | Pi, DeerFlow | 2-5d | Agent Skills standard, progressive discovery, skill loading |
| 12 | **Session forking** | Agent-Deck, Pi, Conductor.build | 2d | Fork a conversation to explore parallel approaches |
| 13 | **Structured review output** | Factory AI, Mission Control | 2d | P0-P3 severity, machine-parseable reviews. Feeds into fail-loopback |
| 16 | **Guardrails / tool authorization** | DeerFlow, Goose, Factory AI | 2d | PreToolUse hook for tool inspection/blocking |
| 28 | **Learner agent / knowledge base** | Mission Control | 3d | Fires on every pass/fail stage transition. Captures lessons into a knowledge table. Injected into future dispatches. Complements skill extraction (#27) |
| 29 | **Checkpoint & crash recovery** | Mission Control | 2d | Save structured state snapshots at stage boundaries (files modified, current step). On crash/re-dispatch, inject checkpoint context so agent resumes where it left off |
| 30 | **Auto-rollback pipeline** | Mission Control | 3d | GitHub webhook monitors merged PRs. Post-merge health check. Auto-creates revert PR on failure. Demotes session to supervised autonomy. New action type: `health_check` |

### Tier 3 — Future (P3)

| # | Item | Source | Effort | Description |
|---|------|--------|--------|-------------|
| 19 | **Web UI** | DeerFlow, Agent-Deck, Goose, Mission Control | Large | Browser dashboard. Mission Control is a full Next.js app — useful reference |
| 21 | **MicroVM sandboxing** | E2B | V.Large | Firecracker VMs |
| 22 | **MCP socket pool** | Agent-Deck | Medium | Share MCP servers across sessions |
| 23 | **In-VM daemon (gRPC)** | E2B | Large | Replace SSH with purpose-built daemon |
| 24 | **Cross-session memory** | DeerFlow, Goose, Pi, Mission Control | Medium | Persistent knowledge base. Mission Control's "Learner agent" (#28) is the structured version of this |
| 25 | **Chat platform bridges** | Agent-Deck, DeerFlow, Pi | Medium | Slack/Telegram/Discord |
| 31 | **Preference learning** | Mission Control | Medium | Human feedback (approve/reject) adjusts future agent prompts. Bayesian confidence on learned preferences |
| 32 | **Idea dedup / similarity** | Mission Control | Medium | Embedding-based deduplication. Auto-suppress similar items |

---

## Recommended Execution Order

### Phase 1: Agent Intelligence (next)
1. **#26 Fail-loopback** (2d) — immediate quality improvement, builds on existing flow gates
2. **#27 Skill extraction** (3d) — compound knowledge over time
3. **#28 Learner agent** (3d) — institutional memory from pass/fail transitions
4. **#13 Structured review output** (2d) — feeds into fail-loopback

### Phase 2: Robustness
5. **#29 Checkpoint recovery** (2d) — resilience for long-running sessions
6. **#16 Guardrails** (2d) — safety for autonomous agents
7. **#4 OTEL observability** (2d) — visibility into the system

### Phase 3: Scale
8. **#6 Sub-agent fan-out** (5d) — parallel execution with DAG
9. **#30 Auto-rollback** (3d) — safety net for auto-merge
10. **#10 Plugin system** (2-5d) — extensibility

### Phase 4: Platform
11. **#12 Session forking** (2d)
12. **#19 Web UI** (large)
13. **#25 Chat bridges** (medium)

---

## What Ark Has That Mission Control Doesn't

- **Multi-compute dispatch** (local, Docker, EC2) — Mission Control is local + one remote gateway
- **TUI** — Mission Control is web-only
- **Hook-based agent status** — Mission Control polls activity timestamps
- **Tiered autonomy per stage** — Mission Control has per-product automation tiers
- **Flow templating** — Mission Control has hardcoded pipeline stages
- **Repo-scoped config** — Mission Control configures via web UI only
- **Claude Code native integration** — Mission Control uses OpenClaw Gateway
- **FTS5 conversation search** — Mission Control has no transcript search
- **Headless CI mode** — Mission Control's API is web-first, not CI-first

---

## Architecture Principles (from this session)

1. **All TUI operations async** — use `asyncState.run()` for all I/O, no exceptions
2. **Status bar owns all hints** — no inline shortcuts in panels/forms
3. **FTS5 is the conversation store** — hooks feed it real-time, both tabs read from it
4. **Providers declare capabilities** — isolation modes, compute features are provider-driven
5. **Flows are the orchestration primitive** — stages, gates, autonomy, templates all live here
6. **Hooks for status, channels for communication** — separate concerns
7. **Incremental everything** — cache refreshes, index updates, transcript parsing
