# Ark Design System

A design system for **Ark**, an orchestration layer for AI coding agents. Ark drives agents (Claude Code, Codex, Gemini CLI, Goose, etc.) through multi-stage SDLC pipelines with real-time TUI, PR review automation, and flexible compute.

This repository codifies Ark's visual language -- colors, typography, iconography, components, voice and tone -- so you can build new product surfaces, marketing pages, slides, and throwaway prototypes that look and feel like native Ark.

---

## Index

| File / Folder | Purpose |
|---|---|
| `README.md` | This file -- brand context, content fundamentals, visual foundations, iconography. |
| `SKILL.md` | Agent Skill manifest -- makes this design system usable as a Claude Skill. |
| `colors_and_type.css` | CSS variables for colors (6 variants: 3 themes × light/dark), type scale, radii, motion, elements. Single source of truth. |
| `assets/` | Real brand assets copied from the Ark repo: logos, icons. Use these directly -- do not redraw. |
| `preview/` | Swatch / specimen / token / component cards that populate the Design System tab. |
| `ui_kits/web/` | Web dashboard UI kit -- React/JSX components and an interactive `index.html` demoing session list, session detail, dashboard pages. |
| `ui_kits/tui/` | CLI/TUI terminal UI kit -- the primary surface for Ark. Monospace, 256-color boxes, mock `ark` commands. |

## Source material

Everything in here was derived from the `ytarasova/ark` GitHub repo (branch `main`). Specific files referenced:

- `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `HANDOFF.md` -- voice, feature list, architecture.
- `packages/web/src/themes/` -- six-theme system (midnight-circuit, arctic-slate, warm-obsidian × dark/light).
- `packages/web/src/styles.css` -- typography scale and component classes.
- `packages/web/src/components/` -- Radix primitives + custom Button, Tooltip, status dots, session cards.
- `packages/web/src/pages/` -- Sessions, Dashboard, Session Detail.
- `packages/desktop/icon.png` -- the "A" logo.
- `package.json` -- icon system is `lucide-react`, fonts load from Google (Inter + JetBrains Mono + Geist Mono).

No Figma was attached. Anything labelled **placeholder** is a best-guess recreation -- flag it during review.

---

## Brand context

**Ark** is a developer-facing tool. It's a CLI-first product (`ark` command) with an optional web dashboard, Electron desktop wrapper, and Control Plane (server + workers).

- **What it does:** orchestrates fleets of AI coding agents across SDLC flows -- intake, planning, audit, execution, verification, close, retro. Runs them on local machines, containers, cloud VMs, or Kubernetes pods.
- **Who it's for:** engineers and engineering teams already comfortable with CLIs, `tmux`, worktrees, and YAML config.
- **Who it's NOT for:** non-technical users. There is no "get started with AI" onboarding copy. The README opens with prerequisites.
- **Competitive framing:** "Ship code with AI agents, not just copilots." Ark positions against ephemeral chat agents by owning the whole lifecycle.

### Products / surfaces

1. **CLI / TUI** -- the primary interface. `ark session start`, `ark dashboard`, `ark web`, `ark doctor`. Uses `chalk` + `tmux` for color and panes.
2. **Web dashboard** (`ark web`) -- Vite + React 19 + Tailwind 4. Session list, session detail, fleet overview, flow DAG visualizer (via `@xyflow/react`), cost charts (`recharts`), embedded terminal (`xterm.js`).
3. **Desktop** -- Electron wrapper around the web dashboard. macOS/Windows/Linux.
4. **Control plane / arkd** -- headless server + worker daemon. No UI of its own; observed via the dashboard.

---

## Content fundamentals

**Voice.** Engineer-to-engineer. Concise, dense, information-forward. Assumes you know what a `worktree`, `tmux`, `MCP`, `DAG`, or `JSON-RPC` is. No hand-holding.

**Tone.** Calm, technical, confident. Slightly dry. Avoids exclamation marks, avoids enthusiasm, avoids marketing adjectives like "powerful," "revolutionary," "delightful." Where a feature is praised, it's done with a one-line capability claim ("85-90% memory reduction by sharing MCP server processes") not an adjective.

**Person.** Imperative second-person for instructions (`Run ark doctor to verify...`). "Ark" as subject when describing behavior (`Ark handles all of that`). Rarely "we" -- mostly the tool is the actor.

**Casing.**
- Product name is lowercase in commands: `ark session start`. Capitalized "Ark" in prose.
- Feature names are Title Case: "Sessions", "Knowledge Graph", "Control Plane".
- Config keys / flags / file paths in `code font`: `--repo`, `~/.ark/ark.db`, `auto_index`.

**Em-dashes.** The codebase README uses double-hyphens `--` instead of em-dashes (`—`). Match this in any Ark-voiced copy.

**Emoji.** Not used. Never in code, never in UI, never in marketing copy. The README has zero emoji. Do not introduce them.

**Unicode decoration.** None. No ✓, ✗, →, •. Use Lucide icons for all glyphs.

**Numbers.** Always specific. "12 specialized agents." "5 runtimes." "33 languages via tree-sitter." "85-90% memory reduction." Never round to "a bunch" or "many."

**Status / state copy.** Short machine-style verbs: `running`, `waiting`, `completed`, `failed`, `stopped`, `pending`. Lowercase. Past/present tense matches the actual state.

**Buttons and CTAs.** Verb-first, one to three words: `Dispatch`, `Stop Session`, `Export Transcripts`, `Add Compute`. Never "Click here" or "Get started".

**Empty states.** Describe what to do, not "Nothing here yet." Example: "No sessions. Create one with `ark session start` or the + button."

**Example snippets (from repo README, all in this voice):**

- "The install script downloads a self-contained tarball that bundles ark + tmux + codegraph..."
- "Launch the web dashboard (or desktop app)"
- "Tests use bun:test. Always run via make test -- never call bun test directly..."
- "Prefer a native window? Install the Ark Desktop app (macOS, Windows, Linux)."

---

## Visual foundations

### Color

Six theme variants total (three themes × light/dark). All themes share the same semantic token names -- switching is literally a class swap on `<html>`.

**Themes**
- **Midnight Circuit** (default, brand) -- indigo/purple primary (`#6b59de`), teal accent, near-black canvas (`#0c0c14`).
- **Arctic Slate** -- royal blue primary (`#2563eb`), neutral slate (`#09090b`). The "sober" option.
- **Warm Obsidian** -- gold primary (`#d4a847`), warm off-black (`#0f0f0f`). The "expensive" option.

**Canvas rhythm.** Dashboards are dark-first. Surfaces step up in lightness from sidebar (`--bg-sidebar`, darkest) → canvas (`--bg`) → card (`--bg-card`) → popover/modal (`--bg-popover`). Difference between adjacent surfaces is ~4-6% luminance -- subtle, never harsh contrast.

**Semantic status colors.** `--running` (blue glow), `--waiting` (amber), `--completed` (green), `--failed` (red), `--stopped` (muted gray). Used as 8px dots, and as subtle glows on running/failed states.

**Diff palette.** `--diff-add-fg` / `--diff-add-bg` (green on 8%-alpha green); `--diff-rm-fg` / `--diff-rm-bg` (red). Used in PR review and transcript views.

**Gradients.** Only two places:
1. The "A" logo (indigo → lavender).
2. `--gradient-brand` (primary → teal/gold) on the occasional hero, login, or "new session" CTA. Never on cards, never on backgrounds. One gradient per screen, max.

### Typography

- **Sans:** Inter -- UI, prose, labels. Weights 300/400/500/600/700.
- **Mono:** JetBrains Mono -- code blocks, transcripts, paths, commands, terminal output.
- **Mono UI:** Geist Mono -- numeric UI chrome (session IDs, timestamps, token counts). Tighter than JetBrains, sits between sans and true code.

**Scale.** 9 steps, base body is **13px** (intentionally dense for information-rich dashboards -- don't scale up). Tracking tightens (`-0.015em`) on display, widens (`0.04em`) on micro/label caps.

**Numeric rendering.** `font-variant-numeric: tabular-nums` on anything that updates live (token counts, durations, costs, progress).

### Spacing

4px baseline. Use `4, 8, 12, 16, 20, 24, 32, 48, 64`. Tight (8-12px) inside cards and list rows; generous (24-32px) between sections. Dashboards favor density.

### Radii

Only three values: **6px** (inputs, chips, buttons), **8px** (cards, panels), **12px** (modals, large surfaces). No 2px, no 16px, no 9999px pills -- except on status dots (which are true circles).

### Borders

1px, `--border` color (theme-dependent gray). Borders are the PRIMARY way surfaces differentiate -- Ark almost never uses drop shadows in the UI. `--border-light` for subtle internal dividers (table rows, list separators).

### Shadows

Deliberately minimal.
- **Popovers / modals:** `0 4px 16px rgba(0,0,0,0.3)` on dark, `0 4px 16px rgba(0,0,0,0.08)` on light.
- **Status glows:** `--running-glow`, `--failed-glow` -- small outer glow (8px blur) on status dots only.
- **Cards:** no shadow. Use border.

### Cards

Background `--bg-card`, 1px `--border`, 8px radius. No shadow. Hover: background shifts to `--bg-hover`, border remains. Padding 16px for list rows, 24px for feature cards.

### Backgrounds, imagery, illustrations

- **No illustrations**, no hand-drawn art, no scenes, no mascots. Ark does not have illustrations. Do not invent them.
- **No repeating patterns** or textures.
- **No photography** in-product. Marketing might use abstract code/terminal screenshots but there is no photography in the app.
- **Graph visualizations** (flow DAGs, dependency graphs, cost charts) ARE the primary visual motif. Use them heavily when they fit.
- **Full-bleed:** only the main canvas fills the viewport. Everything inside is contained in bordered surfaces.
- **Transparency / blur:** none except the `--bg-overlay` scrim behind modals (60% black on dark, 30% on light). No `backdrop-filter: blur`. No frosted glass.

### Animation

- **Easing:** `cubic-bezier(0.32, 0.72, 0, 1)` (a fast-out, gentle-settle curve) for almost everything.
- **Durations:** 150ms (hover, state swaps), 200ms (panel slides, modal open).
- **No bounces.** No spring physics. No elastic. Ark is technical, not playful.
- **Live indicators:** progress bars use a swept-highlight animation (`ds-slide-right`, ~1.5s loop). Status dots on `running` state pulse a glow (`ds-glow-pulse`). Skeleton loaders shimmer (`ds-shimmer`).
- **Fades are OK.** Used for popover enter/exit, toast enter/exit.

### Hover / press states

- **Hover (surfaces):** background steps up to `--bg-hover`. Border stays.
- **Hover (text / icon buttons):** color shifts from `--fg-muted` to `--fg`.
- **Hover (primary button):** background shifts to `--primary-hover` (darker). No lift, no shadow, no scale.
- **Press:** background darkens one more step. No shrink/scale transforms.
- **Focus:** 2px outline in `--primary`, offset 2px. Visible on all interactive elements via `:focus-visible`.
- **Disabled:** 50% opacity, `cursor: not-allowed`. Never gray them out by recoloring -- just fade.

### Protection gradients vs capsules

No protection gradients (no "fade to black at the bottom of the hero"). Ark prefers crisp rectangles. Pills / capsules are reserved for **status badges only** -- everything else is 6-8px rounded.

### Fixed / layout rules

- **App chrome is 3-column:** `--rail-w` (48px icon rail) + `--list-w` (300px list) + fluid main. On narrower screens, the list collapses first.
- **Top bar:** 40px tall, holds breadcrumb, global search, theme toggle, account.
- **Bottom bar (session detail):** 32px tall, holds status dot, token/cost counters, runtime badge.
- **Right panel** (flow DAG, diff viewer): resizable, default 480px.

---

## Iconography

**Library:** [Lucide](https://lucide.dev) via `lucide-react` (pinned to `^1.7.0` in the repo, though that's an older version of lucide; the current Lucide CDN is fine). All icons are **1.5px stroke**, rounded ends, rounded joins. 16×16 at body scale, 14×14 in dense UI, 20×20 in empty states, 32×32 in feature cards.

**No custom icon font.** No sprite sheet. No emoji. Everything comes from Lucide. The only raster asset in `assets/` is the Ark logo PNG.

**Commonly used icons (from the code):**

- Navigation / chrome: `Home`, `List`, `LayoutDashboard`, `Search`, `Settings`, `User`.
- Sessions: `Play`, `Pause`, `Square` (stop), `GitBranch`, `GitFork`, `RefreshCw`, `Trash2`.
- Status: `Circle` (filled dots), `CheckCircle2`, `XCircle`, `AlertCircle`, `Clock`.
- Compute: `Server`, `Cloud`, `Box` (container), `Cpu`.
- Flows / agents: `Workflow`, `Bot`, `Sparkles`, `Network`.
- Files / code: `FileText`, `Folder`, `Terminal`, `Code2`, `Diff`.

**Logo.**
- `assets/ark-icon.png` -- the 1024×1024 app icon. Bold "A" on transparent bg with indigo→lavender gradient fill.
- `assets/ark-wordmark.svg` -- inline SVG wordmark (below), uses the brand gradient. Use next to the A for full lockup.

**Unicode chars:** not used. Draw real icons.

**CDN substitution:** The repo pins `lucide-react@^1.7.0` (pre-2.0). The Lucide API has been stable; using the current CDN-distributed Lucide is a safe approximation. **Flag this if pixel-parity matters.**

---

## Caveats / things that were assumed

- **Fonts:** `Inter` and `JetBrains Mono` and `Geist Mono` all load from Google Fonts -- no local TTFs needed. If the production builds ship different weights, the CSS import list should be extended.
- **Theme accents:** `midnight-circuit` primary was read from the Tailwind theme file. If the source-of-truth hex is slightly different in the running app, it was close enough to match by eye.
- **TUI palette:** the CLI/TUI colors here are extrapolated from `chalk` usage patterns -- the repo doesn't have a single central TUI palette file. Flag if you have one.
