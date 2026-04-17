# Orchestration UX Patterns -- Design Research Report

Generated: 2026-04-16
Scope: UI/UX patterns for agent orchestration and monitoring platforms, with recommendations for Ark's web dashboard.

---

## Table of Contents

1. [Session/Task Management Patterns](#1-sessiontask-management-patterns)
2. [Real-Time Monitoring Patterns](#2-real-time-monitoring-patterns)
3. [Workflow/DAG Visualization](#3-workflowdag-visualization)
4. [Control Plane UX Patterns](#4-control-plane-ux-patterns)
5. [Chat/Interaction Design Patterns](#5-chatinteraction-design-patterns)
6. [Information Architecture Recommendations](#6-information-architecture-recommendations)
7. [Wireframe Descriptions](#7-wireframe-descriptions)
8. [Gap Analysis vs. Current Ark Web UI](#8-gap-analysis-vs-current-ark-web-ui)
9. [References](#9-references)

---

## 1. Session/Task Management Patterns

### 1.1 CI/CD Pipeline Views -- Lessons from GitHub Actions, CircleCI, Buildkite

**GitHub Actions** uses a left-sidebar tree of jobs with a right-panel log viewer. Key patterns:
- **Workflow run summary** at the top: title, triggering event, total duration, status badge
- **Job dependency graph** rendered as a left-to-right DAG with colored nodes (green=pass, red=fail, yellow=running, gray=skipped)
- **Step-level expandable logs** inside each job, with timestamps and duration per step
- **Re-run controls** at both workflow level (re-run all) and job level (re-run failed jobs)
- **Annotations** surface errors/warnings from log output into a summary panel so you don't need to read raw logs

**CircleCI** uses a pipeline-centric view:
- **Pipeline list** as the primary view, each row shows: commit info, pipeline status, jobs as mini circles in a row
- **Job detail** opens a panel with step-by-step output, test results tab, artifacts tab
- **Workflow visualization** is a horizontal DAG where parallel jobs fan out vertically
- **Insights dashboard** shows success rate, duration trends, and credit usage over time

**Buildkite** has the most visually distinctive approach:
- **Waterfall timeline** showing job start/end times on a horizontal axis -- reveals parallelism and bottlenecks at a glance
- **Pipeline steps rendered as blocks** connected by arrows, with emoji-based step labels
- **Unblock steps** for manual gates -- a button appears inline in the pipeline that a human must click to proceed
- **Grouped steps** collapse parallel fan-outs into a single visual block with a count badge

**Recommendations for Ark:**
- Adopt Buildkite's **inline manual gate** pattern for flow stages with `gate: manual`. Show a prominent "Approve" button inline in the pipeline visualization.
- Use GitHub Actions' **annotation extraction** pattern: surface key events (stage transitions, errors, completions) as a summary strip above the raw log/output.
- Add a **waterfall/Gantt sub-view** option for sessions running multi-stage flows, showing elapsed time per stage.
- The current flow pipeline display (`plan > implement > verify > review > merge` with `>` separators) is functional but too compact. Upgrade to a horizontal stepper with colored nodes.

### 1.2 Multi-Session Monitoring -- Avoiding Information Overload

When monitoring 10+ concurrent agents, the key challenge is directing attention to sessions that need it while keeping the rest visible but quiet.

**Patterns from fleet monitoring tools (Datadog Infrastructure Map, Grafana dashboards):**

- **Heat map / grid view**: Small rectangles per session, colored by status. Clicking expands to detail. This scales to 50+ sessions in a single viewport. Datadog's Host Map is the canonical example.
- **Priority-sorted list with urgency indicators**: Running + failed sessions at the top, completed/archived at the bottom. Use pulsing dots or ring animations for sessions needing attention.
- **Swimlane view by agent role or flow**: Group sessions by agent (implementer, reviewer, planner) as horizontal lanes. Each session is a card in its lane. This reveals load distribution and bottlenecks per role.
- **Notification toasts for state transitions**: When a session changes from running to failed/completed/waiting, emit a brief toast. Buildkite does this in their Slack integration; the web UI should do it natively.
- **Sound/vibration for failures**: Optional but valuable when running background agents. A subtle audio ping on failure lets the operator multitask.

**Recommended multi-session views for Ark (in addition to the existing list):**

| View | Best For | Scale |
|------|----------|-------|
| List (current) | Detailed per-session inspection | 1-20 sessions |
| Grid/heatmap | Fleet-wide status at a glance | 10-100 sessions |
| Kanban board | Workflow-oriented teams | 5-30 sessions |
| Timeline/Gantt | Understanding concurrency and duration | 5-20 sessions |
| Swimlane by agent | Load balancing across agent roles | 10-50 sessions |

### 1.3 Status Transitions and State Machines

Ark's session status model: `pending -> ready -> running -> {waiting, completed, stopped, failed} -> archived -> deleting`.

**Best practices from orchestration platforms:**

- **Temporal** shows workflow state as a prominent badge with color coding, plus a "pending activities" count. Transitions are logged as events in a timeline.
- **Airflow** uses a grid view where each cell is a task instance colored by state. The grid's x-axis is time (DAG run), y-axis is task. This reveals patterns like "task X always fails on the third run."
- **Kubernetes** pods show a state machine badge plus conditions (Ready, Initialized, ContainersReady) as sub-states.

**Recommendations for Ark:**
- Add a **state machine diagram** to the session detail view showing allowed transitions from the current state, with the available actions as labeled edges. This helps operators understand what they can do.
- Show **time-in-state** next to the status badge: "running for 4m32s" or "waiting since 2:15pm". The current `relTime(updated_at)` shows when the session was last updated, not when it entered the current state.
- Use **progress indicators** for stages: if the flow has 5 stages and we're on stage 3, show "3/5" or a progress bar. The current pipeline breadcrumb shows this positionally but doesn't quantify it.

---

## 2. Real-Time Monitoring Patterns

### 2.1 Streaming Dashboards -- Datadog, Grafana, New Relic

**Core patterns:**

- **Auto-refresh with visible countdown**: Datadog shows a "Last updated 5s ago" timer and a refresh icon. Users trust data more when they can see its freshness.
- **Live tail mode**: A toggle that switches from polling to streaming (SSE/WebSocket). When enabled, new data pushes to the top or bottom with a highlight animation. When disabled, the view is static until manually refreshed.
- **Pause on hover**: Grafana's log panels auto-scroll, but scrolling up or hovering pauses the stream. A "resume live" button appears at the bottom. This is critical -- users lose their place if the view keeps moving while they're reading.
- **Sparklines in summary cards**: Instead of a single number for "sessions running," show a tiny 50px-wide sparkline of the last 30 data points. This shows trends without requiring a full chart.
- **Time range selector**: Grafana's time picker is the gold standard -- last 5m, 15m, 1h, 6h, 24h, 7d, custom range. All dashboard widgets respect the selection.

**Ark's current approach:** 5-second polling via `useSmartPoll`. This works but has no visible freshness indicator, no pause-on-hover for the live output, and no sparklines.

**Recommendations:**
- Add a **"Live" indicator** to the dashboard header showing connection status (SSE connected / polling / disconnected).
- Implement **pause-on-hover** for the Live Output section in SessionDetail. The existing `outputRef` div auto-scrolls; add scroll-position detection (already done in ChatPanel -- reuse the `userScrolled` pattern).
- Add **sparklines** to the Fleet Status cards. A 1-hour sparkline of running session count, cost accumulation rate, or event frequency. Use a lightweight library like `react-sparklines` or inline SVG.
- Consider a **global time-range selector** that filters the dashboard, costs, and events to a specific window.

### 2.2 Log Streaming Patterns

**Best practices from Kibana, Loki/Grafana, CloudWatch Logs:**

- **Structured log lines** with parsed fields (timestamp, level, source, message) rather than raw text. Each field can be clicked to filter.
- **ANSI color preservation**: Terminal output contains escape codes. Render them faithfully (xterm.js does this; the current `<pre>` in Live Output does not).
- **Log level filtering**: Toggle info/warn/error visibility. Critical for long-running agents that produce verbose output.
- **Search within output**: Ctrl+F is table stakes. A dedicated search bar with next/previous match and match count is better.
- **Bookmarks/pins**: Mark specific log lines to return to later. Useful during debugging.
- **Side-by-side logs**: When monitoring fan-out sessions, view two or more session outputs simultaneously.

**Recommendations for Ark:**
- Replace the `<pre>` Live Output block with a proper log viewer component that handles ANSI codes, line numbers, and in-view search. Libraries: `react-lazylog`, `ansi-to-react`, or a custom component using `ansi_up`.
- Add a **search bar** above the live output with highlight-on-match.
- For fan-out sessions, add a **split-pane view** option that shows outputs from child sessions side by side.

### 2.3 Terminal Embedding

The current `TerminalPanel` implementation using xterm.js is solid. Patterns to add:

- **Resizable terminal**: Allow dragging the terminal panel height. The current fixed 360px height is limiting.
- **Detachable terminal**: Pop out the terminal into its own browser tab/window. This lets operators put the terminal on a second monitor while keeping the dashboard on the primary.
- **Multiple terminal tabs**: If a session has sub-agents, allow switching between their terminal sessions with tabs.
- **Terminal search**: xterm.js supports a search addon (`@xterm/addon-search`). Wire it up.
- **Copy mode**: A keyboard shortcut (e.g., Shift+click or a mode toggle) that makes the terminal content selectable without sending input to the remote.

### 2.4 Activity Feeds and Event Timelines

**Patterns from Slack activity, GitHub activity feed, Linear changelog:**

- **Grouped events**: Collapse repeated events ("Agent completed 3 stages in 2 minutes" instead of 3 separate entries).
- **Filter by event type**: Toggle visibility of status changes, messages, cost events, etc.
- **Relative timestamps that update**: "2 minutes ago" should tick to "3 minutes ago" without a page refresh.
- **Link to source**: Each event in the feed should deep-link to the relevant session/stage.
- **Infinite scroll with date separators**: "--- Today ---", "--- Yesterday ---" headers as the user scrolls back.

The current Recent Activity widget in DashboardView shows events but lacks filtering, grouping, and deep links. Upgrade to a richer activity feed component.

---

## 3. Workflow/DAG Visualization

### 3.1 DAG Rendering Approaches

| Library | Rendering | Interactivity | Layout Algorithm | Best For |
|---------|-----------|---------------|------------------|----------|
| ReactFlow | SVG/HTML | Full (drag, zoom, pan, custom nodes) | Dagre/ELK integration | Complex interactive flow editors |
| Mermaid | SVG (rendered) | Minimal (click handlers) | Built-in | Static documentation diagrams |
| D3-dag | SVG | Manual (bindable) | Sugiyama, Zherebko | Custom research-grade layouts |
| Dagre | Layout only | N/A (layout algorithm) | Sugiyama | Pair with React/SVG for custom rendering |
| Cytoscape.js | Canvas/SVG | Pan, zoom, select | Cola, Dagre, COSE | Network/graph analysis |
| ELK | Layout only | N/A | Layered (Eclipse) | Pair with ReactFlow for large DAGs |
| vis-network | Canvas | Pan, zoom, physics | Various | Quick prototypes |

**Recommended for Ark:** **ReactFlow** with Dagre layout. Reasons:
1. Ark flows are DAGs with 3-8 stages -- small enough that Dagre handles layout well
2. ReactFlow provides custom node components, so each stage can render status, agent info, duration, and action buttons
3. ReactFlow has built-in zoom/pan, minimap, and controls -- valuable when flows get complex (fan-out)
4. Large ecosystem: `@xyflow/react` (v12) is actively maintained, well-documented, MIT licensed
5. Server-side rendering support for static previews

### 3.2 Stage Progression Indicators

**Patterns observed across platforms:**

- **Horizontal stepper** (Material UI, Ant Design): Numbered circles connected by lines. Completed steps are filled, current step has a ring/pulse, future steps are outlined. Works for linear flows up to ~8 stages.
- **Vertical timeline** (GitHub PR timeline, Jira issue history): Events stack vertically with connecting lines. Better for flows where stages have rich metadata.
- **Pipeline bar** (Jenkins Blue Ocean, GitLab CI): Horizontal bar divided into segments, each representing a stage. Width proportional to duration. Color indicates status.
- **Breadcrumb trail** (current Ark approach): `plan > [implement] > verify > review > merge`. Compact but lacks visual weight.

**Recommendation for Ark:** Replace the current breadcrumb pipeline with a **horizontal stepper with DAG support**:

```
  [plan]---->[implement]---->[verify]---->[review]---->[merge]
   done       RUNNING         next        pending      pending
   2m14s      4m32s           -            -            -
```

For fan-out flows, the stepper should branch and reconverge:

```
                    +->[impl-A]--+
  [plan]---->[fan-out]            +->[join]---->[review]
                    +->[impl-B]--+
```

Render this with ReactFlow using custom node components that show:
- Stage name
- Status (colored badge)
- Assigned agent
- Duration (elapsed or total)
- Action button (if gate is manual)

### 3.3 Parallel Execution Visualization (Fan-Out / Fan-In)

Fan-out is one of Ark's differentiating features. Current web UI has no fan-out visualization (noted in SURFACE_PARITY.md gap #9).

**Patterns from distributed systems:**

- **Jaeger/Zipkin trace view**: A waterfall/Gantt chart showing parent and child spans. The parent span encompasses the children. This is the standard for visualizing parallel work.
- **Airflow Grid view**: Each task in a row, each DAG run in a column. Parallel tasks appear in separate rows at the same column position.
- **Temporal** shows child workflows as expandable nodes in the parent workflow's event history.

**Recommendation:** Build a **fan-out panel** that appears when a session has sub-sessions:

```
Fan-out: implement (3 sub-agents)
+-----------+-------------------------------------------+
| impl-A    | [=========>                ] 65% running   |
| impl-B    | [==================>      ] 82% running   |
| impl-C    | [============================] completed  |
+-----------+-------------------------------------------+
Join condition: all complete (2/3 done)
```

Each sub-session row should be clickable to navigate to its detail view.

### 3.4 Diff Viewers and Code Review

The current diff preview renders `git diff --stat` output in a `<pre>` block. This is minimal.

**Patterns from GitHub, GitLab, Gerrit, Reviewable:**

- **Split diff view** (side-by-side old/new) or **unified diff view** (interleaved)
- **Syntax highlighting** in diffs -- critical for readability
- **File tree sidebar** showing changed files with add/modify/delete icons and line count badges
- **Inline comments** for review feedback
- **Expand context** buttons to see surrounding unchanged lines
- **Collapse unchanged files** to focus on what matters

**Recommendations for Ark:**
- Use `react-diff-viewer` or `monaco-editor` in diff mode for syntax-highlighted diff rendering.
- Show a **file tree** of changed files in the left margin. Clicking a file scrolls the diff to that file.
- For the review stage, allow the reviewer agent's comments to appear as **inline annotations** in the diff.

---

## 4. Control Plane UX Patterns

### 4.1 Kubernetes Dashboard Patterns (Lens, Rancher, K9s)

**Lens** (desktop Kubernetes IDE):
- **Cluster-scoped sidebar**: Namespaces, Workloads, Network, Storage, Access Control as top-level categories
- **Resource list with live updates**: Tables with sortable columns, inline status icons, age column
- **Resource detail as a slide-over panel**: Click a pod to see its YAML, events, logs, and shell in a right panel
- **Terminal built-in**: Shell into any pod directly from the UI
- **Metrics overlay**: CPU/memory sparklines in the resource list
- **Multi-cluster support**: Switch between clusters via a top-level dropdown

**Rancher**:
- **Cluster explorer**: A file-system-like tree of all Kubernetes resources
- **Form-based resource creation**: Instead of writing YAML, fill in a form. Toggle between form and YAML views.
- **Bulk actions**: Select multiple resources and apply actions (delete, label, annotate)

**K9s** (terminal UI):
- **Vim-like navigation**: `j`/`k` to move, `:` for commands, `/` for search
- **Pulse view**: A dashboard showing cluster vitals (node count, pod count, CPU/memory)
- **XRay view**: Hierarchical tree (namespace -> deployment -> replicaset -> pod -> container)

**Relevance to Ark:** Ark's control plane has analogous resources (sessions, computes, agents, flows, runtimes, skills, recipes). The patterns apply:

- **Adopt Lens's resource-detail slide-over pattern** -- already implemented in SessionsPage but should extend to compute, agents, flows.
- **Add Rancher's form/YAML toggle** for agent and flow editing. Currently, AgentsView and FlowsView show YAML but editing is done in a code editor. A form view for common fields (name, agent role, skills) with a "View YAML" toggle would lower the barrier.
- **Implement K9s's Vim navigation** -- partially done (j/k/t/n shortcuts in SessionsPage). Extend to all list views.
- **Add a "Pulse" mode to Dashboard** showing real-time vitals: sessions/min, tokens/min, cost/min, error rate.

### 4.2 Cloud Console Patterns (AWS, GCP, Vercel)

**AWS Console**:
- **Service-oriented navigation**: Each service has its own sub-navigation. Breadcrumbs show the path.
- **Resource ARN as the universal identifier**: Every resource has a copyable unique ID.
- **Tag-based filtering**: Filter any resource list by tags.
- **Cost allocation tags**: Tie costs to resources via tags.

**Vercel Dashboard**:
- **Project-centric view**: Everything is scoped to a project (deployments, domains, env vars, logs).
- **Deployment list as a timeline**: Most recent at top, each with status, duration, commit info, preview URL.
- **Instant preview deployments**: Click any deployment to see it live.
- **Function logs**: Real-time streaming with filter by function, status code, duration.
- **Speed Insights**: Performance metrics with percentile breakdowns.

**GCP Console**:
- **Pin frequently used services** to a custom sidebar.
- **Activity feed** across all services -- a unified timeline of changes.
- **IAM integration** -- every page shows what permissions are needed to perform actions.

**Recommendations for Ark:**
- Add **session tags** for filtering and cost allocation. Tags like `team:backend`, `priority:p0`, `feature:auth` would enable powerful filtering.
- Consider **project-scoping** -- when `--repo` is set, filter all views to that repo. Similar to Vercel's project-centric model.
- Add **copyable session IDs** with a click-to-copy button (the ID is shown but not easily copyable).
- Show **required permissions** or daemon status when actions are unavailable, rather than just hiding buttons.

### 4.3 Cost Tracking UIs

**AWS Cost Explorer** patterns:
- **Stacked area chart** showing daily costs broken down by service/resource
- **Forecasting**: Projected end-of-month cost based on current trend
- **Budget alerts**: Visual threshold lines on charts
- **Group by**: Toggle between grouping by service, region, tag, account
- **Anomaly detection**: Highlight unexpected cost spikes

**Datadog billing**:
- **Usage attribution**: Which team/service is responsible for what percentage of spend
- **Commitment tracking**: How much of a committed spend has been used
- **Per-host/container cost breakdown**

**Recommendations for Ark's Costs page:**
- Add a **stacked area chart** showing daily cost by model (claude-sonnet, claude-opus, etc.). The data exists (`costs.byModel`); it needs a time series.
- Add **cost forecasting**: "At current rate, this month will cost $X." Simple linear extrapolation from the month-to-date.
- Surface **budget alerts** prominently -- the dashboard has a budget bar but it should also trigger toasts when thresholds are crossed.
- Add **cost per session** as a sortable column in the session list.
- Group costs by: model, agent, flow, repo, time period. The CLI has `--by` flags; the web UI needs equivalent group-by dropdowns.

### 4.4 Configuration Management UIs

**Patterns for YAML/config editing:**

- **Form view with validation**: Each config field rendered as a typed input (text, number, select, toggle). Real-time validation. This is the 80% case.
- **Code editor with schema**: Monaco Editor with JSON Schema / YAML Schema for autocompletion and error highlighting. This is for power users.
- **Toggle between views**: A tab or button to switch between Form and Code views. Rancher, Backstage, and Argo CD all do this.
- **Diff on save**: Show what changed before confirming. "You're about to change agent role from 'implementer' to 'reviewer'. Proceed?"
- **Template gallery**: Browse pre-built configurations with preview. Click "Use this template" to populate the form.
- **Dry-run / validate**: A button that validates the configuration without applying it.

**Recommendations for Ark:**
- Build a **form view** for agent and flow creation. Fields: name, description, agent role/skills (agent), stages (flow). Power users can toggle to YAML.
- Add **Monaco Editor** with YAML syntax highlighting for the code view. Current implementation uses a plain `<textarea>`.
- Add a **template gallery** for flows and recipes. Show the 13 built-in flows and 8 recipes as cards with descriptions.
- Implement **dry-run validation** for flows: "This flow has 5 stages, uses agents X, Y, Z. All agents are defined."

---

## 5. Chat/Interaction Design Patterns

### 5.1 AI Chat Interfaces

**ChatGPT / Claude.ai patterns:**
- **Markdown rendering** in assistant messages (code blocks, headers, lists, tables)
- **Code blocks with syntax highlighting** and copy button
- **Streaming response** with cursor animation
- **Message actions**: copy, regenerate, edit, branch
- **Artifact/canvas panel**: Side panel for code, documents, or diagrams that the assistant creates
- **Model selector** in the input area
- **File attachments**: Drag-and-drop or click to attach

**Cursor chat patterns:**
- **Inline code references**: Messages reference specific files and line numbers, rendered as clickable links
- **Apply button**: A single button to apply a suggested code change to the file
- **Context indicators**: Shows what files/symbols are in the context window
- **Tool call visualization**: Shows when the agent is searching, reading files, or running commands

**Recommendations for Ark's ChatPanel:**
- Add **Markdown rendering** in agent messages. Use `react-markdown` with `remark-gfm` and `react-syntax-highlighter`.
- Show **tool call activity** when the agent is working: "Agent is running `make test`...", "Agent is reading `src/app.ts`..."
- Add **message actions**: copy message content, link to this message in events.
- Show **context/cost indicator**: "This message used 1.2k tokens ($0.003)".
- Support **file attachments** or paste-to-send for screenshots/logs.

### 5.2 Human-in-the-Loop Patterns

Ark's agents run autonomously but operators need to intervene. The current actions (dispatch, stop, pause, interrupt, complete, advance) are good but the UX could be improved.

**Patterns from industrial automation and robotics:**

- **Intervention hierarchy**: Nudge (hint) < Redirect (change task) < Override (take control) < Kill (terminate). Each level should be visually distinct and increasingly prominent.
- **Confirmation for destructive actions**: "Stop" and "Delete" should require confirmation. "Are you sure? This will terminate the running agent."
- **Guided intervention**: When an agent is stuck/waiting, show suggested next actions based on context. "Agent is waiting for manual gate. You can: Approve, Reject, or Send feedback."
- **Intervention log**: Record all human interventions as events so they appear in the timeline.

**Current Ark gaps:**
- No confirmation dialogs for destructive actions (stop, delete)
- All action buttons are the same size/weight -- "Delete" should be visually de-emphasized compared to "Dispatch"
- No suggested actions based on context
- The "Interrupt" button sends Ctrl-C but there's no feedback about whether the interrupt was received

**Recommendations:**
- Add **confirmation modals** for stop, delete, and archive actions.
- **Group actions by intent**: Primary (Dispatch, Advance, Complete), Secondary (Pause, Fork, Chat, Attach), Danger (Stop, Interrupt, Delete). Use visual hierarchy -- primary actions as solid buttons, secondary as outlined, danger as red/outlined.
- Add **contextual action suggestions**: When status is "waiting" or "blocked," show a prominent banner: "This session is waiting for [gate name]. [Approve] [Reject] [Send Message]".
- Show **intervention feedback**: After sending an interrupt, show "Interrupt sent. Agent acknowledging..." then update when the agent responds.

### 5.3 Tool Call Visualization

Agents in Ark use MCP tools (report, channel messaging, knowledge search). Visualizing tool calls helps operators understand agent behavior.

**Patterns from LangSmith, Vercel AI SDK, OpenAI Playground:**

- **Collapsible tool call blocks**: Each tool call shown as an accordion with: tool name, input parameters, output, duration, status.
- **Nested tool calls**: If a tool triggers sub-tools, show them nested.
- **Timeline integration**: Tool calls appear as events in the session timeline with duration bars.
- **Cost attribution**: Each tool call that invokes an LLM shows the token count and cost.

**Recommendations for Ark:**
- Parse agent messages to detect tool calls and render them as **collapsible blocks** with structured input/output rather than raw text.
- Add tool call events to the **events timeline** with duration and status.
- For MCP tool calls (knowledge search, report), show the **tool name as a badge** in the conversation view.

---

## 6. Information Architecture Recommendations

### 6.1 Current Navigation (12 pages)

```
Dashboard | Sessions | Agents | Flows | Compute | History | Memory | Tools | Schedules | Costs | Settings | Login
```

**Problems:**
1. **Flat hierarchy**: 12 top-level pages is at the upper limit of what users can scan. Research suggests 7 +/- 2 items for comfortable navigation.
2. **Mixed abstractions**: "Sessions" (runtime state) alongside "Agents" (configuration) alongside "Costs" (analytics) alongside "Settings" (meta). These serve different user intents.
3. **No grouping**: Agents, Flows, Runtimes, Skills, Recipes are all related configuration resources but spread across three pages (Agents, Flows, Tools).

### 6.2 Recommended IA Restructure

Group by user intent:

```
OPERATE                    CONFIGURE                 ANALYZE
  Dashboard                  Agents                    Costs
  Sessions                   Flows                     History
  Compute                    Runtimes (under Tools)    Memory
  Schedules                  Skills (under Tools)
                             Recipes (under Tools)
                             Settings

```

**Proposed sidebar structure (7 primary items):**

```
Dashboard          -- Fleet overview, health, costs, activity
Sessions           -- Active and historical sessions (merge History into this)
Resources          -- Agents, Flows, Runtimes, Skills, Recipes (tabbed)
Compute            -- Compute providers and instances
Knowledge          -- Memory + Knowledge Graph (rename from Memory)
Costs              -- Cost tracking, budgets, analytics
Settings           -- Configuration, schedules, auth
```

**Key changes:**
1. **Merge History into Sessions** as a tab/filter. History is just completed/imported sessions. No need for a separate page.
2. **Merge Agents, Flows, Tools into a Resources page** with tabs. These are all YAML resource definitions with the same CRUD pattern.
3. **Rename Memory to Knowledge**. "Memory" is ambiguous; "Knowledge" matches the codebase naming (`knowledge/` package).
4. **Move Schedules under Settings**. Schedules are configuration, not a primary operational concern.
5. **Drop Login from sidebar**. Login is a full-page auth gate, not a navigation item.

This reduces the sidebar from 12 items to 7, which fits the cognitive limit better and groups related concepts.

### 6.3 Deep Linking and URL Structure

The current hash router (`#sessions`, `#sessions/s-abc123`) supports basic navigation. Recommendations:

- **Path-based routing**: `/sessions`, `/sessions/s-abc123`, `/sessions/s-abc123/chat`, `/sessions/s-abc123/terminal`
- **Query parameters for filters**: `/sessions?status=running&agent=implementer`
- **Shareable URLs**: Every view state should be representable as a URL for sharing in Slack/teams.
- **Breadcrumbs**: `Dashboard > Sessions > s-abc123 > Chat`

---

## 7. Wireframe Descriptions

### 7.1 Dashboard (Redesigned)

```
+------------------------------------------------------------------+
|  [Sidebar]  |  DASHBOARD                               [Live] o  |
|             |                                                     |
|  Dashboard  |  +--Fleet Status (2-col span)--+ +--Health--------+ |
|  Sessions   |  |  5 running  2 waiting       | | Conductor: ok  | |
|  Resources  |  |  0 failed   12 completed    | | ArkD: ok       | |
|  Compute    |  |  [sparklines under each]     | | Router: off    | |
|  Knowledge  |  +-----------------------------+ +----------------+ |
|  Costs      |                                                     |
|  Settings   |  +--Cost Summary---+ +--Active Sessions-----------+ |
|             |  | Today: $4.23    | | s-a1b2  implementing  4m   | |
|             |  | Week:  $18.90   | | s-c3d4  reviewing     2m   | |
|             |  | Month: $52.10   | | s-e5f6  waiting gate  8m   | |
|             |  | [budget bar]    | | s-g7h8  running tests 1m   | |
|             |  | [forecast: ~$78]| | [show all ->]              | |
|             |  +-----------------+ +----------------------------+ |
|             |                                                     |
|             |  +--Activity Feed (full-width)--------------------+ |
|             |  | 2:15pm  s-a1b2  Stage advanced: verify -> rev  | |
|             |  | 2:14pm  s-e5f6  Waiting for manual gate        | |
|             |  | 2:12pm  s-g7h8  Dispatched (implementer)       | |
|             |  | 2:10pm  s-c3d4  PR created: #142               | |
|             |  | [filter: all | status | cost | error]          | |
|             |  +------------------------------------------------+ |
+------------------------------------------------------------------+
```

**Key changes from current:**
- Added **sparklines** to fleet status cards
- Added **Active Sessions** widget showing currently running sessions with elapsed time (replaces Quick Actions, which duplicates sidebar functionality)
- Added **cost forecast** to cost summary
- Made activity feed **full-width** with filter tabs
- Added **[Live] indicator** showing real-time connection status

### 7.2 Sessions Page (Enhanced)

```
+------------------------------------------------------------------+
|  [Sidebar]  |  SESSIONS  [All|Running|Waiting|Failed|...]  [+New] |
|             |  [Search /]  [View: List | Grid | Timeline]         |
|             +------+----------------------------------------------|
|             |  List|  SESSION DETAIL: s-a1b2                  [x] |
|             |      |                                              |
|             | o s-a|  [running] s-a1b2         [Stop] [Chat]     |
|             |   1b2|  "Implement auth middleware"                  |
|             |      |                                              |
|             | o s-c|  FLOW PIPELINE (ReactFlow visualization)     |
|             |   3d4|  [plan]-->[implement]-->[verify]-->[review]  |
|             |      |   done     RUNNING       next      pending   |
|             | o s-e|   2m14s    4m32s                              |
|             |   5f6|                                              |
|             |      |  +--Terminal--+ +--Chat--+                   |
|             | o s-g|  | $ make test| | Agent: I've completed     |
|             |   7h8|  | PASS 42/42 | | the auth middleware.      |
|             |      |  | $          | | Shall I proceed to tests? |
|             |      |  +------------+ | You: Yes, run make test   |
|             |      |                 +---------------------------+ |
|             |      |                                              |
|             |      |  USAGE: 12.4k tokens  $0.08                  |
|             |      |  CHANGES: 3 files  +142 -28                  |
|             |      |  [Preview Diff] [Create PR]                  |
|             |      |                                              |
|             |      |  EVENTS TIMELINE                             |
|             |      |  | 2:15  Stage: implement started            |
|             |      |  | 2:14  Dispatched (implementer, claude)    |
|             |      |  | 2:13  Stage: plan completed               |
+------------------------------------------------------------------+
```

**Key changes from current:**
- Added **view switcher** (List, Grid, Timeline) in the header
- **Terminal and Chat shown side-by-side** instead of replacing the detail content
- **Flow pipeline** rendered as a proper DAG visualization with node details
- **Usage/Changes** section is more compact and scannable
- Events timeline uses **connected dots** pattern (already implemented, keep it)

### 7.3 Session Detail -- Grid View (New)

For monitoring many sessions simultaneously:

```
+------------------------------------------------------------------+
|  SESSIONS  [All|Running...]  [View: List | *Grid* | Timeline]     |
|                                                                   |
|  +--------+ +--------+ +--------+ +--------+ +--------+          |
|  | s-a1b2 | | s-c3d4 | | s-e5f6 | | s-g7h8 | | s-i9j0 |        |
|  | impl.  | | review | | WAIT   | | tests  | | plan   |         |
|  | 4m32s  | | 2m10s  | | 8m15s  | | 1m05s  | | 0m42s  |         |
|  | $0.08  | | $0.12  | | $0.04  | | $0.03  | | $0.01  |         |
|  | [====] | | [===]  | | [!!!!] | | [==]   | | [=]    |         |
|  +--------+ +--------+ +--------+ +--------+ +--------+          |
|                                                                   |
|  +--------+ +--------+ +--------+ +--------+                     |
|  | s-k1l2 | | s-m3n4 | | s-o5p6 | | s-q7r8 |  COMPLETED         |
|  | done   | | done   | | done   | | done   |                     |
|  | 12m    | | 8m     | | 15m    | | 6m     |                     |
|  | $0.22  | | $0.15  | | $0.31  | | $0.09  |                     |
|  | [####] | | [####] | | [####] | | [####] |                     |
|  +--------+ +--------+ +--------+ +--------+                     |
+------------------------------------------------------------------+
```

Each card is color-coded by status (green border = running, amber = waiting, red = failed, blue = completed). Cards with "WAIT" or "FAIL" status use attention-grabbing styling. Clicking a card opens the detail panel.

### 7.4 Fan-Out Visualization (New)

When a session uses fan-out, the session detail shows:

```
FAN-OUT: implement (3 parallel agents)
+-------------------------------------------------------------------+
|                                                                    |
|  [plan] ----+----> [impl-A: auth]  ------+                       |
|             |       running 4m, $0.08     |                       |
|             |                             +-----> [join] --> [rev] |
|             +----> [impl-B: api]   ------+        waiting         |
|             |       running 3m, $0.05     |        (2/3)          |
|             |                             |                       |
|             +----> [impl-C: tests] ------+                       |
|                     completed 6m, $0.12                           |
|                                                                    |
+-------------------------------------------------------------------+
|                                                                    |
|  Sub-sessions:                                                     |
|  [running] s-fan-a1  impl-A: auth     4m  $0.08  [Attach] [Chat] |
|  [running] s-fan-b2  impl-B: api      3m  $0.05  [Attach] [Chat] |
|  [done]    s-fan-c3  impl-C: tests    6m  $0.12  [View]          |
|                                                                    |
+-------------------------------------------------------------------+
```

---

## 8. Gap Analysis vs. Current Ark Web UI

### High Priority (Operational Impact)

| Gap | Current State | Recommendation | Effort |
|-----|--------------|----------------|--------|
| Flow pipeline is a text breadcrumb | `plan > [implement] > verify` | ReactFlow DAG with status nodes | Medium |
| No fan-out visualization | Not implemented | Fan-out panel with DAG + sub-session list | Medium |
| Live output lacks ANSI rendering | `<pre>` block with raw text | Use `ansi-to-react` or custom ANSI parser | Small |
| No confirmation for destructive actions | Buttons fire immediately | Add confirmation modals for stop/delete | Small |
| Terminal is fixed height | Hardcoded 360px | Make resizable with drag handle | Small |
| No sparklines on dashboard | Static numbers only | Add react-sparklines to fleet cards | Small |
| Chat lacks Markdown rendering | Plain text | Add react-markdown with syntax highlighting | Small |

### Medium Priority (User Experience)

| Gap | Current State | Recommendation | Effort |
|-----|--------------|----------------|--------|
| No grid/heatmap view for sessions | List view only | Add grid view for fleet monitoring | Medium |
| No view switcher (list/grid/timeline) | List only | Add toggle in SessionsPage header | Small |
| No pause-on-hover for live output | Auto-scrolls without pause | Reuse ChatPanel's userScrolled pattern | Small |
| No search within live output | No search | Add search bar with match highlighting | Medium |
| No cost forecasting | Shows current spend only | Linear extrapolation of month-to-date | Small |
| Activity feed lacks filtering | Shows all events | Add type filter tabs | Small |
| No time-in-state display | Shows updated_at | Track and display state entry time | Small |
| Flat 12-item navigation | All pages at top level | Group into 7 categories (see IA section) | Medium |

### Lower Priority (Polish)

| Gap | Current State | Recommendation | Effort |
|-----|--------------|----------------|--------|
| No detachable terminal | Inline only | Pop-out into new window | Medium |
| No split-pane for fan-out logs | Single output view | Side-by-side output panels | Large |
| No form/YAML toggle for resource editing | YAML-only or form-only | Dual-mode editor | Medium |
| No deep linking for session sub-views | Hash-based routing | Path-based routing with query params | Medium |
| No tool call visualization | Messages shown as plain text | Collapsible tool call blocks | Medium |
| No resource template gallery | Flat list | Card-based gallery with previews | Medium |
| No diff syntax highlighting | Raw `git diff --stat` | `react-diff-viewer` or Monaco diff | Medium |

---

## 9. References

### CI/CD and Pipeline UIs
- GitHub Actions: workflow visualization graph, job dependency rendering, annotation extraction
- CircleCI: pipeline-centric view, insights dashboard, workflow DAG
- Buildkite: waterfall timeline, unblock steps for manual gates, grouped parallel steps
- Jenkins Blue Ocean: pipeline stage visualization, parallel branch rendering
- GitLab CI: pipeline graph view, merge request pipeline widget
- Argo CD: application sync status, rollout visualization, DAG view

### Orchestration Platforms
- Apache Airflow: Grid view, Graph view, Gantt chart, task instance detail
- Temporal: workflow execution timeline, event history, pending activities
- Prefect: flow run timeline, task state visualization, radar view
- Dagster: asset lineage graph, run timeline, sensor/schedule monitoring
- Luigi: task dependency visualization, central scheduler UI

### Monitoring and Observability
- Datadog: Infrastructure Map (host heatmap), Log Explorer, APM trace waterfall
- Grafana: dashboard panels, Loki log streaming, Tempo trace view
- New Relic: entity explorer, distributed tracing, log patterns
- Kibana: Discover (log search), Dashboard (visualizations), Canvas

### Kubernetes and Cloud Dashboards
- Lens: resource list with sparklines, slide-over detail, built-in terminal
- Rancher: cluster explorer, form/YAML toggle, bulk actions
- K9s: Vim navigation, Pulse view, XRay hierarchical view
- AWS Console: service navigation, resource tagging, Cost Explorer
- GCP Console: pinned services, activity feed, IAM integration
- Vercel: project-centric deployment list, function logs, Speed Insights

### AI Chat and Agent UIs
- ChatGPT: Markdown rendering, streaming, message actions, canvas panel
- Claude.ai: artifact panel, project knowledge, conversation branching
- Cursor: inline code references, Apply button, tool call visualization
- LangSmith: trace tree, tool call detail, token attribution
- Vercel AI SDK: useChat hook, streaming UI, tool invocation rendering
- OpenAI Playground: model selector, system prompt, function call display

### DAG Visualization Libraries
- ReactFlow (@xyflow/react): interactive node-based graphs, custom nodes, minimap
- Mermaid: text-based diagram rendering (flowchart, sequence, gantt)
- D3-dag: research-grade DAG layout algorithms
- Dagre: Sugiyama-based graph layout (pairs with React/SVG)
- Cytoscape.js: graph analysis and visualization
- ELK (Eclipse Layout Kernel): layered graph layout for complex DAGs

### Terminal and Log Libraries
- xterm.js: terminal emulation (already used in Ark)
- @xterm/addon-search: search within terminal content
- @xterm/addon-fit: responsive terminal sizing (already used)
- react-lazylog: lazy-loaded log viewer for large files
- ansi-to-react: ANSI escape code to React component rendering
- react-markdown + remark-gfm: Markdown rendering in chat

### Design Systems and Component Libraries Referenced
- Radix UI / shadcn/ui: Ark's current component base
- Material UI Stepper: horizontal/vertical step progression
- Ant Design Steps: step navigation with rich content
- Recharts: charting library (already used in Ark)
- react-sparklines: lightweight inline sparkline charts
- react-diff-viewer: side-by-side and unified diff rendering
- Monaco Editor: code editing with language support and diff mode
