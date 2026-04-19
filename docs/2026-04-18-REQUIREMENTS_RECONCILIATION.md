# Requirements Reconciliation -- 2026-04-18

> **Status:** point-in-time reconciliation of stated Paytm requirements against Ark's current code + docs.
> **Scope:** past 10 days of discussion in `#ark-init` (C0AKLLFN9GC), `#foundry-ark-sync` DM (C0ATUNM8CPK), `#ark-ppsl-experiments` DM (C0AQLGKQ601), plus the Foundary-Ark Requirements canvas (F0AUHKDHXME), Atul's Foundry 2.0 deck, and Rohit's Sage integration drop.
> **No code changes produced.** This document exists to align on *what we're building* before anything else moves.

## Authoritative source

The **Foundary-Ark Requirements canvas** (F0AUHKDHXME, Abhimanyu, 2026-04-17) + Harinder's thread feedback + Abhimanyu's thread reply are treated as the authoritative live requirements document. Harinder explicitly endorsed: *"we are 90% there. With more interviews, we can confirm / hone that part. Please maintain this."*

**Harinder's load-bearing constraint on workflow nodes:** "These are stages of the software lifecycle. In my ideal universe, these are 90% similar across all teams. We should make it somewhat configurable in our ark/foundry systems, but in practice we should not allow huge deviations in the team."

**Implication:** We build ONE canonical workflow with conditional paths (Abhimanyu's second option), NOT per-BU stitched flows.

## Corrections to initial shallow pass

An earlier pass flagged 8 ROADMAP-claimed-DONE items as needing verification. Deep source read corrects them:

| # | Item | Initial call | Actual verdict | Evidence |
|---|---|---|---|---|
| O1 | Native skill injection | needs verify | ✅ DONE | `packages/core/agent/agent.ts:161-169` -- `buildClaudeArgs()` injects skills into system prompt; tested |
| O2 | Artifact tracking + `stage_start_sha` | needs verify | ✅ DONE | `repositories/schema.ts:268` + `session-hooks.ts:387-413` -- per-stage SHA verified against HEAD |
| O3 | MCP config merge into worktrees | needs verify | ✅ DONE | `claude.ts:132-186` (merge) + `claude.ts:452-470` (cleanup) |
| O4 | Auto-start dispatch for 5 runtimes | smoke-test | ✅ DONE | All 5 via native args; `deliver-task.ts` deleted |
| O5 | Web UI status tabs + daemon | branch may conflict | ✅ DONE, branch is docs-only | `SessionsPage.tsx:12`, `useDaemonStatus.ts:15`. `docs/web-ui-design-final` has zero changes in `packages/web/src` |
| O6 | `.ark.yml` provisioning | Yana vs ROADMAP disagree | ✅ DONE (under `worktree.*`, not `provision.*`) | `packages/core/repo-config.ts:5-18` parses `worktree.copy[]` + `worktree.setup`. **ROADMAP.md is stale on this.** |
| O7 | 167-test E2E suite | verify | ❌ BROKEN CLAIM | TUI retired (0 tests); web ~13 spec files. **ROADMAP.md overcounts.** |
| O8 | Knowledge graph auto-index on dispatch | mock-only | 🟡 PARTIAL (confirmed) | `session-orchestration.ts:462` ingests remote only; no completion hook; no real arkd test |

**Two docs-staleness bugs in ROADMAP.md** (O6 and O7) should be fixed so future reconciliations compare against truth.

## Canvas features -- evidence-backed state

| # | Canvas Feature | State | Evidence / file:line | Concrete gap |
|---|---|---|---|---|
| 1 | Multi-tenant + Multi-user (PML/PPSL/Paytm) | 🟡 PARTIAL | `tenant_id` on 32 tables; `app.forTenant()`; auth disabled by default | Never tested multi-user; hosted mode untested |
| 2 | Multi-Repo Dev Environment (+DNS) | 🔮 FUTURE | None in main. Camp 11 spec'd (product manifest + sibling worktrees) | Not started. Blocks Rohit integration |
| 3 | LLM Routing + Multi-Model | 🟡 PARTIAL | `packages/router/` 30 tests, never hit real APIs | MiniMax/SambaNova/TFY adapters missing; not wired into dispatch |
| 4 | MCP Router | ❌ GAP | `mcp-pool.ts` = socket pool, not a router | Centralized routing/dispatch/load-balancing: spec + build required |
| 5 | Auth + RBAC | 🟡 PARTIAL | API keys w/ 3 roles (`auth/api-keys.ts`) | No SSO, no user-mgmt UI, no resource-level permissions |
| 6 | Dashboards (User/Team/BU/Org rollup) | 🟡 PARTIAL | Session-level dashboard + cost views | No team/BU/org aggregation |
| 7 | Auditing | ❌ GAP | `events` = operational log, not audit log | No immutable audit log of sensitive ops |
| 8 | Credentials vault | 📍 PLANNED | Camp 10 "3-4 days" spec | Not started. Per-user MCP creds, encrypted-at-rest |
| 9 | Code Indexing | 🟡 PARTIAL | ops-codegraph integrated | Never CI-tested with real repo |
| 10 | Workflow history | ✅ DONE | events + messages + artifact tables; sessions resumable | -- |
| 11 | Workflow Observability | 🟡 PARTIAL | `otlp.ts` exists, untested against real Jaeger/Tempo | No metrics dashboard, no agent-trace export |
| 12 | Workflow UI (chat, diff, terminal, logs, PR/Jira/branch) | 🟡 PARTIAL | See sub-table | See sub-table |
| 13 | In-App browser (app-specific UI select) | ❌ GAP | None. No Playwright UI, no RPC | ~200+ LOC new component + RPC |
| 14 | Workflow nodes: model + skill + tools + **modes** {manual, agentic, co-paired, conversational} | 🟡 PARTIAL | Current `gate: auto\|manual\|condition\|review` is not the 4-mode vocab | Add `mode` field; implement co-paired + conversational semantics |

### Workflow UI sub-matrix

| Sub-feature | State | Evidence |
|---|---|---|
| Chat input | ✅ present, button = "Send" | `ChatPanel.tsx:117` hardcoded `{sending ? "..." : "Send"}` |
| File upload | ❌ absent | No `<input type="file">` anywhere; no `files` param in `MessageSendParams` |
| Diff review | 🟡 plain `<pre>` render | `SessionDetail.tsx:523` -- raw stat text, no syntax highlighting |
| Terminal | ✅ full duplex | `Terminal.tsx` -- xterm.js via `/api/terminal` WS |
| Container logs | ✅ live poll | `SessionDetail.tsx:709-722` via `session/output` RPC |
| PR link | ✅ present | `SessionDetail.tsx:459-479` displays `s.pr_url` |
| Jira link | ❌ absent | Zero matches for "jira" in `packages/web/src` |
| Branch name | ✅ present | `SessionDetail.tsx:355-356` shows `s.branch` |

**One-line UI copy fixes Abhimanyu asked for (2026-04-13):**

- `ChatPanel.tsx:117` -- "Send" → "Chat"
- `SessionDetail.tsx:51,86-88` -- wrap Fork/Dispatch with Tooltip + `Info` icon (requires adding Tooltip lib)

## Canonical 15-stage workflow -- mapping and gaps

| # | Canonical Stage | Existing Ark coverage | Recommended mode | Agent needed |
|---|---|---|---|---|
| 1 | Thoughts | `brainstorm.yaml::explore→synthesize` | conversational | `worker` ✓ |
| 2 | Discussion | -- | conversational | **NEW: `discussant`** |
| 3 | PRD | `islc::ticket-intake`, `default::intake` | agentic | `ticket-intake` ✓ |
| 4 | Design | -- | co-paired | **NEW: `designer`** |
| 5 | Jira | `ticket-intake` (read-only today) | manual/agentic | `ticket-intake` ✓ (needs write) |
| 6 | Plan | `default::plan`, `autonomous-sdlc::plan` | co-paired | `planner`, `spec-planner` ✓ |
| 7 | Review Plan (security + cost + conversions) | -- | manual | **NEW: `plan-reviewer`** |
| 8 | Code | `default::implement`, `autonomous-sdlc::implement` | agentic | `implementer`, `task-implementer` ✓ |
| 9 | Test | Bundled in implement; `dag-parallel::test` | agentic | `verifier` ✓ |
| 10 | PR | `default::pr` (action `create_pr`) | agentic | -- |
| 11 | PR + Holistic Review | `default::review` | co-paired | `reviewer` ✓ + humans |
| 12 | QA | Partial via `verifier` | manual | `verifier` ✓ |
| 13 | UAT | -- | manual | **NEW: `qa-lead`** |
| 14 | Deploy | `default::close` (Jira transition, no actual deploy) | agentic | **NEW: `deployer`** |
| 15 | Monitor | `default::retro` (workflow retro, not prod monitor) | agentic | **NEW: `monitor`** |

**Vocabulary gaps:** 6 genuinely missing stages (Discussion, Design, Review Plan, UAT, Deploy, Monitor) + 6 new agent definitions.

**`mode` schema addition needed in `packages/core/state/flow.ts`:**

```ts
mode?: "manual" | "agentic" | "co-paired" | "conversational";
```

Orthogonal to `gate`: `gate` answers *should we auto-advance*, `mode` answers *who does the work*. The existing unused `autonomy` field should either be deprecated or repurposed to `mode`.

## Archon schema delta (exact, from source read)

From deep read of Archon's `dag-executor.ts` (lines 1523-2143) and the loop/approval guides. **Ark has neither primitive.**

### Loop node -- not in Ark

```yaml
loop:
  prompt: "...  $USER_MESSAGE ... $nodeId.output ... $LOOP_USER_INPUT ..."
  until: "COMPLETE"                 # completion signal string (case-insensitive)
  max_iterations: 15                # hard ceiling
  fresh_context?: false             # default: session threads across iterations
  until_bash?: "npm run test"       # exit 0 = complete
  interactive?: false               # pause after each iteration for user feedback
  gate_message?: "Approve?"         # required when interactive=true
```

Termination = signal detected OR bash exit 0 (OR logic). Supports Ralph-pattern stateless loops (`fresh_context: true`) and accumulating-context loops.

### Approval node -- not in Ark (`gate: review` is just a pause, no rework cycle)

```yaml
approval:
  message: "Review and approve"
  capture_response?: true           # stores approver comment as $nodeId.output
  on_reject?:
    prompt: "Reviewer rejected: $REJECTION_REASON. Fix and re-submit."
    max_attempts?: 3                # 1-10, default 3
```

Rework loop: user rejects → AI runs `on_reject.prompt` with `$REJECTION_REASON` substituted → session re-pauses at gate → user reviews → repeat or approve. After `max_attempts` rejections, workflow cancels.

### What Ark needs

- Add `loop` and `approval` fields to `StageDefinition` in `packages/core/state/flow.ts`
- Add `session.metadata.rejection_count` + `rejection_reason` fields
- Add `executeLoopNode()` + `executeApprovalNode()` in `session-orchestration.ts`
- Add template variables `$REJECTION_REASON`, `$USER_MESSAGE`, `$ARTIFACTS_DIR`, `$nodeId.output` -- Ark today has only `{summary}`, `{ticket}`, `{workdir}`, `{repo}`, `{branch}`

**What Ark has that Archon doesn't** (worth keeping): fork/fan_out, `on_outcome` routing, compute templates per stage, autonomy modes, verify scripts. Ark is richer on DAG + orchestration; weaker on iteration primitives.

## Rohit/Sage integration (concrete)

Rohit's `PAI-31080-goose-recipe.yaml` = 72 steps, strict TDD cadence (write_tests → implement → verify) × 24 files × 3 repos (`pi-event-registry`, `pi-action-executor`, `pi-risk-intelligence-centre-ui`). Uses `sage-kb` MCP with 5 tools.

### Sage-KB tool equivalence

| Sage tool | Ark equivalent | Status |
|---|---|---|
| `kb_search` | `knowledge/search` RPC | ✅ |
| `kb_search_repo` | `knowledge/search` + `repo_id` filter | 🟡 (needs Camp 11 `repo_id` on nodes) |
| `kb_graph` | `knowledge/context` | ✅ |
| `kb_blast_radius` | `knowledge/impact` MCP tool | ✅ |
| `kb_status` | -- | ❌ no health/readiness tool |

### docker-compose (infra-clean) topology

- **Core always-on (6):** MySQL 8, PostgreSQL (pgvector:pg15), MongoDB 7, Redis 7, Redis Cluster, Keycloak 24
- **Optional profiles (7):** Cassandra, Elasticsearch, Kafka+Zookeeper, LocalStack, Temporal, ClickHouse
- Single bridge network `pi-net`
- 20+ Prism OpenAPI mocks in `docker-compose.mocks.yml`
- Per-dev overrides via `overrides.yml.example` (local / mock / staging / skip)

### Integration cost estimate

~800 LOC + ~4 days:

1. Goose-recipe → Ark-flow translator (~400 LOC)
2. Multi-file task aggregator (~100 LOC)
3. BDD criteria few-shot injector (~50 LOC)
4. `kb_status` shim tool (~150 LOC)
5. docker-compose profile auto-selector (~100 LOC)

Ark's docker provider already supports compose detection (`packages/compute/providers/docker/compose.ts`). Missing: binding a session to a compose topology with profile selection.

## Abhimanyu's 5-group phasing (applied to canvas features)

| Group | Phase | Canvas features in scope |
|---|---|---|
| Dev-PR (Local Only) | Phase 1 -- day time, most tools follow same rules | #10 Workflow history, #12 Workflow UI (chat/diff/terminal/logs/PR/branch), #14 workflow nodes + modes, #9 code indexing -- mostly ✅/🟡 |
| Dev-PR (Remote) | Phase 1 -- evening, others present for questions | #1 Multi-tenant, #2 Multi-repo+DNS, #3 LLM routing, #5 Auth/RBAC, #8 Credentials vault -- mostly 🟡/📍 |
| Infra + Deployment | Phase 1 -- evening | #2 Multi-repo+DNS (dev-env), #11 Observability, deploy/monitor stages -- mostly 🔮 |
| Support Tools (MCPs) | Phase 1 -- evening, shouldn't take much per tool | #4 MCP Router, Sage-KB equivalent, Figma/Atlassian MCPs -- mix ❌/🟡 |
| Product + Jira Creation | **Phase 2** -- not in phase 1, day time, record sessions | #13 In-App browser, stages 1-5 (Thoughts/Discussion/PRD/Design/Jira), Mehul's/Shreyas' tools -- mostly 🔮 |

## The 11 Tool Review Questions -- Ark's own answers

So we can show Ark stands on its own criteria before reviewing other tools:

| # | Question | Ark answer |
|---|---|---|
| 1 | Ideal workflow? | 15-stage canonical (proposed `paytm-sdlc.yaml`); today: `autonomous-sdlc.yaml` (plan→implement→verify→review→pr→merge) |
| 2 | At which stage does it start? | Any -- `session start --flow X --stage Y`. Default: first stage |
| 3 | Which stages need manual intervention? | Per-stage `gate: manual` or `review`. Currently: `brainstorm` uses manual; `autonomous-sdlc` fully auto |
| 4 | Cost tracking? | ✅ PricingRegistry (300+ models), UsageRecorder, multi-dimensional attribution. Gap: MiniMax/SambaNova not registered; router→recorder not wired |
| 5 | Multi-model? | 🟡 5 runtimes (Claude/Codex/Gemini/Goose/claude-max); LLM Router for policy-based selection (untested against real APIs) |
| 6 | Team-customized system prompts? | ✅ Agents YAML per-team; Skills per-agent; `.ark.yaml` repo overrides; project-tier resource stores |
| 7 | Skip to any step? | ✅ `session start --stage X`; `session/advance --to X` RPC |
| 8 | History/session? | ✅ SQLite + events + knowledge graph; per-tenant scoping |
| 9 | Resumable sessions? | ✅ `--resume`, stage isolation `fresh` by default, `continue` for same-agent |
| 10 | Where stored? | Local: `~/.ark/ark.db` (SQLite/WAL). Hosted: Postgres via `DATABASE_URL` |
| 11 | Multi-repo? | ❌ Single `session.repo` today; Camp 11 designed, not started |

## Confirmed gaps NOT on Ark roadmap

These are requirements we heard but roadmap doesn't cover (add before planning next phase):

1. **Canonical 15-stage vocabulary** -- ROADMAP has "Pre-engineering ideate flow" (Camp 10) but not the full Thoughts→Monitor sequence
2. **Node modes** (manual / agentic / co-paired / conversational) -- distinct from existing `gate` vocabulary
3. **Loop nodes** (Archon `until` / `until_bash` / `max_iterations` / `fresh_context`)
4. **Approval with rework** (Archon `on_reject.prompt`) -- `gate: review` is just a pause, no rework cycle
5. **Centralized MCP Router** -- socket pool is not a router
6. **Sage-KB integration contract** -- ability to accept goose-recipe.yaml as session input
7. **In-App browser** (element-selection UI) -- Playwright extension exists but no UI
8. **Foundry 2.0 Track 2: AI Monitor** (Prometheus → Slack) + Self-Healing -- Atul's deck promises by 20 Apr 2026. No Ark representation

## Docs-staleness bugs in ROADMAP.md

- O6: `.ark.yaml` `worktree.copy` / `worktree.setup` IS implemented. ROADMAP still says "Worktree untracked file setup -- NOT BUILT".
- O7: Test count claim "89 TUI + 78 web = 167" is post-TUI-retirement outdated. Reality: ~13 web spec files, 0 TUI.

## Items I could not verify

- **Image contents** from Slack (15+ screenshots/diagrams -- the MiniMax pricing sheet, Abhimanyu's architecture diagrams, Rohit's Sage plan screenshot, Atul's SambaNova feedback image). I only see filenames/sizes.
- **One-time-secret URLs** (2 -- TFY API key + MiniMax key) -- single-view, already consumed by recipients.
- **Paytm internal URLs** (`pi-team.mypaytm.com/sage`, `foundry.mypaytm.com/app`, `tfy.internal.ap-south-1...`, Bitbucket internal PRs) -- not web-accessible.
- **`background-agents.com/landscape`** -- page returned only title via WebFetch (JS-rendered).
- **Open Agents demo** -- detail lives on `open-agents.dev`, not the Vercel template page.
- **X.com/Twitter posts** (8) -- auth-walled.
- **Granola meeting notes URL** (04-14 session) -- auth-walled.

## Counts

| Bucket | Count |
|---|---|
| ✅ DONE (canvas features) | 1 |
| 🟡 PARTIAL (canvas features) | 8 |
| 📍 PLANNED (canvas features) | 2 |
| 🔮 FUTURE (canvas features) | 1 |
| ❌ GAP (canvas features, off roadmap) | 2 |
| + Gap items NOT in the 14-feature canvas list | 6 |
| **Total off-roadmap gaps** | **8** |

## Suggested next steps (for decision, not action)

1. Fix the two docs-staleness bugs in `ROADMAP.md` (O6, O7)
2. Agree on the 15-stage canonical vocabulary + 4-mode terminology and codify as a schema change RFC
3. Decide whether Foundry 2.0 Track 2 (AI Monitor + Self-Healing) lives on Ark's roadmap or sits outside -- deck claims delivery by 2026-04-20
4. Decide whether Rohit/Sage integration is a Phase 1 or Phase 2 deliverable (it touches Phase 1 Infra+Deployment and Phase 2 Product+Jira)
5. Schedule the tool-review interviews (Mehul/Pace, Shreyas/Premium, Adesh/Claude-farm, and the 4 pilot teams) using Abhimanyu's 11-question template

## Addendum -- Code intelligence decisions (2026-04-18 review, later in session)

The research on code-graph / KB tooling alternatives landed a set of decisions documented in full at `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md`. Short form:

### Delivery model: **hybrid**
- **System prompt**: cached repo-map (Aider-style, tree-sitter + PageRank, ~1.5-2.5K tokens, 90% cheaper after first write via Anthropic prompt caching)
- **MCP tools (pooled)**: precise drilldown -- `find_references`, `blast_radius`, `get_definition`, `call_graph`, `search`, `context`, `co_change_history`
- Neither exclusively-system-prompt nor exclusively-MCP was acceptable; the hybrid matches how Aider, Sourcegraph Cody, and Cursor converged.

### Pooling architecture: **arkd hosts, conductor routes**
- One MCP instance per `(tenant, repo, tool)` -- not per session. 10 sessions on `pi-event-registry` share a single `codegraph-mcp` process.
- arkd spawns long-lived MCP subprocesses; conductor routes agent-side traffic by `(tenant_id, repo_id)`.
- This upgrades reconciliation §2 #4 **MCP Router** from ❌ GAP to ✅ real router, and O8 **Knowledge graph auto-index on dispatch** from 🟡 PARTIAL to ✅.
- Sage-KB and any external tenant MCPs (Atlassian, Bitbucket, Figma) proxy through the same conductor surface.

### Tool choice: **staged**
1. **Keep ops-codegraph as the base** -- already vendored, 34 languages, Java tree-sitter good. Add repo-map generator on top (~440 LOC, ~2 days).
2. **Embed codebase-memory-mcp** alongside -- MIT-licensed static C binary, 66 languages, claimed 10× fewer tokens + 2.1× fewer tool calls (arXiv:2603.27277). Vendored via same pattern as goose/codex/codegraph. See `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` §6a for the 6 concrete deltas.
3. **Pilot both in parallel** on Paytm repos, measure token-per-query + precision, keep the winner as default.
4. **Consider GitNexus** for cross-repo Cypher IF PolyForm NC license can be resolved with akonlabs.com.
5. **Skip**: Serena (LSP per-repo too heavy to pool), Understand-Anything (no MCP server), graphify (multimodal overhead), Bloop (stale, desktop-only), Sourcegraph src-cli (enterprise/cloud).

### Net gap-list update

Two items move from ❌ GAP to 📍 PLANNED (with concrete design):
- **#4 Centralized MCP Router** → design exists, ~780 LOC to build
- **Sage-KB integration contract** → conductor-side proxy path, no code on Ark's knowledge side

One new requirement surfaces from the design:
- **Aider-style repo-map generator** on top of existing ops-codegraph -- not in original canvas but required to make system-prompt delivery cost-effective

## Sources consulted

- Slack channels past 10 days: C0AKLLFN9GC, C0ATUNM8CPK, C0AQLGKQ601
- Canvas F0AUHKDHXME (Foundary-Ark Requirements)
- Google Slides 1zELDDOa1Ln7nIwnynAVd-0uWQ3ZBDkYLiSyKeX3ZIok (Foundry 2.0 deck, Atul)
- Rohit's Slack drop: `PAI-31080-goose-recipe.yaml`, `seed.zip`, `infra-clean.zip` (Downloads folder)
- `docs/ROADMAP.md` (1297 lines), `docs/SURFACE_PARITY.md` (118 lines)
- Archon source via GitHub: `dag-executor.ts` lines 1523-2143, sample workflows
- `archon.diy/book/essential-workflows/`, `archon.diy/guides/loop-nodes/`, `archon.diy/guides/approval-nodes/`
- Ark source: `packages/core/agent/agent.ts`, `packages/core/state/flow.ts`, `packages/core/services/session-orchestration.ts`, `packages/core/services/session-hooks.ts`, `packages/core/repo-config.ts`, `packages/core/claude/claude.ts`, `packages/core/repositories/{schema,artifact}.ts`, `packages/web/src/components/{ChatPanel,SessionDetail,Terminal}.tsx`, `packages/web/src/hooks/useDaemonStatus.ts`, `packages/web/src/pages/SessionsPage.tsx`, `packages/compute/providers/docker/compose.ts`, `packages/router/{providers,config,types,pricing}.ts`, `flows/definitions/*.yaml`, `agents/*.yaml`
