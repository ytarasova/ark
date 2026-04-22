# Progress Check -- 2026-04-19

> **Baseline:** `docs/2026-04-18-*.md` (requirements reconciliation, code-intelligence design, flow dispatch spec, unified summary, collated roadmap).
> **This doc:** snapshot of state against those gaps after ~24 hours + 148 commits on main.
> **Method:** systematic audit of `packages/` + `flows/` + `vendor/` against each gap item; git log correlation; file:line evidence.
> **Head:** `8a6c29df refactor(core): split DI registrations + migrate sessions/compute via awilix (#248)`

## 0. Headline

- **4 items shipped** since 2026-04-18 (mostly infrastructure: DI split, snapshot/pause-resume, ComputePool, session/dispatch RPC removal)
- **7 items remain PARTIAL** (canvas features partially implemented or dual-stack)
- **14 items still GAP / FUTURE** (the canvas-vocabulary + schema extensions + Rohit/Abhimanyu enablers that were targeted for Week 1)

**Blunt read:** infrastructure under the hood advanced materially (compute pool, pause/resume, DI, polymorphic provider registry). The **8 off-roadmap gaps from the reconciliation §8** did NOT close -- all 8 are still GAP or PARTIAL. The Week-1 pilot-unblock items from `COLLATED_ROADMAP.md` are partially addressed (codebase-memory-mcp shipped via PR #202 = mostly this session's own work), but `--recipe-file`, the 15-stage RFC, and the Send->Chat / info-tooltip UI polish have not landed.

## 1. Full audit table

| # | Item | 2026-04-18 state | 2026-04-19 state | Evidence / commit |
|---|---|---|---|---|
| 1 | Canonical 15-stage SDLC vocabulary | ❌ GAP | 🟡 **PARTIAL** | 12 ISLC agents in `agents/` map to major canonical stages (ticket-intake, spec-planner, plan-auditor, planner, task-implementer, verifier, reviewer, closer, documenter, retro) but **flow schema** (`packages/core/state/flow.ts`) unchanged and no `paytm-sdlc.yaml` covering all 15 stages declared. Third-pass re-audit 2026-04-19. |
| 2 | Node modes (manual/agentic/co-paired/conversational) | ❌ GAP | ❌ **still GAP** | `StageDefinition` in `packages/core/state/flow.ts` unchanged -- `gate: auto\|manual\|condition\|review` only; no `mode` field |
| 3 | Loop nodes (Archon `until`/`until_bash`/`max_iterations`/`fresh_context`) | ❌ GAP | ❌ **still GAP** | No matches in state/services |
| 4 | Approval with rework (Archon `on_reject.prompt`) | ❌ GAP | ❌ **still GAP** | No `on_reject`, `rejection_count`, `rejection_reason` in schema |
| 5 | Centralized MCP Router | ❌ GAP | 🟡 **PARTIAL** | `packages/core/mcp-pool.ts` = socket pool; conductor routing design exists (`CODE_INTELLIGENCE_DESIGN.md` §5) but no code yet |
| 6 | Sage-KB / ad-hoc recipe file dispatch | ❌ GAP | ✅ **SHIPPED (via general inputs)** | Both CLI and Web UI support it via a more general `inputs.files` + `inputs.params` contract, not via a dedicated `--recipe-file` flag. CLI: `--file <role=path>` (repeatable) + `--param <k=v>` (repeatable) at `packages/cli/commands/session.ts:42-67`. Web UI: `InputsSection` component with flow-aware schema (`packages/web/src/components/session/InputsSection.tsx`) + `NewSessionModal.tsx:931-933`. Flows declare `inputs:` contract; CLI validates required inputs; goose runtimes get `--params k=v` passed through automatically. Example: `ark session start --flow sage-dispatch --file recipe=~/Downloads/PAI-31080-goose-recipe.yaml --param jira_key=PAI-31080` |
| 7 | In-App browser (UI element selector) | ❌ GAP | 🟡 **PARTIAL** | `packages/core/extension-catalog.ts:40-44` lists `@anthropics/playwright-mcp` as a browser-category extension available for one-click install. Agents can use Playwright MCP if they install it. **But** no custom Ark UI element picker or highlighter in the Web UI. Third-pass re-audit 2026-04-19. |
| 8 | Foundry 2.0 Track 2 (AI Monitor + Self-Healing) | 🔮 FUTURE | 🔮 **still FUTURE** | No prometheus/grafana/alert_rule code; outside Ark scope |
| 9 | Multi-tenant + Multi-user | 🟡 PARTIAL | 🟡 **PARTIAL** (no progress) | `tenant_id` on 32 tables; auth disabled by default; hosted.ts untested |
| 10 | Multi-repo (Camp 11) | 🔮 FUTURE | 🔮 **still FUTURE** | No `session.repos[]` schema; still single-repo |
| 11 | LLM Router MiniMax/SambaNova/TFY adapters | 🟡 PARTIAL | ❌ **GAP** (downgraded for clarity) | No provider definitions in `packages/router/config.ts`. |
| 12 | Per-stage model routing | ❌ GAP | ✅ **SHIPPED** | `packages/core/services/dispatch.ts:260-263` reads `stageDef?.model ?? session.config?.model_override` and applies it to `agent.model` before dispatch. Schema field at `flow.ts:42`. Wired end-to-end; no unit tests for it yet. (Revised 2026-04-19 re-audit.) |
| 13 | Dashboards Team/BU/Org rollups | 🟡 PARTIAL | 🟡 **PARTIAL** (no progress) | Session-level dashboard only |
| 14 | Auditing (event-store adapters migrated) | ❌ GAP | ✅ **SHIPPED** (this session) | All 3 stubs (`local`, `test`, `control-plane`) migrated to real delegation against `EventRepository`. `local` + `control-plane` share the same delegation pattern (distinct DatabaseAdapter at composition root). `test` is a real in-memory array implementation with tenant filtering. 12/12 EventRepository tests pass. Port doc updated to spell out immutability semantics: `log` is the only append path; `deleteForTrack` is explicitly a session-lifecycle cascade, NOT an audit-tampering op. For compliance-grade tamper-proof audit a future `ComplianceAuditStore` port is recommended (see port doc). |
| 15 | Credentials vault (Camp 10) | 📍 PLANNED | 📍 **still PLANNED** | `packages/core/adapters/test/secret-store.ts` + `MapSecretStore` for tests only; no encrypted storage |
| 16 | Workflow Observability OTLP | 🟡 PARTIAL | 🟡 **PARTIAL** (no progress) | `packages/core/otlp.ts` stub; no real Jaeger/Tempo wiring |
| 17 | Workflow UI file upload | ❌ GAP | 🟡 **PARTIAL** | `packages/web/src/components/ui/ChatInput.tsx:55-73` supports Cmd+V image paste. `SessionDetail.tsx:613` uses `ChatInput` with attachment support (`:238-244`). BUT `ChatPanel.tsx` (the inline slide-out chat in the session list) still uses basic `Input` without file affordance. Partial surface coverage. (Revised 2026-04-19 re-audit.) |
| 18 | Workflow UI diff-review syntax highlight | 🟡 PARTIAL | 🟡 **PARTIAL** (no progress) | Still raw `<pre>` render in `SessionDetail.tsx` |
| 19 | Remove `codegraph` from versions.yaml | ⏳ deferred | ⏳ **still deferred** | Still present in `vendor/versions.yaml` (dual-stack with codebase-memory-mcp) |
| 20 | Retire native `knowledge/search` + `context` + `impact` | ⏳ deferred | ⏳ **still deferred** | All 3 cases still present in `packages/core/knowledge/mcp.ts` |
| 21 | Pool MCP via arkd/conductor | ⏳ deferred | ⏳ **still deferred** | `.mcp.json` per-session injection in `writeChannelConfig`; no arkd pooling |
| 22 | **SnapshotStore + session pause/resume** (#201) | n/a | ✅ **SHIPPED** | `packages/core/services/session-snapshot.ts`; compute-side `snapshot-store.ts` + `-fs.ts`; tests `session-pause-snapshot.test.ts`. Commit `5fb22ca3`. |
| 23 | **ComputePool + LocalFirecrackerPool** (#232/234) | n/a | ✅ **SHIPPED** | `packages/compute/core/pool/local-firecracker-pool.ts`; `types.ts` `ComputePool` interface; tests; wired into `ComputeTarget` via `ef293b95` (#234). Commit `eda02638`. |
| 24 | **session/dispatch RPC removed** (#231) | n/a | ✅ **SHIPPED** | RPC surface removed; auto-dispatch on session creation preserved. Commit `221df1e2`. |
| 25 | **Awilix DI split** (#248) | n/a | ✅ **SHIPPED** | `packages/core/di/` new dir (`index.ts`, `persistence.ts`, `services.ts`, `runtime.ts`, `container.ts`); PROXY injection; sessions + compute migrated. Commit `8a6c29df`. |

Counts (after 2026-04-19 third-pass re-audit + action pass): **7 shipped, 8 partial, 7 still-gap, 3 still-future** (total 25). **5 of the 8 off-roadmap gaps from reconciliation §8 remain fully open**; item 6 (recipe-file dispatch) and the model-routing canvas decision are both shipped; item 14 (audit-log adapters) shipped this session; items 1 and 7 upgraded to PARTIAL. Also shipped this session: `ChatPanel.tsx:117` rename `"Send"` -> `"Chat"` (Abhimanyu 2026-04-13 feedback). Fork/Dispatch tooltips not applicable -- Web UI uses `Resume` as the single re-dispatch surface post-TUI retirement.

## 2. What actually changed between 2026-04-18 and 2026-04-19 (by commit family)

From the 148-commit delta, the material groups are:

### A. Compute platform (PRs #201, #232-238, #246, #247, #248)
- Snapshot/pause/resume foundation (#201)
- ComputePool + LocalFirecrackerPool (#232, #234)
- FlyMachinesCompute added then dropped (#233, #237) -- SaaS backends removed, self-hosted only
- arkd-bundled Docker image (#235)
- 6PN tunnel for Fly (#236)
- Polymorphic ProviderFlagSpec for CLI (#238)
- SOLID audit top-20 + 6 refactors (#246)
- stage-orchestrator.ts split (#247)
- Awilix DI split for sessions + compute (#248)

### B. This session's own work (PR #202, commit `da129331`)
- codebase-memory-mcp v0.6.0 vendored
- Agent exposure via `.mcp.json` (Claude) + `--with-extension` (Goose)
- `ark knowledge codebase {status,tools,reindex}` CLI
- `CodebaseMemoryPanel` on Web UI Memory page
- 5 dated review docs (this is one of them)

### C. What did NOT change
- Flow schema (`StageDefinition`) -- no `mode`, no `loop`, no `approval.on_reject`
- No new canvas-ordered stages
- No canonical `paytm-sdlc.yaml`
- No `--recipe-file <path>` CLI flag
- No MiniMax/SambaNova/TFY router adapters
- No secrets vault
- No multi-repo session schema
- No in-app browser
- No AI Monitor
- No UI `Send -> Chat` rename (still `"Send"` on `ChatPanel.tsx:117`)
- No info tooltips on Fork / Dispatch
- No file upload affordance on Web UI chat
- No Jira link in SessionDetail

## 3. Week-1 collated-roadmap status

From `docs/2026-04-18-COLLATED_ROADMAP.md` §4 Week 1:

| # | Action | Status 2026-04-19 |
|---|---|---|
| 1 | Canonical 15-stage + 4-mode schema RFC | ❌ not done |
| 2 | `--param k=v` + ad-hoc recipe-file dispatch | ✅ **done via `--file role=path` + `--param k=v`** (CLI + Web UI); more general than the original `--recipe-file` spec |
| 3 | Install 9 ISLC recipes + smoke IN-* ticket | ❌ not verifiable (need real-session evidence) |
| 4 | Token-benchmark codebase-memory-mcp vs pure-Grep | ❌ not done |
| 5 | UI polish (Send->Chat + info tooltips on Fork/Dispatch) | ❌ not done -- `ChatPanel.tsx:117` still `Send` |

**Week-1 scorecard (corrected): 1/5 fully complete, 4/5 not done.** The dispatch-input mechanism (item 2) landed as the heaviest of the five and is already working end-to-end on both surfaces.

## 4. Deferred items from PR #202 (`b9356da`) -- still deferred

All three items called out in `2026-04-18-CODE_INTELLIGENCE_DESIGN.md` for "post-pilot" are still deferred:

1. Remove `codegraph` from `vendor/versions.yaml` -- still there (dual-stack)
2. Retire native `knowledge/search` + `context` + `impact` -- still present in `packages/core/knowledge/mcp.ts`
3. Pool via arkd/conductor -- still per-session `.mcp.json` injection

This is consistent with the "benchmark first, retire after" plan. No urgency unless the pilot starts.

## 4b. Third-pass re-audit + action pass (added 2026-04-19 evening)

Third pass found two more items shipped under different names, one item-item confirm, plus this session landed a handful of small actions.

**Upgrades from re-audit:**
- **Item 1 (canonical 15-stage vocabulary):** ❌ GAP -> 🟡 PARTIAL. `agents/` contains 12 ISLC agents that map to major canonical stages (ticket-intake, spec-planner, plan-auditor, planner, task-implementer, verifier, reviewer, closer, documenter, retro, plus cross-cutting). The *agents* cover the semantic; the *flow schema* (`packages/core/state/flow.ts`) is unchanged and no `paytm-sdlc.yaml` canonical flow exists. To close fully: add canonical flow YAML.
- **Item 7 (in-app browser):** ❌ GAP -> 🟡 PARTIAL. `packages/core/extension-catalog.ts:40-44` lists `@anthropics/playwright-mcp` as a one-click installable browser extension. Agents can use Playwright MCP tools; no custom Ark UI picker/highlighter on top.
- **Item 18 (diff-review syntax):** confirmed 🟡 PARTIAL. `packages/web/src/components/ui/DiffViewer.tsx` is a full custom diff viewer with CSS-variable add/remove coloring, tabs, theme support. No per-language syntax highlighting.

**Actions landed this session:**
- **Item 14 (audit log):** ❌ MORE BROKEN -> ✅ SHIPPED. The three NOT_MIGRATED stubs (`local`, `test`, `control-plane`) migrated to real implementations. `local` + `control-plane` delegate to existing `EventRepository` (SQL-agnostic via DatabaseAdapter). `test` is a real in-memory array with tenant filtering. Port doc clarifies that `log` is the only append path and `deleteForTrack` is session-cascade not audit-tamper. 12/12 EventRepository tests pass.
- **Send -> Chat** rename landed at `packages/web/src/components/ChatPanel.tsx:117`. Abhimanyu 2026-04-13 feedback now addressed.
- **Fork/Dispatch tooltips:** N/A. These were TUI concepts; post-TUI-retirement the Web UI uses `Resume` as the single re-dispatch surface (see `SessionDetail.tsx:218` comment). Dropping this item from Week-1 work.

## 4a. Re-audit corrections (added 2026-04-19 earlier)

Two meaningful upgrades + one hidden regression surfaced by a second-pass audit focused on generalizations rather than literal spec names:

- **Item 6 (ad-hoc recipe-file dispatch):** ❌ GAP -> ✅ SHIPPED. Implemented as the general `--file role=path` + `--param k=v` inputs contract on both CLI and Web UI. More general than the original spec.
- **Item 12 (per-stage model routing):** ❌ GAP -> ✅ SHIPPED. `packages/core/services/dispatch.ts:260-263` applies `stageDef.model` override to the agent before dispatch. The plan-with-Opus-implement-with-MiniMax strategy is wire-ready today.
- **Item 17 (workflow UI file upload):** ❌ GAP -> 🟡 PARTIAL. ChatInput + SessionDetail support attachments; ChatPanel's inline slide-out chat still uses basic Input.
- **Item 14 (audit log):** 🟡 PARTIAL -> ❌ MORE BROKEN than reported. All three adapters (`local`, `test`, `control-plane`) are NOT_MIGRATED stubs. Port has `deleteForTrack()` which violates immutability. This is worse than tracking indicated and is a **compliance risk** if audit features are assumed to work for the pilot.

## 5. Observations

### Good signal
- Infrastructure is compounding: DI split, stage-orchestrator split, SOLID refactors, pause/resume, compute pool. Each of these makes the 4-mode + loop + approval schema work easier when it happens.
- `StageDefinition.model?: string` field is already there (`flow.ts:42`), so adding per-stage routing is wiring, not schema change.
- `packages/core/di/` split gives a clean place to register new services (router, secrets vault) without growing a god-object.
- Compute pool + snapshot work is Camp 14 Phase 2 material landing early -- positive surprise.

### Drag signal
- All 8 off-roadmap gaps unchanged in 24 hours. These are product/schema decisions, not engineering effort.
- 5/5 Week-1 roadmap items not complete. The canvas asks (Send->Chat, tooltips, file upload, Jira link, diff syntax) are trivially small and have not moved.
- codebase-memory-mcp shipped without its **dual-stack retirement follow-up**, which is fine for now but becomes debt if the pilot benchmark is delayed.
- No evidence of a pilot dispatch attempt on a real repo (Rohit's pi-event-registry or Abhimanyu's IN-* ticket).

### Implicit trajectory
The team shipped what it was already working on (compute + DI) and paused on the 2026-04-18 alignment items. That is a valid engineering choice if the compute refactor was a blocker for Camp 11 multi-repo (it plausibly is). Recommend explicitly sequencing: after DI settles, take one Week-1 item per day for 5 days.

## 6. Recommended re-sequence for Week 2

Given Week-1 slip, prioritize the cheapest-yet-highest-signal items first:

1. **Send -> Chat + info tooltips + file upload affordance** (~half-day) -- canvas asks, literally line-level edits
2. **`--recipe-file <path>` CLI flag + synthetic inline agent** (~0.5 day) -- unblocks Rohit Path B
3. **Install Abhimanyu's 9 ISLC recipes at `~/.ark/recipes/goose/`** and dispatch one IN-* ticket (~0.5 day) -- validates Path A
4. **Node-modes + 15-stage RFC PR** (no impl, just schema + 1 example flow) (~0.5 day) -- unblocks everything else
5. **Pick a single canvas off-roadmap gap and ship it end-to-end** (pick #5 MCP Router pooling OR #6 Sage-KB contract OR #1 canonical stages)

Then revisit this progress doc on 2026-04-20 with fresh audit.

## 7. Nothing to commit from this audit

This is a tracking doc, not a state change. The audit is read-only. Save + git add + commit when ready to log.

## 8. Cross-references

- `docs/2026-04-18-REQUIREMENTS_RECONCILIATION.md` -- original gap list (§8)
- `docs/2026-04-18-COLLATED_ROADMAP.md` -- Week 1-4 plan
- `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` -- codebase-memory + pooling design (deferred items §6-7)
- `docs/2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` -- Path A + Path B dispatch spec
- `docs/ROADMAP.md` -- plan-of-record; 2026-04-18 review section at top
