# Ark -- State of the Union -- 2026-04-19

> **Status:** consolidated view across the six tracking docs + current main.
> **Audience:** Yana, Zineng, Abhimanyu, Atul, Harinder, plus pilot leads.
> **Read first:** §1 Headline -- the single-screen answer.
> **Read in depth:** §5 What's Done, §6 What's Blocked, §7 Forward Plan.

## 1. Headline

- **Two-day alignment pass delivered.** Five dated review docs published on 2026-04-18 (reconciliation, Rohit/Abhimanyu flow support, code-intelligence design, unified summary, collated roadmap) plus a 2026-04-19 progress audit. These are the point-in-time record.
- **Correction 2026-04-19 (later in day):** ad-hoc recipe-file dispatch is already shipped via the general `inputs.files` + `inputs.params` contract on both CLI (`--file role=path` + `--param k=v` at `packages/cli/commands/session.ts:42-67`) and Web UI (`InputsSection` component). This closes item 6 of the reconciliation §8 off-roadmap gap list -- 7 of 8 remain, not 8.
- **codebase-memory-mcp integration SHIPPED** (PR #202, merged into main). v0.6.0 static C binary vendored; 14 code-intelligence tools auto-injected into every agent session; CLI + Web UI surfaces live. Paper: arXiv:2603.27277 claims 10x fewer tokens + 2.1x fewer tool calls vs pure-Grep baselines.
- **Harinder's anchor:** *"We are 90% there."* Deep audit confirms. Remaining work is vocabulary alignment + integration + polish, not new subsystems.
- **Compute platform advanced materially** since 2026-04-18: Awilix DI split, SnapshotStore + pause/resume, ComputePool with Firecracker warm pool, polymorphic ProviderFlagSpec, session/dispatch RPC retired, SOLID audits + 6 structural refactors.
- **But all 8 off-roadmap canvas gaps remain open.** 24-hour audit shows Week-1 scorecard of 0/5 fully complete, 1/5 partial. Infrastructure compounded; canvas vocabulary and pilot-unblock items did not.
- **Pilot unblock: 1-2 days of focused scope.** The remaining Week-1 items are all small (UI copy tweaks, CLI flag, RFC PR, recipe install). None require new architecture. Recommend sequencing one per day.

## 2. Where we were

Starting point on 2026-04-18 (from the Foundary-Ark Requirements canvas F0AUHKDHXME + Harinder/Abhimanyu thread replies + Atul's Foundry 2.0 deck + Rohit's Sage integration drop):

- **14 features** in the canvas
- **15 canonical SDLC stages** (Thoughts -> Monitor)
- **4 workflow node modes** (manual / agentic / co-paired / conversational)
- **5 tool-review phases** (Abhimanyu's grouping)
- **11 tool-review questions** as an evaluation harness
- **8 off-roadmap gaps** surfaced by the reconciliation
- **2 docs-staleness bugs** in `ROADMAP.md`, fixed in PR #202

## 3. Where we are (2026-04-19)

Main is at `98d6d188` with **148 commits since PR #202 merged**. Net state against the 25-item audit in `docs/2026-04-19-PROGRESS_CHECK.md`:

| Bucket | Count |
|---|---|
| ✅ SHIPPED | 4 (all infrastructure since 2026-04-18) + 1 (codebase-memory-mcp integration PR #202 itself) |
| 🟡 PARTIAL | 7 |
| ❌ GAP | 11 |
| 🔮 FUTURE | 3 |

**Of the 8 off-roadmap gaps in reconciliation §8: ALL 8 remain open or partial.** No product-facing canvas gap closed in the last 24 hours.

## 4. What's published (doc inventory)

Six tracking docs in `docs/` carry the point-in-time record. All are interlinked:

| Doc | What it is | Read when |
|---|---|---|
| `ROADMAP.md` | Plan-of-record: 14 Camps + 11 SPs + landscape gap analysis; 2026-04-18 review section at top | Planning across weeks/months |
| `2026-04-18-REQUIREMENTS_RECONCILIATION.md` | 14 canvas features x Ark state with file:line evidence; 8 off-roadmap gaps; docs-staleness audit | Understanding the canvas-to-code mapping |
| `2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` | Goose recipe schema comparison; hybrid Path A + Path B dispatch spec; ~135 LOC first slice | Implementing Sage/ISLC dispatch |
| `2026-04-18-CODE_INTELLIGENCE_DESIGN.md` | Hybrid repo-map + pooled MCP architecture; codebase-memory-mcp vendoring plan; KB/KG facade; storage (S3 or Postgres) | Designing the code-intel infra work |
| `2026-04-18-UNIFIED_SUMMARY.md` | Executive summary + 12 open decisions | Quick alignment read |
| `2026-04-18-COLLATED_ROADMAP.md` | Collated Week-1-to-Week-4 plan with ownership + success criteria | Weekly scheduling |
| `2026-04-19-PROGRESS_CHECK.md` | 25-row audit against the 2026-04-18 gap list; day-2 delta | Daily status check |
| `2026-04-19-STATE_OF_UNION.md` | **This doc** | Single-screen current-state briefing |

## 5. What's done (shipped matrix)

### Since 2026-04-18 (infrastructure, 148 commits)

| PR | What | Evidence |
|---|---|---|
| #202 | codebase-memory-mcp v0.6.0 vendored; 14 MCP tools auto-injected for Claude + Goose; `ark knowledge codebase` CLI; Web UI `CodebaseMemoryPanel` | `packages/core/knowledge/codebase-memory-finder.ts`; `writeChannelConfig` injection; `vendor/versions.yaml`; `scripts/vendor-codebase-memory-mcp.sh` |
| #201 | SnapshotStore + session pause/resume (Phase 3 foundation) | `packages/core/services/session-snapshot.ts`; `packages/compute/core/snapshot-store.ts` + `-fs.ts`; tests |
| #231 | session/dispatch RPC removed (v2 with e2e fixes) | RPC surface removed; auto-dispatch on creation preserved |
| #232, #234 | ComputePool + LocalFirecrackerPool; wired into ComputeTarget dispatch | `packages/compute/core/pool/local-firecracker-pool.ts`; warm-pool of microVMs |
| #233, #235, #236, #237 | FlyMachines added, arkd-bundled Docker image, 6PN tunnel, then Fly + E2B dropped (self-hosted only) | SaaS backends off; on-prem focus |
| #238 | Polymorphic ProviderFlagSpec registry for CLI | Generic `compute <provider>` flag dispatch |
| #246 | SOLID audit top-20 findings + 6 structural refactors | Audit-driven cleanup |
| #247 | stage-orchestrator.ts split into focused modules + architecture audit | Single-responsibility modules |
| #248 | Awilix DI split (sessions + compute migrated) | `packages/core/di/` with PROXY injection (bun build compatible) |

### Previously shipped (from ROADMAP.md DONE table, verified 2026-04-18)
Awilix DI container -- IDatabase (SQLite + Postgres) -- Full session orchestration -- DAG flow engine with `on_outcome` + `on_failure: retry(N)` + conditional edges -- Unified knowledge graph -- Agent eval system -- Universal cost tracking (300+ models) -- 5 runtime backends (Claude / Codex / Gemini / Goose / Aider) -- 12 agent roles -- Artifact tracking + per-stage `stage_start_sha` verification -- MCP config merge into worktrees -- Auto-start dispatch for all 5 runtimes -- Web UI 7-tab filter + 15s daemon health polling -- Auto-rebase before PR -- Verify stage in autonomous-sdlc -- Commit verification gates -- Worktree auto-cleanup -- Multi-tenant channel hardening -- ESLint zero-warnings -- Auth (API keys + 3 roles) -- 13 flow definitions -- 7 builtin skills -- 10 recipe templates.

## 6. What's blocked (gaps still open after 24 hours)

All 8 off-roadmap gaps from reconciliation §8. These are **product/schema decisions**, not engineering effort:

| Gap | Cost to ship | What unblocks when it ships |
|---|---|---|
| Canonical 15-stage SDLC vocabulary (Thoughts -> Monitor) | RFC PR only (~0.5 day) | Every new flow, every tool review, every BU onboarding |
| Node modes {manual / agentic / co-paired / conversational} | Schema change on `StageDefinition` (~0.5 day code + tests) | Abhimanyu's entire node-definition thread |
| Loop nodes (Archon `until_bash` / `max_iterations` / `fresh_context`) | ~200 LOC in `state/flow.ts` + orchestrator | Ralph-pattern iterative loops |
| Approval with rework (Archon `on_reject.prompt`) | ~150 LOC; session metadata fields | Human-in-the-loop refinement cycles |
| Centralized MCP Router (arkd hosts + conductor routes) | ~780 LOC per design doc §5 | Pooling MCPs across sessions (Camp 10 + Camp 11 converge here) |
| ~~Sage-KB / ad-hoc recipe file dispatch~~ | ✅ **SHIPPED** | Both CLI and Web UI support via general `inputs.files` + `inputs.params` contract (CLI `--file role=path` + `--param k=v`; Web UI flow-aware InputsSection). See `packages/cli/commands/session.ts:42-67` and `packages/web/src/components/session/InputsSection.tsx`. More general than the 2026-04-18 spec. |
| In-App browser (UI element selector on live app) | ~200 LOC + Playwright embed | Canvas feature #13 |
| Foundry 2.0 Track 2 (AI Monitor + Self-Healing) | Unscoped; Atul's deck promises 2026-04-20 | Separate track; outside Ark roadmap unless decision lands |

## 7. Forward plan (next 5-7 working days)

Revised from `COLLATED_ROADMAP.md` Week 1 based on what actually landed vs slipped. Priority: close the cheap canvas items first, then pick one big gap per day.

### Day 1 -- UI polish (quarter day)
1. `ChatPanel.tsx:117` rename `"Send"` -> `"Chat"` (Abhimanyu 2026-04-13)
2. `SessionDetail.tsx:51, 86-88` add Info tooltips on Fork + Dispatch buttons (Abhimanyu 2026-04-13)
3. ~~Ad-hoc recipe-file dispatch~~ **already shipped** via general inputs contract (`--file role=path` + `--param k=v`) on both CLI and Web UI. Confirm with a real dispatch against Rohit's `PAI-31080-goose-recipe.yaml` on Day 2.

### Day 2 -- Dogfood Path A (Abhimanyu ISLC)
4. Copy the 9 ISLC recipes (`~/Downloads/islc-*.yaml`) to `~/.ark/recipes/goose/`
5. Dispatch one real IN-* ticket through `ark session start --runtime goose --recipe islc-orchestrate --param jira_key=IN-xxxx`
6. Capture what works + what breaks; file issues for each concrete gap

### Day 3 -- 15-stage + 4-mode schema RFC
7. Draft a `mode: manual | agentic | co-paired | conversational` addition to `StageDefinition`
8. Draft a `flows/definitions/paytm-sdlc.yaml` with all 15 stages as a universal flow (Abhimanyu's option 2)
9. PR the RFC with no orchestrator impl yet -- just schema + 1 example flow + docs

### Day 4 -- Token-efficiency benchmark
10. Pick two Paytm repos (Rohit's `pi-event-registry` + a PML repo)
11. Run the same 10 canonical agent queries through both paths: pure-Grep baseline vs codebase-memory-mcp tools
12. Measure tokens/query + latency + precision; publish results

### Day 5 -- Pick one big gap and ship it end-to-end
Options (pick based on what Day 1-4 reveals):
- Option A: **MCP Router pooling** (design exists in §5 of `CODE_INTELLIGENCE_DESIGN.md`)
- Option B: **Sage-KB integration contract** (Path B end-to-end)
- Option C: **Canonical stages flow with orchestrator support** (Day 3 RFC made real)
- Option D: **Camp 10 secrets-vault thin slice** (unblocks every pilot dispatch)

## 8. Team + ownership

From `COLLATED_ROADMAP.md` §5 (no changes):

| Workstream | Lead | Support |
|---|---|---|
| Core orchestration + flow schema | Yana | Zineng |
| codebase-memory-mcp pilot + benchmarks | Yana + Abhimanyu | -- |
| ISLC recipe port + Abhimanyu dogfood | Abhimanyu | Yana |
| Rohit/Sage integration + Camp 11 | Yana | Rohit |
| MiniMax / SambaNova / TrueFoundry router | Abhimanyu | Atul |
| Web UI conversation interface + repo dropdown | Zineng | Yana |
| Electron / Tauri desktop | Yana | -- |
| Adoption tracking + leadership sync | Atul | -- |
| Foundry 2.0 QA Infra + AI Monitor | Atul | TBD |
| Secrets vault (Camp 10) | Yana | Abhimanyu |

## 9. Open product decisions

12 decisions carry over from `UNIFIED_SUMMARY.md` §10. Highest priority (blocking Week-1 / Week-2 execution):

1. **Commit to hybrid code-intel delivery** (repo-map in system prompt + pooled MCP drilldown). Design is landed; implementation is deferred. Say yes or no.
2. **15-stage vocabulary + 4-mode schema -- RFC path forward.** Day-3 target above.
3. **Rohit/Sage integration -- P1 or P2?** Day-2 dogfood will answer.
4. **Secrets-vault urgency.** Both Rohit and Abhimanyu need per-user MCP creds on day-1 of pilot. Today users configure goose manually. Camp 10 work (~5-6 days combined) should jump priority.
5. **Recipe registry for Goose recipes.** Reserve `~/.ark/recipes/goose/` for registered Goose recipes (Path A), or stay file-path-only (Path B only)?
6. **Sage-KB equivalence.** Short-term: let goose call `sage-kb` directly (network reachability caveat). Long-term: bridge `sage-kb` <-> Ark knowledge MCP.
7. **Foundry 2.0 Track 2 scope.** Atul's deck promises AI Monitor + Self-Healing by 2026-04-20 (today). In Ark or out?
8. **codebase-memory-mcp pilot benchmark.** Day 4. Keeper or one of two?
9. **Storage backend in control-plane mode.** S3 or Postgres both approved. Pick per workload after pilot.
10. **Sunset ops-codegraph?** Dual-stack is active; retirement pending benchmark outcome.
11. **Web UI file upload + Jira link + diff-with-syntax.** Day 1 covers two of three; Jira link needs discovery API + UI.
12. **Codify Archon loop + approval primitives.** Decision: adopt now as part of schema RFC, or defer until specific flow needs them.

## 10. Success signal (ship criteria for the 4-week window)

From `COLLATED_ROADMAP.md` §6 -- unchanged:

- At least one pilot user (Feature Store / RU / Risk / PPSL / Insurance) has an agent autonomously identify + fix a real bug end-to-end on their own repo
- At least one Rohit-generated Sage plan (PAI-*) dispatched and run through Ark (may require Camp 11 if plan spans >1 repo)
- At least one Abhimanyu ISLC recipe (e.g. `islc-orchestrate` against an IN-* ticket) dispatched and run end-to-end
- Twice-weekly adoption review meetings running with leadership
- Token spend per session on code intelligence drops below 10K tokens (vs >50K on pure-Grep baseline) -- measured on the codebase-memory-mcp pilot

## 11. Risks worth naming

- **Foundry 2.0 Track 2 deadline is today.** Atul's Google Slides deck (2026-04-09) promised both tracks by 2026-04-20. Track 1 (QA Infra) is overlap with Camp 10 + Camp 11 work. Track 2 (AI Monitor + Self-Healing) has no Ark representation. If the promise is live, we need a plan this week, even if that plan is "Track 2 is a separate track."
- **Week-1 slip.** 5 small canvas items did not land. If the pattern continues, pilot onboard for PML / RU / Risk / Insurance slips.
- **Dual-stack debt.** codebase-memory-mcp runs alongside ops-codegraph. Harmless for a week; debt if not retired after benchmark.
- **No real pilot dispatch attempted.** We have not run Rohit's PAI-31080 or any of Abhimanyu's ISLC recipes against a live Paytm repo. The integration docs are theoretical until this happens.
- **Secrets vault is a day-1 pilot blocker.** Every MCP that needs credentials (Atlassian, Bitbucket, Figma, Sage-KB) requires a user to hand-edit `~/.config/goose/config.yaml` today. That's a day-1 recruit-onboarding friction.

## 12. Cross-references

- `docs/ROADMAP.md` -- plan-of-record (Camps 0-14, SPs 1-11, landscape gap analysis)
- `docs/2026-04-18-REQUIREMENTS_RECONCILIATION.md` -- per-feature evidence, 8 off-roadmap gaps, docs-staleness audit
- `docs/2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` -- hybrid dispatch spec
- `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` -- hybrid + pooled MCP + codebase-memory vendoring + KB/KG facade
- `docs/2026-04-18-UNIFIED_SUMMARY.md` -- executive summary + 12 open decisions
- `docs/2026-04-18-COLLATED_ROADMAP.md` -- Week-1-to-Week-4 plan with ownership + success criteria
- `docs/2026-04-19-PROGRESS_CHECK.md` -- 25-row audit table with file:line evidence
- **This doc:** single-screen briefing across all the above

---

*Next state-of-the-union: 2026-04-26, or sooner if any of the Day 1-5 actions land materially.*
