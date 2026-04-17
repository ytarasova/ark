# Ark Design System Research

Comprehensive design system guidelines for the Ark web dashboard, informed by
analysis of Linear, Vercel Geist, Radix Themes, shadcn/ui, GitHub Primer,
Tailwind UI, and Apple HIG. Targeted at a desktop-first AI agent orchestration
platform built with React + Vite + Tailwind CSS v4 + Radix UI primitives +
Lucide icons + class-variance-authority (cva).

---

## 1. Core Design Principles

### 1.1 Functional Elegance

Beauty follows from function, not decoration. Every visual element must earn its
place. Linear exemplifies this -- no gradients, no drop shadows on cards, no
ornamental borders. Surfaces are distinguished through subtle background shifts
and whitespace alone.

**Ark implication:** Remove decorative borders where background-color differences
already communicate hierarchy. Reserve borders for interactive boundaries
(inputs, cards that contain actions).

### 1.2 Information Density as a Feature

Developer tools must surface maximum information without feeling crowded. Linear
and GitHub achieve this through tight vertical rhythm (28-32px row heights),
small but legible type (12-13px body), and strategic use of monospace for
scannable data (IDs, timestamps, costs).

**Ark implication:** The current 13px body text and monospace badges are on
track. Formalize two density modes (see Section 7).

### 1.3 Semantic Color, Not Decorative Color

Color conveys meaning: status, severity, interactivity. Vercel Geist uses a
near-monochrome palette with a single accent (blue-600). Linear uses a muted
palette with colored status indicators. Neither uses color for decoration.

**Ark implication:** The purple primary (#7c6aef) is fine as accent. Restrict
color usage to: status indicators, interactive elements (links, buttons),
severity (error/warning/success), and selection states. Everything else is
grayscale.

### 1.4 Dark-First, Light-Compatible

Agent orchestration tools are monitoring dashboards -- users watch them for
extended periods. Dark mode is the default. Light mode must be fully supported
but is the secondary experience.

**Ark implication:** Current dark theme variables are well-structured. Ensure all
new components are authored dark-first with light overrides.

### 1.5 Motion Communicates State, Not Style

Animation is functional: it shows what changed, confirms actions, and smooths
layout shifts. Linear uses 150-200ms transitions for most interactions. Apple HIG
recommends spring-based easing for natural feel.

**Ark implication:** See Motion guidelines (Section 8). Remove `glow-pulse` on
running status dots -- replace with a static glow that's already visually
distinct.

### 1.6 Consistent Component API

Every component follows the same contract: `variant`, `size`, optional
`className` for escape hatches. shadcn/ui and Radix Themes both enforce this.
cva (class-variance-authority) is the tool for this.

**Ark implication:** Current Button and Badge already follow this pattern.
Extend to all new components.

### 1.7 Composition Over Configuration

Small, focused components composed together beat large components with many
props. shadcn/ui's `Card` = `Card + CardHeader + CardTitle + CardDescription +
CardContent + CardFooter`. This is preferable to a single `<Card title="..."
description="..." footer={...} />`.

**Ark implication:** Already followed in Card. Apply the same pattern to new
components (Table, Dialog, Command Palette).

### 1.8 Accessibility is Non-Negotiable

Keyboard navigation, screen reader support, focus management. Radix primitives
handle this at the primitive level. GitHub Primer enforces WCAG 2.1 AA contrast
ratios (4.5:1 for text, 3:1 for UI elements).

**Ark implication:** Use Radix primitives for all interactive patterns (Dialog,
DropdownMenu, Tooltip, Tabs, etc.). Never build custom modals with raw divs --
the current Modal component should migrate to Radix Dialog.

### 1.9 Type as Interface

Typography does the heavy lifting in developer tools. Vercel Geist uses
Inter/Geist Sans with a strict type scale. GitHub Primer uses 5 heading sizes
and 3 body sizes. The type scale defines the visual hierarchy.

**Ark implication:** Formalize the type scale (see Section 5). Current usage of
arbitrary sizes like `text-[13px]`, `text-[15px]`, `text-[12px]` should migrate
to semantic scale tokens.

### 1.10 Progressive Disclosure

Show summary first, details on demand. Linear's issue list shows title + status;
click to expand metadata. GitHub's PR list shows title + checks; click for diff.
Never front-load every data field.

**Ark implication:** Session list shows summary + status + ID. Detail panel
reveals full metadata, events, cost, terminal. This pattern is correct -- extend
it to agents, flows, compute.

### 1.11 Spatial Consistency

Use a single spacing scale everywhere. Radix Themes uses a 9-step scale:
`--space-1` (4px) through `--space-9` (160px). Tailwind's default scale (4px
base) maps well to this. Mix-and-match spacing destroys visual coherence.

**Ark implication:** Standardize on the 4px grid. See Layout specification
(Section 6).

### 1.12 Forgiveness in Destructive Actions

Destructive actions (stop session, delete compute) need confirmation or undo.
Linear uses inline undo toasts. GitHub uses confirmation dialogs for irreversible
actions.

**Ark implication:** Add confirmation dialogs for stop/delete. Add undo
capability to toasts for reversible actions.

---

## 2. Component Architecture

### 2.1 Three-Layer Model

Adopt the three-layer component architecture used by the best design systems:

```
Layer 1: Primitives (Radix UI)
  - Dialog, DropdownMenu, Tooltip, Tabs, Popover, Select, Switch, Checkbox,
    RadioGroup, ScrollArea, Separator, Slider, Toast (Sonner), Collapsible,
    Accordion, ContextMenu, AlertDialog, HoverCard, NavigationMenu
  - Zero styling, full accessibility, keyboard navigation
  - Never re-implement what Radix provides

Layer 2: Styled Components (shadcn/ui pattern, owned by Ark)
  - Button, Badge, Card, Input, Modal -> Dialog, Table, DataTable,
    Command, Textarea, Label, Select, Tabs
  - Styled with Tailwind + cva, composable sub-components
  - Source-owned (copied into project, not imported from node_modules)

Layer 3: Composed Patterns (Ark-specific)
  - SessionCard, StatusDot, FlowDiagram, CostWidget, EventTimeline,
    AgentPromptEditor, TerminalPanel, ChatPanel
  - Built from Layer 2 components, contain business logic
  - Live in components/ (not components/ui/)
```

### 2.2 Component File Structure

```
components/
  ui/                    # Layer 2: styled primitives
    button.tsx           # cva variants, Radix Slot support
    badge.tsx            # cva variants
    card.tsx             # composable sub-components
    input.tsx            # form input with label integration
    textarea.tsx         # multiline input
    label.tsx            # form label
    separator.tsx        # horizontal/vertical rule
    dialog.tsx           # Radix Dialog + styled overlay/content
    alert-dialog.tsx     # confirmation dialogs
    dropdown-menu.tsx    # Radix DropdownMenu + styled items
    context-menu.tsx     # right-click menus
    select.tsx           # Radix Select + styled trigger/content
    tabs.tsx             # Radix Tabs + styled list/trigger/content
    tooltip.tsx          # Radix Tooltip + styled content
    popover.tsx          # Radix Popover + styled content
    command.tsx          # cmdk-based command palette
    table.tsx            # composable table primitives
    data-table.tsx       # TanStack Table integration
    scroll-area.tsx      # Radix ScrollArea
    skeleton.tsx         # loading placeholder
    toast.tsx            # Sonner-based toast system
    toggle.tsx           # toggle button
    toggle-group.tsx     # grouped toggles
    collapsible.tsx      # expandable sections
    accordion.tsx        # stacked collapsibles
    switch.tsx           # boolean toggle
    checkbox.tsx         # Radix Checkbox
    radio-group.tsx      # Radix RadioGroup
    slider.tsx           # range input
    progress.tsx         # progress bar
    avatar.tsx           # user/agent avatar
    hover-card.tsx       # preview on hover
    sheet.tsx            # slide-out panel
    resizable.tsx        # resizable panels (react-resizable-panels)
  patterns/              # Layer 3: composed business components
    session-card.tsx
    session-list.tsx
    session-detail.tsx
    status-indicator.tsx # StatusDot + StatusBadge unified
    event-timeline.tsx
    cost-widget.tsx
    flow-diagram.tsx
    agent-card.tsx
    compute-card.tsx
    terminal-panel.tsx
    chat-panel.tsx
    command-palette.tsx  # global Cmd+K
    empty-state.tsx      # reusable empty states
    error-boundary.tsx   # error fallback UI
    loading-state.tsx    # full-page / section loading
```

### 2.3 cva Variant Convention

Every styled component uses cva with this contract:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const componentVariants = cva(
  "base-classes-shared-across-all-variants",
  {
    variants: {
      variant: {
        default: "...",
        secondary: "...",
        // etc.
      },
      size: {
        default: "...",
        sm: "...",
        lg: "...",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

interface ComponentProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof componentVariants> {}

function Component({ className, variant, size, ...props }: ComponentProps) {
  return (
    <div
      className={cn(componentVariants({ variant, size, className }))}
      {...props}
    />
  );
}
```

### 2.4 Prop Patterns

Follow these conventions across all components:

| Pattern | Convention | Example |
|---------|-----------|---------|
| Polymorphism | `asChild` + Radix Slot | `<Button asChild><Link /></Button>` |
| Size | `"default" \| "sm" \| "lg" \| "icon"` | `<Button size="sm" />` |
| Visual variant | `"default" \| "secondary" \| "outline" \| "ghost" \| "destructive"` | `<Button variant="ghost" />` |
| Controlled state | `open` / `onOpenChange` | `<Dialog open={open} onOpenChange={setOpen} />` |
| Class override | `className` (always last in cn()) | `<Card className="col-span-2" />` |
| Ref forwarding | Use `React.forwardRef` or React 19 ref prop | Components that wrap native elements |

---

## 3. Color System

### 3.1 Semantic Token Architecture

Colors are defined as CSS custom properties with semantic names. Never use raw
Tailwind colors (like `bg-blue-500`) in component code -- always go through
tokens.

```
Tier 1: Functional Tokens (what the color DOES)
  --background, --foreground
  --card, --card-foreground
  --popover, --popover-foreground
  --primary, --primary-foreground
  --secondary, --secondary-foreground
  --muted, --muted-foreground
  --accent, --accent-foreground
  --destructive, --destructive-foreground
  --border, --input, --ring

Tier 2: Component-Scoped Tokens
  --sidebar, --sidebar-foreground, --sidebar-primary, etc.

Tier 3: Status Tokens (NEW -- add these)
  --status-running, --status-running-bg
  --status-waiting, --status-waiting-bg
  --status-completed, --status-completed-bg
  --status-failed, --status-failed-bg
  --status-stopped, --status-stopped-bg
  --status-pending, --status-pending-bg
```

### 3.2 Recommended Color Palette

The current Ark palette is well-chosen. Recommended refinements:

```css
:root {
  /* Backgrounds - use oklch for perceptual uniformity */
  --background: oklch(1 0 0);              /* pure white */
  --foreground: oklch(0.145 0.015 286);    /* near-black with slight blue */
  --card: oklch(0.985 0 0);               /* barely off-white */
  --muted: oklch(0.96 0.005 286);         /* light gray */
  --muted-foreground: oklch(0.55 0.01 286); /* medium gray */

  /* Primary - keep the purple */
  --primary: oklch(0.55 0.18 280);        /* refined purple */

  /* Borders */
  --border: oklch(0.92 0.005 286);        /* subtle */
  --border-strong: oklch(0.85 0.008 286); /* for emphasis */

  /* Status - semantic, consistent across themes */
  --status-running: oklch(0.72 0.17 165);     /* emerald */
  --status-running-bg: oklch(0.72 0.17 165 / 0.1);
  --status-waiting: oklch(0.75 0.15 85);      /* amber */
  --status-waiting-bg: oklch(0.75 0.15 85 / 0.1);
  --status-completed: oklch(0.65 0.15 250);   /* blue */
  --status-completed-bg: oklch(0.65 0.15 250 / 0.1);
  --status-failed: oklch(0.63 0.2 25);        /* red */
  --status-failed-bg: oklch(0.63 0.2 25 / 0.1);
  --status-stopped: oklch(0.55 0.01 286);     /* gray */
  --status-stopped-bg: oklch(0.55 0.01 286 / 0.08);
}

.dark {
  --background: oklch(0.13 0.005 286);
  --foreground: oklch(0.93 0.005 286);
  --card: oklch(0.16 0.005 286);
  --muted: oklch(0.22 0.008 286);
  --muted-foreground: oklch(0.6 0.01 286);
  --border: oklch(0.25 0.008 286);
  --border-strong: oklch(0.32 0.01 286);
  /* Status tokens remain the same in dark mode */
}
```

### 3.3 Color Usage Rules

1. **Maximum 2 hues per view** (primary purple + one status color at a time).
2. **Gray is the dominant color.** 80%+ of any screen should be grayscale.
3. **Status colors are reserved.** Never use emerald for non-running states,
   never use red for non-error states.
4. **Opacity for backgrounds.** Status backgrounds use 10-15% opacity of the
   status color, not a separate color.
5. **oklch for new tokens.** Migrate from hex to oklch for perceptual uniformity
   (Tailwind v4 default).

---

## 4. Typography

### 4.1 Font Stack

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
```

Inter is correct for a developer tool -- it was designed for screens, has
excellent legibility at small sizes, and includes tabular figures. JetBrains Mono
for code and data is on-brand.

### 4.2 Type Scale

Replace arbitrary pixel sizes with a semantic scale. Based on analysis of Linear
(which uses a similar tight scale) and Radix Themes (9-step scale):

| Token | Size | Line Height | Weight | Usage |
|-------|------|-------------|--------|-------|
| `text-display` | 24px / 1.5rem | 32px | 600 | Page titles (rarely used) |
| `text-title` | 18px / 1.125rem | 28px | 600 | Section titles |
| `text-heading` | 15px / 0.9375rem | 22px | 600 | Card titles, dialog titles |
| `text-body` | 13px / 0.8125rem | 20px | 400 | Default body text |
| `text-body-medium` | 13px / 0.8125rem | 20px | 500 | Emphasized body text |
| `text-label` | 12px / 0.75rem | 16px | 500 | Form labels, metadata |
| `text-caption` | 11px / 0.6875rem | 16px | 500 | Timestamps, secondary info |
| `text-micro` | 10px / 0.625rem | 14px | 500 | Badges, status text, tertiary info |

**Letter spacing by size:**

| Size | Letter Spacing |
|------|---------------|
| >= 15px | -0.01em (tight) |
| 12-14px | 0 (normal) |
| <= 11px uppercase | 0.04-0.08em (tracked) |

### 4.3 Type Usage Patterns

```
Page header:     text-heading font-semibold text-foreground
Card title:      text-heading font-semibold text-foreground  (or text-label if compact)
Card subtitle:   text-body text-muted-foreground
Body text:       text-body text-foreground
Metadata:        text-label font-mono text-muted-foreground
Badge:           text-micro font-mono font-medium uppercase tracking-wider
Button:          text-body font-medium
Input:           text-body text-foreground
Input label:     text-label font-medium text-muted-foreground uppercase tracking-wide
Tooltip:         text-label text-foreground
```

### 4.4 Migration from Arbitrary Sizes

Current codebase uses `text-[13px]`, `text-[15px]`, `text-[12px]`, `text-[10px]`,
`text-[11px]`, `text-[14px]`. Map these to semantic tokens via `@theme inline`:

```css
@theme inline {
  --text-body: 0.8125rem;       /* 13px */
  --text-heading: 0.9375rem;    /* 15px */
  --text-label: 0.75rem;        /* 12px */
  --text-caption: 0.6875rem;    /* 11px */
  --text-micro: 0.625rem;       /* 10px */
}
```

---

## 5. Iconography

### 5.1 Icon System

Lucide is the correct choice -- it's the community fork of Feather with better
maintenance, consistent 24x24 grid, 1.5px stroke width.

### 5.2 Icon Sizing

| Context | Size | Tailwind Class |
|---------|------|---------------|
| Sidebar nav | 15px | `size-[15px]` |
| Button icon (default) | 16px | `size-4` |
| Button icon (sm) | 14px | `size-3.5` |
| Card title icon | 14px | `size-3.5` |
| Inline with text | Match text line-height | `size-4` |
| Page header action | 18px | `size-[18px]` |
| Empty state | 40-48px | `size-10` or `size-12` |

### 5.3 Icon Opacity

Icons that accompany text should be slightly muted (current `opacity-50` on
sidebar icons is correct). Icons that ARE the primary interaction (icon buttons)
should be full opacity with hover state.

---

## 6. Layout System

### 6.1 Spacing Scale

Use Tailwind's default 4px-based scale exclusively. The 9 most-used values:

| Token | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| space-1 | 4px | `p-1`, `gap-1` | Tight inline spacing |
| space-2 | 8px | `p-2`, `gap-2` | Default inline gap |
| space-3 | 12px | `p-3`, `gap-3` | Component internal padding |
| space-4 | 16px | `p-4`, `gap-4` | Card padding, section gap |
| space-5 | 20px | `p-5`, `gap-5` | Page padding |
| space-6 | 24px | `p-6`, `gap-6` | Large section padding |
| space-8 | 32px | `p-8`, `gap-8` | Section separation |
| space-10 | 40px | `p-10` | Page margins (desktop) |
| space-12 | 48px | `p-12` | Large empty states |

### 6.2 Page Layout Grid

The app uses a sidebar + main content pattern. Formalize the grid:

```
+--[sidebar]--+--[main content]------------------------+
|  200px      |  fluid                                  |
|  (48px      |                                         |
|   collapsed)|  +--[header: 48px]-------------------+  |
|             |  |  Title       Actions              |  |
|  [nav]      |  +----------------------------------+  |
|             |  |                                    | |
|             |  |  [content area: fluid]             | |
|             |  |                                    | |
|             |  +------------------------------------+ |
+-------------+-----------------------------------------+
```

**Sidebar widths:**
- Expanded: 200px (current, correct)
- Collapsed: 48px (current, correct)
- Mobile: always collapsed

**Header height:** 48px (`h-12`), sticky, with backdrop blur. Current
implementation is correct.

**Content padding:** 20px vertical, 24px horizontal (`p-5 px-6`). Current
implementation is correct.

### 6.3 Master-Detail Pattern

For list views (Sessions, Agents, Flows, Compute):

```
+--[list panel]--+--[detail panel]--------------------+
|  320-400px     |  fluid                              |
|  resizable     |                                     |
|                |  [detail header: metadata]           |
|  [search/      |  [tabs: overview | events | ...]    |
|   filter bar]  |  [tab content]                      |
|                |                                     |
|  [list items]  |                                     |
|                |                                     |
+----------------+-------------------------------------+
```

Use `react-resizable-panels` for the split. The divider should be a 1px border
that becomes a 4px drag handle on hover.

**List panel widths:**
- Default: 360px
- Min: 280px
- Max: 500px
- Stored in localStorage per-view

### 6.4 Dashboard Grid

The dashboard uses a responsive card grid:

```
Desktop (>= 1280px):  3 columns, 16px gap
Tablet  (>= 768px):   2 columns, 16px gap
Mobile  (< 768px):    1 column, 12px gap
```

Cards can span columns: `col-span-2` for wide widgets (Fleet Status), default
`col-span-1` for standard widgets.

### 6.5 Responsive Breakpoints

Desktop-first breakpoints (using Tailwind's defaults):

| Breakpoint | Width | Target |
|-----------|-------|--------|
| Default | >= 1280px | Desktop monitor |
| `lg:` | >= 1024px | Laptop |
| `md:` | >= 768px | Tablet / narrow window |
| `sm:` | >= 640px | Mobile landscape |
| (base) | < 640px | Mobile portrait |

Since Ark is desktop-first, most layouts are designed for the default breakpoint.
`md:` triggers sidebar collapse and single-column layouts.

### 6.6 Container Widths

No max-width on the main content area -- it should fill available space. For
centered content (settings forms, login), use:

```
max-w-lg   (512px)  - single-column forms
max-w-2xl  (672px)  - wide forms, config editors
max-w-4xl  (896px)  - documentation, wide content
```

---

## 7. Density Modes

### 7.1 Approach

Radix Themes handles density through a single `scaling` prop on the Theme
component (90%, 95%, 100%, 105%, 110%). This scales all spacing, font sizes, and
line heights uniformly.

For Ark, implement two discrete density modes rather than continuous scaling:

| Mode | Target User | Characteristics |
|------|------------|-----------------|
| **Compact** | Power users, monitoring | Tighter spacing, smaller text, more rows visible |
| **Comfortable** | Default, onboarding | Standard spacing, easier scanning |

### 7.2 Density Token Differences

| Element | Compact | Comfortable |
|---------|---------|-------------|
| List row height | 32px | 40px |
| Table row height | 28px | 36px |
| Card padding | 12px | 16px |
| Card gap | 12px | 16px |
| Header height | 40px | 48px |
| Sidebar item height | 28px | 32px |
| Button height (default) | 32px | 36px |
| Button height (sm) | 26px | 32px |
| Body text | 12px | 13px |
| Label text | 11px | 12px |
| Badge text | 9px | 10px |

### 7.3 Implementation

Use a CSS class on the root element and CSS custom properties:

```css
:root, .density-comfortable {
  --density-row-h: 40px;
  --density-table-row-h: 36px;
  --density-card-p: 16px;
  --density-header-h: 48px;
  --density-sidebar-item-h: 32px;
  --density-body-size: 0.8125rem;
  --density-label-size: 0.75rem;
}

.density-compact {
  --density-row-h: 32px;
  --density-table-row-h: 28px;
  --density-card-p: 12px;
  --density-header-h: 40px;
  --density-sidebar-item-h: 28px;
  --density-body-size: 0.75rem;
  --density-label-size: 0.6875rem;
}
```

Store preference in localStorage (`ark-density`). Toggle via Settings page or
keyboard shortcut.

---

## 8. Motion and Animation

### 8.1 Timing

| Category | Duration | Easing | Usage |
|----------|----------|--------|-------|
| Micro | 100-150ms | `ease-out` | Hover states, focus rings, opacity |
| Standard | 200ms | `cubic-bezier(0.32, 0.72, 0, 1)` | Dropdowns, tooltips, popovers |
| Expand | 250-300ms | `cubic-bezier(0.32, 0.72, 0, 1)` | Collapsible sections, accordion |
| Page | 300ms | `cubic-bezier(0.32, 0.72, 0, 1)` | Panel slides, route transitions |
| Spring | 500ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Toast entrance, dialog entrance |

The easing `cubic-bezier(0.32, 0.72, 0, 1)` is Linear's signature curve --
fast start, gentle deceleration. It feels responsive without being jarring.

### 8.2 Entrance Animations

```css
/* Fade in (default for overlays) */
@keyframes fade-in {
  from { opacity: 0; }
}

/* Slide up (toasts, bottom sheets) */
@keyframes slide-up {
  from { transform: translateY(8px); opacity: 0; }
}

/* Scale in (dialogs, popovers) */
@keyframes scale-in {
  from { transform: scale(0.95); opacity: 0; }
}

/* Slide from right (detail panels, sheets) */
@keyframes slide-from-right {
  from { transform: translateX(16px); opacity: 0; }
}

/* Collapse/expand (accordion, collapsible) */
/* Use Radix's built-in data-state animations */
```

### 8.3 Loading States

**Skeleton screens** over spinners. Skeleton shapes should match the content
they replace:

```tsx
function SessionListSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="px-3 py-2.5 flex items-center gap-2">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-3.5 w-[60%]" />
          <Skeleton className="h-3 w-16 ml-auto" />
        </div>
      ))}
    </div>
  );
}
```

**Skeleton component:**
```tsx
function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted",
        className
      )}
    />
  );
}
```

### 8.4 Transition Patterns by Component

| Component | Enter | Exit | Trigger |
|-----------|-------|------|---------|
| Dialog/Modal | scale-in 200ms | fade-out 150ms | open/close |
| Dropdown menu | scale-in 150ms | fade-out 100ms | trigger click |
| Tooltip | fade-in 100ms (200ms delay) | fade-out 100ms | hover |
| Toast | slide-up 300ms spring | slide-down 200ms | action/event |
| Sheet/Panel | slide-from-right 250ms | slide-to-right 200ms | open/close |
| Collapsible | height animate 250ms | height animate 200ms | toggle |
| Tab content | fade-in 150ms | instant | tab switch |
| List item add | slide-up 200ms | fade-out 150ms | data update |
| Page transition | fade-in 150ms | instant | navigation |

### 8.5 Real-Time Update Animation

For SSE/polling updates (new sessions, status changes, events):

1. **New item in list:** Slide-up + fade-in, 200ms. Brief highlight
   (`bg-primary/5`) that fades over 2s.
2. **Status change:** Badge cross-fade, 200ms. StatusDot color transition,
   300ms.
3. **Counter update:** Number morphing with `tabular-nums` font feature. Use
   CSS `transition: color 300ms` for cost updates.
4. **New event in timeline:** Append with slide-up. Flash left border with
   primary color, fade over 1.5s.

### 8.6 Reduced Motion

Always respect `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 9. Data Table Patterns

### 9.1 Table Architecture

Use TanStack Table (React Table v8) for all tabular data. It provides:
- Column definitions with sorting, filtering, visibility
- Row selection, expansion
- Pagination
- Virtual scrolling (via TanStack Virtual) for large datasets

### 9.2 Table Component Design

```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead sortable sorted="asc">Session</TableHead>
      <TableHead>Status</TableHead>
      <TableHead sortable>Cost</TableHead>
      <TableHead className="text-right">Actions</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>...</TableCell>
      <TableCell>...</TableCell>
      <TableCell>...</TableCell>
      <TableCell>...</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

### 9.3 Table Styling

| Element | Style |
|---------|-------|
| Header row | `bg-muted/50 text-muted-foreground text-label font-medium uppercase tracking-wider` |
| Header cell | `px-3 py-2 text-left` |
| Body row | `border-b border-border hover:bg-accent transition-colors` |
| Body cell | `px-3 py-2 text-body` |
| Selected row | `bg-accent border-l-2 border-l-primary` |
| Sortable header | Chevron icon, `cursor-pointer hover:text-foreground` |
| Sticky header | `sticky top-0 z-10 bg-background/80 backdrop-blur-xl` |

### 9.4 Table Features for Ark

| Feature | Implementation |
|---------|---------------|
| Column resize | TanStack Table `columnResizeMode: "onChange"` |
| Column visibility | Dropdown checkbox list |
| Row selection | Checkbox column, shift-click range select |
| Virtual scroll | TanStack Virtual for >100 rows |
| Empty state | Centered illustration + message + action button |
| Loading | Skeleton rows matching column layout |
| Inline actions | Icon buttons on row hover |
| Expandable rows | Chevron toggle, animated expansion |

---

## 10. Dialog and Modal Patterns

### 10.1 Dialog Types

| Type | Width | Use Case |
|------|-------|----------|
| Alert Dialog | 400px | Confirmations (stop session, delete) |
| Standard Dialog | 500-560px | Forms (new session, edit config) |
| Wide Dialog | 700-800px | Complex forms (flow editor, agent config) |
| Sheet (right) | 400-500px | Detail panels, quick edits |
| Full-screen Dialog | 90vw x 85vh | Code editors, terminal, flow designer |
| Command Palette | 550px | Cmd+K search/action interface |

### 10.2 Dialog Anatomy

```
+--[Dialog]---------------------------------------+
| [Title]                              [X button] |
| [Description]                                   |
+------------------------------------------------+
|                                                 |
| [Content area - scrollable]                     |
|                                                 |
+------------------------------------------------+
| [Secondary action]          [Cancel] [Primary]  |
+-------------------------------------------------+
```

- Title: `text-heading font-semibold`
- Description: `text-body text-muted-foreground`
- Footer: right-aligned actions, primary button last
- Max height: 85vh with scrollable content area
- Overlay: `bg-black/60` with fade-in

### 10.3 Command Palette

Implement a global Cmd+K command palette (following Linear, Vercel, GitHub
patterns). Use `cmdk` (Command Menu for React):

```
+--[Command Palette]-------------------------------+
| [Search icon] [Search input]           [Esc]     |
+-------------------------------------------------+
| Recent                                           |
|   > Session: "Feature X"          [Ctrl+Enter]   |
|   > Session: "Bug fix Y"                         |
|                                                   |
| Actions                                           |
|   > New Session                   [Ctrl+N]       |
|   > Search Knowledge              [Ctrl+Shift+K] |
|   > Toggle Dark Mode              [Ctrl+D]       |
|                                                   |
| Navigation                                        |
|   > Dashboard                                     |
|   > Sessions                                      |
|   > Agents                                        |
+-------------------------------------------------+
```

---

## 11. Toast and Notification Patterns

### 11.1 Toast System

Migrate from custom Toast to Sonner (maintained by the shadcn/ui author). Sonner
provides:
- Stacking (multiple toasts)
- Auto-dismiss with progress
- Action buttons (Undo)
- Promise-based toasts (loading -> success/error)
- Swipe to dismiss

### 11.2 Toast Types

| Type | Icon | Color | Duration | Dismissible |
|------|------|-------|----------|-------------|
| Success | Checkmark | emerald border-left | 3s | Yes |
| Error | X | red border-left | 5s | Yes |
| Warning | Alert triangle | amber border-left | 4s | Yes |
| Info | Info | blue border-left | 3s | Yes |
| Loading | Spinner | neutral | Until resolved | No |
| Action | None | neutral | Until dismissed | Yes (with action button) |

### 11.3 Toast Positioning

Bottom-right, stacked upward. 20px from edges. Max 3 visible toasts.

---

## 12. Component Inventory

### 12.1 What Ark Needs, Mapped to Implementations

| Ark Need | shadcn/ui Component | Radix Primitive | Priority |
|----------|-------------------|-----------------|----------|
| **Buttons** | Button | Slot | Exists (keep) |
| **Badges** | Badge | -- | Exists (keep) |
| **Cards** | Card | -- | Exists (keep) |
| **Input fields** | Input | -- | Exists (keep) |
| **Text areas** | Textarea | -- | Add |
| **Labels** | Label | Label | Add |
| **Separators** | Separator | Separator | Exists (keep) |
| **Dialogs** | Dialog | Dialog | Replace Modal |
| **Alert dialogs** | AlertDialog | AlertDialog | Add |
| **Dropdown menus** | DropdownMenu | DropdownMenu | Add |
| **Context menus** | ContextMenu | ContextMenu | Add |
| **Select dropdowns** | Select | Select | Add |
| **Tabs** | Tabs | Tabs | Add |
| **Tooltips** | Tooltip | Tooltip | Add |
| **Popovers** | Popover | Popover | Add |
| **Command palette** | Command | -- (cmdk) | Add |
| **Data tables** | DataTable | -- (TanStack) | Add |
| **Scroll areas** | ScrollArea | ScrollArea | Add |
| **Skeletons** | Skeleton | -- | Add |
| **Toast system** | Sonner | -- (sonner) | Replace Toast |
| **Switches** | Switch | Switch | Add |
| **Checkboxes** | Checkbox | Checkbox | Add |
| **Radio groups** | RadioGroup | RadioGroup | Add |
| **Sliders** | Slider | Slider | Add |
| **Progress bars** | Progress | Progress | Add |
| **Avatars** | Avatar | -- | Add |
| **Collapsibles** | Collapsible | Collapsible | Add |
| **Accordions** | Accordion | Accordion | Add |
| **Hover cards** | HoverCard | HoverCard | Add |
| **Sheets** | Sheet | Dialog | Add |
| **Toggle groups** | ToggleGroup | ToggleGroup | Add |
| **Resizable panels** | Resizable | -- (react-resizable-panels) | Add |

### 12.2 Ark-Specific Components

| Component | Purpose | Dependencies |
|-----------|---------|-------------|
| StatusIndicator | Status dot + badge for session/compute status | Badge |
| EventTimeline | Chronological event list with icons | ScrollArea |
| CostWidget | Cost display with budget progress | Card, Progress |
| FlowDiagram | Visual DAG of flow stages | Custom SVG/Canvas |
| TerminalPanel | Embedded xterm.js terminal | xterm.js |
| ChatPanel | Agent chat interface | ScrollArea, Input |
| SessionCard | Session summary for list/grid views | Card, StatusIndicator |
| AgentCard | Agent definition viewer | Card, Badge, Collapsible |
| ComputeCard | Compute resource status | Card, StatusIndicator |
| EmptyState | Reusable empty state with icon + CTA | Button |
| LoadingState | Full-area skeleton loading | Skeleton |
| ErrorBoundary | Error fallback with retry | Button |
| MetricCard | KPI display (count + trend) | Card |
| CodeBlock | Syntax-highlighted code display | Shiki or Prism |
| KeyValue | Label-value pairs for metadata | -- |
| FilterBar | Search + filter controls | Input, Select, ToggleGroup |
| CommandPalette | Global Cmd+K interface | Command |

---

## 13. Sidebar and Navigation Patterns

### 13.1 Sidebar Design

The current sidebar is well-structured. Refinements:

| Element | Current | Recommended |
|---------|---------|-------------|
| Logo area height | 44px | 48px (match header) |
| Nav item height | ~32px | 32px (standardize) |
| Nav item padding | `px-2` | `px-2.5` |
| Active indicator | `border-l-2` | `bg-accent rounded-md` (like Linear) |
| Icon opacity | `opacity-50` | `opacity-60` (slightly more visible) |
| Section dividers | None | Group nav items: Primary / Secondary / Settings |
| Keyboard nav | None | Arrow keys + Enter to navigate |

### 13.2 Navigation Groups

```
-- Primary --
Dashboard
Sessions
Agents
Flows

-- Infrastructure --
Compute
Tools
Schedules

-- Observability --
History
Memory
Costs

-- [bottom] --
Settings
```

---

## 14. Patterns for Real-Time Data

### 14.1 Data Freshness Strategy

| Data Type | Update Strategy | Interval | Visual Indicator |
|-----------|----------------|----------|-----------------|
| Session list | SSE + poll fallback | SSE real-time, poll 5s | None (always fresh) |
| Session detail | SSE for active, poll for static | SSE real-time, poll 10s | "Updated Xs ago" |
| Dashboard stats | Poll | 5s | None |
| Events | SSE | Real-time | New event highlight |
| Cost data | Poll | 30s | None (updates slowly) |
| System health | Poll | 10s | Status dot animation |
| Compute status | SSE + poll | SSE real-time, poll 15s | Status transition |

### 14.2 Optimistic Updates

For user-initiated actions (dispatch, stop, pause):
1. Immediately update local state to expected result
2. Show action in progress (button loading state)
3. Revert on error with error toast
4. Confirm on success with success toast (optional for non-destructive actions)

### 14.3 Connection Status

Show connection state in the sidebar footer:
- Connected: green dot (already implemented via daemonStatus)
- Reconnecting: amber dot + "Reconnecting..." text
- Disconnected: red dot + "Offline" text

---

## 15. Form Patterns

### 15.1 Form Layout

Forms use a consistent single-column layout with field groups:

```
[Label]
[Input / Select / Textarea]
[Helper text or error message]

[16px gap]

[Label]
[Input / Select / Textarea]
[Helper text or error message]

[24px gap]

[Group Title]
[Separator]

[Label]
[Input]
```

### 15.2 Form Field Styling

| Element | Style |
|---------|-------|
| Label | `text-label font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block` |
| Input | `h-9 rounded-md border border-input bg-background px-3 text-body` |
| Focus | `ring-2 ring-ring ring-offset-2 ring-offset-background` |
| Error | `border-destructive focus:ring-destructive` |
| Error text | `text-caption text-destructive mt-1` |
| Helper text | `text-caption text-muted-foreground mt-1` |
| Required indicator | `text-destructive` asterisk after label |

### 15.3 Form Validation

- Validate on blur (not on change -- too aggressive)
- Show error state immediately on submit attempt
- Clear error when user starts editing the field
- Use native HTML validation attributes where possible (`required`, `pattern`,
  `minLength`, `maxLength`)
- Complex validation (async uniqueness checks) uses debounced validation

---

## 16. Empty States

### 16.1 Empty State Anatomy

```
+--[Empty State]------------------------------------+
|                                                    |
|              [Icon: 40px, muted]                   |
|                                                    |
|         [Title: text-heading, foreground]          |
|    [Description: text-body, muted-foreground]     |
|                                                    |
|              [Primary action button]               |
|                                                    |
+---------------------------------------------------+
```

### 16.2 Empty State Content

| View | Icon | Title | Description | Action |
|------|------|-------|-------------|--------|
| Sessions | Play | No sessions yet | Start your first AI agent session | New Session |
| Agents | Settings | No custom agents | Create agents to define specialized AI roles | Browse Agents |
| Flows | GitBranch | No custom flows | Flows orchestrate multi-stage agent workflows | Browse Flows |
| History | Clock | No session history | Completed and archived sessions appear here | -- |
| Events | Activity | No events yet | Events will appear as sessions progress | -- |
| Search | Search | No results | Try adjusting your search or filters | Clear Filters |
| Compute | Server | No compute resources | Configure compute targets for agent execution | Add Compute |

---

## 17. Keyboard Shortcuts

### 17.1 Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open command palette |
| `Cmd+N` | New session |
| `Cmd+/` | Toggle sidebar |
| `Cmd+D` | Toggle dark/light mode |
| `Cmd+,` | Open settings |
| `Escape` | Close dialog/panel, deselect |
| `?` | Show keyboard shortcuts |

### 17.2 View-Specific Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `j` / `k` | List views | Move selection down/up |
| `Enter` | List views | Open selected item |
| `Escape` | Detail panel | Close detail |
| `d` | Session selected | Dispatch |
| `s` | Session selected | Stop |
| `r` | Session selected | Retry |
| `f` | Any list | Focus search/filter |

---

## 18. Implementation Roadmap

### Phase 1: Foundation (Week 1)
1. Add semantic type scale tokens to `styles.css`
2. Add status color tokens to `styles.css`
3. Replace custom Modal with Radix Dialog
4. Add Tooltip component (Radix)
5. Add Skeleton component
6. Add Select component (Radix)
7. Replace custom Toast with Sonner

### Phase 2: Core Components (Week 2)
1. Add Tabs component (Radix)
2. Add DropdownMenu component (Radix)
3. Add Command palette (cmdk)
4. Add DataTable component (TanStack Table)
5. Add Sheet component for detail panels
6. Add Collapsible component
7. Add ScrollArea component

### Phase 3: Patterns (Week 3)
1. Refactor SessionList to use DataTable
2. Implement master-detail with resizable panels
3. Add EmptyState component
4. Add ErrorBoundary component
5. Add FilterBar component
6. Implement skeleton loading for all views

### Phase 4: Polish (Week 4)
1. Implement density modes
2. Add all entrance/exit animations
3. Add keyboard shortcuts framework
4. Implement command palette with full action set
5. Add real-time update animations
6. Accessibility audit (keyboard nav, ARIA, contrast)

---

## 19. Sources and References

### Design Systems Studied

| System | URL | Key Takeaways |
|--------|-----|---------------|
| Linear | https://linear.app | Information density, keyboard-first, subtle animations, monochrome + status colors |
| Vercel Geist | https://vercel.com/geist | Type scale, oklch colors, minimal component API, dark-first |
| Radix Themes | https://radix-ui.com/themes | Scaling/density system, 9-step spacing/type scales, composable Theme provider |
| Radix Primitives | https://radix-ui.com/primitives | Accessibility-first unstyled components, WAI-ARIA compliance |
| shadcn/ui | https://ui.shadcn.com | cva variant system, source-owned components, Tailwind + Radix composition |
| GitHub Primer | https://primer.style | Design tokens, WCAG AA compliance, enterprise patterns |
| Tailwind CSS | https://tailwindcss.com | Utility classes, spacing scale, responsive design, v4 oklch |
| Apple HIG | https://developer.apple.com/design/human-interface-guidelines | Desktop density, spatial layout, motion guidelines |
| Tailwind UI | https://tailwindui.com | Production component templates, layout patterns |

### Libraries to Add

| Package | Purpose | Size |
|---------|---------|------|
| `@radix-ui/react-dialog` | Accessible dialogs/modals | ~12KB |
| `@radix-ui/react-dropdown-menu` | Dropdown menus | ~15KB |
| `@radix-ui/react-tabs` | Tab interfaces | ~8KB |
| `@radix-ui/react-tooltip` | Tooltips | ~10KB |
| `@radix-ui/react-select` | Select dropdowns | ~18KB |
| `@radix-ui/react-popover` | Popovers | ~12KB |
| `@radix-ui/react-scroll-area` | Custom scrollbars | ~8KB |
| `@radix-ui/react-collapsible` | Expand/collapse | ~5KB |
| `@radix-ui/react-accordion` | Accordion sections | ~8KB |
| `@radix-ui/react-switch` | Toggle switches | ~5KB |
| `@radix-ui/react-checkbox` | Checkboxes | ~5KB |
| `@radix-ui/react-hover-card` | Hover previews | ~10KB |
| `@radix-ui/react-alert-dialog` | Confirmation dialogs | ~10KB |
| `@radix-ui/react-context-menu` | Right-click menus | ~15KB |
| `@radix-ui/react-toggle-group` | Grouped toggles | ~6KB |
| `@radix-ui/react-progress` | Progress bars | ~4KB |
| `cmdk` | Command palette | ~7KB |
| `sonner` | Toast notifications | ~8KB |
| `@tanstack/react-table` | Data tables | ~25KB |
| `@tanstack/react-virtual` | Virtual scrolling | ~5KB |
| `react-resizable-panels` | Resizable layouts | ~12KB |

### Key Blog Posts and Talks (recommended reading)

- "Designing Linear" -- Linear team, on information density and keyboard-first design
- "Building Vercel's Design System" -- Rauno Freiberg, on Geist architecture
- "Radix Themes: Building a Pre-styled Component Library" -- Radix team
- "shadcn/ui: Beautifully designed components" -- shadcn, on source-owned components
- "Design Tokens and Theming" -- GitHub Primer team, on multi-theme token architecture
- "Invisible Details of Interaction Design" -- Rauno Freiberg, on micro-interactions
- "The 4px Grid" -- Figma team, on spatial consistency

---

## Appendix A: CSS Token Reference

Complete token list for `styles.css` additions:

```css
/* Add to @theme inline block */
@theme inline {
  /* ... existing tokens ... */

  /* Type scale */
  --text-display: 1.5rem;
  --text-title: 1.125rem;
  --text-heading: 0.9375rem;
  --text-body: 0.8125rem;
  --text-label: 0.75rem;
  --text-caption: 0.6875rem;
  --text-micro: 0.625rem;

  /* Line heights */
  --leading-display: 2rem;
  --leading-title: 1.75rem;
  --leading-heading: 1.375rem;
  --leading-body: 1.25rem;
  --leading-label: 1rem;
  --leading-caption: 1rem;
  --leading-micro: 0.875rem;

  /* Radius scale */
  --radius-none: 0;
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  --radius-2xl: 1rem;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);

  /* Status colors */
  --color-status-running: var(--status-running);
  --color-status-running-bg: var(--status-running-bg);
  --color-status-waiting: var(--status-waiting);
  --color-status-waiting-bg: var(--status-waiting-bg);
  --color-status-completed: var(--status-completed);
  --color-status-completed-bg: var(--status-completed-bg);
  --color-status-failed: var(--status-failed);
  --color-status-failed-bg: var(--status-failed-bg);
  --color-status-stopped: var(--status-stopped);
  --color-status-stopped-bg: var(--status-stopped-bg);
}
```

## Appendix B: Animation Utilities

```css
/* Add to styles.css */
@keyframes scale-in {
  from { transform: scale(0.95); opacity: 0; }
}

@keyframes slide-from-right {
  from { transform: translateX(16px); opacity: 0; }
}

@keyframes slide-to-right {
  to { transform: translateX(16px); opacity: 0; }
}

@keyframes highlight-fade {
  from { background-color: var(--primary) / 0.05; }
  to { background-color: transparent; }
}

/* Utility classes */
.animate-fade-in {
  animation: fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1);
}

.animate-scale-in {
  animation: scale-in 200ms cubic-bezier(0.32, 0.72, 0, 1);
}

.animate-slide-up {
  animation: slide-up 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.animate-slide-from-right {
  animation: slide-from-right 250ms cubic-bezier(0.32, 0.72, 0, 1);
}

.animate-highlight {
  animation: highlight-fade 2s ease-out;
}
```

## Appendix C: Component Template (Copy-Paste Starter)

```tsx
// components/ui/example.tsx
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const exampleVariants = cva(
  // Base classes
  "inline-flex items-center justify-center rounded-md transition-colors",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground border border-border",
        filled: "bg-primary text-primary-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-4 text-body",
        sm: "h-8 px-3 text-label",
        lg: "h-10 px-6 text-body",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ExampleProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof exampleVariants> {}

function Example({ className, variant, size, ...props }: ExampleProps) {
  return (
    <div
      className={cn(exampleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Example, exampleVariants };
```
