# Unified Summary -- 2026-04-18

> **Purpose:** single entry point tying together the review work done on 2026-04-18. No code changes produced -- this is an alignment document before building.
>
> **Companions** (read for depth):
> - `docs/2026-04-18-REQUIREMENTS_RECONCILIATION.md` -- every canvas feature vs Ark state with file:line evidence
> - `docs/2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` -- deep dive on dispatching the two external Goose recipes
> - `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` -- hybrid repo-map + pooled MCP architecture, codebase-memory-mcp vendoring + KB/KG integration, storage model for local + control-plane modes
> - `docs/2026-04-18-COLLATED_ROADMAP.md` -- one-page collated agreed plan combining canvas + 4 review docs + ROADMAP.md
> - **`docs/2026-04-19-PROGRESS_CHECK.md`** -- day-2 audit: 4 items shipped, 7 still partial, 14 still gap; all 8 off-roadmap gaps from §8 of the reconciliation remain open
>
> **2026-04-18 implementation shipped:** codebase-memory-mcp v0.6.0 vendored (commit `b9356da`); 14 code-intelligence tools now auto-injected into every agent session; CLI + Web UI surfaces live. See Section 12 file inventory.

---

## 0. Executive summary

The **Foundary-Ark Requirements canvas** (F0AUHKDHXME, Abhimanyu 2026-04-17) plus Harinder's thread feedback and Abhimanyu's reply are the authoritative requirements document. Harinder endorsed: *"we are 90% there."* Deep audit confirms that estimate is approximately right -- most required capabilities exist in skeletal or partial form. The real work is **vocabulary alignment + integration + polish**, not inventing new subsystems.

**Eight requirements are genuinely off-roadmap** and need explicit decisions: the canonical 15-stage SDLC vocabulary, the 4-mode node semantics (manual/agentic/co-paired/conversational), Archon-style loop + rework-on-reject nodes, a centralized MCP Router, Sage-KB MCP integration, Workflow UI file upload, the In-App browser, and Foundry 2.0 Track 2 (AI Monitor + Self-Healing) -- which Atul's deck promises by 2026-04-20.

**Two docs-staleness bugs** in `docs/ROADMAP.md`: `.ark.yaml` worktree provisioning is shipped (under `worktree.copy`/`worktree.setup`, not `provision.*`) but ROADMAP says "NOT BUILT"; and the "167 e2e tests" claim is post-TUI-retirement stale (reality: ~13 web spec files, 0 TUI).

**Rohit's Sage flow and Abhimanyu's ISLC flow are both Goose recipes but structurally different** (one narrative-and-delegation, one pre-expanded steps). Ark's Goose executor already handles `--recipe`, `--sub-recipe`, `--params`. Two CLI surfaces missing (`--param k=v` and `--recipe-file <path>`) plus Camp 11 multi-repo worktrees are the main blockers. First-pilot unblock is ~1-2 days of CLI work; full integration is ~10 days.

---

## 1. What was reviewed

### Sources consumed

| Source | Scope | Authority |
|---|---|---|
| Slack `#ark-init` (C0AKLLFN9GC) | Past 10 days | High -- platform steering |
| Slack DM C0ATUNM8CPK (Atul/Rohit/Yana) | Past 10 days | Integration context |
| Slack DM C0AQLGKQ601 (ppsl experiments) | Past 10 days | Model/TFY/MiniMax working details |
| Foundary-Ark Requirements canvas F0AUHKDHXME | Current | **Authoritative live doc** |
| Atul's Foundry 2.0 Google Slides deck (`1zELDDOa...`) | Static snapshot | Deadline 2026-04-20 |
| Rohit's Slack drop (2026-04-16) | `PAI-31080-goose-recipe.yaml` + `seed.zip` + `infra-clean.zip` | Rohit's integration target |
| Abhimanyu's shared files | 9 ISLC Goose recipes in `~/Downloads/islc-*.yaml` + full clone at `/tmp/goose-flow-compare/` | Abhimanyu's harness patterns |
| Archon reference | `github.com/coleam00/Archon` source (`dag-executor.ts:1523-2143`) + all 3 archon.diy guides | Workflow primitive reference |
| Ark `docs/ROADMAP.md` | 1297 lines | Planning-of-record (partially stale) |
| Ark `docs/SURFACE_PARITY.md` | 118 lines | CLI/TUI/Web feature matrix |

### Items I could not access (reported)

- **Image content** (15+ screenshots / diagrams in Slack -- Abhimanyu's architecture drawings, MiniMax pricing sheet, Rohit's Sage plan screenshot, Atul's SambaNova feedback). Only filenames and sizes visible.
- **Paytm internal URLs**: `pi-team.mypaytm.com/sage/...`, `foundry.mypaytm.com/app`, `tfy.internal.ap-south-1...`, Bitbucket internal PRs -- all auth-walled.
- **One-time-secret URLs** (2): TFY API key + MiniMax key -- single-view, already consumed by recipients.
- **Granola meeting notes URL** (04-14 session) -- auth-walled.
- **Google Docs Slides API** was disabled on the `gws` project; worked around by `drive.files.export` as text/plain.
- **`background-agents.com/landscape`** -- page returned only title via WebFetch (JS-rendered).
- **Open Agents demo** -- detail lives on `open-agents.dev`, not on the Vercel template page I fetched.
- **X.com / Twitter posts** (8 links) -- auth-walled.

---

## 2. Authoritative requirements (verbatim anchors)

From the canvas + thread responses:

### Design decisions
- Workflow needs to be consistent across Paytm (token + cost optimization)
- Ability to insert LLM Router
- Support for web (minimum) + APP
- Human in the loop support
- Workflow needs to be configurable at BU level
- Workflow stages: **Thoughts → Discussion → PRD → Design → Jira → Plan → Review Plan (holistic: security/cost/conversions) → Code → Test → PR → PR + Holistic Review → QA → UAT → Deploy → Monitor**

### Features list (14 items)
Multi-tenant + multi-user · Multi-repo dev env (+DNS) · LLM Routing + multi-model · MCP Router · Auth + RBAC · Dashboards (User/Team/BU/Org) · Auditing · Credentials vault · Code indexing · Workflow history · Workflow observability · Workflow UI (chat + file upload? + diff + terminal + logs + PR/Jira/branch summary) · In-app browser (app-specific UI element select) · Workflow nodes definition

### Workflow nodes
`model + skill + tools + modes { manual, agentic, co-paired (agentic + manual review), conversational }`

### Harinder's load-bearing constraint
> "These are stages of the software lifecycle. In my ideal universe, these are 90% similar across all teams. We should make it somewhat configurable in our ark/foundry systems, but in practice we should not allow huge deviations."

**Implication:** ONE canonical workflow with conditional paths -- NOT per-BU stitched flows.

### Abhimanyu's 5-group phasing (for tool reviews)
1. **Product + Jira Creation** -- Phase 2, day time, record sessions (Mehul/Shreyas tools)
2. **Dev-PR (Local Only)** -- Phase 1, day time
3. **Dev-PR (Remote)** -- Phase 1, evening (others present for questions)
4. **Infra + Deployment** -- Phase 1, evening
5. **Support Tools (MCPs)** -- Phase 1, evening

### 11 Tool Review Questions (for interviewing other tools)
1. Ideal workflow? 2. Entry stage? 3. Stages needing manual intervention? 4. Cost tracking? 5. Multi-model? 6. Team-customized prompts? 7. Skip-to-step? 8. History/session? 9. Resumable? 10. Storage location? 11. Multi-repo?

### Atul's Foundry 2.0 deck (delivery 2026-04-20)
Two parallel tracks: **QA Infra in Cloud** (CLI on-demand test infra, 24×7, no shared-env queues) + **AI Monitor** (Prometheus + Slack, replaces Grafana watching + PaytmCaller). Vision: Fully Automated QA + Self-Healing Systems.

---

## 3. Corrections to initial shallow verdicts

An earlier pass flagged 8 ROADMAP-claimed-DONE items as possibly regressed. Deep source read corrects 6 of 8:

| # | Item | Initial | Actual | Evidence |
|---|---|---|---|---|
| O1 | Native skill injection | ⚠️ | ✅ DONE | `agent.ts:161-169` -- `buildClaudeArgs()` injects; tested |
| O2 | Artifact tracking + `stage_start_sha` | ⚠️ | ✅ DONE | `schema.ts:268` + `session-hooks.ts:387-413` |
| O3 | MCP config merge to worktrees | ⚠️ | ✅ DONE | `claude.ts:132-186` + `:452-470` |
| O4 | Auto-start dispatch 5 runtimes | ⚠️ | ✅ DONE | All via native args; `deliver-task.ts` deleted |
| O5 | Web tabs + daemon auto-detect | ⚠️ | ✅ DONE (+ branch is docs-only) | `SessionsPage.tsx:12`; `useDaemonStatus.ts:15`. `docs/web-ui-design-final` has zero code changes in `packages/web/src` |
| O6 | `.ark.yml` worktree provisioning | ⚠️ | ✅ DONE (naming mismatch) | `repo-config.ts:5-18` -- `worktree.copy[]` + `worktree.setup`. ROADMAP says `provision.*` / NOT BUILT -- **stale** |
| O7 | 167-test E2E suite claim | ⚠️ | ❌ BROKEN CLAIM | TUI retired (0 tests); web ~13 spec files. **ROADMAP overcounts** |
| O8 | Knowledge graph auto-index | ⚠️ | 🟡 PARTIAL | Remote only; no completion hook; mock-tested |

**Net:** ROADMAP is reliable except for O6 (underreports) and O7 (overcounts). Fix both before next reconciliation cycle.

---

## 4. Requirement state at a glance

Grouped by bucket. For per-item file/line evidence, see `2026-04-18-REQUIREMENTS_RECONCILIATION.md`.

### ✅ Shipped and verified (6 confirmed this session)
- Native skill injection into dispatched sessions
- Artifact tracking + per-stage `stage_start_sha` verification
- MCP config merge on worktree setup, cleanup on stop
- Auto-start dispatch for all 5 runtimes
- Web UI 7-tab status filter + 15s daemon health polling
- `.ark.yml` worktree provisioning (`worktree.copy[]` + `worktree.setup`)
- Workflow history (events + messages + artifacts + session resume)
- DAG engine (`on_outcome`, `on_failure: retry(N)`, conditional edges)

### 🟡 Built but not integrated/tested (13+)
Multi-tenant + multi-user (untested); LLM Router (never hit real APIs); Multi-model (5 runtimes wired, router not wired into dispatch); Auth + basic RBAC (disabled by default); Dashboards (session-level only, no team/BU/org rollup); Code indexing (never CI-tested with real repo); Workflow observability (OTLP untested); Workflow UI (chat ✓, diff plain, no file upload, no Jira); Knowledge graph auto-index (partial, mock-only); E2E suite (smaller than claimed); PM/Eng/QA/DevOps agent coverage (12 agents, gaps for discussion/design/UAT/deploy/monitor roles); ISLC recipes not ported; Async Postgres (sleepSync hack); 9 other compute providers untested.

### 📍 Explicitly on roadmap, not started (~20)
Credentials vault (Camp 10, 3-4 days); Per-user MCP creds; Dev-env provider (compose + Traefik DNS); Google/GitHub SSO; Full user-mgmt UI; GitHub App webhooks; Bitbucket REST; Jira Cloud REST; Slack bot; Figma MCP; PM/QA/DevOps agent roles; MiniMax/SambaNova/TFY providers in router; Per-stage model routing; Tauri v2 desktop evaluation; Goose stream-json parser; Feature-flag session config; Sub-recipe runtime invocation; Port Abhimanyu's 9 ISLC recipes; Multi-repo (Camp 11).

### 🔮 Longer horizon on roadmap (~20)
Compute hibernate/snapshot/restore; Decoupled arkd-to-arkd proxy; Compute pooling; Daytona/Modal/Fly.io providers; Temporal integration; Local durable workflow engine; A2A/ACP/AGENTS.md protocol adoption; CodeRabbit/Greptile integration; SWE-bench; Evaluation-driven routing; asciinema recording; Cache-control optimization; DX metrics; Contribution charts; Executive dashboard; ROI calculator; In-session subagent UI; Knowledge graph visualization; Live feed sidebar; Onboarding wizard.

### ❌ Off-roadmap gaps (8 -- need product decisions)
1. **Canonical 15-stage SDLC vocabulary** (Thoughts → Monitor)
2. **Node modes** (manual / agentic / co-paired / conversational) -- distinct from existing `gate`
3. **Loop nodes** (Archon `until` / `until_bash` / `max_iterations` / `fresh_context`)
4. **Approval with rework** (Archon `on_reject.prompt`) -- `gate: review` is a pause without rework
5. **Centralized MCP Router** -- socket pooling is not a router
6. **Sage-KB MCP integration contract** (accept goose-recipe.yaml as session input)
7. **In-App browser** (element-selection UI on live app)
8. **Foundry 2.0 Track 2 -- AI Monitor + Self-Healing** (deck promises by 2026-04-20, Ark has no representation)

### ⚠️ ROADMAP docs-staleness bugs
- **O6 (worktree provisioning):** ROADMAP says "Worktree untracked file setup -- NOT BUILT"; code implements it under `worktree.copy`/`worktree.setup`
- **O7 (test count):** ROADMAP claims 89 TUI + 78 web = 167 tests; TUI retired (0) and web ~13 spec files

---

## 5. Canonical 15-stage workflow -- mapping + schema

Harinder's direction implies one universal flow with conditional edges. Current state per stage:

| # | Canonical stage | Ark coverage | Recommended mode | Agent |
|---|---|---|---|---|
| 1 | Thoughts | `brainstorm.yaml::explore→synthesize` | conversational | `worker` ✓ |
| 2 | Discussion | -- | conversational | **NEW `discussant`** |
| 3 | PRD | `islc::ticket-intake`, `default::intake` | agentic | `ticket-intake` ✓ |
| 4 | Design | -- | co-paired | **NEW `designer`** |
| 5 | Jira | `ticket-intake` (read-only) | manual/agentic | needs write perms |
| 6 | Plan | `default::plan`, `autonomous-sdlc::plan` | co-paired | `planner`, `spec-planner` ✓ |
| 7 | Review Plan (security + cost + conversions) | -- | manual | **NEW `plan-reviewer`** |
| 8 | Code | `default::implement`, `autonomous-sdlc::implement` | agentic | `implementer`, `task-implementer` ✓ |
| 9 | Test | Bundled in implement; `dag-parallel::test` | agentic | `verifier` ✓ |
| 10 | PR | `default::pr` (action) | agentic | -- |
| 11 | PR + Holistic Review | `default::review` | co-paired | `reviewer` ✓ + humans |
| 12 | QA | Partial via `verifier` | manual | `verifier` ✓ |
| 13 | UAT | -- | manual | **NEW `qa-lead`** |
| 14 | Deploy | `default::close` (Jira transition, no deploy) | agentic | **NEW `deployer`** |
| 15 | Monitor | `default::retro` (workflow retro, not prod) | agentic | **NEW `monitor`** |

**Vocabulary gaps:** 6 genuinely missing stages (Discussion, Design, Review Plan, UAT, Deploy, Monitor) + 6 new agent YAML files.

### `mode` schema proposal (addition to `StageDefinition`)

```ts
mode?: "manual" | "agentic" | "co-paired" | "conversational";
```

Orthogonal to `gate`. `gate` answers *should we auto-advance?*, `mode` answers *who does the work?*. The currently-unused `autonomy` field should be deprecated or repurposed.

---

## 6. Archon schema deltas (loop + approval)

Deep read of `dag-executor.ts:1523-2143`. Ark has neither primitive.

### Loop node (not in Ark)

```yaml
loop:
  prompt: "... $USER_MESSAGE ... $nodeId.output ... $LOOP_USER_INPUT ..."
  until: "COMPLETE"                 # completion signal string (case-insensitive)
  max_iterations: 15
  fresh_context?: false             # default: threads across iterations
  until_bash?: "npm run test"       # exit 0 = loop ends
  interactive?: false               # pause for user feedback each iteration
  gate_message?: "Approve?"         # required when interactive=true
```

Termination = signal OR bash (OR logic). Supports stateless Ralph-pattern (`fresh_context: true`) and accumulating-context loops.

### Approval node (not in Ark -- `gate: review` is just a pause, no rework)

```yaml
approval:
  message: "Review and approve"
  capture_response?: true           # stores approver comment as $nodeId.output
  on_reject?:
    prompt: "Reviewer rejected: $REJECTION_REASON. Fix and re-submit."
    max_attempts?: 3
```

Rework loop: reject → AI runs `on_reject.prompt` with `$REJECTION_REASON` substituted → session re-pauses at gate → repeat or approve. After `max_attempts` rejections, workflow cancels.

### What Ark would need
- Add `loop` + `approval` fields to `StageDefinition` in `packages/core/state/flow.ts`
- Add `session.metadata.rejection_count` + `rejection_reason`
- Add `executeLoopNode()` + `executeApprovalNode()` in `session-orchestration.ts`
- Add template variables `$REJECTION_REASON`, `$USER_MESSAGE`, `$ARTIFACTS_DIR`, `$nodeId.output`
- Ark today has `{summary}`, `{ticket}`, `{workdir}`, `{repo}`, `{branch}` only

**What Ark keeps over Archon:** fork/fan_out, `on_outcome` routing, compute templates per stage, autonomy modes, verify scripts. Ark is richer on DAG + orchestration; weaker on iteration.

---

## 7. Rohit (Sage) and Abhimanyu (ISLC) flow support

Both are Goose recipes. Populate different optional sections.

| Dimension | Abhimanyu ISLC | Rohit Sage (PAI-31080) |
|---|---|---|
| Author | Hand-written, reusable | Machine-generated upstream |
| Size | 9 files × ~150 lines | 1 file × 1375 lines, 72 steps |
| Model | Narrative `prompt:` + sub-recipe delegation via `goose` tool | `steps[]` array, linear |
| Params | `jira_key`, `auto`, `from_stage` | None |
| State | `.workflow/<key>/state.json` + `subtasks.json` + `plan.md` | Sage owns upstream |
| Resume | `from_stage` param | Step index (TBD) |
| Gates | `AskUserQuestion` unless `auto: true` | None explicit |
| Repos | 1 per ticket | 3 (pi-event-registry, pi-action-executor, pi-risk-intelligence-centre-ui) |
| MCPs | Atlassian + Bitbucket + Figma | sage-kb only |
| Feature flags | `.workflow/config.json` | None |

### What Ark supports today
`packages/core/executors/goose.ts:75-82` already passes `--recipe`, `--sub-recipe`, `--params k=v` to `goose run`. Channel MCP wired via `--with-extension`. Router env injected. Interactive mode (`-s`) for manual gates.

### Recommended hybrid dispatch

- **Path A (Abhimanyu)** -- registered recipe: `cp ~/Downloads/islc-*.yaml ~/.ark/recipes/goose/` then `ark session start --runtime goose --recipe islc-orchestrate --param jira_key=IN-1234 --param auto=false`
- **Path B (Rohit)** -- ad-hoc file: `ark session start --runtime goose --recipe-file /path/to/generated.yaml` (Sage output is ephemeral per ticket, no registration)
- **Path C (Web)** -- recipe-file upload through ChatPanel (needs file upload -- itself a canvas gap)

### Concrete deltas (no code yet)

| # | Change | File(s) | ~LOC | Enables |
|---|---|---|---|---|
| 1 | `--param k=v` flag on `ark session start` | `packages/cli/commands/session/start.ts` | 30 | Path A params |
| 2 | Propagate CLI `--param` into goose `recipeParams` | `session-orchestration.ts` dispatch | 20 | Path A params |
| 3 | `--recipe-file <path>` flag | `start.ts` | 20 | Path B entry |
| 4 | Synthetic inline agent for `--recipe-file` | `agent.ts` | 40 | Path B dispatch |
| 5 | Persist `recipe_file` on session config | `repositories/session.ts` (whitelist col) | 5 | Path B resume |
| 6 | Web recipe-file upload + new session wizard | `ChatPanel.tsx`, `SessionDetail.tsx`, server handler | 200 | Path C |
| 7 | Multi-repo detection from `steps[].args.repo` | new Goose-recipe YAML inspector | 80 | Path B for multi-repo |
| 8 | Session-scoped feature flags | `session.ts`, goose executor | 40 | Abhimanyu's `enablePlanAudit` |
| 9 | Goose stream-json parser → status poller | new parser | 150 | Sub-stage progress both paths |
| 10 | Three-tier `~/.ark/recipes/goose/` resolution | new goose-recipe-store | 80 | Path A governance |

**Minimum viable slice** (items 1-5 + 7): **~135 LOC in 1-2 days** -- unblocks both dogfood cases.

**Full integration** (everything): ~10 days.

### MCP credentials -- the sharp edge (Camp 10 blocker)
Neither recipe works on a fresh machine until the user configures goose MCPs manually (`~/.config/goose/config.yaml`). Both paths need Camp 10 secrets vault + `env_keys` declarative lookup before production. Camp 10 work: ~3-4 days for vault + 1-2 days for env-file injection.

---

## 8. Abhimanyu's 5-group phasing applied

| Group | Phase | Canvas features in scope |
|---|---|---|
| Dev-PR (Local Only) | P1 day | #10 workflow history, #12 workflow UI, #14 node modes, #9 code indexing |
| Dev-PR (Remote) | P1 evening | #1 multi-tenant, #2 multi-repo+DNS, #3 LLM routing, #5 auth/RBAC, #8 creds vault |
| Infra + Deployment | P1 evening | #2 dev-env, #11 observability, deploy/monitor stages |
| Support Tools (MCPs) | P1 evening | #4 MCP Router, Sage-KB, Figma/Atlassian MCPs |
| Product + Jira Creation | **P2** | #13 in-app browser, stages 1-5 (Thoughts→Jira), Mehul/Shreyas tools |

---

## 9. The 11 Tool Review Questions -- answered for Ark itself

So we can evaluate other tools from a clean baseline:

| # | Question | Ark answer |
|---|---|---|
| 1 | Ideal workflow? | 15-stage canonical (proposed `paytm-sdlc.yaml`); today: `autonomous-sdlc.yaml` (plan→implement→verify→review→pr→merge) |
| 2 | Entry stage? | Any -- `session start --flow X --stage Y` |
| 3 | Manual intervention stages? | Per-stage `gate: manual\|review`. Today `brainstorm` = manual, `autonomous-sdlc` = auto |
| 4 | Cost tracking? | ✅ 300+ models in PricingRegistry. Gap: MiniMax/SambaNova not registered; router→recorder not wired |
| 5 | Multi-model? | 🟡 5 runtimes; router for policy-based select (untested against real APIs) |
| 6 | Team-customized prompts? | ✅ agents YAML, skills per-agent, `.ark.yaml`, project tier |
| 7 | Skip-to-step? | ✅ `--stage X`, `session/advance --to X` |
| 8 | History/session? | ✅ SQLite + events + knowledge graph, tenant-scoped |
| 9 | Resumable? | ✅ `--resume`, `isolation: fresh\|continue` |
| 10 | Storage? | Local `~/.ark/ark.db` (SQLite/WAL); Hosted Postgres via `DATABASE_URL` |
| 11 | Multi-repo? | ❌ single `session.repo`; Camp 11 designed, not started |

---

## 10. Open product decisions (for the team to make)

1. **Adopt the 15-stage canonical vocabulary + 4-mode semantics?** (Section 5) -- codify as schema change RFC before any new flows land. Harinder: "one definition for the whole company."
2. **Adopt Archon's loop + rework-on-reject primitives?** (Section 6) -- adds `loop` + `approval` to `StageDefinition`. Significant but well-scoped.
3. **Is Foundry 2.0 Track 2 on Ark's plate?** Atul's deck promises AI Monitor + Self-Healing by 2026-04-20. No current Ark representation.
4. **Rohit/Sage integration -- P1 or P2?** It spans Phase 1 (Infra+Deployment + Support Tools) and Phase 2 (Product+Jira). First pilot slice (Paths A + B single-repo) is 1-2 days; Rohit's 3-repo case needs Camp 11.
5. **Secrets-vault urgency.** Both Rohit and Abhimanyu flows need per-user MCP creds on day 1 of pilot. Today users configure goose manually. Camp 10 work (~5-6 days combined) should jump priority.
6. **Recipe registry for Goose recipes** -- do we reserve `~/.ark/recipes/goose/` for registered Goose recipes (Path A), or stay file-path-only (Path B only)?
7. **Sage-KB equivalence** -- short-term let goose call sage-kb directly; long-term bridge sage-kb ↔ Ark's knowledge MCP so Ark-native flows get the same queries?
8. **Web UI file upload + Jira link + diff-with-syntax-highlighting** -- canvas asks for these. When?
9. **Code intelligence: commit to hybrid delivery + arkd-pooled MCPs?** (`docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` §1-§5) -- repo-map in system prompt + pooled MCP drilldown, arkd hosts, conductor routes. Unlocks 6-12× token reduction per session.
10. **Vendor codebase-memory-mcp into the Ark binary?** (`2026-04-18-CODE_INTELLIGENCE_DESIGN.md` §6a) -- MIT, 66 languages including required Python/JS/TS/Java, 14 MCP tools. Target: v0.6.0 pin. Caveat: tree-sitter-only for Java (no LSP type resolution). ~0.5 day to vendor + ~1 week to pool through arkd.
11. **Storage backend for code graph in control-plane mode** -- S3 or Postgres, both approved (2026-04-18). Pick per workload after pilot.
12. **Sunset ops-codegraph if codebase-memory-mcp wins the pilot benchmark?** Staged migration (Week 1 coexist → Week 2 benchmark → Week 3 pick primary → Week 4 sunset decision).

---

## 11. Recommended next actions (priority ordered)

### Immediate (this week)
1. **Fix ROADMAP.md docs-staleness** -- two edits, O6 (worktree.* is done) and O7 (test count). Keep this doc as source of truth. (Applied in this update -- see ROADMAP.md 2026-04-18 review section.)
2. **Codify the canonical 15-stage + 4-mode schema** as an RFC PR -- no implementation, just schema + agents stubs + one example flow file.
3. **Install Abhimanyu's 9 ISLC recipes at `~/.ark/recipes/goose/`** and smoke-test Path A with one IN-* ticket. Confirms dispatch works end-to-end.
4. **Ship the ~135 LOC slice** to unblock dogfood of both Paths A and B (items 1-5 + 7 from Section 7). Single PR.
5. **Vendor codebase-memory-mcp v0.6.0** into the Ark binary (~0.5 day -- new `vendor/versions.yaml` entry + `scripts/vendor-codebase-memory-mcp.sh` + finder). See `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` §6a for the 6 concrete deltas.

### Short-term (next 1-2 weeks)
5. **Camp 10 secrets vault + env-file injection** (~5-6 days). Unblocks real-pilot MCP creds.
6. **UI tweaks from Abhimanyu's feedback** -- "Send" → "Chat" (one line in `ChatPanel.tsx:117`), info tooltips on Fork + Dispatch in `SessionDetail.tsx:51,86-88`. Ship alongside the file upload affordance.
7. **Camp 11 start** (multi-repo design) -- required for Rohit's 3-repo recipe. Lock product-manifest + sibling worktree layout decisions.
8. **Goose stream-json parser** (Camp 10 item) -- sub-stage progress for Ark's UI against both Rohit's and Abhimanyu's flows.

### Medium-term (next month)
9. **Archon loop + approval primitive** implementation after schema RFC lands.
10. **Pre-engineering PRD/ideate flow** (Camp 10) + PM-agent roles (SP8). Enables Mehul/Shreyas tool reviews.
11. **Router production-ready** -- test against real Anthropic/OpenAI/Google + add MiniMax/SambaNova/TFY adapters.
12. **Jira Cloud + Bitbucket + Slack integrations** (SP3) -- triggers sessions from ticket events.

### Deferred (after pilot)
13. **In-App browser** (Playwright element selector UI) -- canvas feature, ~200 LOC + Playwright integration.
14. **AI Monitor** (Foundry 2.0 Track 2) -- scope call needed; Ark or separate track?
15. **Tauri v2 evaluation** for desktop -- Electron prototype exists but broken.
16. **Dashboard rollups** -- team / BU / org aggregations.

---

## 12. File inventory (saved in this session)

| Path | Purpose |
|---|---|
| `docs/2026-04-18-REQUIREMENTS_RECONCILIATION.md` | Per-feature evidence-backed reconciliation: canvas vs Ark state with file:line citations, 8 off-roadmap gaps, docs-staleness bugs, code intelligence addendum |
| `docs/2026-04-18-SUPPORTING_ROHIT_AND_ABHIMANYU_FLOWS.md` | Deep dive on dispatching both Goose recipe shapes -- schema comparison, hybrid path design, ~135 LOC first slice |
| `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` | Hybrid repo-map + pooled MCP architecture, codebase-memory-mcp vendoring plan, KB/KG integration, storage model for local + control-plane modes, multi-repo federation |
| `docs/2026-04-18-UNIFIED_SUMMARY.md` | **This document** -- ties all four together, decisions + priorities |

### Also available on disk (pre-existing)
- `/tmp/goose-flow-compare/` -- Abhimanyu's full goose-flow repo clone
- `~/Downloads/islc-*.yaml` -- 9 ISLC Goose recipes
- `~/Downloads/PAI-31080-goose-recipe.yaml` -- Rohit's Sage output
- `~/Downloads/infra-clean.zip` -- Rohit's docker-compose topology (6 core + 7 profile services)
- `~/Downloads/seed.zip` -- multi-DB seed data (30MB)

---

## 13. What's not yet verified

- **Abhimanyu's 5 unread sub-recipes** -- audit, execute, verify, close, retro, ideate. Likely same shape as ticket-intake + plan; confirm before assuming.
- **End-to-end dispatch of either recipe through Ark** -- never actually run. Items 1-5 of Section 7 enable it; run at least one real pilot ticket through the ~135 LOC slice to validate.
- **`sage-kb` MCP reachability** from Ark's docker compute -- does `http://localhost:8300/sage/mcp` work across network boundaries, or does it need port mapping / overlay network?
- **Recipe version currency** -- are Abhimanyu's ISLC or Rohit's Sage recipes newer upstream than what's in my Downloads?
- **Image content** in Slack -- 15+ screenshots I could not see (architecture diagrams, pricing screenshots, Sage UI screenshot).
- **Paytm internal URLs** -- Sage web UI, Foundry dashboard, TFY config panels were all inaccessible.

---

## 14. Sources (for future reconciliations)

**Canvas / threads:**
- Foundary-Ark Requirements canvas `F0AUHKDHXME` (edit history visible via Slack canvas API)
- Thread `1776409350.070589` (Harinder's feedback, 2026-04-17)
- Thread `1776414593.336189` (Abhimanyu's reply with features + modes, 2026-04-17)
- Atul's Foundry 2.0 deck Google Slides `1zELDDOa1Ln7nIwnynAVd-0uWQ3ZBDkYLiSyKeX3ZIok` (exported via `gws drive files export --mimeType text/plain`)

**Repos / sources:**
- `github.com/coleam00/Archon` -- `dag-executor.ts:1523-2143` for loop + approval implementation
- `archon.diy/book/essential-workflows/`, `archon.diy/guides/loop-nodes/`, `archon.diy/guides/approval-nodes/`
- `github.com/abhimanyu-rathore-paytm/goose-flow` -- cloned at `/tmp/goose-flow-compare/`
- `background-agents.com/landscape` (partial fetch -- JS-rendered)
- `ona.com/stories/building-a-software-factory-in-public`

**Ark source files read:**
- `packages/core/agent/agent.ts`, `packages/core/agent/recipe.ts`
- `packages/core/state/flow.ts`, `packages/core/stores/flow-store.ts`
- `packages/core/services/session-orchestration.ts`, `session-hooks.ts`
- `packages/core/repo-config.ts`
- `packages/core/claude/claude.ts`
- `packages/core/repositories/{schema,artifact}.ts`
- `packages/core/executors/goose.ts`
- `packages/web/src/components/{ChatPanel,SessionDetail,Terminal}.tsx`
- `packages/web/src/hooks/useDaemonStatus.ts`
- `packages/web/src/pages/SessionsPage.tsx`
- `packages/compute/providers/docker/compose.ts`
- `packages/router/{providers,config,types,pricing}.ts`
- All 14 flow YAMLs in `flows/definitions/`
- All 12 agent YAMLs in `agents/`
- `docs/ROADMAP.md`, `docs/SURFACE_PARITY.md`

---

*End of unified summary. For depth: see companion docs listed in Section 12.*
