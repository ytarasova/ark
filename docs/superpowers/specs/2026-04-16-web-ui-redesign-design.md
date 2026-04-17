# Ark Web UI Redesign -- Design Specification

**Date:** 2026-04-16
**Status:** Final Proposal
**Scope:** Full web UI rework -- layout, themes, navigation, component system, session detail

---

## 1. Visual Philosophy

**One sentence:** Ark looks like Linear crossed with a DAG pipeline -- dense, dark, restrained, with color that means something.

The register is **functional elegance**: beauty follows from function, not decoration. No gradients on buttons, no ornamental borders, no drop shadows on cards. Surfaces are distinguished through subtle background shifts and whitespace. 80%+ of any screen is grayscale. Color enters only for status, interaction, and Ark's signature DAG pipeline.

This is not Apple HIG consumer polish (explored in FRESH-1 mockup -- too soft for fleet agent management). Not Datadog density-at-all-costs. It's the Linear/Vercel zone: every pixel earns its place, information is dense but breathable, and the tool disappears behind the work.

**Visual metaphor: Constellation / Neural Flow.** Agents are nodes. Flows are edges. Active sessions glow. The DAG pipeline -- Ark's key differentiator -- is the visual centerpiece of every session. No competitor visualizes SDLC flow progress this way.

### 1.1 Design Decisions Summary

| Decision         | Choice                                                                | Rationale                                                                                 |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Aesthetic        | Functional elegance (Linear register)                                 | Dense operational tool, not consumer app; restraint = premium                             |
| Themes           | 3 switchable (Midnight Circuit default)                               | User choice; CSS custom properties make it trivial                                        |
| Layout           | Icon Rail (48px) + List Panel + Detail Panel                          | Maximizes horizontal space; industry standard (Linear, VS Code, Cursor)                   |
| Dashboard header | Status chips in page header                                           | No KPI tiles; counts double as filters; zero wasted vertical space                        |
| Session detail   | Tabbed panels (Conversation, Terminal, Events, Diff, Todos)           | Full-height single-panel focus; keyboard shortcuts 1-5 to switch                          |
| Navigation       | 6 items: Sessions (home), Agents, Compute, Knowledge, Costs, Settings | Aggressive consolidation from 10; "Agents" groups agents/flows/tools/runtimes as sub-tabs |
| Dashboard page   | Eliminated -- Sessions IS the home screen                             | Status chips + session list provide the overview                                          |
| Typography       | Inter + JetBrains Mono + Geist Mono                                   | Proven at small sizes; dual mono for code vs UI data                                      |
| Primary accent   | Purple #7C6AEF                                                        | AI/agent alignment; distinct from Windsurf mint, GitHub blue                              |
| Motion           | Functional only, 150-200ms                                            | Linear's curve; no decorative animation                                                   |
| Density          | Single compact mode                                                   | Power users managing agent fleets want maximum density                                    |

### 1.2 Research Synthesis

This spec synthesizes six research tracks:

| Input                             | What was adopted                                                                             | What was rejected (and why)                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Design spec brainstorm            | Icon rail, 3 themes, status chips, tabbed panels, 6-item nav, sessions as home, Cmd+K        | -- (all major decisions confirmed)                                                                                         |
| FRESH-1 mockup (PR #149)          | Clean surface transitions (200ms), localStorage theme persistence, keyboard shortcuts        | 240px text sidebar (wastes space for 6 items), right workspace panel (fragments focus), Apple HIG aesthetic (too consumer) |
| Competitor analysis (15 products) | Three-panel layout, dark-first, keyboard-first, Linear density, Cursor tool-call blocks      | Windsurf Kanban (list + grid toggle covers this), Datadog KPI tiles (wasted vertical space)                                |
| Design system research            | Functional elegance, 3-layer components, semantic color, cva variants, Sonner toasts         | Density toggle (single compact mode is enough)                                                                             |
| Typography/color research         | Inter + JetBrains + Geist Mono, purple primary, constellation metaphor, oklch for new tokens | Custom/display fonts (Inter wins at dense UI sizes)                                                                        |
| Orchestration UX patterns         | ReactFlow DAGs, horizontal stepper pipeline, fan-out panel, pause-on-hover                   | Waterfall/Gantt view (post-v1), split-pane fan-out logs (post-v1)                                                          |

---

## 2. Application Shell

### 2.1 Three-Panel Layout

```
+------+------------------+-------------------------------+
| Icon |   List Panel     |        Detail Panel           |
| Rail |   (resizable)    |                               |
| 48px |   280-400px      |        remaining              |
|      |                  |                               |
| [Ark]|  - search        |  [session header + pipeline]  |
| Sess |  - filter chips  |  [tabs: Conv|Term|Evt|Diff]   |
| Agnt |  - session list  |  [tab content -- full height] |
| Comp |                  |  [chat input pinned bottom]    |
| Know |                  |                               |
| Cost |                  |                               |
| [Cog]|                  |                               |
+------+------------------+-------------------------------+
```

- **Icon Rail** (48px): Logo + 5 nav icons + settings at bottom. Tooltip on hover. Active state: icon tinted primary, left border accent. Icons use Lucide at 15px, 1.5px stroke. Inactive: `text-muted-foreground`; hover: `text-foreground`; active: `text-primary` with `bg-accent rounded-md` highlight (Linear pattern).
- **List Panel** (280-400px, resizable): Context-dependent. On Sessions page: session list with search, status filter chips, and session cards. On Agents page: agent/flow/tool/runtime list. Collapsible via Cmd+B or drag to zero. Width stored in localStorage per-view. Uses `react-resizable-panels` with 1px border that becomes 4px drag handle on hover.
- **Detail Panel** (remaining): Full session detail, agent definition view, compute status, etc. No separate right workspace panel -- tabbed content keeps focus on one thing at a time.

### 2.2 Icon Rail Navigation

6 items, top to bottom:

| Position | Icon                  | Label     | View      | Contains                                                                     |
| -------- | --------------------- | --------- | --------- | ---------------------------------------------------------------------------- |
| Logo     | Ark gradient mark     | --        | --        | Brand mark, links to Sessions                                                |
| 1        | `Play` or custom      | Sessions  | sessions  | Active + history (filter/tab), session detail                                |
| 2        | `Bot` or `Settings`   | Agents    | agents    | Sub-tabs: Agents, Flows, Tools, Runtimes (first sub-tab shares parent label) |
| 3        | `Server`              | Compute   | compute   | Compute templates + active instances                                         |
| 4        | `Brain` or `BookOpen` | Knowledge | knowledge | Memory + codegraph search                                                    |
| 5        | `DollarSign`          | Costs     | costs     | Spending, budgets, model breakdown                                           |
| Bottom   | `Cog`                 | Settings  | settings  | Config, schedules, router, daemon health                                     |

Daemon health dot: embedded in the logo area or Settings icon (green/amber/red glow).

### 2.3 Page Header Pattern

Every page uses the same header bar:

```
[Page Title]  [status chip] [status chip]  ...  [secondary info]  [primary action button]
```

- **Sessions page**: `Sessions  [7 running] [2 waiting]  ...  $12.40 today  [+ New]`
- **Agents page**: `Agents  [12 agents] [8 flows]  ...  [+ Create]`
- Status chips are clickable filters (toggle to filter list below). Active chip has colored background.
- Cost/secondary info is right-aligned, muted color, monospace.

### 2.4 Command Palette (Cmd+K)

Global command palette for power users. Uses `cmdk` library (matches Linear/Raycast pattern):

- Navigate to any page or session
- Create new session (with flow/agent selection)
- Search sessions, agents, flows by fuzzy match on ID, summary, agent name
- Quick actions: stop session, dispatch, attach terminal, advance stage
- System commands: start/stop daemon, toggle theme, clear DB
- Keyboard shortcut hints displayed on each item

---

## 3. Themes

Three switchable themes. Applied via class on `<html>` element (`midnight-circuit`, `arctic-slate`, `warm-obsidian`) combined with `dark`/`light` modifier. User preference stored in localStorage. OS preference detection for initial selection.

All themes share identical semantic status colors (Section 3.4) and the same CSS custom property names. Only the values change.

### 3.1 Midnight Circuit (Default)

Deep blue-black backgrounds, purple-cyan accents. Constellation/neural network aesthetic. Premium and technical. Closest to Linear + Stripe.

**Dark mode:**

| Token                  | Value     | Usage                                    |
| ---------------------- | --------- | ---------------------------------------- |
| `--background`         | `#0C0C14` | Page background -- deep blue-black       |
| `--card`               | `#14141E` | Card/panel surfaces                      |
| `--popover`            | `#18182A` | Elevated popovers                        |
| `--sidebar`            | `#0A0A12` | Icon rail, list panel                    |
| `--foreground`         | `#E4E4ED` | Primary text (off-white, not pure white) |
| `--muted-foreground`   | `#7878A0` | Secondary text                           |
| `--primary`            | `#7C6AEF` | Purple accent                            |
| `--primary-foreground` | `#FFFFFF` | Text on primary                          |
| `--secondary`          | `#1E1E30` | Subtle backgrounds                       |
| `--border`             | `#252540` | Purple-tinted borders                    |
| `--ring`               | `#7C6AEF` | Focus rings                              |
| `--destructive`        | `#E5484D` | Error/danger                             |

**Light mode:**

| Token                | Value     | Usage                                      |
| -------------------- | --------- | ------------------------------------------ |
| `--background`       | `#F8F8FC` | Slight purple tint                         |
| `--card`             | `#FFFFFF` | Cards                                      |
| `--sidebar`          | `#F0F0F8` | Sidebar background                         |
| `--foreground`       | `#1A1A2E` | Primary text                               |
| `--muted-foreground` | `#6B6B88` | Secondary text                             |
| `--primary`          | `#6C5CE7` | Darker purple for WCAG AA (4.2:1 on white) |
| `--border`           | `#DCDCE8` | Borders                                    |

### 3.2 Arctic Slate

Cool neutral gray-blue. Electric blue accent. Vercel/GitHub feel. For users who prefer minimal.

**Dark mode:**

| Token                | Value     |
| -------------------- | --------- |
| `--background`       | `#09090B` |
| `--card`             | `#111113` |
| `--sidebar`          | `#09090B` |
| `--foreground`       | `#EDEDF0` |
| `--muted-foreground` | `#71717A` |
| `--primary`          | `#3B82F6` |
| `--border`           | `#27272A` |

**Light mode:**

| Token          | Value     |
| -------------- | --------- |
| `--background` | `#FAFAFA` |
| `--card`       | `#FFFFFF` |
| `--foreground` | `#18181B` |
| `--primary`    | `#2563EB` |
| `--border`     | `#E4E4E7` |

### 3.3 Warm Obsidian

Warm dark stone. Amber/gold accent. Grafana-inspired energy. Reduces eye strain during long sessions.

**Dark mode:**

| Token                | Value     |
| -------------------- | --------- |
| `--background`       | `#0F0F0F` |
| `--card`             | `#191919` |
| `--sidebar`          | `#0C0C0C` |
| `--foreground`       | `#EDEDED` |
| `--muted-foreground` | `#878787` |
| `--primary`          | `#D4A847` |
| `--border`           | `#2A2A2A` |

**Light mode:**

| Token          | Value     |
| -------------- | --------- |
| `--background` | `#FAF9F7` |
| `--card`       | `#FFFFFF` |
| `--foreground` | `#1C1C1C` |
| `--primary`    | `#B8922E` |
| `--border`     | `#E0DFDB` |

### 3.4 Semantic Status Colors (All Themes)

Consistent across all themes. Status colors are reserved -- never use emerald for non-running states, never use red for non-error states.

| Status    | Dark Mode               | Light Mode              | Glow                             |
| --------- | ----------------------- | ----------------------- | -------------------------------- |
| running   | `#34D399` (emerald-400) | `#059669` (emerald-600) | Subtle static glow (not pulsing) |
| waiting   | `#FBBF24` (amber-400)   | `#D97706` (amber-600)   | No                               |
| completed | `#60A5FA` (blue-400)    | `#2563EB` (blue-600)    | No                               |
| failed    | `#F87171` (red-400)     | `#DC2626` (red-600)     | Subtle red                       |
| stopped   | `#6B7280` at 0.4        | `#9CA3AF` at 0.6        | No                               |
| pending   | `#6B7280` at 0.3        | `#9CA3AF` at 0.5        | No                               |

**Running glow is static, not pulsing.** Design system research recommends against pulsing animation -- a static glow is visually distinct without being distracting during extended monitoring.

### 3.5 Brand Gradient

```css
/* Adapts per theme -- purple-cyan for Midnight, blue-cyan for Arctic, amber-orange for Warm */
--gradient-brand: linear-gradient(135deg, var(--primary) 0%, #06b6d4 100%);
```

The cyan evokes "flow" and "orchestration" -- water flowing through channels.

Used for: logo mark, empty states, DAG pipeline progress fill. **Never** on buttons or UI chrome.

### 3.6 Color Usage Rules

1. **Maximum 2 hues per view** (primary accent + one status color at a time).
2. **Gray is the dominant color.** 80%+ of any screen should be grayscale.
3. **Status colors are reserved.** Never use emerald for non-running states, never use red for non-error states.
4. **Opacity for backgrounds.** Status backgrounds use 10-15% opacity of the status color, not a separate color.
5. **oklch for new tokens.** Migrate from hex to oklch for perceptual uniformity (Tailwind v4 direction).

---

## 4. Typography

### 4.1 Font Stack

Three typographic voices:

```css
/* UI text (navigation, labels, buttons, descriptions, body) */
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;

/* Code (code blocks, terminal output, log viewers) */
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;

/* Data (session IDs, costs, timestamps, port numbers -- narrower, refined) */
--font-mono-ui: "Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace;
```

**Inter** wins over Geist Sans: proven at 11-13px (the sizes that dominate Ark's dense dashboard), massive glyph coverage, battle-tested in thousands of products. Geist was considered for differentiation but Inter's legibility at small sizes is unmatched.

**Dual monospace**: JetBrains Mono for immersive code contexts (terminal, code blocks). Geist Mono for inline data (session IDs, costs, timestamps) -- it's narrower and more refined for UI use.

### 4.2 Type Scale

Base: 13px. 9-step semantic scale aligned with the design system research (Appendix B). Tight but legible for dense dashboards.

| Token              | Size  | Weight  | Line Height | Letter Spacing | Usage                                        |
| ------------------ | ----- | ------- | ----------- | -------------- | -------------------------------------------- |
| `text-display`     | 24px  | 600     | 32px        | -0.015em       | Page titles (rarely used)                    |
| `text-title`       | 18px  | 600     | 28px        | -0.01em        | Section titles                               |
| `text-heading`     | 15px  | 600     | 22px        | -0.01em        | Card titles, dialog titles, panel headers    |
| `text-body`        | 13px  | 400     | 20px        | 0              | Default body text, list items, form inputs   |
| `text-body-medium` | 13px  | 500     | 20px        | 0              | Emphasized body, nav labels, section headers |
| `text-label`       | 12px  | 500     | 16px        | 0              | Form labels, tab labels, metadata            |
| `text-caption`     | 11px  | 400-500 | 16px        | +0.01em        | Timestamps, secondary info, table metadata   |
| `text-micro`       | 10px  | 500     | 14px        | +0.02em        | Badges, status text, keyboard shortcuts      |
| `text-2xs`         | 9px   | 500     | 12px        | +0.04em        | Superscripts, count badges (use sparingly)   |

Letter spacing rules: >= 15px use -0.01em (tight), 12-14px use 0 (normal), <= 11px uppercase use 0.04-0.08em (tracked).

**Monospace is always 1px smaller** than its corresponding sans context to appear optically equal.

**No text larger than 20px anywhere in the app.** This is a dense operational tool, not a marketing page.

### 4.3 Weight Convention

| Weight  | Name       | Usage                                                                                                                       |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400     | Regular    | Body text, descriptions, form inputs                                                                                        |
| **500** | **Medium** | **The workhorse.** Buttons, nav items, table headers, labels, sidebar items. This weight is what makes dense UIs scannable. |
| 600     | Semibold   | Section headings, card titles, active states. Avoid overuse.                                                                |
| 700     | Bold       | Page titles only. Appears max 1-2 times per viewport.                                                                       |

**Anti-pattern:** Using only 400 and 700. The 500 weight is critical for the subtle hierarchy that makes dense UIs breathable.

### 4.4 Key Rules

- Session IDs always use `--font-mono-ui` (Geist Mono)
- Cost values always use `--font-mono-ui` with `tabular-nums`
- Agent names in regular weight sans, flow names in regular weight sans
- ALL CAPS labels: only at 10-11px, tracked at +0.04em to +0.08em
- Never adjust letter-spacing on monospace -- it breaks column alignment

---

## 5. Session Detail View

The most complex and most-used screen. This is where operators spend 80% of their time.

### 5.1 Structure

```
+------------------------------------------------------------------+
| [*] s-a1b2  Add auth middleware   [plan]->[IMPL]->[___]  $0.82  [Stop] |  <- session header
+------------------------------------------------------------------+
| Conversation | Terminal | Events (24) | Diff (+42/-8) | Todos (3) |  <- tabs
+------------------------------------------------------------------+
|                                                                    |
|  [A] Analyzing codebase. Found 3 files to modify.                 |
|                                                                    |
|  [>] Edit: packages/server/routes/api.ts              [done] v    |  <- collapsible tool call
|                                                                    |
|  [A] Applied auth middleware to all 3 files.                       |
|                                                                    |
|  --- Stage advanced: plan -> implement  (2:15pm) ---              |  <- inline banner
|                                                                    |
+------------------------------------------------------------------+
| [Send message to agent...]                              [Send]    |  <- pinned input
+------------------------------------------------------------------+
```

### 5.2 Session Header Bar

Single row, always visible. The most information-dense element in the app:

- **Status dot** with appropriate color and static glow for running
- **Session ID** (Geist Mono, clickable to copy)
- **Summary text** (truncated, muted color)
- **DAG pipeline**: horizontal stage badges showing progress. Completed = emerald fill, active = primary color with glow, pending = muted outline. Always visible -- Ark's key differentiator. For fan-out flows, branches visually using ReactFlow + Dagre.
- **Cost badge** (Geist Mono, primary color)
- **Action buttons** (Stop, Dispatch, Advance -- context-dependent). Grouped by intent: primary actions as solid buttons, secondary as outlined, danger as red/outlined.

### 5.3 Tabs

| Tab          | Content                                                     | Badge         |
| ------------ | ----------------------------------------------------------- | ------------- |
| Conversation | Agent messages + tool calls + user messages                 | --            |
| Terminal     | Live terminal output (xterm.js, ANSI-rendered)              | --            |
| Events       | Timeline of session events (stage changes, reports, errors) | Event count   |
| Diff         | Syntax-highlighted diff viewer (files changed by agent)     | +lines/-lines |
| Todos        | Agent's todo list items with status                         | Pending count |

Keyboard shortcuts: `1` through `5` to switch tabs (when not in chat input). Tab switch uses 150ms `fade-in` animation.

### 5.4 Conversation Rendering

- **Agent messages**: Left-aligned, markdown rendered (react-markdown + remark-gfm + syntax highlighting). Code blocks with copy button.
- **Tool calls**: Collapsible blocks (Cursor pattern) with tool icon, name, file path, status badge (running/done/error), and duration. Collapsed by default once complete. Expand to see full input/output.
- **User messages**: Visually distinct (slight background shift or right-aligned). Rare in autonomous mode.
- **Stage transitions**: Inline banner: "Stage advanced: plan -> implement" with timestamp.
- **Cost per message**: Optional subtle "1.2k tokens ($0.003)" indicator.

### 5.5 Chat Input

Pinned at bottom of Conversation tab:

- Text input with placeholder "Send message to agent..."
- Send button (primary color)
- Input expands vertically for multi-line (shift+enter for newline, enter to send)
- Disabled with explanatory text when session is not running/waiting

### 5.6 Fan-Out Visualization

When a session uses fan-out, the DAG pipeline branches and the Events tab shows a fan-out panel:

```
Fan-out: implement (3 parallel agents)
+-----------+-------------------------------------------+
| impl-A    | [=========>                ] 65% running   |
| impl-B    | [==================>      ] 82% running   |
| impl-C    | [============================] completed  |
+-----------+-------------------------------------------+
Join condition: all complete (2/3 done)
```

Each sub-session row is clickable to navigate to its detail view.

---

## 6. Sessions List (Home Screen)

### 6.1 List Panel Content

- **Search bar**: Filter by session ID, summary text, agent name. Focus with `/` key.
- **Status filter chips**: `[7 running] [2 waiting] [3 completed] [1 failed]` in the page header (not in the list panel). Click to toggle filter. Active chip has colored background matching the status color.
- **Session cards**: Compact rows in the list panel.

### 6.2 Session Card (List Item)

52px height. Contains:

```
[status dot] s-a1b2          2m ago
Add auth middleware...
[plan][impl][___][___]  implementer  $0.82
```

- Status dot with appropriate color/glow
- Session ID (Geist Mono) + relative time (updates live without page refresh)
- Summary (truncated to 1 line)
- Mini pipeline (3px height bars, colored by stage status)
- Agent name + cost (muted, right-aligned, Geist Mono for cost)

Selected card: highlighted background + left border accent (primary color).

### 6.3 View Toggles

Two view modes (toggle in header):

- **List** (default): Compact rows in the list panel, detail in main panel. Best for 1-20 sessions.
- **Grid**: Session cards in a card grid in the main panel (no list panel). Each card color-coded by status (border color). Better for fleet overview with 10+ sessions. Cards with "waiting" or "failed" status use attention-grabbing styling.

---

## 7. Component Architecture

### 7.1 Three-Layer Model

```
Layer 1: Primitives (Radix UI)
  Dialog, DropdownMenu, Tooltip, Tabs, Popover, Select, Switch,
  ScrollArea, Separator, Collapsible, AlertDialog, HoverCard
  -> Zero styling, full accessibility, keyboard navigation

Layer 2: Styled Components (shadcn/ui pattern, cva)
  Button, Badge, Card, Input, Tabs, Command, Dialog, Table, etc.
  -> Tailwind + cva, composable sub-components, source-owned

Layer 3: Composed Patterns (Ark-specific)
  SessionCard, PipelineBadges, StatusDot, ConversationView,
  ToolCallBlock, CommandPalette, FanOutPanel, etc.
  -> Built from Layer 2, contain business logic
```

### 7.2 New/Modified Components

| Component          | Type     | Purpose                                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| `IconRail`         | New      | 48px navigation rail with icon buttons and tooltips                                 |
| `ListPanel`        | New      | Resizable session/resource list panel                                               |
| `SessionHeader`    | Modified | Compact header with inline DAG pipeline                                             |
| `PipelineBadges`   | New      | Horizontal stage badges for DAG visualization (ReactFlow + Dagre for complex flows) |
| `StatusChip`       | New      | Clickable filter chip ("7 running") with status color                               |
| `ConversationView` | Modified | Markdown rendering (react-markdown), tool call blocks, stage banners                |
| `ToolCallBlock`    | New      | Collapsible tool call display (Cursor pattern) with name, file, status, duration    |
| `CommandPalette`   | New      | Cmd+K overlay (cmdk library)                                                        |
| `ThemeSwitcher`    | New      | Theme selection in Settings                                                         |
| `FanOutPanel`      | New      | Fan-out sub-session progress visualization                                          |
| `StatusIndicator`  | New      | Unified StatusDot + StatusBadge with static glow for running                        |

### 7.3 cva Variant Convention

Every styled component uses cva with consistent contract: `variant`, `size`, optional `className` for escape hatches. Props follow shadcn/ui patterns: `asChild` for polymorphism, `open`/`onOpenChange` for controlled state.

### 7.4 Libraries to Add

| Library                                                                  | Purpose                                      |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| `cmdk`                                                                   | Command palette                              |
| `react-resizable-panels`                                                 | Resizable list/detail split                  |
| `react-markdown` + `remark-gfm`                                          | Conversation markdown rendering              |
| `react-syntax-highlighter` or `shiki`                                    | Code block highlighting                      |
| `sonner`                                                                 | Toast notifications (replace current custom) |
| `@xyflow/react` (ReactFlow)                                              | DAG pipeline visualization for complex flows |
| (Already have) `@radix-ui/*`, `lucide-react`, `class-variance-authority` | Keep                                         |

### 7.5 Libraries to Consider (Post-v1)

| Library                            | Purpose                                | Decision                  |
| ---------------------------------- | -------------------------------------- | ------------------------- |
| `@tanstack/react-table`            | Data tables for Compute, Costs         | Add if table views needed |
| `react-diff-viewer` or Monaco diff | Syntax-highlighted diffs               | Recommend for Diff tab    |
| `ansi-to-react`                    | ANSI terminal rendering in Live Output | Recommend                 |

---

## 8. Interaction Patterns

### 8.1 Keyboard Shortcuts

| Shortcut | Action                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------- |
| `Cmd+K`  | Command palette                                                                                |
| `Cmd+B`  | Toggle list panel (collapse to 0px with 200ms animation; restore to stored width on re-toggle) |
| `1-5`    | Switch session detail tabs                                                                     |
| `Cmd+N`  | New session                                                                                    |
| `Escape` | Close detail / deselect                                                                        |
| `j/k`    | Navigate session list (vim-style)                                                              |
| `Enter`  | Open selected session                                                                          |
| `/`      | Focus search                                                                                   |

Shortcuts displayed as badge hints throughout the interface.

### 8.2 Motion

Functional only. No decorative animation.

| Category | Duration  | Easing                           | Usage                                  |
| -------- | --------- | -------------------------------- | -------------------------------------- |
| Micro    | 100-150ms | `ease-out`                       | Hover states, focus rings, opacity     |
| Standard | 200ms     | `cubic-bezier(0.32, 0.72, 0, 1)` | Dropdowns, tooltips, tab switches      |
| Expand   | 250ms     | `cubic-bezier(0.32, 0.72, 0, 1)` | Collapsible sections, tool call expand |

The easing `cubic-bezier(0.32, 0.72, 0, 1)` is Linear's signature curve -- fast start, gentle deceleration. Feels responsive without being jarring.

- **New item in list**: slide-up + fade-in 200ms, brief highlight (`bg-primary/5`) fading over 2s.
- **Status change**: badge cross-fade 200ms.
- **Tab switch**: fade-in 150ms (instant exit).
- **No page transition animations.** No loading spinners for < 200ms operations. Use skeleton screens.

### 8.3 Density

Single density mode -- compact. Optimized for power users managing agent fleets:

- Session card rows: 52px height (with mini pipeline)
- Table rows: 32px height
- Icon rail items: 36px touch target
- Spacing scale: 4px base grid (Tailwind defaults)

### 8.4 Real-Time Updates

- **SSE live updates** with visible "Live" indicator in header
- **Pause-on-hover** for streaming content (reuse existing `userScrolled` pattern)
- **Brief highlight animation** (2s fade) when new items appear in lists
- **Relative timestamps** update live without page refresh

### 8.5 Empty States

Every view needs a dedicated empty state. Pattern: centered icon (40px, muted) + title (text-lg) + description (text-base, muted) + optional primary action button.

| View                       | Icon          | Title                | Description                                     | Action        |
| -------------------------- | ------------- | -------------------- | ----------------------------------------------- | ------------- |
| Sessions (no sessions)     | Play          | No sessions yet      | Start your first AI agent session               | New Session   |
| Sessions (search empty)    | Search        | No results           | Try adjusting your search or filters            | Clear Filters |
| Conversation (new session) | MessageSquare | No messages yet      | Dispatch the session or send a message to start | --            |
| Events (empty)             | Activity      | No events yet        | Events will appear as the session progresses    | --            |
| Diff (no changes)          | FileCode      | No changes yet       | File changes will appear after implementation   | --            |
| Todos (empty)              | CheckSquare   | No todos             | The agent will create todos as it works         | --            |
| Agents                     | Bot           | No custom agents     | Create agents to define specialized AI roles    | Browse Agents |
| Compute                    | Server        | No compute resources | Configure compute targets for agent execution   | Add Compute   |

### 8.6 Loading States

Use skeleton screens, never spinners. Skeleton shapes match the content they replace:

- **Session list**: 6-8 skeleton rows matching the session card layout (dot + text lines + pipeline bars)
- **Conversation**: 3-4 skeleton message blocks with avatar + text placeholders
- **Tab content**: Content-appropriate skeleton matching the tab's expected layout
- **No loading states for < 200ms operations**: Show content or nothing

---

## 9. Accessibility

- **WCAG AA contrast**: All text meets 4.5:1 on its background. Light mode primary uses `#6C5CE7` (4.2:1) not `#7C6AEF` (3.38:1 -- fails).
- **Focus rings**: 2px ring in primary color on all interactive elements via `focus-visible:ring-2`.
- **Keyboard navigation**: Full keyboard operability. Tab order follows visual order. Arrow keys in lists. Vim navigation (j/k) in all list views.
- **Screen reader**: Semantic HTML. ARIA labels on icon-only buttons (icon rail, action buttons). Status changes announced via live regions.
- **Reduced motion**: Respect `prefers-reduced-motion`. Disable glow and slide animations. Instant transitions.

---

## 10. Implementation Notes

### 10.1 Theme Switching

```tsx
// Theme stored in localStorage, applied as class
<html class="midnight-circuit dark">
  <!-- OR -->
<html class="arctic-slate dark">
  <!-- OR -->
<html class="warm-obsidian light">
```

CSS custom properties cascade from the theme class. No JS needed for token resolution. Tailwind `@theme inline` block references the CSS variables.

### 10.2 Font Loading

```html
<link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/jetbrains-mono-var.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/geist-mono-var.woff2" as="font" type="font/woff2" crossorigin />
```

Variable font versions (single file, all weights). `font-display: swap` to prevent FOIT.

### 10.3 Migration Path

The redesign replaces the current layout entirely but can reuse:

- All `packages/web/src/components/ui/*` primitives (Button, Card, Badge, Input, etc.)
- Hooks (`useSmartPoll`, `useApi`, `useSessionDetailData`, `useDaemonStatus`)
- Utility functions (`fmtCost`, `relTime`, `formatRepoName`)
- API layer (`hooks/useApi.ts`)

New layout components wrap existing content views. Migration order:

1. Theme system + CSS variables (all 3 themes, dark + light)
2. IconRail + ListPanel + shell layout
3. Session detail (tabbed panels, conversation rendering with markdown + tool call blocks)
4. Remaining pages (Agents, Compute, Knowledge, Costs, Settings)
5. Command palette
6. DAG pipeline visualization (ReactFlow for complex flows, CSS stepper for simple)
7. Polish (animations, keyboard shortcuts, fan-out panel, accessibility audit)

---

## 11. What This Spec Does NOT Cover

- Mobile/responsive layouts (desktop-only tool)
- Electron-specific features (beyond existing drag regions)
- API changes (purely frontend)
- Data visualization library choices (Recharts is fine for now)
- Exact icon choices for the rail (decided during implementation)
- Kanban/swimlane views (post-v1 consideration)
- Waterfall/Gantt timeline view (post-v1 consideration)
