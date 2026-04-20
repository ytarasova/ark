# Collated Agreed Roadmap -- 2026-04-18

> **Purpose:** one-page plan combining the Foundary-Ark canvas, Harinder/Abhimanyu/Atul/Rohit inputs, Ark's prior ROADMAP.md, the four 2026-04-18 review docs, and the work already shipped on 2026-04-18.
>
> **Read for depth:**
> - `docs/2026-04-18-REQUIREMENTS_RECONCILIATION.md` -- per-feature evidence
> - `docs/2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` -- the two external flows
> - `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` -- hybrid delivery + pooling + codebase-memory-mcp
> - `docs/2026-04-18-UNIFIED_SUMMARY.md` -- exec summary + 12 open decisions
> - `docs/ROADMAP.md` -- the product-of-record (updated 2026-04-18)
> - **`docs/2026-04-19-PROGRESS_CHECK.md`** -- day-2 audit against this roadmap. Week-1 scorecard: 0/5 fully complete, 1/5 partial. All 8 off-roadmap gaps from reconciliation §8 remain open. Infrastructure (DI split, pause/resume, ComputePool) advanced; canvas-vocabulary items did not.

## 0. Position after 2026-04-18

Four commits on `docs/web-ui-design-final`:
- `48f069e` -- 4 dated review docs + ROADMAP 2026-04-18 section + staleness fixes
- `b9356da` -- codebase-memory-mcp vendored + agent/CLI/Web UI exposure
- `d2cb3f4` -- em-dash scrub (132 files, 691 replacements)
- *(this commit)* -- collated roadmap + cross-doc updates reflecting SHIPPED state

Pushed to `origin/docs/web-ui-design-final` (`https://github.com/ytarasova/ark`).

**Harinder's anchor:** *"90% there."* Confirmed by deep audit. Remaining work is **integration + polish + canonical vocabulary**, not new subsystems.

## 1. Agreed requirements (canonical, from canvas F0AUHKDHXME + threads)

### Design decisions (verbatim anchors)
- Workflow consistent across Paytm (token + cost optimization)
- Ability to insert LLM Router
- Support for Web (minimum) + App
- Human in the loop support
- Workflow configurable at BU level
- Canonical stages: **Thoughts -> Discussion -> PRD -> Design -> Jira -> Plan -> Review Plan (holistic: security/cost/conversions) -> Code -> Test -> PR -> PR + Holistic Review -> QA -> UAT -> Deploy -> Monitor**

### Workflow node definition
`model + skill + tools + modes { manual, agentic, co-paired (agentic + manual review), conversational }`

### Harinder's load-bearing constraint
> "These are stages of the software lifecycle. In my ideal universe, these are 90% similar across all teams. We should make it somewhat configurable in our ark/foundry systems, but in practice we should not allow huge deviations."

Implication: **ONE canonical workflow with conditional paths.** Not per-BU stitched flows.

### Feature list (14 canvas items)
Multi-tenant + multi-user -- Multi-repo dev env (+DNS) -- LLM Routing + multi-model -- MCP Router -- Auth + RBAC -- Dashboards (User/Team/BU/Org) -- Auditing -- Credentials vault -- Code indexing -- Workflow history -- Workflow observability -- Workflow UI (chat+upload, diff, terminal, logs, PR/Jira/branch summary) -- In-app browser -- Workflow nodes (with the 4 modes).

### Additional source inputs integrated
- **Atul's Foundry 2.0 deck** (2026-04-09) -- two tracks (QA Infra + AI Monitor), 2026-04-20 deadline
- **Abhimanyu's ISLC (goose-flow)** -- 9 reusable Goose recipes, master orchestrator + sub-recipes, `.workflow/<jira-key>/` artifacts, Atlassian + Bitbucket + Figma MCPs
- **Rohit's Sage integration** -- machine-generated Goose recipes (PAI-31080 = 72 steps, 3 repos), `sage-kb` MCP, docker-compose dev env (6 core + 7 profile services), multi-DB seed data
- **5-group tool-review phasing** (Abhimanyu) -- Product+Jira (P2), Dev-PR Local (P1 day), Dev-PR Remote (P1 evening), Infra+Deploy (P1 evening), Support Tools/MCPs (P1 evening)

## 2. What's already done (evidence-backed)

### Shipped + verified 2026-04-18
- **codebase-memory-mcp v0.6.0 vendored** -- 14 MCP tools auto-injected into every session's `.mcp.json` for Claude Code; wired via `--with-extension` for Goose; `mcp__codebase-memory__*` auto-added to permissions. CLI (`ark knowledge codebase status/tools/reindex`) and Web UI (`CodebaseMemoryPanel` on Memory page) surfaces live. Paper: arXiv:2603.27277 claims 10x fewer tokens, 2.1x fewer tool calls.
- **Four dated review docs** capturing the full 2026-04-18 alignment pass, cross-referenced and consistent.
- **ROADMAP staleness fixes**:
  - `.ark.yaml` worktree provisioning moved from NOT BUILT to DONE (code lives under `worktree.copy[]` + `worktree.setup`, not `provision.*`)
  - Test count claim ("89 TUI + 78 web = 167") marked STALE post-TUI-retirement
- **691 em-dash instances scrubbed** from 132 files per CLAUDE.md hygiene rule

### Previously shipped (from ROADMAP.md DONE table, verified this review)
Awilix DI -- IDatabase (SQLite + Postgres) -- Full session orchestration -- DAG flow engine with `on_outcome`, `on_failure: retry(N)`, conditional edges -- Knowledge graph (unified store) -- Agent eval system -- Universal cost tracking (300+ models) -- 5 runtime backends (Claude/Codex/Gemini/Goose/Aider) -- 12 agent roles -- Artifact tracking + per-stage `stage_start_sha` verification -- MCP config merge into worktrees -- Auto-start dispatch for all 5 runtimes -- Web UI 7-tab filter + 15s daemon health polling -- Auto-rebase before PR -- Verify stage in autonomous-sdlc -- Commit verification gates -- Worktree auto-cleanup -- Multi-tenant channel hardening -- ESLint zero-warnings -- Auth (API keys + 3 roles) -- 13 flow definitions -- 7 builtin skills -- 10 recipe templates.

## 3. Off-roadmap gaps confirmed (need product decisions)

| # | Gap | State | Owner decision needed |
|---|---|---|---|
| 1 | Canonical 15-stage SDLC vocabulary | Schema gap | Commit to the vocabulary via RFC PR |
| 2 | Node modes (manual/agentic/co-paired/conversational) | Schema gap | `mode` field on `StageDefinition`; orthogonal to `gate` |
| 3 | Loop nodes (Archon `until` / `until_bash` / `max_iterations` / `fresh_context`) | Schema gap | Adopt Archon primitives |
| 4 | Approval with rework (Archon `on_reject.prompt`) | Schema gap | Same as above |
| 5 | Centralized MCP Router | Design landed, code pending | Conductor+arkd pooling per code-intel design doc |
| 6 | Sage-KB integration contract (accept goose-recipe.yaml as session input) | Design landed, code pending | `ark session start --recipe-file <path>` Path B |
| 7 | In-App browser (UI element selector on live app) | Not started | Scope vs defer |
| 8 | Foundry 2.0 Track 2 (AI Monitor + Self-Healing) | Not on Ark roadmap | Deck promises 2026-04-20; scope inside or outside Ark |

## 4. Collated agreed plan (priority-ordered, next ~4 weeks)

Grouped by Abhimanyu's 5 phases, sequenced by dependency.

### Week 1 -- UNBLOCK PILOT (dogfood loop closes)
1. **Canonical 15-stage + 4-mode schema RFC** (no impl, just schema PR)
2. **`ark session start --param k=v`** + **`--recipe-file <path>`** (~135 LOC) -- unblocks both Abhimanyu (Path A registered ISLC recipes) and Rohit (Path B ad-hoc Sage recipes)
3. **Install Abhimanyu's 9 ISLC recipes** at `~/.ark/recipes/goose/` and smoke-test one IN-* ticket end-to-end
4. **`ark knowledge codebase reindex pi-event-registry`** dry-run on Rohit's repo + capture token numbers vs pure-Grep baseline
5. **UI polish from Abhimanyu's feedback** (`ChatPanel.tsx:117` Send->Chat; `SessionDetail.tsx:51,86-88` info tooltips on Fork/Dispatch)

### Week 2 -- BENCHMARK + UNBLOCK INFRA
6. **codebase-memory-mcp vs ops-codegraph benchmark** on 2 real Paytm repos; pick primary based on token-per-query + precision + Java correctness
7. **Camp 10 secrets vault (thin slice)** -- per-user MCP credentials for Atlassian/Bitbucket/Figma/Sage-KB; env-file injection pattern from goose-flow. Unblocks day-1 pilot.
8. **Camp 11 multi-repo (design lock + minimal impl)** -- session schema `repo -> repos[]`; worktree sibling layout; required for Rohit's 3-repo PAI-31080
9. **Goose stream-json parser** -- sub-stage progress visible in Ark's UI for both Rohit's and Abhimanyu's flows

### Week 3 -- MODEL + ROUTING
10. **LLM Router tested against real APIs** -- Anthropic + OpenAI + Google smoke; MiniMax/SambaNova/TrueFoundry adapters
11. **Per-stage model routing** -- plan with Opus, implement with MiniMax (Apr 14 decision)
12. **MiniMax/SambaNova pricing registered** in PricingRegistry so UsageRecorder attributes correctly

### Week 4 -- COLLATING
13. **Paytm-SDLC canonical flow** committed at `flows/definitions/paytm-sdlc.yaml` with all 15 stages
14. **6 new agent roles** (discussant, designer, plan-reviewer, qa-lead, deployer, monitor) as YAML stubs
15. **Archon loop + approval primitives** in `StageDefinition` schema + orchestration
16. **Pool code-intel MCPs via arkd/conductor** per design doc §5 (~780 LOC)
17. **Sage-KB proxy** through conductor for unified agent surface

### Deferred (explicit non-goals for the 4-week window)
- In-App browser (canvas feature #13) -- separate scope
- Foundry 2.0 Track 2 AI Monitor + Self-Healing -- pending Atul scope call
- GitNexus pilot -- pending PolyForm license resolution
- Tauri v2 desktop evaluation -- post-pilot
- Dashboard rollups (team/BU/org aggregations) -- post-pilot
- ACP protocol adoption -- exploratory POC only per Apr 14 decision

## 5. Ownership (as best inferred from Slack threads)

| Workstream | Lead | Support |
|---|---|---|
| Core orchestration + flow schema | Yana | Zineng |
| Codebase-memory-mcp pilot + benchmarks | Yana + Abhimanyu | -- |
| ISLC recipe port + Abhimanyu dogfood | Abhimanyu | Yana |
| Rohit/Sage integration + Camp 11 | Yana | Rohit |
| MiniMax / SambaNova / TrueFoundry router | Abhimanyu | Atul |
| Web UI conversation interface + repo dropdown | Zineng | Yana |
| Electron / Tauri desktop | Yana (Thu+) | -- |
| Adoption tracking + leadership sync | Atul | -- |
| Foundry 2.0 QA Infra + AI Monitor | Atul | TBD |
| Secrets vault (Camp 10) | Yana | Abhimanyu |

## 6. Success criteria (ship signal for the 4-week window)

- At least one pilot user (Feature Store / RU / Risk / PPSL / Insurance) has an agent autonomously identify + fix a real bug end-to-end on their own repo
- At least one Rohit-generated Sage plan (PAI-*) dispatched and run through Ark (may require Camp 11 if plan spans >1 repo)
- At least one Abhimanyu ISLC recipe (e.g. `islc-orchestrate` against an IN-* ticket) dispatched and run end-to-end
- Twice-weekly adoption review meetings running with leadership
- Token spend per session on code intelligence drops below 10K tokens (vs >50K on pure-Grep baseline) -- measured on the codebase-memory-mcp pilot

## 7. Cross-references

- `docs/ROADMAP.md` remains the detailed plan-of-record (Camps 0-14, SP1-SP11, landscape gap analysis)
- This doc is a *collated view* aligning the ROADMAP with the 2026-04-18 requirements reconciliation + code-intelligence design + flow-dispatch spec
- Updates to any of the 4 dated docs + this collated view + ROADMAP.md should stay coherent; they reference each other bidirectionally
- If tension surfaces between this doc and ROADMAP.md, **ROADMAP.md wins** -- this doc is derived summary
