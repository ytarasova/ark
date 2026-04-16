# Ark Design Guidelines

> Source of truth for all Ark web UI work. Every component, every pixel, every interaction.
> Last updated: 2026-04-15

---

## 1. Design Philosophy

### 1.1 Confident Control

Ark is a control plane for autonomous agent fleets. The ONE feeling when you open Ark: **confidence**.
You are in command of powerful systems. The UI communicates this through restraint, precision, and
information density -- not through decoration or animation.

### 1.2 Complexity is Earned, Not Hidden

Ark has 11 compute providers, DAG-based orchestration, 4 agent runtimes, an LLM router, and a
knowledge graph. This complexity is a feature. Do not flatten it into simplistic views. Instead,
use progressive disclosure: the default view is a clean conversation timeline; depth is one click
away in the workspace panel. Every layer should feel intentional, never overwhelming.

### 1.3 Conversation-First, Always

The center of Ark is a conversation. Not a dashboard, not a settings page, not a chart. When a
user opens Ark, they see a session list and a chat timeline. Orchestration events, tool calls,
stage transitions, and review findings all render inline in the conversation -- not in separate
tabs. The conversation IS the control interface.

### 1.4 Monochromatic with Functional Color

Color is reserved for status and action. Everything else is grayscale. This forces visual hierarchy
through typography (weight, size, opacity) rather than through hue. The result: a UI that looks
calm at rest and communicates clearly when something needs attention.

### 1.5 No Generic SaaS Aesthetic

Ark is not a generic dashboard. If a component could appear in any shadcn/ui starter template
without modification, it is not finished. Every element should feel purpose-built for agent
orchestration. This means: monospaced metadata, pipeline stage indicators in the header, tool-call
cards with timing data, inline diff rendering.

---

## 2. Layout System

### 2.1 Three-Panel Standard

```
+----------+---------------------------+------------------+
|  Sidebar  |        Center            |   Workspace      |
|  216px    |        flex: 1           |   320px          |
|           |    (max-width: 720px     |                  |
|           |     for conversation)    |                  |
+----------+---------------------------+------------------+
```

- **Left sidebar (216px):** Session list grouped by flow, bottom navigation (Agents, Flows, Compute, Costs, Settings).
- **Center (flexible):** Conversation timeline with 720px max-width content column. Input bar fixed at bottom.
- **Right workspace (320px):** Tabbed panel -- Overview, Files, Diff, Metrics. Context-reactive to the selected session.

### 2.2 When to Use Fewer Panels

| Layout | When |
|--------|------|
| 3-panel | Default session view. Always. |
| 2-panel (sidebar + center) | Settings, Agents, Flows, Compute, Costs pages. No workspace needed. |
| Full-width | Never in the app shell. Only for standalone pages (login, onboarding). |

### 2.3 Header Bar (Always Visible, 44px)

Contents, left to right:
1. **Wordmark** -- "Ark", 15px, weight 600, letter-spacing -0.01em
2. **Pipeline stage indicator** -- Monospaced, shows current flow stages (plan --> implement --> verify --> review --> merge). Color-coded: green (done), accent (active), muted (pending).
3. **Search trigger** -- "Search..." button with Cmd+K badge, right-aligned
4. **Session meta** -- Cost and elapsed time in mono, muted color

### 2.4 Input Bar (Always Visible)

Fixed to the bottom of the center panel. 720px max-width inner container matching the conversation.
Contains: text input (13px sans), model name badge (10px mono, muted), send button (32x32px, accent background).

### 2.5 Sidebar Navigation

Bottom of the sidebar, separated by a 1px border-top:
- Agents (A), Flows (F), Compute (C), Costs ($), Settings (,)
- Each item shows its keyboard shortcut as a `kbd` badge
- Version number at the very bottom (10px mono, most muted color)

---

## 3. Typography System

### 3.1 Font Families

| Role | Family | Rationale |
|------|--------|-----------|
| UI text | `'Geist Sans', system-ui, -apple-system, sans-serif` | Purpose-built for developer tools. Superior to Inter at small sizes. Variable weight support. |
| Code and data | `'Geist Mono', 'SF Mono', 'Cascadia Code', monospace` | Pairs with Geist Sans. Used for all machine-generated content: IDs, timestamps, file paths, tool output, metrics. |

### 3.2 Type Scale

| Token | Size | Weight | Line-height | Letter-spacing | Usage |
|-------|------|--------|-------------|----------------|-------|
| `heading-lg` | 15px | 600 | 1.3 | -0.01em | Wordmark, page titles |
| `body` | 14px | 400 | 1.7 | normal | Agent prose, user messages, finding text |
| `body-medium` | 14px | 500 | 1.7 | normal | Emphasized body text (finding labels, summary values) |
| `ui-label` | 12px | 400 | 1.5 | normal | Session names, sidebar nav, file names, tool summaries |
| `ui-label-mono` | 12px | 400 | 1.5 | normal | Session status, overview grid values, agent models |
| `section-label` | 11px | 600 | 1.3 | 0.05em | Agent name labels ("PLANNER"), section headings. Always uppercase. |
| `system-label` | 10px | 600 | 1.3 | 0.06-0.08em | Sidebar section labels, group headers. Always uppercase. |
| `caption-mono` | 11px | 400 | 1.5-1.7 | normal | System events, tool detail output, diff content |
| `micro-mono` | 10px | 400-500 | 1.3 | normal | Timestamps, durations, line counts, kbd badges, version |

### 3.3 Typography Rules

- **Agent prose** uses `body` (14px/1.7). This is the most-read text. Never go smaller.
- **User messages** use `body` at the same size as agent prose. Differentiated by container treatment, not font size.
- **System events** use `caption-mono` (11px mono). They are secondary to conversation content.
- **Maximum content width** for readability: 720px for conversation, no max for workspace panels.
- **Never use serif.** Ark is a technical tool. Sans and mono only.

---

## 4. Color System

### 4.1 Dark Theme (Default)

```css
/* Surfaces -- darkest to lightest */
--page:      #0a0a0b;    /* App background, center panel */
--panel:     #111113;    /* Sidebar, workspace panel, input bar */
--recessed:  #18181b;    /* Inset surfaces: code blocks, input fields, tool rows */
--hover:     #1c1c1f;    /* Hover state on interactive elements */
--active:    #222226;    /* Active/pressed state, expanded tool detail */

/* Text -- brightest to dimmest */
--text:      #fafafa;    /* Primary text: headings, body, selected items */
--text-2:    #a1a1aa;    /* Secondary text: labels, file names, unselected items */
--text-3:    #52525b;    /* Tertiary text: placeholders, system events, tool summaries */
--text-4:    #3f3f46;    /* Quaternary text: timestamps, separators, disabled items */

/* Accent */
--accent:       #8b5cf6;                    /* THE accent color. Violet. */
--accent-faint: rgba(139, 92, 246, 0.07);   /* Accent background tint */

/* Borders */
--border:    #1e1e22;    /* All borders. One value. Consistent. */

/* Status (functional color only) */
--green:     #4ade80;    /* Running, passed, added lines, approved */
--red:       #f87171;    /* Failed, error, removed lines */
--amber:     #fbbf24;    /* Waiting, warning, notes */
```

### 4.2 Light Theme

```css
--page:      #ffffff;
--panel:     #fafafa;
--recessed:  #f4f4f5;
--hover:     #efefef;
--active:    #e8e8ec;

--text:      #18181b;
--text-2:    #52525b;
--text-3:    #a1a1aa;
--text-4:    #d4d4d8;

--accent:       #7c3aed;
--accent-faint: rgba(124, 58, 237, 0.05);

--border:    #e4e4e7;

--green:     #16a34a;
--red:       #dc2626;
--amber:     #d97706;
```

### 4.3 Color Rules

- **When to use color:** Status indicators, accent on selected/active elements, diff lines, and the send button. That is the complete list.
- **When to use grayscale:** Everything else. Text hierarchy is achieved through the 4-level text opacity scale, not through colored text.
- **The ONE accent color** is violet (`#8b5cf6` dark / `#7c3aed` light). Used for: selected sidebar item border, active tab underline, send button background, user message left border, text selection, link text. Nowhere else.
- **Status color mapping:**

| Status | Color | Token |
|--------|-------|-------|
| running | `--green` | Pulsing animation (2s ease-in-out) |
| completed | `--text-3` | No animation. Completed is not special. |
| failed | `--red` | Static. Red text. |
| waiting | `--amber` | Static. Amber text. |
| stopped | `--text-4` | Dimmest. Stopped sessions fade into the background. |

- **Why monochromatic wins:** Agent orchestration generates dense, information-rich timelines. Color noise competes with the content. A monochromatic base lets functional color (status, diffs, accent) cut through instantly.

---

## 5. Component Guidelines

### 5.1 Session List Items

- Container: 7px 10px padding, 6px radius, 2px transparent left border. Hover: `--hover` bg (150ms). Selected: `--accent-faint` bg + `--accent` left border (200ms).
- Name: 12px, `--text-2` (brightens to `--text` when selected)
- Status: 10px mono, colored per status mapping
- Time: 10px mono, `--text-4`
- Group headers (flow names): 10px uppercase, `--text-4`, 0.08em letter-spacing

### 5.2 Tool Call Rows

Stacked with 1px gap, wrapped in a 6px border-radius container. Each row:
- Background: `--recessed`
- Hover: `--active`
- Font: 12px mono, `--text-3`
- Expand arrow: 10x10px SVG, rotates 90deg on open (150ms ease)
- Timing badge: 10px mono, `--text-4`, right-aligned
- Expanded detail: `--active` background, 11px mono, `--text-3`, 1.6 line-height, indented 28px left

Tool call status icons:
- Success: green checkmark SVG (10x10px)
- Running: no icon or spinner
- Error: red X icon

### 5.3 User Messages

- Container: 46px left margin, 2px accent left border, 12px 16px padding, `--accent-faint` bg, `0 8px 8px 0` radius.
- Label: 10px uppercase, accent color, 0.06em letter-spacing
- Body: 14px, `--text`, 1.7 line-height
- User messages are NOT chat bubbles. They are left-border-accented blocks in the timeline.

### 5.4 Agent Messages

- No background, no border. Agent messages are the default content flow.
- Label: 11px uppercase, `--text-3`, 0.05em letter-spacing, 6px bottom margin
- Body: 14px, `--text`, 1.7 line-height, 12px paragraph spacing
- Inline code: 12px mono, `--recessed` background, `--text-2` color, 3px border-radius, 1px 5px padding
- Left indent: 46px (aligns with user message content after the accent border)

### 5.5 System Events

- Layout: flex row, baseline-aligned, 10px gap.
- Timestamp: 11px mono, `--text-4`, 36px wide, right-aligned
- Event text: 11px mono, `--text-3`. Stage names within events: weight 500, `--text-2`.
- System events are the quietest element in the timeline. They provide context without demanding attention.

### 5.6 Review Findings

Each finding is a flex row with:
- **Badge:** 10px mono, weight 500, 3px border-radius, 2px 7px padding
  - `Good`: green text on green/8% background
  - `Note`: amber text on amber/8% background
  - `Issue`: red text on red/8% background
- **Text:** 14px, `--text`, 1.7 line-height. Bold labels use weight 500, not 700.

### 5.7 Summary Blocks

- Container: 8px radius, `--recessed` bg, 1px `--border`, 14px 16px padding, 12px mono, 1.7 line-height.
- Used for: PR summaries, session completion reports, cost breakdowns.
- Key-value pairs: `--text-3` keys, `--text-2` values. Indented sub-items at 14px left padding.
- Dividers: 1px `--border` with 8px vertical margin.

### 5.8 Buttons

| Variant | Background | Text | Border | Usage |
|---------|-----------|------|--------|-------|
| Primary | `--accent` | white | none | Send message, confirm actions |
| Ghost | transparent | `--text-2` | none | Sidebar nav, toolbar actions |
| Outline | transparent | `--text-2` | 1px `--border` | Search trigger, secondary actions |

- Size: 32px height for icon buttons, 28-32px height for text buttons
- Border-radius: 6-8px
- Hover: opacity 0.85 (primary), background `--hover` (ghost/outline)
- Transitions: 150ms on all interactive properties

### 5.9 Tabs (Workspace Panel)

- Tab: 11px, weight 500, `--text-3`, 40px height. Active: `--text` with 2px accent underline (inset 12px from edges, 1px radius).
- Use a sliding indicator that animates between tabs (250ms cubic-bezier(0.4, 0, 0.2, 1)).

### 5.10 Diff Viewer

- Header: 11px mono, `--text-3`, `--recessed` background, 6px top border-radius
- Body: 11px mono, 1.7 line-height, `--page` background, 1px `--border`, 6px bottom border-radius
- Line colors:
  - Added: `--green` text, green/4% background
  - Removed: `--red` text, red/4% background
  - Context: `--text-3`
  - Hunk header: `--text-4`

### 5.11 Command Palette

- Overlay: black/55% with 6px backdrop blur
- Box: 520px wide, `--panel` background, 12px border-radius, 48px shadow
- Search input: 14px sans, `--text`, no border (just the container border)
- Results: 13px, `--text-2`, 6px border-radius hover, grouped with 10px uppercase labels
- Animation: scale 0.98 to 1.0 on open (150ms cubic-bezier)

### 5.12 Empty States

- Center-aligned in the available space
- Icon (if any): 24-32px, `--text-4`
- Heading: 14px, `--text-2`
- Subtext: 12px, `--text-3`
- Action button (if any): ghost variant
- No illustrations, no mascots, no emoji. Keep it plain and functional.

---

## 6. Interaction Guidelines

### 6.1 Hover Behavior

- **Interactive items** (session rows, file entries, tool rows, nav items): background shifts to `--hover`. 150ms transition.
- **Buttons:** Primary buttons reduce opacity to 0.85. Ghost buttons get `--hover` background.
- **Non-interactive text:** No hover change. Ever. Do not add hover effects to body text, labels, or system events.

### 6.2 Click/Press Feedback

- **Selection** (sessions, files, tabs): immediate visual change (background, border, text color). No delay.
- **Actions** (send, create, delete): button shows `--active` background momentarily. No bounce, no scale.
- **Expansion** (tool details): smooth height animation (200ms ease). Arrow icon rotates 90deg (150ms ease).

### 6.3 Transitions

| Property | Duration | Easing | Usage |
|----------|----------|--------|-------|
| background-color | 120-150ms | ease | Hover states, selection |
| border-color | 200ms | ease | Focus rings, selected borders |
| color | 150ms | ease | Tab text, link hover |
| transform (rotate) | 150ms | ease | Expand/collapse arrows |
| transform (scale) | 150ms | cubic-bezier(0.4, 0, 0.2, 1) | Command palette open |
| opacity | 150ms | ease | Overlay open/close, button hover |
| max-height | 200ms | ease | Collapsible sections |
| left, width | 250ms | cubic-bezier(0.4, 0, 0.2, 1) | Tab indicator slide |

### 6.4 Animation Principles

- **Animate to communicate state**, not to decorate. The only repeating animation is the status pulse (2s ease-in-out, opacity 1 to 0.4) on running sessions.
- **No entrance animations** on page load. Content appears immediately.
- **No exit animations** when removing items. They disappear.
- **Scrollbar:** 4px wide, `--text-4` thumb, transparent track, 2px border-radius. Near-invisible.

### 6.5 Keyboard Shortcuts

- **Cmd+K:** Command palette (search sessions, agents, flows, run commands)
- **Single-key shortcuts** for sidebar navigation: A (Agents), F (Flows), C (Compute), $ (Costs), , (Settings)
- **Esc:** Close any overlay (command palette, modals)
- Shortcuts are shown as `kbd` badges next to their triggers. Never as inline text ("Press X to...").

### 6.6 Text Selection

Background: accent color at 25% opacity (`rgba(139, 92, 246, 0.25)`). Works on both themes.

---

## 7. Content Guidelines

### 7.1 Agent Messages

- Rendered as rich markdown with syntax-highlighted code blocks.
- Paragraphs: 14px, 1.7 line-height, 12px bottom margin.
- Ordered/unordered lists: same size as paragraphs, 20px left padding, 4px item spacing.
- Inline code: 12px mono in a `--recessed` pill (3px radius, 1px 5px padding).
- Agent label (e.g., "PLANNER", "IMPLEMENTER") appears above each message block. 11px uppercase mono.

### 7.2 User Messages

- Same text treatment as agent messages (14px, 1.7 line-height).
- Visually distinguished by: accent left border (2px), accent-faint background, "YOU" label in accent color.
- Never right-aligned. This is a timeline, not a chat app.

### 7.3 System Events

- Format: `[HH:MM]  Stage plan dispatched`
- Timestamp is right-aligned in a fixed 36px column. Event text flows after.
- Stage names are slightly brighter (`--text-2`) within the muted event text.
- Stage transitions: "Stage plan completed -- advancing to implement"
- Session lifecycle: "Session started -- flow: autonomous-sdlc -- compute: local"

### 7.4 Tool Call Summaries

One-line summary per tool call:
- **Read:** "Read auth.ts, session.ts, config.yaml" (list file names, no paths unless ambiguous)
- **Write/Create:** "Created packages/core/auth/provider.ts (89 lines)"
- **Edit:** "Edited packages/server/routes.ts (+28 -3)"
- **Search:** "Searched 'authenticate' across packages/"
- **Command:** "bun test packages/core/__tests__/auth.test.ts" with result badge ("12 passed")

Tool calls should be collapsed by default. Expanding shows detail (file contents read, diff of changes, command output).

### 7.5 Review Findings

Structured list with badge + text. Each finding is one sentence. Bold the category label:
- "**PKCE flow** implemented correctly with S256 challenge method"
- "**Missing test:** No test for max pool exhaustion scenario"

Overall verdict appears as a paragraph after findings: "Overall: **approve** with minor suggestions."

### 7.6 Stage Transitions in the Timeline

Stage transitions are system events, not agent messages. They appear as muted monospaced lines
between agent message blocks. They mark time, not content.

---

## 8. Anti-Patterns

### 8.1 DO NOT: Garden-Variety shadcn

If your component looks like it came from `npx shadcn-ui add card` with zero modification, redo it.
Ark components have: monospaced metadata, timing data, pipeline awareness, status color coding.
A generic Card with a title and description is not an Ark component.

### 8.2 DO NOT: Color as Decoration

Never use accent color for section headings, card borders, background gradients, or decorative
elements. Color is reserved for: status, selected state, accent borders on user messages, and
the send button. If you are adding color and it is not communicating state, remove it.

### 8.3 DO NOT: Chat Bubble Layout

User messages are NOT right-aligned chat bubbles. They are left-border-accented blocks in a
vertical timeline. The conversation is a log of events, not a messaging app. This was an explicit
design decision to support the hybrid chat + orchestration timeline.

### 8.4 DO NOT: Tiny Text

Agent prose must be 14px minimum. The v1 design used 12px for chat text -- this was identified as
a readability failure. System events and metadata can be 10-11px. Body content cannot.

### 8.5 DO NOT: Dashboard-First

The home screen is the session list + conversation, not a metrics dashboard. Dashboard views
(costs, compute utilization) are secondary pages accessed via sidebar navigation. Never redirect
the user to a dashboard on app open.

### 8.6 DO NOT: Animate for Fun

No bouncing buttons, no sliding-in cards, no fade-in-on-scroll effects. The only repeating
animation is the running-status pulse. Entry/exit animations are reserved for overlays (command
palette, modals) and expand/collapse interactions.

### 8.7 DO NOT: Multiple Hover Effects

One hover effect per element. A session item gets a background change on hover. It does not
also get a border change, a shadow, and a text color shift. Pick one visual change. One.

### 8.8 DO NOT: Purple Everything

The accent color (`#8b5cf6`) is used in exactly these places: selected item border, active tab
underline, send button, user message border, text selection, links. If you are adding accent
color to a new element, you are probably wrong. Check this list first.

### 8.9 DO NOT: Forget Dark Mode Contrast

Common mistake: using `--text-4` (#3f3f46) for text that needs to be readable. `--text-4` is for
timestamps, separators, and disabled items only. If a user needs to read it without squinting,
use `--text-3` minimum. If it is body content, use `--text` or `--text-2`.

### 8.10 DO NOT: Use Em Dashes

Use hyphens (-) or double dashes (--) everywhere. Never use the em dash character (U+2014).
This is a project-wide convention, not just a UI rule.

---

## Appendix: CSS Variable Quick Reference

```css
:root {
  /* Surfaces */
  --page: #0a0a0b;
  --panel: #111113;
  --recessed: #18181b;
  --hover: #1c1c1f;
  --active: #222226;

  /* Text */
  --text: #fafafa;
  --text-2: #a1a1aa;
  --text-3: #52525b;
  --text-4: #3f3f46;

  /* Accent */
  --accent: #8b5cf6;
  --accent-faint: rgba(139, 92, 246, 0.07);

  /* Border */
  --border: #1e1e22;

  /* Status */
  --green: #4ade80;
  --red: #f87171;
  --amber: #fbbf24;

  /* Fonts */
  --sans: 'Geist Sans', system-ui, -apple-system, sans-serif;
  --mono: 'Geist Mono', 'SF Mono', 'Cascadia Code', monospace;
}
```
