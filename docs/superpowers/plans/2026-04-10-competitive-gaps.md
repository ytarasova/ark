# Competitive Gap Closure Plan

Based on deep analysis of Mission Control (builderz-labs) and market research (SoulForge, GitNexus, Higress).

---

## Phase A: Dashboard & Visualization (3-5 days)

### A1. Overview Dashboard
Widget grid homepage replacing the session list as landing page:
- Fleet status (running/waiting/stopped/failed counts with sparklines)
- Cost summary (today/week/month with trend arrow)
- Recent activity stream (last 20 events across all sessions)
- Quick actions (new session, dispatch, search)
- Gateway/conductor health indicator
- Onboarding checklist for first-time users

### A2. Cost Visualization (Recharts)
Replace plain cost table with charts:
- Pie chart: cost by model (Opus/Sonnet/Haiku)
- Line chart: cost trend over time (daily/weekly)
- Bar chart: cost per agent role
- Per-session cost attribution with drill-down
- Budget usage gauge (daily/weekly/monthly limits)

Install: `bun add recharts` (web UI)

### A3. Boot Sequence
Staged loading screen with labeled progress steps:
- Auth check
- Database connection
- Provider registration
- Conductor start
- Agent/flow/skill loading
- Ready

### A4. Smart Polling
`useSmartPoll` hook: pause polling when browser tab is hidden, resume on focus. Reduce unnecessary API calls.

### A5. Live Feed Sidebar
Collapsible right-side panel showing real-time events across all sessions without leaving the current view.

---

## Phase B: Task Board & Quality Gates (3-5 days)

### B1. Task/Kanban Board
Full task lifecycle management:
- Columns: Backlog, Inbox, Assigned, In Progress, Review, Quality Review, Done
- Drag-and-drop between columns
- Task assignment to agent roles
- Dispatch button per task
- Retry counter and feedback rating on completion
- GitHub issue linking (import issue as task)
- Comment threads with @mentions

Map to Ark: a "task" is a lightweight session precursor. Creating a task doesn't dispatch -- it queues work. Dispatching a task creates a session.

### B2. Aegis Quality Gate
Blocking review system before task completion:
- When an agent reports "completed", route to a reviewer agent
- Reviewer produces structured feedback (approve/reject with reasons)
- Rejection feeds back into next dispatch as context
- Requires operator sign-off for final approval
- Tracks approval history per task

Wire into flow stages: add `gate: review` type that requires agent-to-agent review.

---

## Phase C: Security & Audit (2-3 days)

### C1. Security Posture Score
Composite 0-100 score based on:
- Secret detection (scan tool inputs/outputs for API keys, tokens)
- Injection attempt tracking (prompt injection patterns)
- Tool authorization compliance (guardrail violations)
- Trust scoring per agent (weighted history of successes/failures)

### C2. Audit Trail
Immutable log of all sensitive operations:
- Login/logout events
- Session dispatch/stop/delete
- API key create/revoke
- Settings changes
- Tenant policy changes
- IP address + user agent tracking

New table: `audit_log (id, action, actor, actor_id, target_type, target_id, detail, ip_address, user_agent, tenant_id, created_at)`

### C3. Exec Approval Queue
Real-time approval for borderline tool executions:
- Risk classification: low/medium/high/critical
- Operator approves/denies from dashboard
- Glob-pattern allowlist ("always allow `git status`")
- Badge on nav showing pending approvals count

### C4. Trust Scoring
Per-agent trust score (0-1) updated on every event:
- `task.success`: +0.02
- `task.failure`: -0.05
- `injection.attempt`: -0.15
- `secret.exposure`: -0.20
- `guardrail.violation`: -0.10
- Score displayed on agent detail and security dashboard

---

## Phase D: Webhooks & Alerts (2-3 days)

### D1. Outbound Webhook System
- Register webhook endpoints with event subscriptions
- HMAC-SHA256 signing of payloads
- Delivery history with status codes
- Retry with exponential backoff
- Circuit breaker (disable after N consecutive failures)

Events: session.created, session.completed, session.failed, agent.error, cost.threshold, security.alert, pr.created, schedule.triggered

New tables: `webhooks`, `webhook_deliveries`

### D2. Declarative Alert Rules
- Entity type (agent/session/compute/schedule)
- Condition field + operator + value
- Action: webhook, notification, email, slack
- Cooldown period (don't re-fire for N minutes)
- Enable/disable toggle

New table: `alert_rules`

---

## Phase E: Agent Intelligence (2-3 days)

### E1. Agent Eval Framework
Four-layer evaluation:
- **Output evals**: completion rate, success rate per agent role
- **Trace evals**: convergence speed (turns to completion), loop detection
- **Component evals**: tool call latency p50/p95/p99 per tool
- **Drift detection**: compare recent performance to 4-week rolling baseline, alert on >10% degradation

Store in knowledge graph as `type=eval` nodes.

### E2. Standup Reports
Auto-generated daily summary per agent:
- Completed today
- In progress
- Blocked/failed
- Overdue tasks
- Cost incurred

CLI: `ark standup [--agent <name>] [--date <date>]`
Web: Standup panel with date picker

### E3. Per-Task Model Routing
Automatic model selection based on task signals:
- Task complexity keywords → model tier
- Estimated hours → model tier
- Priority → model tier
- Override: explicit `--model` flag

This extends our existing LLM Router with task-aware routing at the dispatch level.

---

## Phase F: Integrations (2-3 days)

### F1. GitHub Issues Sync
Bidirectional:
- Import GitHub issues as tasks (label → priority mapping)
- Sync status changes back (task done → close issue)
- Assignee → agent role mapping
- Auto-link PRs to issues

### F2. Slack Integration
Beyond current bridge notifications:
- Slack commands: `/ark dispatch`, `/ark status`, `/ark costs`
- Thread-based session interaction (reply to agent messages in Slack)
- Channel per project/team

### F3. Linear Integration
Same as GitHub but for Linear:
- Import issues as tasks
- Status sync
- Cycle/sprint awareness

---

## Phase G: User Experience Polish (2-3 days)

### G1. Agent Detail Depth
Expand agent detail view with tabs:
- Overview (current: name, runtime, model)
- Memory (per-agent knowledge nodes)
- Tasks (sessions assigned to this agent role)
- Activity (events filtered by this agent)
- Config (editable YAML)
- Tools (MCP servers configured)
- Eval (performance metrics)

### G2. Session Detail Enhancement
- Conversation view (already exists, improve formatting)
- File diff viewer (inline diff, not just stat)
- Cost breakdown per session (token usage by turn)
- Timeline view (events as a visual timeline, not just a list)

### G3. Onboarding Wizard
Multi-step wizard for new users:
1. Install prerequisites (Bun, tmux, Claude CLI, Axon)
2. Configure auth (API key or Claude login)
3. Connect a repository
4. Create first session
5. Watch it work

### G4. i18n Foundation
Add `next-intl` or equivalent for the web UI. Start with English, add framework for community translations.

---

## Phase H: User Management (1-2 days)

### H1. Full User CRUD
Web panel for managing users:
- Create/edit/delete users
- Assign roles (admin/member/viewer)
- View last login, API key count

### H2. Google/GitHub SSO
OAuth login flow:
- Google Sign-In with admin approval
- GitHub OAuth
- Map OAuth identity to tenant

### H3. Access Request Workflow
New users request access, admins approve/deny from the dashboard.

---

## Updated Roadmap Timeline

```
Done  ████████████████████████  Core platform, DI, flows, compute, knowledge, router
                                2552 tests, 0 fail

Phase A: Dashboard + Charts     █████        (3-5 days)
Phase B: Task Board + Quality   █████        (3-5 days)
Phase C: Security + Audit       ███          (2-3 days)
Phase D: Webhooks + Alerts      ███          (2-3 days)
Phase E: Agent Intelligence     ███          (2-3 days)
Phase F: Integrations           ███          (2-3 days)
Phase G: UX Polish              ███          (2-3 days)
Phase H: User Management        ██           (1-2 days)
```

## Priority Matrix

| Item | Impact | Effort | Do First? |
|------|--------|--------|-----------|
| Dashboard overview | High | Medium | Yes |
| Cost charts | High | Low | Yes |
| Task/Kanban board | High | High | Yes |
| Security posture | High | Medium | Yes |
| Audit trail | Medium | Low | Yes |
| Webhooks | Medium | Medium | After core UX |
| Agent evals | Medium | Medium | After core UX |
| Alert rules | Medium | Low | After webhooks |
| User management | Medium | Medium | After auth |
| GitHub sync | Medium | Medium | After task board |
| Standup reports | Low | Low | Nice to have |
| i18n | Low | Medium | Future |
| Office visualization | Low | High | Skip (gimmick) |
