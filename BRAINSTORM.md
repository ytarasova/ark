# Research: Prompt-context bloat and cost

Brainstorm of distinct research angles for understanding and reducing input-token waste across Ark's dispatch pipeline. Exploration only -- no implementation decisions made here. A concrete plan should follow once an angle is picked.

## 1. What actually enters the prompt today

Every autonomous-dispatch session that runs through `SessionService.launch` -> `assembleTask` (`packages/core/services/dispatch/task-assembly.ts:23`) builds a user-message body from these components, in order:

| # | Source | File | Bound |
|---|---|---|---|
| 1 | Knowledge-graph "auto context" block (memories + related sessions + key files + learnings + skills) | `packages/core/services/dispatch-context.ts:107` -> `packages/core/knowledge/context.ts:131` | 2000 tokens / 8000 chars (5 files, 3 memories, 3 sessions, 2 learnings, 2 skills; memory=200 chars, learning=150 chars) |
| 2 | Stage task header + "you are X agent" framing | `packages/core/services/task-builder.ts:31` | unbounded (agent YAML) |
| 3 | Runtime `task_prompt` block (completion contract, `ask_user` hint, etc.) | runtime YAML, appended at `task-builder.ts:68` | unbounded (author-controlled) |
| 4 | "Previous stages" event list | `task-builder.ts:132` | unbounded (grows with rejection count) |
| 5 | Attachment previews (text files inline, binaries pointer-only) | `task-builder.ts:86` | 3000 chars per file |
| 6 | `PLAN.md` or previous stage completion summary | `task-builder.ts:146` | 3000 chars |
| 7 | `git log --oneline -10` of the worktree | `task-builder.ts:163` | 10 commits, one line each |
| 8 | Filtered conversation messages (if agent YAML defines a filter) | `task-builder.ts:188` | 500 chars per message, unbounded count |
| 9 | Repo-map tree (file paths + exports, top 200 files) | `dispatch-context.ts:124` -> `repo-map.ts:160` | 1500 tokens / 6000 chars |
| 10 | `rework_prompt` if gate/reject left one | `task-assembly.ts:46` | **unbounded** |

On top of that, the runtime's system prompt carries:

- `agent.system_prompt` (YAML body) (`packages/core/agent/agent.ts:241`)
- Appended "Completion contract" paragraph (always added, ~800 chars)
- `buildToolHints()` listing every builtin + MCP server tool (`claude/permissions.ts:81`)
- Each enabled skill's full prompt body inlined (`agent.ts:271`)
- Autonomy-mode suffix when `autonomy=full` (~350 chars)

Finally, **outside Ark's source tree**, each Claude turn also ships:

- MCP tool schema + description for every registered tool (ark-mcp 27 tools + channel + ask_user + stage_control + any connector MCPs). This is the largest variable-bytes block on most turns and Ark has no code that bounds it.
- The Claude harness's own preamble (CLAUDE.md at repo root, user MEMORY index, system reminders, skills list). This is not logged anywhere in Ark today.

## 2. What we already measure

- `UsageRecorder` (`packages/core/observability/usage.ts`) writes `usage_records` rows per session with `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, attributed by `model | provider | runtime | agent_role | tenant | user`.
- Source feeds: transcript parsers (claude, codex, gemini) during `Stop`/`SessionEnd` hooks; claude-agent's SDK `Stop` hook payload; router events.
- `PricingRegistry` covers 300+ models with `calculateCost` and a CSV export.
- Per-dispatch `prompt_sent` event records `task_length` (bytes) and the full task text (`task-assembly.ts:52`). **The task body is fully reconstructible after the fact -- but no breakdown by component is captured.**

The gap: we can see "session X burned $1.40" but cannot attribute that to "knowledge context was 8K chars, repo map was 6K, PLAN.md was 3K, MCP tool descs were 40K" without rebuilding each component from scratch.

## 3. Research approaches

### A. Instrumentation-first empirical audit (measure before you cut)

Build a "prompt composition recorder" that tags each component (1-10 above + system-prompt components + MCP tool schemas) with its byte count and emits a structured `prompt_breakdown` event per dispatch. Produce a `costs breakdown` CLI and web panel that joins this with `usage_records`.

- **Summary:** We don't know what's fat until we weigh it. Ship the scale first.
- **Deliverables:** `PromptComposition` type, recorder wired into `assembleTask` and `buildClaudeArgs`, event schema, a one-page "where do your input tokens go" report across the last N days.
- **Trade-offs:** Doesn't itself reduce cost; no experimentation component.
- **Effort:** ~1 week for recorder + event; ~3 days for the report.
- **Risks:** MCP tool schemas are the largest component on most turns and they're assembled inside the Claude CLI, not by Ark -- measuring that slice requires either a Claude SDK proxy or a stub MCP HTTP listener that Ark controls. Without that, the breakdown has a big "other" bucket.
- **Value:** This is the foundation for B, C, D. All of those rely on numbers we don't have today.

### B. Hypothesis-driven deletion study

Pick the three fattest Ark-controlled components (likely: repo-map block, auto knowledge context, completion-contract boilerplate) and A/B them. For each, add a feature flag, run paired dispatches of autonomous-sdlc flow on fixed tasks, and compare cost + stage-completion outcome.

- **Summary:** Directly answers "does removing X break anything?"
- **Deliverables:** Three flags, a paired-run harness, outcome scoring (completed? report type? PR opened?), statistical writeup.
- **Trade-offs:** Outcome is noisy even with identical inputs -- need N in the dozens per arm.
- **Effort:** 2-3 weeks including analysis; requires Rohit-tier real workloads for stable signal.
- **Risks:** Existing completed sessions are not a fair control because model behavior drifts. The experiment has to be run fresh and contemporaneously. Agent-sdk runtime is cleaner to instrument than claude-code (CLI).
- **Dependency:** Weak version possible without A, but A makes the design of B much sharper.

### C. Cache-aware prompt reordering

Anthropic's automatic prompt caching gives >90% discount on the cached prefix and has a 5-minute TTL. Today Ark (a) puts the knowledge-context block *before* the task header (variable per session), (b) inlines `{{session_id}}` / timestamps into the system prompt, and (c) relies on implicit cache hits -- no explicit `cache_control` breakpoints. Net: the cached prefix is likely short and often missed.

Restructure so that the stable content (agent.system_prompt, runtime task_prompt, completion contract, tool hints, skill prompts, per-repo repo-map) is a fixed prefix, followed by an explicit cache breakpoint, then the volatile bits (session id, task, PLAN.md). Measure cache-hit ratio before and after via `cache_read_tokens / (input_tokens + cache_read_tokens)`.

- **Summary:** Reorder rather than shrink. Same context, much cheaper.
- **Deliverables:** A "prompt layout" module that emits a prefix+breakpoint+suffix, integrated into `claude-agent` launch first (the SDK supports `cache_control`), then claude-code if CLI exposes it.
- **Trade-offs:** claude-code CLI may not expose cache_control; only claude-agent (Anthropic Agent SDK, already in use -- see `project_claude_agent_ec2.md`) can benefit immediately. Could widen the runtime gap.
- **Effort:** 2-3 weeks for claude-agent; parked for claude-code pending CLI support.
- **Risks:** Any per-session variable leaking into the "stable" prefix (timestamps, session IDs, UUIDs) defeats the cache silently. Needs a drift check.
- **Value:** Likely the largest-dollar lever. Fleet-scale dispatch sends the same prefix thousands of times; cache hit = near-free tokens.

### D. Context-usage correlation study (no code change)

Analyse existing session transcripts: was the injected content actually consulted? Concretely: did the agent's tool calls reference any file paths from the repo-map block? Did any grep/read target a file named in the "Key Files" knowledge section? Did it quote or cite a memory? Build a simple correlator script; classify each injected chunk as "cited" / "near-cited" / "unused."

- **Summary:** If 80% of the bytes we inject are never referenced, we're paying for noise.
- **Deliverables:** A one-shot analysis script that ingests `prompt_sent` events + transcripts, outputs per-component hit rate, top-wasted components.
- **Trade-offs:** Correlation isn't causation -- agent may have been primed without quoting. Treat as "suggestive" not "proof."
- **Effort:** 1-2 weeks, analysis only.
- **Risks:** Transcripts are not uniform across runtimes; claude-agent SDK transcripts and claude-code transcripts have different shapes. Coverage limited to one runtime initially.
- **Dependency:** Doesn't need A but benefits from A's event schema.

### E. MCP tool-description diet

Ark mounts 30+ MCP tools by default (27 ark tools + channel, ask_user, stage_control, connectors). Each tool ships a description and JSON schema on every turn. On sessions with several connector MCPs, tool metadata is commonly the single largest share of input tokens.

Research track: (1) measure bytes-per-tool across the current MCP catalog, (2) profile a representative session to get tool-metadata share of input tokens, (3) prototype **stage-scoped MCP mounts** -- agent YAML declares which MCP servers and/or which specific tools it needs, and the dispatcher only configures those. (4) separately, prototype description compression (terse one-line summaries for rarely-used tools, full schema only for declared `tools:` list).

- **Summary:** Don't send 30 tool schemas when the agent only calls 3.
- **Deliverables:** Audit spreadsheet, per-session tool-metadata share, design doc for stage-scoped mounts.
- **Trade-offs:** Too-terse descriptions make the model misuse or ignore tools; agents that probe tools dynamically break. Lazy mount changes the session contract.
- **Effort:** ~1 week audit, ~3 weeks for stage-scoped mount prototype.
- **Risks:** Claude caches tool blocks automatically and separately -- benefit may already be realised in cache; need cache-read numbers first (A or G).

### F. Knowledge-context ROI audit

The auto-injected knowledge block (memories, related sessions, key files, learnings, skills) adds a retrieval round-trip + up to 8K chars per dispatch. It's small vs. repo map + MCP, but it's dispatch-time, synchronous, and frequently low-signal (the related-session links in my own prompt are stubs with empty `changed:` fields).

Research track: sample 100 recent dispatches, grade each injected memory/session/learning for topical relevance to the task, compute precision@k. If <30% of injected items are relevant, replace dispatch-time injection with a `knowledge/context` MCP tool the agent calls when it wants.

- **Summary:** Is the auto-inject worth the round-trip?
- **Deliverables:** A scored sample, decision doc (keep / move to pull-model / tune scoring).
- **Effort:** 1-2 weeks analysis; ~2 weeks to flip the surface if warranted.
- **Risks:** Subjective grading introduces bias; need at least two raters.

### G. Cache telemetry quick-win

Before (or during) A, ship a minimal web/CLI view: per-session cache hit rate = `cache_read_tokens / (input_tokens + cache_read_tokens)` over time, grouped by runtime and agent. `usage_records` already has the raw columns; only the view is missing.

- **Summary:** Cheapest first look. Tells us whether the absolute size or the cache-miss rate is the real problem.
- **Deliverables:** A panel in the `costs` web tab; a `ark costs --cache` CLI column.
- **Effort:** 2-3 days.
- **Risks:** Subscription runtimes don't emit token counts the same way -- panel may have gaps for claude-max.

## 4. Suggested sequencing

1. **G** (cache telemetry, 3 days) tells us in a week whether C is the right lever.
2. **A** (instrumentation, 1-2 weeks) gives us the per-component breakdown needed to choose between E, B, F.
3. **D** (correlation study, 1-2 weeks) can run in parallel with A -- doesn't block anything.
4. Pick one of **B / C / E / F** as the follow-up implementation track based on what the above reveals.

## 5. Open questions (for the human)

1. **Audience.** Is this research for "reducing our Anthropic bill" (API mode) or "getting more work per subscription seat" (subscription mode)? Subscription cares about per-session latency more than $; API cares about total input tokens. Several approaches weigh differently between the two.
2. **Unit of analysis.** Per-dispatch? Per-session (can have many dispatches)? Per-flow run? The right aggregation affects how we design the recorder schema in A.
3. **Runtime priority.** Do we optimize for `claude-agent` (SDK, recent, gives us cache_control knobs) or `claude-code` (CLI, legacy, larger fleet today)? Pattern C is claude-agent-only in the short term.
4. **Success criteria.** Is the deliverable (a) a report identifying the biggest waste, (b) a measured reduction of some target (e.g. 40% fewer input tokens on autonomous-sdlc), or (c) an architectural change (e.g. stage-scoped MCP mounts)?
5. **Risk appetite on silent regressions.** Deletion-style approaches (B, E) and cache-reordering (C) can degrade quality in ways that only show up after dozens of runs. Do we have an outcome-quality signal beyond "report(completed) was called"?
6. **Control of the Claude harness prompt.** The largest chunks a fresh-context agent sees (CLAUDE.md + MEMORY index + skills list + MCP tool schemas) are injected by the Claude binary / SDK, not by Ark. How far do we want to go upstream? Options: (a) treat those as a fixed cost and only optimize what we control; (b) move more dispatch onto `claude-agent` where we drive the system prompt ourselves; (c) ship an MCP HTTP proxy so we can observe what the harness ships.

## 6. Findings not yet turned into approaches

- `rework_prompt` (row 10 above) is unbounded and concatenates on every rejection -- a session with 5 rejections carries 5 full rework bodies forward. Worth a one-line fix regardless of the broader research.
- `appendPreviousStageContext` lists every completed stage; a flow with 10 stages accumulates 10 bullet points per dispatch of the later stages.
- The repo map is **regenerated from disk every dispatch**. For fleet-scale EC2 launches on the same repo this is both slow and gives different byte-for-byte output as files change -- meaning prompt caching never re-hits the repo-map block even when the repo hasn't changed materially. A content-hashed on-disk cache of `generateRepoMap(repo, sha)` is an easy complementary win to approach C.
- No dispatch code today consults `input_tokens` budget before sending. `ARK_MAX_BUDGET_USD` exists but is a post-hoc cap, not a pre-flight one. A "reject this dispatch if estimated prompt > N tokens" guard is absent.

---
*Written 2026-05-04 by Ark agent during `research-prompt-context-bloat-cost` exploration stage. No implementation changes were made in this session.*
