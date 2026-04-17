# Early Prototype References

**Screenshots:** [v0-prototype/](v0-prototype/)

---

## 1. V0 Prototype -- "Mission Control"

**Source:** https://v0-gmc-gold.vercel.app/
**Date:** Early 2026 (pre-design-spec exploration)

## What It Was

A v0-generated prototype exploring an enterprise "Mission Control" concept for Ark. Horizontal top nav with 15 tabs (Sessions, Workflow, Dashboard, Signals, Jira, Bitbucket, Health, Automation, Team, Incidents, Integrations, Debug, Knowledge, Org & Team, Dependencies). Single dark-green theme, TechCorp org branding.

![Overview](v0-prototype/v0-prototype-overview.png)

## Key Patterns Worth Carrying Forward

### 1. Integration-Aware Session Overview

The Session Detail had an Overview tab with 4 status cards showing real-time counts from connected tools:

| Card | Content |
|------|---------|
| Jira Issues | count, done/in-progress breakdown |
| Pull Requests | count, open/merged breakdown |
| Pipelines | count, success/failed breakdown |
| Deployments | count, active status |

![Agent Beta overview](v0-prototype/v0-prototype-agent-beta.png)

**Design principle: these cards must be contextual to the org's configured integrations.** Not every team uses Jira -- some use GitHub Issues, Linear, or nothing. Not every team uses Bitbucket -- some use GitHub, GitLab. The overview surface should dynamically render cards only for integrations the team has actually connected.

Possible integration surfaces:

| Category | Options |
|----------|---------|
| Issue tracker | Jira, GitHub Issues, Linear, GitLab Issues, Shortcut |
| Source control | GitHub, Bitbucket, GitLab |
| CI/CD | GitHub Actions, Bitbucket Pipelines, GitLab CI, Jenkins, CircleCI |
| Deployments | Vercel, AWS, GCP, Kubernetes, ArgoCD |
| Communication | Slack, Teams, Discord |

Each integration provides a typed card renderer. No integrations configured = no overview tab (or a setup prompt).

### 2. Connected Workflow Graph

The Workflow page showed a horizontal pipeline: `PROJ-123 (Jira) -> Agent Session 1 -> PR-#42 (Bitbucket)` with status dots on each node.

![Workflow view](v0-prototype/v0-prototype-workflow.png)

This maps directly to Ark's DAG flows but rendered at a higher level -- showing the external artifacts (tickets, PRs, deploys) as nodes alongside the agent stages. This is a powerful differentiator vs Ona's linear trigger->prompt->shell->PR model.

**For Ark:** Combine the internal DAG (plan -> implement -> verify -> review -> merge) with external integration nodes to show the full end-to-end picture.

### 3. Itemized Cost Breakdown

The v0 prototype split costs into:
- **Token Cost** -- LLM API usage
- **Container Cost** -- compute runtime
- **Total Cost** -- sum

Our current design shows a single cost badge. The itemized view helps operators understand where money is going, especially for long-running sessions on paid compute (EC2, Firecracker).

### 4. Runtime Launcher Buttons

Session header had "Open in Cursor" / "Open Terminal" / "Open in Claude" buttons. Quick-jump to the runtime where the agent is actually working. Relevant for Ark since sessions can run on different runtimes (Claude Code, Codex, Gemini CLI, Goose).

### 5. Session Progress Bar

A simple linear progress bar (e.g., "65%") pinned at the bottom of the session detail. Complements our DAG stage badges with a single at-a-glance metric. Could be derived from: `completed_stages / total_stages`.

## What We Deliberately Changed

| Aspect | V0 Prototype | New Design (PR #150) | Why |
|--------|-------------|----------------------|-----|
| Navigation | 15-item horizontal tab bar | 48px icon rail, 5 core items | Focus over feature sprawl |
| Session list | 2-item sidebar, minimal info | 8-card list panel with search, filters, pipeline bars, cost | Production-grade fleet view |
| Conversation | Basic chat bubble | Tool call blocks, stage transitions, code highlighting | Reflects real agent output |
| Stats | KPI tile strip (Dashboard) | Stats woven into context | No corporate dashboards |
| Theming | Single dark green | 3 themes x dark/light toggle | Operator preference |
| Keyboard | None | Cmd+K, j/k, 1-5, / | Power-user first |
| Density | Standard spacing | Compact (52px cards, 13px base) | Fleet monitoring density |

---

## 2. Product Grooming Prototype -- Stage-Based Rich Output

**Source:** Internal prototype (localhost:3333)
**Date:** Early 2026
**Context:** A product management flow where each stage produces structured output, not chat

<!-- Screenshot: grooming-side-view.png (to be added) -->

### What It Shows

A multi-stage product refinement session with:

**Left sidebar -- stage progression:**
- Intelligence (research gathering)
- Wiki & JIRA Context (completed, with timing badges)
- VOC Synthesis (completed)
- Problem Refinement (completed)
- Pre-Grooming (active, "Running...")
- "Approve & Continue" gate button at bottom

**Detail panel -- structured rich output (not conversation):**
The active "Pre-Grooming" stage renders structured sections:
- Dependency/constraint bullets (Vendor lock, Latency SLA, Privacy, Offline fallback)
- Red "Blocker" callout (contractual confirmation of telephony vendor)
- "Data & Analytics Readiness" gap analysis
- "Recommended Spike / Investigation Items" with interactive checkboxes
- "Rough Complexity Signal" with sprint allocation estimates and risk callouts
- "PM Next Step" action item

### Why This Matters for Ark

This represents a **non-SDLC flow** through Ark's DAG engine. The same session/stage/gate architecture that powers `plan -> implement -> verify -> review -> merge` can also power:

```
research -> PRD -> design planner -> mockups -> ... -> implementation
```

Key design implications:

1. **Stage sidebar as primary nav (not session list):** When viewing a session in this mode, the left panel shows the flow's stages with completion status -- not a list of other sessions. This is a detail-view variant where the DAG itself becomes the navigation.

2. **Rich output renderers per stage type:** Each stage can produce different output formats:
   - Code stages -> conversation + terminal + diff (current mockups)
   - Research stages -> structured findings with citations
   - PRD stages -> requirement tables, gap analysis, blockers
   - Design stages -> mockup renders (via Figma MCP, v0, etc.)
   - Grooming stages -> complexity estimates, spike recommendations, checklists

3. **Interactive elements in output:** Checkboxes, approve/reject buttons, editable fields within the stage output. Not just read-only -- the operator can interact with stage results before gating to the next stage.

4. **Tool-contextual output:** Just like integration cards are contextual to the org's tools, stage output format depends on the connected MCPs:
   - Figma MCP connected -> design stages render Figma embeds
   - Jira MCP connected -> grooming stages link to/create Jira tickets
   - GitHub MCP connected -> implementation stages show PR status

### Generalized Flow Types

| Flow | Stages | Output Type |
|------|--------|-------------|
| SDLC | plan -> implement -> verify -> review -> merge | Conversation, terminal, diff |
| Product Refinement | research -> VOC -> problem -> grooming -> planning | Structured docs, gap analysis, estimates |
| Design | research -> PRD -> design -> mockups -> review | Figma embeds, visual comparisons |
| PR Review | fetch -> analyze -> comment | Structured review, inline annotations |
| Incident Response | detect -> investigate -> mitigate -> postmortem | Structured findings, timelines |

The web UI should handle all of these -- the session detail view adapts its panel layout and renderers based on the flow type and stage.

---

## 3. PRD Feature Planning Prototype -- Hierarchical Stages with Acceptance Criteria

**Source:** Internal prototype (localhost:3333, Feature Planning view)
**Date:** Early 2026
**Context:** A PRD-oriented flow where stages form a collapsible tree and output includes structured feature backlogs with acceptance criteria

### What It Shows

A multi-stage feature planning session with hierarchical stage navigation:

**Left sidebar -- collapsible stage tree (not flat list):**
- Feature Planning (expandable, contains "Auto App (v1)" sub-item)
- Solution Review
- Design Spec
- Screen Mockups
- PRD
- JIRA & Confluence
- Expand all / Collapse all controls at top

Each stage is a tree node that can have child items. Completed stages show checkmarks, active stage is highlighted. This is a DAG rendered as a **collapsible tree** rather than a flat vertical list.

**Detail panel -- structured PRD output:**
The "Feature Planning" stage renders:
- **Critical finding callout** (yellow/warning): "The GQ App can launch a call but has no end-to-end pipeline to capture the outcome or auto-create the follow-up task."
- **Feature backlog table** (max 5 items):
  | Priority | Feature | Evidence |
  | P0 | Call-outcome capture SDK | Low evidence |
  | P0 | Call-outcome event API | ... |
  | P1 | Call recording API | ... |
  | P1 | Task manager integration | ... |
  | P2 | Offline queue & sync | ... |
- **Per-feature deep dive** -- "PG - Call-outcome capture SDK":
  - What it does (technical description)
  - **User story**: "As an FSE, I want the app to automatically record who I called and whether the call was answered, so I spend 5 seconds logging per call vs the next task."
  - **Acceptance criteria** in Given/When/Then format:
    - Given a call initiated from the GQ App, when the call ends, then the SDK emits a CALL_ENDED event
    - Given a CALL_ENDED event, when the app receives it, then a pre-populated log is created...

**Header metadata:**
- Cost: $223.70
- Token usage: 4.4k / 80,000 (with visual bar)
- History and Auto Run toggles

### Key Patterns for Ark

1. **Hierarchical collapsible stage tree:** Stages aren't always a flat list. Complex flows (feature planning across multiple features) produce a tree where each stage can expand to show sub-items. The sidebar needs `Expand all / Collapse all` controls and tree-node expand/collapse per stage.

2. **Feature backlog as structured output:** A prioritized table (P0/P1/P2) with feature name, description, and evidence level. This is a typed renderer -- not markdown, but an actual sortable/filterable table component.

3. **Given/When/Then acceptance criteria:** Stages that produce PRD-style output render acceptance criteria in structured BDD format with keyword highlighting (Given/When/Then bolded or color-coded).

4. **Critical finding callouts:** Warning-level callouts (distinct from error/blocker callouts in the grooming prototype) that surface the most important insight from a stage's analysis.

5. **Token budget visibility:** The header shows token usage as a fraction (4.4k / 80,000) with a visual progress bar -- letting the operator see how much budget remains for the session.

6. **Per-feature drill-down:** The detail panel can show a summary table of all features, then drill into a specific feature's user story + acceptance criteria + technical details. This is a master-detail pattern within a single stage's output.

---

## Design Takeaways -- Combined

### For the Session Detail View

1. **Add Overview tab** -- contextual integration cards based on org's connected tools
2. **Stage sidebar variant** -- for non-SDLC flows, show stage progression as left nav instead of session list
3. **Rich output renderers** -- per-stage typed output (structured docs, not just chat)
4. **Interactive stage output** -- checkboxes, approve/reject, editable fields within rendered content
5. **Runtime launcher** -- "Open in [runtime]" button in session header

### For the Stage Sidebar

6. **Collapsible hierarchical tree** -- stages can have child items, with expand/collapse per node and Expand all / Collapse all controls
7. **Master-detail within stages** -- summary table view that drills into per-item detail (e.g., feature backlog -> single feature's acceptance criteria)

### For the Workflow/Flow View

8. **Connected workflow graph** -- DAG with external integration nodes (tickets, PRs, deploys)
9. **Flow type selector** -- SDLC, Product Refinement, Design, PR Review, etc.

### For Structured Output Renderers

10. **Feature backlog tables** -- prioritized (P0/P1/P2) with sortable columns
11. **Given/When/Then blocks** -- BDD acceptance criteria with keyword highlighting
12. **Critical finding callouts** -- warning-level (yellow) distinct from blocker-level (red)
13. **User story cards** -- "As a [role], I want [goal], so [benefit]" formatted blocks

### For Cost/Progress

14. **Itemized cost breakdown** -- token/compute split on hover or in detail row
15. **Token budget bar** -- usage fraction (4.4k / 80,000) with visual progress indicator
16. **Progress derivation** -- `completed_stages / total_stages` as bar or badge

### For Integration Architecture

17. **Contextual surfaces everywhere** -- cards, output renderers, stage types all adapt to the org's connected tools. No hardcoded Jira/Bitbucket assumptions.
