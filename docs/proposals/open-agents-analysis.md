# Open Agents Analysis: UX + Capabilities Proposal

> Research date: 2026-04-15
> Compared: Vercel Open Agents (vercel-labs/open-agents) vs Ark v0.17.0

## Executive Summary

Open Agents is Vercel's open-source reference app for cloud-hosted coding agents. It ships a polished Next.js 16 web UI with Geist typography, oklch color system, and a focused feature set: chat-driven coding sessions in Firecracker sandboxes with auto-commit/PR workflows. Compared to Ark, Open Agents is narrower in scope (single compute target, no DAG orchestration, no multi-tenant, no CLI) but significantly more refined in UI/UX. Ark's architecture is more powerful -- 11 compute providers, DAG flows, LLM router, knowledge graph -- but the web dashboard lags behind in visual polish and interaction design. This proposal identifies specific design improvements and capability gaps worth addressing.

## Part 1: UX/UI Analysis

### Open Agents Design Language

**Color System**
- Uses oklch() color space (perceptually uniform, modern CSS)
- Light mode: `--background: oklch(1 0 0)` (pure white), `--foreground: oklch(0.141 0.005 285.823)` (near-black)
- Dark mode: `--background: oklch(0.141 0.005 285.823)`, `--foreground: oklch(0.985 0 0)`
- Primary: oklch-based dark blue-purple (light) / light blue-purple (dark)
- Minimal accent colors -- monochromatic with functional color only for status
- The landing page is almost entirely black-and-white with no decorative color

**Typography**
- Geist Sans (variable weight) for UI text via `--font-geist-sans`
- Geist Mono for code and tool output via `--font-geist-mono`
- Large, bold headlines on landing page (appears ~48-72px, heavy weight)
- Body text is restrained, lightweight, generous line-height

**Card/Panel Treatment**
- `rounded-xl` (12px+) for major containers, `rounded-2xl` for chat bubbles
- `shadow-2xl shadow-black/8` (light) / `shadow-black/30` (dark) for elevated panels
- Borders are subtle, often 1px with low-contrast colors
- The app mockup on the landing page floats with dramatic shadow, creating depth
- Tool call summaries use `rounded-lg` with muted background fills

**Navigation**
- Left sidebar with session list (collapsible on mobile via Sheet component)
- Breadcrumb bar at top: `project / branch / session-name [status]`
- Sessions sidebar shows name + relative time (e.g., "3m", "2h", "1d")
- Clean separation: sidebar = navigation, main area = conversation + workspace

**Conversation UI**
- User messages: right-aligned, `rounded-2xl rounded-br-md` (chat bubble shape)
- Agent responses: left-aligned, rendered with Streamdown (rich markdown)
- Tool calls: collapsible cards with status icon, tool name, summary, timing
  - Running: spinning Loader2 (yellow)
  - Success: green checkmark
  - Error: red X with red-tinted text
  - Thinking blocks: Brain icon with elapsed timer
- Input bar: bottom-fixed, `rounded-xl`, shows model name + cost indicator
- Inline questions: pill-style option buttons with progress dots

**Data Visualization**
- Minimal -- no charts or dashboards. Usage shown as simple text metrics
- Workflow steps rendered as a vertical timeline with durations
- Diff viewer: side-by-side or unified, powered by @pierre/diffs

**Animations**
- tw-animate-css library for entrance/exit transitions
- FOUC prevention: theme class applied before render via inline script
- Status indicators pulse subtly (similar to Ark's glow-pulse)

**What Makes It Feel "Beautiful"**
1. Extreme restraint -- almost no color, letting content breathe
2. Geist font family -- purpose-built for developer tools, excellent at all sizes
3. Large whitespace margins and generous padding
4. The mockup-on-landing technique: app preview with dramatic shadow on gray bg
5. Monochromatic palette forces visual hierarchy through weight and size, not color
6. oklch color space ensures perceptual consistency across light/dark modes

### Ark's Current Design

**Strengths**
- Well-structured CSS variable system (similar token approach to Open Agents)
- Comprehensive sidebar with 10+ navigation items reflecting deep feature set
- Dark mode support with coherent purple accent (`#7c6aef`)
- Functional status indicators (emerald/amber/red with glow animations)
- Collapsible sidebar with localStorage persistence
- Good component library: Card, Button, Badge, Modal, Input, Separator

**Weaknesses**
- Inter font is generic -- every SaaS dashboard uses it
- Color palette relies on hex values, not oklch (less perceptual uniformity)
- Chat bubbles are small (`text-[12px]`, `rounded-lg`) -- feels cramped
- No breadcrumb or contextual header showing current session context
- Dashboard is metrics-heavy but visually dense (small cards, tight spacing)
- Purple accent (`#7c6aef`) is used everywhere -- sidebar, ring, selection -- making it feel monotone rather than intentional
- No rich tool-call rendering in chat (Open Agents has specialized renderers for bash, edit, read, write, diff)
- Missing workspace/diff viewer in session context

### Comparison Matrix

| Element | Open Agents | Ark | Gap |
|---------|------------|-----|-----|
| Font family | Geist Sans/Mono (custom, modern) | Inter/JetBrains Mono (generic) | Medium -- font swap is easy |
| Color space | oklch (perceptually uniform) | hex (legacy) | Low -- cosmetic improvement |
| Dark bg | `oklch(0.141...)` (~#1a1a2e equivalent) | `#101014` (deeper black) | Minimal -- both are good |
| Primary accent | Monochromatic (near-black/white) | Purple `#7c6aef` everywhere | Design choice, not gap |
| Card radius | `rounded-xl` (12px+) | `rounded-lg` (8px) | Small -- easy CSS change |
| Card shadows | `shadow-2xl shadow-black/8` | Minimal/none | Medium -- adds depth |
| Chat text size | Normal body size | `text-[12px]` (tiny) | High -- readability issue |
| Chat bubble shape | `rounded-2xl rounded-br-md` | `rounded-lg` (uniform) | Medium -- visual polish |
| Tool call rendering | Specialized per-tool (bash, edit, diff, read, write) | None -- plain text | High -- major UX gap |
| Breadcrumb header | Project / branch / session | Page title only | Medium -- context awareness |
| Session sidebar | Name + relative time, streaming indicator | Full session list with status dots | Ark is richer here |
| Diff viewer | Inline, side-by-side, @pierre/diffs | None in web UI | High -- missing feature |
| Input bar | Model name, cost %, mic icon | Basic text input | Medium -- polish |
| Thinking blocks | Brain icon + elapsed timer | Not shown | Medium -- transparency |
| Animations | tw-animate-css (enter/exit) | glow-pulse only | Low -- decorative |
| Mobile responsive | Sheet-based sidebar | Grid collapse to 48px | Both adequate |

### Recommended Design Changes (prioritized)

1. **Increase chat text size and bubble treatment** (< 1hr) -- Change from `text-[12px]` to `text-sm` (14px). Use `rounded-2xl` with directional rounding for user/agent bubbles. Biggest readability win.

2. **Add tool-call rendering in chat** (2-3 days) -- Create specialized renderers for common tool types (bash command, file edit, file read, file write). Show collapsible cards with tool name, status icon, summary line. This is the single biggest UX gap.

3. **Switch to Geist font family** (< 1hr) -- Replace Inter with Geist Sans, JetBrains Mono with Geist Mono. Import from `@fontsource/geist-sans` and `@fontsource/geist-mono`. Instant modernization.

4. **Add contextual breadcrumb header** (< 2hr) -- When viewing a session, show: `Agent / Flow / Session Summary [status]` in the top bar instead of just "Sessions".

5. **Add diff viewer to session detail** (1-2 days) -- Show file changes made by the agent. Can use a lightweight diff library or render unified diffs.

6. **Increase card radii and add shadows** (< 30min) -- Bump default from `rounded-lg` to `rounded-xl`. Add `shadow-sm` to cards in light mode. Small change, noticeable lift.

7. **Add thinking/reasoning blocks** (4hr) -- Show agent reasoning as collapsible blocks with elapsed time. Improves transparency.

8. **Migrate to oklch color space** (2hr) -- Convert hex palette to oklch. Better perceptual consistency, especially in dark mode gradients.

## Part 2: Product Capabilities

### Feature Matrix

| Capability | Open Agents | Ark | Notes |
|-----------|------------|-----|-------|
| **Agent management** | Single agent type, configured via system prompt | YAML-defined agents, multiple runtimes | Ark is significantly ahead |
| **Session/chat interface** | Polished web chat with streaming, tool rendering | Web chat (basic) + tmux terminal | Open Agents UX ahead, Ark has more depth |
| **Multi-agent orchestration** | Explorer + Executor subagents (2-agent delegation) | DAG-based flows, fan-out, N-agent pipelines | Ark is far ahead |
| **Tool/MCP integration** | Built-in tools (read, write, edit, bash, grep, glob) | Built-in tools + MCP server support | Ark has MCP, Open Agents does not |
| **Compute/sandbox** | Vercel Sandbox (Firecracker MicroVM) only | 11 providers (local, Docker, devcontainer, Firecracker, EC2, e2b, k8s, etc.) | Ark is far ahead |
| **Code review / PR workflow** | Auto-commit, auto-push, auto-PR creation, code-review skill | Manual via CLI or agent | Open Agents more automated |
| **Knowledge/context** | Dynamic system prompt with git/env context, context compaction | Knowledge graph, codebase indexing | Ark has deeper knowledge layer |
| **Cost tracking** | Token usage per session, usage analytics page, leaderboard | Cost tracking dashboard, per-model breakdown, budgets | Both capable, Ark more granular |
| **Scheduling/triggers** | Durable workflows (Vercel Workflow SDK), no cron | Cron schedules, webhooks, event-driven triggers | Ark is ahead |
| **Multi-tenant/team** | Single-user with Vercel/GitHub OAuth | Multi-tenant with roles and permissions | Ark is ahead |
| **Desktop app** | None | Electron shell wrapping web dashboard | Ark is ahead |
| **CLI** | None | Full Commander.js CLI (`ark <command>`) | Ark is ahead |
| **API** | Next.js API routes, chat workflow trigger | JSON-RPC + WebSocket + REST | Ark is ahead |
| **Runtime support** | Claude (via AI SDK), multi-model via AI Gateway | Claude Code, Codex, Gemini CLI, Goose | Ark supports more agent runtimes |
| **Deployment** | Vercel-only (cloud) | Self-hosted, Docker, Helm, hybrid | Ark is far ahead |
| **Session sharing** | Read-only shareable links with env redaction | Not available in web UI | Open Agents has this, Ark does not |
| **Voice input** | ElevenLabs transcription | None | Open Agents has this |
| **Workspace/IDE** | In-browser codespace with file tree + diff viewer | Terminal-based (tmux) | Different approaches |

### Capabilities Ark Should Adopt (prioritized)

1. **Session sharing via read-only links** -- Low effort, high value. Generate a shareable URL that shows a session's conversation history without authentication. Open Agents redacts env vars in shared views -- good pattern to follow.

2. **Auto-commit/PR workflow in web UI** -- Open Agents' post-finish pipeline (auto-commit, push, create PR) is smooth. Ark has this capability in flows but not as a one-click web UI feature.

3. **In-browser workspace (file tree + diff viewer)** -- Being able to see what files the agent changed, review diffs, and browse the workspace without opening a terminal is a major usability win.

4. **Thinking/reasoning visibility** -- Showing the agent's reasoning chain (with timing) builds trust. Open Agents' ThinkingBlock component is a good reference.

5. **Voice input for chat** -- Nice-to-have for accessibility and hands-free operation.

### Capabilities Where Ark is Ahead

1. **Multi-provider compute** -- 11 compute providers vs Open Agents' single Vercel Sandbox. This is Ark's core differentiator. Users can run agents locally, in Docker, on EC2, in Kubernetes -- or any combination.

2. **DAG-based orchestration** -- True multi-agent pipelines with fan-out, handoffs, and dependency graphs. Open Agents only has 2-agent delegation (explorer + executor).

3. **Runtime diversity** -- Supporting Claude Code, Codex, Gemini CLI, and Goose means users aren't locked into one LLM vendor. Open Agents is Claude-first with AI Gateway as an escape hatch.

4. **CLI-first architecture** -- Ark's CLI (`ark <command>`) enables scripting, CI/CD integration, and power-user workflows that Open Agents can't match.

5. **LLM Router** -- Circuit breakers, 3 routing policies, and OpenAI-compatible proxy. Open Agents uses Vercel AI Gateway, which is similar but less configurable.

6. **Scheduling and triggers** -- Cron jobs, webhooks, event-driven agent launches. Open Agents has no scheduling.

7. **Desktop app** -- Electron shell provides a native experience. Open Agents is web-only.

8. **Self-hosted deployment** -- Docker, Helm charts, and full self-hosting. Open Agents requires Vercel infrastructure.

## Part 3: Implementation Roadmap

### Quick Wins (< 1 day each)

- **Increase chat text size**: `text-[12px]` -> `text-sm`, better bubble shapes
- **Switch to Geist fonts**: Replace Inter/JetBrains Mono imports
- **Increase card radii and shadows**: `rounded-lg` -> `rounded-xl`, add `shadow-sm`
- **Add breadcrumb header**: Show agent/flow/session context in top bar
- **Migrate hex to oklch**: Convert CSS variables (cosmetic, no behavior change)

### Medium Lifts (1-3 days each)

- **Tool call rendering in chat**: Specialized components for bash, edit, read, write tool calls with collapsible detail, status icons, and timing
- **Session sharing**: Generate read-only shareable links with env var redaction
- **Thinking/reasoning blocks**: Collapsible reasoning display with elapsed timer
- **Diff viewer in session detail**: Show agent's file changes as inline diffs
- **Auto-commit/PR button**: One-click "commit and create PR" from session detail

### Strategic Investments (1+ week)

- **In-browser workspace**: File tree + editor + diff viewer within session context. This is a significant frontend feature but dramatically improves the "review what the agent did" experience.
- **Streamdown-style rich message rendering**: Replace plain text agent responses with rendered markdown, code blocks with syntax highlighting, and inline file references.
- **Voice input**: ElevenLabs or Whisper integration for voice-to-text in chat input.

## Appendix: Screenshots

| Screenshot | Path |
|-----------|------|
| Open Agents landing (light) | `docs/proposals/screenshots/open-agents-landing.png` |
| Open Agents landing (full, light) | `docs/proposals/screenshots/open-agents-landing-full.png` |
| Open Agents landing (full, dark) | `docs/proposals/screenshots/open-agents-dark-mode.png` |

Note: Open Agents requires Vercel OAuth to access authenticated pages (sessions, settings, workspace). The screenshots above show the public landing page with an app mockup preview. The mockup itself reveals the session UI layout: left sidebar with session list, main area with chat messages and tool call summaries, breadcrumb header with project/branch/session, and input bar with model selector.

Ark's web UI could not be screenshotted during this analysis (the `web` command serves static files that require the Vite dev server for full rendering). The design analysis is based on source code review of `packages/web/src/styles.css`, `Layout.tsx`, `Sidebar.tsx`, `ChatPanel.tsx`, and `DashboardView.tsx`.
