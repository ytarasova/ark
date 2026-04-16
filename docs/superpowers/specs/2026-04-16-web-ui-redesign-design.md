# Ark Web UI Redesign -- Design Specification

**Date:** 2026-04-16
**Status:** Draft
**Scope:** Full web UI rework -- layout, themes, navigation, component system, session detail

---

## 1. Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Themes | All 3 switchable (Midnight Circuit default) | User choice; CSS custom properties make it trivial |
| Layout | Icon Rail (48px) + Master-Detail | Maximizes horizontal space for session detail; industry standard (Linear, Cursor, VS Code) |
| Dashboard header | Status chips in page header | No KPI tiles; counts double as filters; zero wasted vertical space |
| Session detail | Tabbed panels (Conversation, Terminal, Events, Diff, Todos) | Full-height single panel focus; keyboard shortcuts 1-5 to switch |
| Navigation | 6 items: Sessions (home), Agents, Compute, Knowledge, Costs, Settings | Aggressive consolidation from 10; "Agents" groups agents/flows/tools/runtimes as sub-tabs |
| Dashboard page | Eliminated -- Sessions IS the home screen | Status chips + session list provide the overview |

---

## 2. Application Shell

### 2.1 Three-Panel Layout

```
+------+------------------+-------------------------------+
| Icon |   List Panel     |        Detail Panel           |
| Rail |   (resizable)    |                               |
| 48px |   200-320px      |        remaining              |
|      |                  |                               |
|      |  - search        |  [session header + pipeline]  |
|      |  - filter chips  |  [tabs: Conv|Term|Evt|Diff]   |
|      |  - session list  |  [tab content -- full height] |
|      |                  |  [chat input pinned bottom]    |
|      |                  |                               |
+------+------------------+-------------------------------+
```

- **Icon Rail** (48px): Logo + 5 nav icons + settings at bottom. Tooltip on hover. Active state: icon tinted primary, left border accent.
- **List Panel** (200-320px, resizable): Context-dependent. On Sessions page: session list with search, status filter chips, and session cards. On Agents page: agent/flow/tool/runtime list. Collapsible via keyboard shortcut (Cmd+B) or drag to zero.
- **Detail Panel** (remaining): Full session detail, agent definition view, compute status, etc.

### 2.2 Icon Rail Navigation

6 items, top to bottom:

| Position | Icon | Label | View | Contains |
|----------|------|-------|------|----------|
| Logo | Ark gradient | -- | -- | Brand mark, links to Sessions |
| 1 | `Play` or custom | Sessions | sessions | Active + history (filter/tab), session detail |
| 2 | `Bot` or `Settings` | Agents | agents | Sub-tabs: Agents, Flows, Tools, Runtimes (first sub-tab shares parent label) |
| 3 | `Server` | Compute | compute | Compute templates + active instances |
| 4 | `Brain` or `BookOpen` | Knowledge | knowledge | Memory + codegraph search |
| 5 | `DollarSign` | Costs | costs | Spending, budgets, model breakdown |
| Bottom | `Cog` | Settings | settings | Config, schedules, router, daemon health |

Daemon health dot: embedded in the logo area or Settings icon (green/amber/red glow).

### 2.3 Page Header Pattern

Every page uses the same header bar:

```
[Page Title]  [status chip] [status chip]  ...  [secondary info]  [primary action button]
```

- **Sessions page**: `Sessions  [7 running] [2 waiting]  ...  $12.40 today  [+ New]`
- **Agents page**: `Agents  [12 agents] [8 flows]  ...  [+ Create]`
- Status chips are clickable filters (toggle to filter list below).
- Cost/secondary info is right-aligned, muted color.

### 2.4 Command Palette (Cmd+K)

Global command palette for power users:

- Navigate to any page or session
- Create new session (with flow/agent selection)
- Search sessions, agents, flows
- Quick actions: stop session, dispatch, attach terminal
- System commands: start/stop daemon, clear DB

Uses `cmdk` library (already in the React ecosystem). Matches Linear/Raycast pattern.

---

## 3. Themes

Three switchable themes. Applied via class on `<html>` element (`midnight-circuit`, `arctic-slate`, `warm-obsidian`) combined with `dark`/`light` modifier. User preference stored in localStorage. OS preference detection for initial selection.

### 3.1 Midnight Circuit (Default)

Deep blue-black backgrounds, purple-cyan accents. Neural network / circuit aesthetic. Premium and technical.

**Dark mode:**

| Token | Value | Usage |
|-------|-------|-------|
| `--background` | `#0C0C14` | Page background |
| `--card` | `#14141E` | Card/panel surfaces |
| `--popover` | `#18182A` | Elevated popovers |
| `--sidebar` | `#0A0A12` | Icon rail, list panel |
| `--foreground` | `#E4E4ED` | Primary text |
| `--muted-foreground` | `#7878A0` | Secondary text |
| `--primary` | `#7C6AEF` | Purple accent |
| `--primary-foreground` | `#FFFFFF` | Text on primary |
| `--secondary` | `#1E1E30` | Subtle backgrounds |
| `--border` | `#252540` | Purple-tinted borders |
| `--ring` | `#7C6AEF` | Focus rings |
| `--destructive` | `#E5484D` | Error/danger |

**Light mode:**

| Token | Value | Usage |
|-------|-------|-------|
| `--background` | `#F8F8FC` | Slight purple tint |
| `--card` | `#FFFFFF` | Cards |
| `--sidebar` | `#F0F0F8` | Sidebar background |
| `--foreground` | `#1A1A2E` | Primary text |
| `--muted-foreground` | `#6B6B88` | Secondary text |
| `--primary` | `#6C5CE7` | Darker purple for WCAG AA (4.2:1 on white) |
| `--border` | `#DCDCE8` | Borders |

### 3.2 Arctic Slate

Cool neutral gray-blue. Electric blue accent. GitHub/Vercel feel.

**Dark mode:**

| Token | Value |
|-------|-------|
| `--background` | `#0F1117` |
| `--card` | `#161922` |
| `--sidebar` | `#0B0D13` |
| `--foreground` | `#E5E7EB` |
| `--muted-foreground` | `#6B7280` |
| `--primary` | `#3B82F6` |
| `--border` | `#1F2937` |

**Light mode:**

| Token | Value |
|-------|-------|
| `--background` | `#F9FAFB` |
| `--card` | `#FFFFFF` |
| `--foreground` | `#111827` |
| `--primary` | `#2563EB` |
| `--border` | `#E5E7EB` |

### 3.3 Warm Obsidian

Warm dark stone. Amber/gold accent. Grafana-inspired energy.

**Dark mode:**

| Token | Value |
|-------|-------|
| `--background` | `#0E0D0B` |
| `--card` | `#16140F` |
| `--sidebar` | `#0A0908` |
| `--foreground` | `#E8E4DE` |
| `--muted-foreground` | `#8B8579` |
| `--primary` | `#F59E0B` |
| `--border` | `#2A2520` |

**Light mode:**

| Token | Value |
|-------|-------|
| `--background` | `#FAFAF8` |
| `--card` | `#FFFFFF` |
| `--foreground` | `#1C1917` |
| `--primary` | `#D97706` |
| `--border` | `#E7E5E4` |

### 3.4 Semantic Status Colors (All Themes)

Consistent across all themes. Use Tailwind semantic classes, not hardcoded hex.

| Status | Dark Mode | Light Mode | Glow |
|--------|-----------|------------|------|
| running | `#34D399` (emerald-400) | `#059669` (emerald-600) | Yes, pulsing |
| waiting | `#FBBF24` (amber-400) | `#D97706` (amber-600) | No |
| completed | `#60A5FA` (blue-400) | `#2563EB` (blue-600) | No |
| failed | `#F87171` (red-400) | `#DC2626` (red-600) | Subtle |
| stopped | `#6B7280` at 0.4 | `#9CA3AF` at 0.6 | No |
| pending | `#6B7280` at 0.3 | `#9CA3AF` at 0.5 | No |

### 3.5 Brand Gradient

```css
--gradient-brand: linear-gradient(135deg, var(--primary) 0%, #06B6D4 100%);
```

Used for: logo mark, empty states, onboarding. Adapts to theme (purple-cyan for Midnight, blue-cyan for Arctic, amber-orange for Warm).

---

## 4. Typography

### 4.1 Font Stack

- **Sans:** Inter (`--font-sans`) -- body text, UI labels, headings
- **Mono:** JetBrains Mono (`--font-mono`) -- code, terminal, session IDs, technical values
- No additional fonts needed. Both are already loaded.

### 4.2 Type Scale

Base: 13px. Ratio: 1.2 (minor third).

| Token | Size | Weight | Usage |
|-------|------|--------|-------|
| `text-xs` | 10px | 400 | Timestamps, tertiary labels |
| `text-sm` | 11px | 400 | Secondary text, metadata |
| `text-base` | 13px | 400 | Body text, list items |
| `text-md` | 14px | 500 | Emphasized body, nav labels |
| `text-lg` | 16px | 600 | Section headings, page titles |
| `text-xl` | 20px | 600 | Large headings (rare) |

Monospace is always 1px smaller than its context (12px in body, 10px in secondary text).

### 4.3 Key Rules

- Session IDs always monospace: `font-family: var(--font-mono)`
- Cost values always monospace
- Agent names in regular weight, flow names in regular weight
- No text larger than 20px anywhere in the app (this is a dense tool, not a marketing page)

---

## 5. Session Detail View

The most complex and most-used screen.

### 5.1 Structure

```
+------------------------------------------------------------------+
| [status dot] s-a1b2  Add auth middleware   [plan]->[impl]->...  $0.82  [Stop] |  <- session header
+------------------------------------------------------------------+
| Conversation | Terminal | Events (24) | Diff (+42/-8) | Todos (3) |  <- tabs
+------------------------------------------------------------------+
|                                                                    |
|  [Agent avatar] Analyzing codebase. Found 3 files...              |
|                                                                    |
|  [Tool icon] Edit: packages/server/routes/api.ts        [done]    |  <- collapsible
|                                                                    |
|  [Agent avatar] Applied auth middleware to all 3 files.            |
|                                                                    |
+------------------------------------------------------------------+
| [Send message to agent...]                              [Send]    |  <- pinned input
+------------------------------------------------------------------+
```

### 5.2 Session Header Bar

Single row, always visible:

- Status dot (with glow animation for running)
- Session ID (monospace, clickable to copy)
- Summary text (truncated, muted color)
- DAG pipeline: horizontal stage badges showing progress (completed=green, active=primary, pending=muted). Always visible -- Ark's key differentiator.
- Cost badge (monospace, primary color)
- Action buttons (Stop, Dispatch, Advance -- context-dependent)

### 5.3 Tabs

| Tab | Content | Badge |
|-----|---------|-------|
| Conversation | Agent messages + tool calls + user messages | -- |
| Terminal | Live terminal output (ANSI-rendered) | -- |
| Events | Timeline of session events (stage changes, reports, errors) | Event count |
| Diff | Git diff viewer (files changed by agent) | +lines/-lines |
| Todos | Agent's todo list items with status | Pending count |

Keyboard shortcuts: `1` through `5` to switch tabs (when not in chat input).

### 5.4 Conversation Rendering

- **Agent messages**: Avatar (gradient circle with "A") + message bubble. Markdown rendered. Code blocks with syntax highlighting.
- **Tool calls**: Collapsible blocks with tool icon, name, file path, and status (running/done/error). Collapsed by default once complete. Expand to see full input/output.
- **User messages**: Right-aligned or visually distinct. Rare in autonomous mode.
- **Stage transitions**: Inline banner: "Stage advanced: plan -> implement" with timestamp.

### 5.5 Chat Input

Pinned at bottom of Conversation tab:

- Text input with placeholder "Send message to agent..."
- Send button (primary color)
- Input expands vertically for multi-line (shift+enter for newline, enter to send)
- Disabled when session is not running/waiting

---

## 6. Sessions List (Home Screen)

### 6.1 List Panel Content

- **Search bar**: Filter by session ID, summary text, agent name
- **Status filter chips**: `[7 running] [2 waiting] [3 completed] [1 failed]` -- click to toggle filter. Active chip has colored background. Chips appear in the page header, not in the list panel.
- **Session cards**: Compact rows in the list panel

### 6.2 Session Card (List Item)

```
[status dot] s-a1b2          2m ago
Add auth middleware...
[plan][impl][___][___]  implementer  $0.82
```

- Status dot with appropriate color/glow
- Session ID (monospace) + relative time
- Summary (truncated to 1 line)
- Mini pipeline (3px height bars, colored by stage status)
- Agent name + cost (muted, right-aligned)

Selected card: highlighted background + left border accent (primary color).

### 6.3 View Toggles

Two view modes (toggle in header):

- **List** (default): Compact rows in the list panel, detail in main panel
- **Grid**: Session cards in a grid layout in the main panel (no list panel). Better for fleet overview with 10+ sessions.

---

## 7. Component Architecture

### 7.1 Layering

1. **Radix UI primitives**: Dialog, Popover, DropdownMenu, Tabs, Tooltip, ScrollArea, Separator
2. **Styled components** (cva): Button, Badge, Card, Input -- existing pattern, keep as-is
3. **Composed patterns**: SessionCard, PipelineBadges, StatusDot, ConversationMessage, ToolCallBlock

### 7.2 New/Modified Components

| Component | Type | Purpose |
|-----------|------|---------|
| `IconRail` | New | 48px navigation rail with icon buttons |
| `ListPanel` | New | Resizable session/resource list panel |
| `SessionHeader` | Modified | Compact header with inline DAG pipeline |
| `PipelineBadges` | New | Horizontal stage badges for DAG visualization |
| `StatusChip` | New | Clickable filter chip ("7 running") |
| `ConversationView` | Modified | Markdown rendering, tool call blocks, stage banners |
| `ToolCallBlock` | New | Collapsible tool call display |
| `CommandPalette` | New | Cmd+K overlay (cmdk library) |
| `ThemeSwitcher` | New | Theme selection in Settings |

### 7.3 Libraries to Add

| Library | Purpose |
|---------|---------|
| `cmdk` | Command palette |
| `react-resizable-panels` | Resizable list/detail split |
| (Already have) `@radix-ui/*`, `lucide-react`, `class-variance-authority` | Keep |

### 7.4 Libraries to Consider

| Library | Purpose | Decision |
|---------|---------|----------|
| `@tanstack/react-table` | Data tables for Compute, Costs | Add if table views needed |
| `sonner` | Toast notifications (replace current custom) | Recommend |
| `react-markdown` + `react-syntax-highlighter` | Conversation markdown rendering | Recommend |

---

## 8. Interaction Patterns

### 8.1 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Command palette |
| `Cmd+B` | Toggle list panel |
| `1-5` | Switch session detail tabs |
| `Cmd+N` | New session |
| `Escape` | Close detail / deselect |
| `J/K` | Navigate session list (vim-style) |
| `Enter` | Open selected session |

### 8.2 Animations

Minimal, functional:

- **Status dot glow**: `glow-pulse` 2.5s ease-in-out (running sessions only)
- **Panel transitions**: 150ms ease-out for tab switches
- **List items**: `slide-up` 200ms on new session appearance
- **Command palette**: `fade-in` 100ms + `slide-up` 50ms

No page transition animations. No loading spinners for < 200ms operations.

### 8.3 Density

Single density mode -- compact. Optimized for information-dense professional use:

- List rows: 52px height (session card with pipeline)
- Table rows: 32px height
- Icon rail items: 36px touch target
- Spacing scale: 4/6/8/10/12/16px (Tailwind defaults)

---

## 9. Accessibility

- **WCAG AA contrast**: All text meets 4.5:1 on its background. Primary accent in light mode uses `#6C5CE7` (4.2:1) instead of `#7C6AEF` (3.38:1 -- fails).
- **Focus rings**: 2px ring in primary color on all interactive elements. Already implemented via `focus-visible:ring-2`.
- **Keyboard navigation**: Full keyboard operability. Tab order follows visual order. Arrow keys in lists.
- **Screen reader**: Semantic HTML. ARIA labels on icon-only buttons. Status changes announced via live regions.
- **Reduced motion**: Respect `prefers-reduced-motion`. Disable glow-pulse and slide animations.

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

### 10.2 Migration Path

The redesign replaces the current layout entirely but can reuse:

- All `packages/web/src/components/ui/*` primitives (Button, Card, Badge, Input, etc.)
- Hooks (`useSmartPoll`, `useApi`, `useSessionDetailData`, `useDaemonStatus`)
- Utility functions (`fmtCost`, `relTime`, `formatRepoName`)
- API layer (`hooks/useApi.ts`)

New layout components wrap existing content views. Migration order:

1. Theme system + CSS variables
2. IconRail + ListPanel + shell layout
3. Session detail (tabbed panels, conversation rendering)
4. Remaining pages (Agents, Compute, Knowledge, Costs, Settings)
5. Command palette
6. Polish (animations, keyboard shortcuts, accessibility audit)

---

## 11. What This Spec Does NOT Cover

- Mobile/responsive layouts (desktop-only tool)
- Electron-specific features (beyond existing drag regions)
- API changes (purely frontend)
- Data visualization library choices (Recharts is fine for now)
- Exact icon choices for the rail (to be decided during implementation)
