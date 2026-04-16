# V0 Prototype Reference -- "Mission Control"

**Source:** https://v0-gmc-gold.vercel.app/
**Date:** Early 2026 (pre-design-spec exploration)
**Screenshots:** [v0-prototype/](v0-prototype/)

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

## Next Steps

1. **Add Overview tab** to Session Detail mockups -- contextual integration cards based on connected tools
2. **Design Workflow page** -- DAG flow graph with external integration nodes
3. **Itemize cost badge** -- expand to show token/compute split on hover or in a detail row
4. **Add runtime launcher** -- "Open in [runtime]" button in session header
5. **Derive progress %** -- from DAG stage completion, show as subtle bar or badge
