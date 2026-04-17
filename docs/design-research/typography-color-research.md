# Ark Visual Identity -- Typography & Color System Research

> Research compiled April 2026. Covers premium developer tool design systems,
> typography best practices for dense data UIs, and color system specifications
> for an AI agent orchestration platform.

---

## Table of Contents

1. [Typography Research](#1-typography-research)
2. [Color System Research](#2-color-system-research)
3. [Theme Proposals](#3-theme-proposals)
4. [Visual Identity Direction](#4-visual-identity-direction)
5. [Icon Style Recommendation](#5-icon-style-recommendation)
6. [Implementation Notes](#6-implementation-notes)
7. [Sources & References](#7-sources--references)

---

## 1. Typography Research

### 1.1 What Premium Developer Tools Use

| Product | Sans Font | Mono Font | Notes |
|---------|-----------|-----------|-------|
| **Linear** | Inter (custom optical sizes) | Berkeley Mono | Clean, geometric. Heavy use of 500 weight. |
| **Vercel** | Geist Sans | Geist Mono | Custom-designed for developer UIs. Tight metrics. |
| **Raycast** | Inter / system | SF Mono / system | Follows platform conventions, Apple-first. |
| **GitHub** | -apple-system, Segoe, system | SFMono, Consolas, monospace | System-first approach for global audience. |
| **Stripe** | -apple-system, system | Source Code Pro | Documentation-heavy; system fonts for speed. |
| **Supabase** | Custom sans (Inter-based) | Source Code Pro | Slightly softer/friendlier than Linear. |
| **Datadog** | Proxima Nova | Source Code Pro | Warmer humanist sans; dashboard-dense. |
| **Grafana** | Inter | Roboto Mono | Data-dense dashboards. Recently moved to Inter. |
| **Notion** | Inter | system mono | Content-first; large type scale for documents. |
| **Figma** | Inter | Inter (mono stylistic set) | Minimal font loading; Inter everywhere. |
| **Railway** | Satoshi | JetBrains Mono | Distinctive geometric sans; developer-forward. |
| **Planetscale** | Inter | JetBrains Mono | Clean, conventional choice. |

**Key insight:** The market has consolidated around two tiers:
- **Safe/proven:** Inter + JetBrains Mono (Grafana, Planetscale, Figma, Notion)
- **Distinctive:** Geist (Vercel), Satoshi (Railway), custom (Linear, Stripe)

### 1.2 Sans-Serif Font Comparison

#### Inter (current Ark choice)
- **Pros:** Exceptional at small sizes (11-13px). Designed specifically for screens. Huge glyph coverage. Free. Battle-tested in thousands of products. Tabular/oldstyle number alternates. Variable font with optical sizing.
- **Cons:** Ubiquitous -- "the new Helvetica" of developer tools. Can feel generic. Slightly wide x-height can make large text feel casual.
- **Best for:** Data-dense UIs, tables, small labels, international text.

#### Geist Sans (Vercel)
- **Pros:** Specifically designed for developer tooling. Tighter letter-spacing than Inter at body sizes. More geometric/technical feel. Slightly condensed proportions fit more data. Free (SIL OFL). Ships with excellent variable font support.
- **Cons:** Newer, less battle-tested across browsers. Slightly less readable below 11px compared to Inter. Smaller glyph coverage for non-Latin scripts.
- **Best for:** Developer dashboards, code-adjacent UIs, technical products.

#### SF Pro (Apple)
- **Pros:** Best-in-class on macOS/iOS. Optical sizes from 6pt to display. Beautiful at every weight. System-level hinting.
- **Cons:** Only licensed for Apple platforms. Cannot be distributed on web for non-Apple users. Legal risk for cross-platform products.
- **Best for:** macOS/iOS-only products (not suitable for Ark's web UI).

#### Plus Jakarta Sans
- **Pros:** Geometric but warm. Excellent display weights. Distinctive character at large sizes. Good for brand/marketing.
- **Cons:** Less optimized for very small UI text (below 12px). Can feel too "designerly" for dense dashboards.
- **Best for:** Marketing pages, headings, brand identity. Not ideal as a sole UI font.

#### Satoshi
- **Pros:** Clean geometric with character. Good at medium sizes (14-18px). Distinctive without being distracting. Free for commercial use.
- **Cons:** Limited to 9 weights/styles. No italic. Less refined hinting at very small sizes. No variable font.
- **Best for:** Headings, navigation, distinctive brand text. Pair with Inter for body.

#### General Sans
- **Pros:** Modern geometric with soft terminals. Good weight range. Variable font available.
- **Cons:** Less optimized for small sizes. Can look too similar to Satoshi.
- **Best for:** Display text, marketing.

#### Cabinet Grotesk
- **Pros:** Very distinctive display face. Strong personality at large sizes.
- **Cons:** Not suitable for body text or UI. Display-only.
- **Best for:** Logos, hero sections, marketing only.

#### Space Grotesk
- **Pros:** Proportional companion to Space Mono. Geometric with techy feel. Good for technical branding.
- **Cons:** Slightly quirky letterforms (the "a" and "g") can feel inconsistent in dense UI.
- **Best for:** Headings with a technical feel. Pairs with Space Mono.

### 1.3 Monospace Font Comparison

#### JetBrains Mono (current Ark choice)
- **Pros:** Designed for code. 139 code-specific ligatures. Increased x-height for better readability at small sizes. Free (SIL OFL). Excellent at 12-14px. Good weight range (100-800).
- **Cons:** Ligatures can be polarizing. Wider than some alternatives -- takes more horizontal space in tables.
- **Best for:** Code blocks, terminal output, log viewers.

#### Geist Mono
- **Pros:** Designed as companion to Geist Sans. Tighter metrics (fits more columns). Clean, no ligatures by default. Modern design.
- **Cons:** Newer; some developers find it less readable than JetBrains Mono at very small sizes.
- **Best for:** Inline code, metrics, status indicators, tabular data. Excellent for UI mono.

#### SF Mono
- **Pros:** Beautiful on Apple platforms. Good at small sizes. Clean and professional.
- **Cons:** Apple-only licensing.
- **Best for:** macOS fallback only.

#### Berkeley Mono
- **Pros:** Extremely refined. Distinctive character. Beautiful at all sizes.
- **Cons:** Commercial license required ($75+ per seat). Not free for open-source.
- **Best for:** Premium products with budget for type licensing.

#### Fira Code
- **Pros:** Excellent ligatures. Very readable. Large community. Free.
- **Cons:** Feels slightly dated compared to newer options. Wider character width.
- **Best for:** Code editors, but less ideal for UI elements.

#### IBM Plex Mono
- **Pros:** Part of a comprehensive family (Sans, Serif, Mono). Corporate-grade quality. Excellent internationalization.
- **Cons:** IBM aesthetic can feel corporate/enterprise. Slightly wider.
- **Best for:** Enterprise products, documentation-heavy UIs.

### 1.4 Recommendation: Typography Stack

**Primary sans:** Keep **Inter** as the primary UI font. It is proven at the small sizes (11-13px) that dominate Ark's dense dashboard. Consider **Geist Sans** as a differentiation option -- it was designed for exactly this use case and its tighter metrics would serve the data-dense session list and detail views well.

**Display/heading option:** If differentiation is desired, use **Geist Sans** or **Satoshi** for headings (h1-h3) while keeping Inter for body/UI text. This creates a subtle two-font hierarchy.

**Monospace:** Keep **JetBrains Mono** for code blocks and terminal. Add **Geist Mono** as the UI monospace (session IDs, costs, timestamps, port numbers) -- it is narrower and more refined for inline use.

```css
/* Recommended font stacks */
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
--font-mono-ui: "Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace;

/* OR for differentiation: */
--font-sans: "Geist Sans", "Inter", -apple-system, system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
```

### 1.5 Type Scale for Dense Data Dashboards

Ark is a monitoring/orchestration dashboard. Dense UIs need a compressed type scale
with clear hierarchy despite small absolute sizes. The following scale is based on
a 1.2 ratio (minor third) starting from a 13px base, optimized for dashboard use:

| Token | Size | Weight | Line Height | Letter Spacing | Use Case |
|-------|------|--------|-------------|----------------|----------|
| `text-2xs` | 10px | 500 | 14px (1.4) | +0.02em | Micro labels, badge text, keyboard shortcuts |
| `text-xs` | 11px | 400-500 | 16px (1.45) | +0.01em | Table metadata, timestamps, secondary info |
| `text-sm` | 12px | 400-500 | 18px (1.5) | +0.005em | Table body, sidebar items, descriptions |
| `text-base` | 13px | 400 | 20px (1.54) | 0 | Primary body text, form labels |
| `text-md` | 14px | 500 | 20px (1.43) | -0.005em | Section headers, emphasized text |
| `text-lg` | 16px | 600 | 22px (1.38) | -0.01em | Card titles, panel headers |
| `text-xl` | 18px | 600 | 24px (1.33) | -0.015em | Page section headers |
| `text-2xl` | 22px | 700 | 28px (1.27) | -0.02em | Page titles |
| `text-3xl` | 28px | 700 | 34px (1.21) | -0.025em | Dashboard hero numbers (total cost, etc.) |

**Monospace scale:** Mono text should be 1px smaller than its corresponding sans size
to appear optically equal (monospace fonts have wider set widths).

| Token | Size | Weight | Line Height | Use Case |
|-------|------|--------|-------------|----------|
| `mono-xs` | 10px | 400 | 16px | Inline code, session IDs, port numbers |
| `mono-sm` | 11px | 400-500 | 18px | Log lines, terminal text, cost values |
| `mono-base` | 12px | 400 | 20px | Code blocks, transcript viewer |
| `mono-lg` | 14px | 500 | 22px | Hero metrics (costs, counts) |

### 1.6 Font Weight Usage Patterns

Premium tools follow consistent weight conventions:

| Weight | Name | Usage Pattern |
|--------|------|---------------|
| **400** (Regular) | Body | All body text, descriptions, paragraphs, form inputs |
| **500** (Medium) | UI | Interactive elements (buttons, links, nav items), table headers, labels, sidebar items. **This is the workhorse weight for UI text.** Linear and Vercel use 500 extensively. |
| **600** (Semibold) | Emphasis | Section headings, card titles, active states, selected items. Avoid overuse -- reserved for clear hierarchy jumps. |
| **700** (Bold) | Display | Page titles, hero numbers, empty-state headings. Use sparingly. In dashboard UIs, bold should appear max 1-2 times per viewport. |

**Anti-pattern:** Using only 400 and 700. The 500 and 600 weights are critical for
the subtle hierarchy that makes dense UIs scannable.

### 1.7 Letter-Spacing and Line-Height for Dense UIs

**Letter-spacing rules:**
- **Small text (10-11px):** +0.01em to +0.03em. Tight text becomes illegible; add air.
- **Body text (12-14px):** 0 to +0.005em. Default tracking is fine.
- **Headings (16-22px):** -0.01em to -0.02em. Tighten for visual density/impact.
- **Display (24px+):** -0.02em to -0.03em. Large text needs tightening to avoid looking loose.
- **ALL CAPS labels:** +0.04em to +0.08em. Uppercase text must be tracked out. Ark's current `tracking-[0.08em]` on uppercase labels is correct.
- **Monospace:** Never adjust letter-spacing. It breaks column alignment.

**Line-height rules for dashboard UIs:**
- **Dense tables/lists:** 1.3-1.4 (tight). Maximizes vertical density.
- **Body text in panels:** 1.5-1.6 (comfortable). Aids readability for longer text.
- **Headings:** 1.1-1.25. Tight for visual impact.
- **Code blocks:** 1.5-1.6. Generous for scanability.

### 1.8 Differentiating UI Text vs Content Text vs Code

Premium tools use three distinct typographic voices:

1. **UI Text** (navigation, labels, buttons, status indicators)
   - Font: Sans at 500 weight
   - Size: 11-13px
   - Color: foreground or muted-foreground
   - Tracking: slightly positive for labels
   - Uppercase only for tiny category labels (10-11px)

2. **Content Text** (descriptions, summaries, documentation, chat messages)
   - Font: Sans at 400 weight
   - Size: 13-14px
   - Color: foreground
   - Line-height: 1.5-1.6
   - Tracking: 0
   - May use serif for long-form (Notion, GitHub READMEs)

3. **Code / Data** (session IDs, costs, timestamps, logs, terminal)
   - Font: Monospace at 400 weight
   - Size: 10-12px (1px smaller than adjacent sans)
   - Color: often a distinct color (muted or accent)
   - Line-height: 1.5 for code blocks
   - Background: subtle contrast (secondary/card color)
   - Tabular numbers: always enabled for aligned columns

---

## 2. Color System Research

### 2.1 Competitor Color Analysis

#### Linear -- Blue-Purple Axis
- Primary: `#5E6AD2` (indigo-purple)
- Background dark: `#0A0A0B` (near black with warm undertone)
- Background light: `#FFFFFF`
- Accent: Purple gradients on CTAs and focus states
- Status: Green (active), Yellow (in progress), Gray (backlog), Red (cancelled)
- Philosophy: Minimal palette. Purple communicates premium/craft. Very restrained color use -- most of the UI is grayscale with purple as the sole accent.

#### Vercel -- Monochrome Minimalism
- Primary: `#000000` (black) / `#FFFFFF` (white)
- Accent: `#0070F3` (blue, used very sparingly)
- Background dark: `#000000` (true black)
- Background light: `#FAFAFA`
- Borders: Very subtle (`#333` dark, `#eaeaea` light)
- Philosophy: Near-zero color. Relies on typography, spacing, and contrast. The most minimal approach in the industry. Color appears only in interactive states and status indicators.

#### Raycast -- Vibrant Gradients
- Primary: gradient from `#FF6363` to `#D63AFF` (red to purple)
- Background dark: `#18181B` (warm dark gray)
- Accent colors: Vibrant rainbow palette for different command categories
- Philosophy: Color as navigation/categorization. Gradients add energy and playfulness. Warm dark mode feels inviting.

#### GitHub -- Neutral with Scale
- Primary: `#1F6FEB` (blue, link/interactive color)
- Background dark: `#0D1117` (blue-black)
- Background light: `#FFFFFF`
- Borders: `#30363D` (dark), `#D0D7DE` (light)
- Status: Green (success), Yellow (pending), Red (failure), Gray (neutral)
- Philosophy: Massive scale means maximum accessibility. Neutral grays with blue interactive elements. Status colors are the primary way color enters the UI.

#### Stripe -- Blue Gradient Premium
- Primary: `#635BFF` (Stripe purple-blue)
- Gradients: Complex multi-stop gradients (purple -> blue -> cyan) for brand elements
- Background: Warm light grays for documentation
- Philosophy: Purple-blue communicates trust and premium quality. Gradients used for brand moments, not UI chrome.

#### Datadog -- Purple Monitoring
- Primary: `#632CA6` (deep purple)
- Background dark: `#1A1A2E` (dark blue-purple)
- Chart palette: Purpose-built for overlapping time series (6-8 distinguishable colors)
- Status: Green/yellow/red traffic light for alerts
- Philosophy: Purple brand but neutral UI. Dense dashboards rely on color only for data, not chrome.

#### Grafana -- Dark Data Visualization
- Primary: `#FF9830` (orange) -- distinctive in the monitoring space
- Background dark: `#181B1F` (cool dark)
- Chart palette: 24-color purpose-built palette for distinguishable series
- Panel borders: Very subtle to maximize chart space
- Philosophy: Charts are king. UI chrome is invisible. Color budget is spent entirely on data visualization.

### 2.2 Semantic Status Colors for Agent Sessions

Ark's current status mapping (from `StatusDot.tsx`) is solid. Here is a refined specification with precise hex values, accessibility ratios, and light/dark variants:

| Status | Semantic | Dark Mode | Light Mode | Dot Glow | Rationale |
|--------|----------|-----------|------------|----------|-----------|
| **running** | Active/healthy | `#34D399` (emerald-400) | `#059669` (emerald-600) | Yes, pulsing | Green = active. Glow draws eye to running sessions. |
| **waiting** | Paused/input needed | `#FBBF24` (amber-400) | `#D97706` (amber-600) | No | Amber = attention needed. Steady (not pulsing) = stable pause. |
| **completed** | Success/done | `#60A5FA` (blue-400) | `#2563EB` (blue-600) | No | Blue = completed state. Not green (avoids confusion with "running"). |
| **failed** | Error | `#F87171` (red-400) | `#DC2626` (red-600) | Subtle red | Red = error. Faint glow signals urgency without alarm fatigue. |
| **stopped** | Manually stopped | `#6B7280` (gray-500) at 0.4 | `#9CA3AF` (gray-400) at 0.6 | No | Muted = intentionally inactive. |
| **pending** | Queued/not started | `#6B7280` (gray-500) at 0.3 | `#9CA3AF` (gray-400) at 0.5 | No | Lighter than stopped; hasn't run yet. |
| **archived** | Historical | `#6B7280` (gray-500) at 0.2 | `#9CA3AF` (gray-400) at 0.3 | No | Most muted; past state. |

**Monitoring traffic light pattern** (for system health):
- **Healthy:** `#34D399` (emerald) -- systems operational
- **Degraded:** `#FBBF24` (amber) -- partial issues, attention needed
- **Down:** `#F87171` (red) -- system failure, action required
- **Unknown:** `#6B7280` (gray) -- no data / not monitored

### 2.3 Dark Theme Best Practices

Research across 20+ developer tools reveals these patterns:

**Background values:**
- **True black (`#000000`):** Vercel, some terminal emulators. High contrast, can feel stark. Works with OLED screens.
- **Near-black (`#0A-0F` range):** Linear (`#0A0A0B`), GitHub (`#0D1117`). Preferred by most premium tools.
- **Soft dark (`#10-18` range):** Raycast (`#18181B`), Grafana (`#181B1F`), Ark currently (`#101014`). Slightly softer.

**Key principles:**
1. **Blue-shift backgrounds for warmth:** Adding a slight blue or purple tint to dark backgrounds (e.g., `#101014` vs `#101010`) reduces harshness. Ark's current `#101014` already does this subtly.
2. **Never use pure white text on dark:** Use `#E8E8EC` (Ark's current choice) or similar off-white. Pure white (`#FFFFFF`) causes halation. Reserve pure white for interactive focus states.
3. **Contrast ratios:** WCAG AA requires 4.5:1 for body text, 3:1 for large text. For muted text, aim for at least 4.5:1 against background even though it appears "muted."
4. **Reduce blue light:** Warm up the palette slightly. Cool blues (`#60A5FA`) are fine for accents but avoid them as large-area background colors.
5. **Elevation through lightness, not shadow:** In dark mode, higher elements are lighter (not darker with shadow). Cards should be lighter than the page background. Ark does this correctly (`#1A1A20` card on `#101014` background).
6. **Border subtlety:** Borders should be barely visible -- just enough to delineate. `0.1-0.15` opacity of white works better than hard gray values. Ark's `#2A2A35` is good.

### 2.4 Light Theme Best Practices

Many developer tools treat light mode as secondary, but professionals who work in bright environments need it:

1. **Avoid pure white backgrounds:** Use `#FAFAFA` to `#F8F8FA` for main background (Ark uses `#FFFFFF` for page, `#F8F8FA` for cards -- swap these for reduced glare).
2. **Text should not be pure black:** Use `#1A1A2E` (Ark's current choice) or `#111827`. This reduces contrast to a comfortable level.
3. **Borders in light mode:** Lighter than most developers expect. `#E5E7EB` to `#E0E0E8` range.
4. **Primary accent:** Must pass AA contrast on white backgrounds. `#7C6AEF` at 3.38:1 on white fails AA for small text. Consider darkening to `#6C5CE7` (4.2:1) or `#5B4ADB` (5.1:1) for text use.
5. **Status colors must adapt:** Dark-mode emerald-400 on white background has low contrast. Use 600 variants in light mode.

### 2.5 Accent Color Analysis

**Current: `#7C6AEF` (purple)**

Purple is used by Linear, Stripe, Datadog, and many AI companies (Anthropic, OpenAI). It connotes intelligence, creativity, and premium quality.

**Alternative directions:**

| Color Direction | Hex Range | Connotation | Used By | Fit for Ark |
|----------------|-----------|-------------|---------|-------------|
| **Indigo-Purple** (current) | `#7C6AEF` | Intelligence, AI, premium | Linear, Stripe, Anthropic | Strong. Aligns with AI/agent space. |
| **Electric Blue** | `#3B82F6` to `#2563EB` | Trust, technology, speed | GitHub, Vercel (accent), Tailwind | Good. More "infrastructure" feel. |
| **Teal-Cyan** | `#06B6D4` to `#0891B2` | Clarity, monitoring, flow | Supabase, some observability tools | Good for orchestration metaphor (flow/water). |
| **Warm Violet** | `#8B5CF6` to `#7C3AED` | Creative, approachable AI | Figma, Warp | Warmer variant of current purple. |
| **Green-Emerald** | `#10B981` to `#059669` | Growth, automation, systems | Vercel (success), Railway | Connotes "autonomous" and "alive." |
| **Orange** | `#F59E0B` to `#EA580C` | Energy, alertness, distinctive | Grafana, Cloudflare | Distinctive but can conflict with warning/amber status. |

**Recommendation:** Stay with purple but refine it. `#7C6AEF` is a good hue. For a more distinctive identity, consider shifting slightly toward **indigo** (`#6366F1`) which separates Ark from Anthropic's violet while maintaining the AI/intelligence connotation. Alternatively, a **teal accent** (`#06B6D4`) as a secondary color pairs beautifully with purple and evokes "flow" and "orchestration."

### 2.6 Gradient Usage

**When gradients add value:**
- Brand moments: logo, empty states, onboarding
- Progress/status: a gradient bar showing flow progress (stage 1 -> 5)
- Data visualization: heatmaps, utilization gauges
- Hero numbers: total cost, active sessions count
- Background glow effects: subtle radial gradients behind active elements

**When gradients feel gimmicky:**
- Buttons (unless brand CTAs on marketing pages)
- Navigation elements
- Table rows
- Status badges
- Regular UI borders

**Recommended gradient palette:**

```css
/* Brand gradient -- marketing, hero moments, empty states */
--gradient-brand: linear-gradient(135deg, #7C6AEF 0%, #06B6D4 100%);

/* Subtle glow -- behind active cards, selected states */
--gradient-glow: radial-gradient(ellipse at center, rgba(124,106,239,0.08) 0%, transparent 70%);

/* Flow progress -- stage pipeline visualization */
--gradient-flow: linear-gradient(90deg, #7C6AEF 0%, #3B82F6 50%, #06B6D4 100%);

/* Cost/usage -- charts and meters */
--gradient-usage: linear-gradient(90deg, #34D399 0%, #FBBF24 60%, #F87171 100%);
```

### 2.7 Chart / Visualization Palette

Ark's current chart colors (`#82aaff`, `#c3e88d`, `#ffcb6b`, `#ff5370`, `#b4befe`, `#89ddff`, `#f78c6c`) are derived from Material Palenight -- a good starting point but lacks systematic design for accessibility.

**Recommended chart palette (8 colors, colorblind-safe order):**

```
1. #7C6AEF  (purple -- primary, brand color first)
2. #06B6D4  (cyan -- high contrast vs purple)
3. #F59E0B  (amber -- warm complement)
4. #EC4899  (pink -- distinct from purple and red)
5. #10B981  (emerald -- distinct from cyan)
6. #F97316  (orange -- distinct from amber)
7. #8B5CF6  (violet -- secondary purple)
8. #64748B  (slate -- for "other" category)
```

**Model-specific colors (Ark-tailored):**

```
opus:    #EC4899  (pink -- highest tier, premium feel)
sonnet:  #7C6AEF  (purple -- mid tier, brand color)
haiku:   #06B6D4  (cyan -- lightweight, fast)
gemini:  #3B82F6  (blue -- Google association)
codex:   #10B981  (green -- OpenAI association)
unknown: #64748B  (slate -- fallback)
```

---

## 3. Theme Proposals

### Theme A: "Midnight Circuit"

The default/signature theme. Deep blue-black backgrounds with purple-cyan accents.
Evokes neural networks and circuit boards. Premium and technical.

#### Dark Mode

```css
:root.midnight-circuit.dark {
  /* Backgrounds */
  --background:           #0C0C14;    /* Deep blue-black */
  --card:                 #14141E;    /* Raised surface */
  --popover:              #18182A;    /* Elevated popover */
  --sidebar:              #0A0A12;    /* Sidebar, slightly deeper */

  /* Foreground */
  --foreground:           #E4E4ED;    /* Primary text */
  --muted-foreground:     #7878A0;    /* Secondary text */

  /* Accent */
  --primary:              #7C6AEF;    /* Purple accent */
  --primary-foreground:   #FFFFFF;
  --ring:                 #7C6AEF;

  /* Semantic */
  --secondary:            #1E1E30;    /* Subtle backgrounds */
  --secondary-foreground: #E4E4ED;
  --accent:               #1E1E30;
  --accent-foreground:    #E4E4ED;
  --muted:                #1E1E30;

  /* Borders */
  --border:               #252540;    /* Purple-tinted border */
  --input:                #252540;

  /* Status */
  --destructive:          #E5484D;
  --destructive-foreground: #FFD2D3;

  /* Sidebar */
  --sidebar-border:       #1E1E35;
  --sidebar-accent:       #1A1A2C;
}
```

#### Light Mode

```css
:root.midnight-circuit {
  /* Backgrounds */
  --background:           #F8F8FC;    /* Slight purple tint */
  --card:                 #FFFFFF;
  --popover:              #FFFFFF;
  --sidebar:              #F0F0F8;

  /* Foreground */
  --foreground:           #1A1A2E;
  --muted-foreground:     #6B6B88;

  /* Accent */
  --primary:              #6C5CE7;    /* Slightly darker for contrast */
  --primary-foreground:   #FFFFFF;
  --ring:                 #6C5CE7;

  /* Semantic */
  --secondary:            #EDEDF5;
  --secondary-foreground: #1A1A2E;
  --accent:               #EDEDF5;
  --accent-foreground:    #1A1A2E;
  --muted:                #EDEDF5;

  /* Borders */
  --border:               #DCDCE8;
  --input:                #DCDCE8;

  /* Status */
  --destructive:          #E5484D;
  --destructive-foreground: #FFFFFF;

  /* Sidebar */
  --sidebar-border:       #E0E0EC;
  --sidebar-accent:       #E8E8F4;
}
```

### Theme B: "Arctic Slate"

Cool, minimal, Vercel-inspired. Near-monochrome with blue as the sole accent color.
Clean and professional. Feels like "infrastructure."

#### Dark Mode

```css
:root.arctic-slate.dark {
  /* Backgrounds */
  --background:           #09090B;    /* Near black, cool */
  --card:                 #111113;    /* Very subtle lift */
  --popover:              #18181B;
  --sidebar:              #09090B;

  /* Foreground */
  --foreground:           #EDEDF0;
  --muted-foreground:     #71717A;

  /* Accent */
  --primary:              #3B82F6;    /* Clean blue */
  --primary-foreground:   #FFFFFF;
  --ring:                 #3B82F6;

  /* Semantic */
  --secondary:            #1C1C20;
  --secondary-foreground: #EDEDF0;
  --accent:               #1C1C20;
  --accent-foreground:    #EDEDF0;
  --muted:                #1C1C20;

  /* Borders */
  --border:               #27272A;
  --input:                #27272A;

  /* Status */
  --destructive:          #EF4444;
  --destructive-foreground: #FEE2E2;

  /* Sidebar */
  --sidebar-border:       #1C1C20;
  --sidebar-accent:       #141416;
}
```

#### Light Mode

```css
:root.arctic-slate {
  /* Backgrounds */
  --background:           #FAFAFA;
  --card:                 #FFFFFF;
  --popover:              #FFFFFF;
  --sidebar:              #F4F4F5;

  /* Foreground */
  --foreground:           #18181B;
  --muted-foreground:     #71717A;

  /* Accent */
  --primary:              #2563EB;
  --primary-foreground:   #FFFFFF;
  --ring:                 #2563EB;

  /* Semantic */
  --secondary:            #F4F4F5;
  --secondary-foreground: #18181B;
  --accent:               #F4F4F5;
  --accent-foreground:    #18181B;
  --muted:                #F4F4F5;

  /* Borders */
  --border:               #E4E4E7;
  --input:                #E4E4E7;

  /* Status */
  --destructive:          #DC2626;
  --destructive-foreground: #FFFFFF;

  /* Sidebar */
  --sidebar-border:       #E4E4E7;
  --sidebar-accent:       #EAEAED;
}
```

### Theme C: "Warm Obsidian"

Warm dark palette with amber/gold accents. Feels approachable, "alive," and organic.
Inspired by Raycast's warmth and Warp's friendliness. Good for reducing eye strain
during long sessions.

#### Dark Mode

```css
:root.warm-obsidian.dark {
  /* Backgrounds */
  --background:           #0F0F0F;    /* Warm neutral black */
  --card:                 #191919;    /* Warm lift */
  --popover:              #1F1F1F;
  --sidebar:              #0C0C0C;

  /* Foreground */
  --foreground:           #EDEDED;
  --muted-foreground:     #878787;

  /* Accent */
  --primary:              #D4A847;    /* Warm gold */
  --primary-foreground:   #0F0F0F;
  --ring:                 #D4A847;

  /* Semantic */
  --secondary:            #1F1F1F;
  --secondary-foreground: #EDEDED;
  --accent:               #1F1F1F;
  --accent-foreground:    #EDEDED;
  --muted:                #1F1F1F;

  /* Borders */
  --border:               #2A2A2A;
  --input:                #2A2A2A;

  /* Status */
  --destructive:          #E54D4D;
  --destructive-foreground: #FFD6D6;

  /* Sidebar */
  --sidebar-border:       #222222;
  --sidebar-accent:       #171717;
}
```

#### Light Mode

```css
:root.warm-obsidian {
  /* Backgrounds */
  --background:           #FAF9F7;    /* Warm off-white */
  --card:                 #FFFFFF;
  --popover:              #FFFFFF;
  --sidebar:              #F5F4F0;

  /* Foreground */
  --foreground:           #1C1C1C;
  --muted-foreground:     #737373;

  /* Accent */
  --primary:              #B8922E;    /* Darker gold for contrast */
  --primary-foreground:   #FFFFFF;
  --ring:                 #B8922E;

  /* Semantic */
  --secondary:            #F0EFEB;
  --secondary-foreground: #1C1C1C;
  --accent:               #F0EFEB;
  --accent-foreground:    #1C1C1C;
  --muted:                #F0EFEB;

  /* Borders */
  --border:               #E0DFDB;
  --input:                #E0DFDB;

  /* Status */
  --destructive:          #DC2626;
  --destructive-foreground: #FFFFFF;

  /* Sidebar */
  --sidebar-border:       #E0DFDB;
  --sidebar-accent:       #EAE9E4;
}
```

### Theme Comparison Matrix

| Aspect | Midnight Circuit | Arctic Slate | Warm Obsidian |
|--------|-----------------|--------------|---------------|
| **Personality** | Premium AI, technical | Minimal, infrastructure | Warm, approachable |
| **Primary accent** | Purple `#7C6AEF` | Blue `#3B82F6` | Gold `#D4A847` |
| **Background undertone** | Blue-purple | Neutral cool | Warm neutral |
| **Closest to** | Linear, Stripe | Vercel, GitHub | Raycast, Warp |
| **Best for** | Default/brand | Users who prefer minimal | Long sessions, eye comfort |
| **Data visualization** | Purple-first palette | Blue-first palette | Gold-first palette |
| **Risk** | May blend with AI crowd | May feel generic | Gold can feel non-technical |

**Recommendation:** Use **Midnight Circuit** as the default. It is closest to Ark's current palette and aligns with the AI agent branding. Offer **Arctic Slate** as an alternative for users who prefer minimal aesthetics. Consider **Warm Obsidian** for future "comfort mode" or as an option for users with eye strain concerns.

---

## 4. Visual Identity Direction

### 4.1 Visual Metaphor: "Constellation / Neural Flow"

Agent orchestration needs a metaphor that conveys:
- **Multiplicity:** Many agents working in parallel
- **Connection:** Agents coordinated through flows and channels
- **Autonomy:** Agents operating independently within the system
- **Flow:** DAG-based progression through SDLC stages

**Recommended metaphor: Constellation / Neural Network**

This combines the "nodes and edges" of a DAG with the organic, intelligent feel of neural networks and star constellations. It avoids the overused "circuit board" pattern while still feeling technical.

**Visual language:**
- **Nodes** = agents/sessions (circles with status-colored dots)
- **Edges** = flow connections (thin lines, optionally animated)
- **Clusters** = related sessions or flow stages (subtle grouping)
- **Glow** = active/running state (subtle radial emanation from active nodes)
- **Pulse** = heartbeat/health (gentle animation on running agents)

**Where to use:**
- Session flow visualization (already exists -- stage pipeline)
- Empty states: constellation animation as a placeholder
- Loading states: nodes connecting animation
- Background texture: extremely subtle dot grid (like Linear's subtle grid)
- Logo mark: abstract constellation of 3-5 connected nodes

### 4.2 Competitor Visual Branding Analysis

| Product | Visual Metaphor | Brand Feel | Distinctive Element |
|---------|----------------|------------|---------------------|
| **Linear** | Speed/velocity | Sharp, fast, precise | Keyboard-first UX, speed animations |
| **Vercel** | Triangle/deployment | Minimal, confident | Black/white extremes, triangle logo |
| **Raycast** | Spotlight/search | Playful, fast, colorful | Rainbow gradients, command palette |
| **GitHub** | Octocat/social | Community, open | Mona mascot, contribution graph green |
| **Grafana** | Dashboard/panels | Data-dense, monitoring | Orange brand, dark panels |
| **Datadog** | Dog/monitoring | Friendly enterprise | Purple + dog mascot |

**Ark's opportunity:** No AI orchestration tool has established a strong visual identity yet. The "constellation" metaphor is unclaimed in this space and naturally maps to Ark's DAG-based flow architecture.

### 4.3 Making Dark Mode Warm vs Cold

**Cold/Technical (current Ark lean):**
- Blue-tinted backgrounds (`#101014` -- has blue in the hex)
- Cool gray text
- Blue/purple accents
- No warm colors except status (amber, red)

**To make it warmer:**
1. Add `0.5-1%` warmth to backgrounds: `#101014` -> `#111012` (add a tiny red/amber bias)
2. Use slightly warm grays for muted text: `#8888A0` -> `#888890`
3. Incorporate one warm accent (gold, amber, warm orange) for interactive elements
4. Use warm white for foreground: `#E8E8EC` -> `#EDECE8` (slight warm shift)
5. Add subtle warm gradient overlays to brand moments

**Recommended approach:** Keep the cool technical foundation but warm it slightly. A `#111014` background with `#E8E8EC` text is a sweet spot -- technical but not clinical.

---

## 5. Icon Style Recommendation

### 5.1 Analysis of Icon Approaches

| Style | Products Using It | Pros | Cons |
|-------|-------------------|------|------|
| **1px outlined** | Vercel, Linear | Minimal, elegant | Can be hard to see at small sizes |
| **1.5px outlined** | Lucide (current Ark), Radix | Good balance | The industry standard; safe choice |
| **2px outlined** | Heroicons, Feather | Bold, clear | Can feel chunky in dense UIs |
| **Filled** | Apple SF Symbols | Clear at small sizes | Heavier, can dominate layout |
| **Duo-tone** | Phosphor | Depth, distinctive | More complex, harder to maintain |

### 5.2 Recommendation

**Keep Lucide (1.5px outlined)** as the primary icon set. It is:
- Already integrated in Ark
- Comprehensive (1000+ icons)
- Consistent with the Inter + clean UI aesthetic
- 1.5px stroke is readable at the 14-16px sizes used in Ark's sidebar and buttons

**Enhancements:**
- Use **filled variants** for active/selected states in the sidebar (e.g., filled home icon when on dashboard)
- Use **16px icons** in the sidebar and toolbar (current standard)
- Use **14px icons** inline with text (table actions, status indicators)
- Use **20px icons** for empty states and feature callouts
- Color: Icons should be `currentColor` (inherit text color). Never color icons independently unless they are status indicators.

**Sidebar icon treatment:**
```
Inactive: text-muted-foreground (outline, 1.5px)
Hover:    text-foreground (outline, 1.5px)
Active:   text-primary (filled variant if available, or outline with bg highlight)
```

---

## 6. Implementation Notes

### 6.1 Current State Assessment

Ark's current design system is already well-structured:
- **CSS custom properties** for all colors (correct approach)
- **Tailwind `@theme inline`** for integration (modern approach)
- **Light/dark mode** via `.dark` class
- **Status colors** consistently applied through `StatusDot.tsx`
- **Inter + JetBrains Mono** is a solid foundation

### 6.2 Recommended Changes (Priority Order)

1. **Add `--font-mono-ui` variable** for Geist Mono (session IDs, costs, timestamps)
2. **Add type scale tokens** to the theme (`--text-2xs` through `--text-3xl`)
3. **Fix light mode primary contrast:** Darken `#7C6AEF` to `#6C5CE7` for light mode text usage
4. **Add status color CSS variables** instead of hardcoded Tailwind classes:
   ```css
   --status-running: #34D399;
   --status-waiting: #FBBF24;
   --status-completed: #60A5FA;
   --status-failed: #F87171;
   --status-stopped: var(--muted-foreground);
   ```
5. **Add chart color variables:**
   ```css
   --chart-1: #7C6AEF;
   --chart-2: #06B6D4;
   --chart-3: #F59E0B;
   --chart-4: #EC4899;
   --chart-5: #10B981;
   --chart-6: #F97316;
   --chart-7: #8B5CF6;
   --chart-8: #64748B;
   ```
6. **Refine dark background:** Consider `#0C0C14` (slightly deeper, more purple) for Midnight Circuit personality
7. **Add gradient variables** for brand moments and flow visualization

### 6.3 Font Loading Strategy

```html
<!-- Preload critical fonts -->
<link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/jetbrains-mono-var.woff2" as="font" type="font/woff2" crossorigin>

<!-- Optional: Geist Mono for UI monospace -->
<link rel="preload" href="/fonts/geist-mono-var.woff2" as="font" type="font/woff2" crossorigin>
```

Use `font-display: swap` for all fonts to prevent FOIT (flash of invisible text).
The variable font versions of Inter and JetBrains Mono are recommended -- single file,
all weights, smaller total payload than loading multiple static weights.

---

## 7. Sources & References

### Typography

- **Inter** by Rasmus Andersson: https://rsms.me/inter/ -- Design rationale and metrics documentation
- **Geist** by Vercel: https://vercel.com/font -- Font documentation and design philosophy
- **JetBrains Mono** by JetBrains: https://www.jetbrains.com/lp/mono/ -- Code font design specifics
- **Practical Typography** by Matthew Butterick: https://practicaltypography.com/ -- Line spacing, letter spacing guidelines
- **Type Scale** tool: https://typescale.com/ -- Interactive type scale calculator (minor third = 1.200)
- **Material Design Type System:** https://m3.material.io/styles/typography -- Google's type scale methodology

### Color Systems

- **Radix Colors:** https://www.radix-ui.com/colors -- Systematic color scales designed for dark/light mode with accessibility
- **Tailwind CSS Colors:** https://tailwindcss.com/docs/customizing-colors -- Industry-standard color scale (50-950)
- **Linear Design** (analysis): Linear.app UI studied for palette and application of indigo-purple
- **Vercel Design** (analysis): Vercel dashboard and v0.dev studied for monochrome approach
- **GitHub Primer Color System:** https://primer.style/foundations/color -- Comprehensive semantic color documentation
- **WCAG Contrast Guidelines:** https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html -- AA (4.5:1) and AAA (7:1) requirements

### Color Tools

- **Oklch Color Space:** https://oklch.com/ -- Perceptually uniform color space for generating palettes
- **Colorblind Simulator:** https://www.color-blindness.com/coblis-color-blindness-simulator/ -- Test chart palettes
- **Realtime Colors:** https://www.realtimecolors.com/ -- Preview color systems in context

### Design Systems

- **Shadcn/ui Themes:** https://ui.shadcn.com/themes -- CSS variable architecture (same pattern Ark uses)
- **Radix UI:** https://www.radix-ui.com/ -- Component primitives with built-in dark mode
- **Linear's design approach** discussed at Config 2023 and in their blog posts on quality and craft
- **Vercel's design philosophy** documented through Geist font release and v0 design system
- **Grafana's visualization palette:** https://grafana.com/docs/grafana/latest/panels-visualizations/ -- 24-color chart system

### Dark Mode Research

- **Apple HIG Dark Mode:** https://developer.apple.com/design/human-interface-guidelines/dark-mode -- Elevation through lightness
- **Material Design Dark Theme:** https://m3.material.io/styles/color/dark-theme -- Comprehensive dark mode guidelines
- **"Dark Mode vs. Light Mode" (NNGroup):** https://www.nngroup.com/articles/dark-mode/ -- Readability research

### Icon Systems

- **Lucide Icons:** https://lucide.dev/ -- 1.5px stroke outlined icon set (Ark's current choice)
- **Radix Icons:** https://www.radix-ui.com/icons -- 15x15 grid, 1px stroke, minimal
- **Phosphor Icons:** https://phosphoricons.com/ -- 6 weights including duo-tone
- **Heroicons:** https://heroicons.com/ -- Two variants (outline 1.5px, solid filled)

---

## Appendix A: Quick Reference -- Full Color Token Specification

### Semantic Color Tokens (theme-agnostic)

```css
/* Surface hierarchy (dark mode example) */
--surface-0: /* deepest background (page) */
--surface-1: /* raised (card, sidebar) */
--surface-2: /* elevated (popover, dropdown) */
--surface-3: /* highest (tooltip, dialog overlay) */

/* Text hierarchy */
--text-primary:   /* main readable text */
--text-secondary: /* descriptions, hints */
--text-tertiary:  /* placeholders, disabled */
--text-inverse:   /* text on primary-colored bg */

/* Interactive */
--interactive-default:  /* links, clickable text */
--interactive-hover:    /* hover state */
--interactive-active:   /* pressed/active state */
--interactive-focus:    /* focus ring */

/* Status (functional) */
--status-success:       /* running, healthy, passing */
--status-warning:       /* waiting, degraded, attention */
--status-error:         /* failed, down, critical */
--status-info:          /* completed, informational */
--status-neutral:       /* stopped, archived, inactive */

/* Data visualization (ordered for maximum distinguishability) */
--chart-1 through --chart-8
```

### Appendix B: Type Scale CSS Custom Properties

```css
@theme inline {
  /* Sans scale */
  --text-2xs: 0.625rem;   /* 10px */
  --text-xs:  0.6875rem;  /* 11px */
  --text-sm:  0.75rem;    /* 12px */
  --text-base: 0.8125rem; /* 13px */
  --text-md:  0.875rem;   /* 14px */
  --text-lg:  1rem;       /* 16px */
  --text-xl:  1.125rem;   /* 18px */
  --text-2xl: 1.375rem;   /* 22px */
  --text-3xl: 1.75rem;    /* 28px */

  /* Line heights */
  --leading-tight:   1.25;
  --leading-snug:    1.375;
  --leading-normal:  1.5;
  --leading-relaxed: 1.625;

  /* Letter spacing */
  --tracking-tighter: -0.025em;
  --tracking-tight:   -0.01em;
  --tracking-normal:  0;
  --tracking-wide:    0.01em;
  --tracking-wider:   0.04em;
  --tracking-widest:  0.08em;
}
```
