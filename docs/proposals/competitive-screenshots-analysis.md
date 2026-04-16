# Competitive Product Screenshot Analysis

Captured April 2026. All screenshots at 1440x900 viewport.

---

## 1. Linear

**URL:** https://linear.app
**Screenshot:** `screenshots/linear-landing.png`

| Element | Value |
|---------|-------|
| Background | #0A0A0B (near-black), gradient to deep charcoal |
| Font | Inter (custom variant, "Linear Sans" in some contexts) |
| Card radius | 8px |
| Border | 1px solid rgba(255,255,255,0.06) -- barely visible |
| Accent color | #5E6AD2 (indigo/violet for brand), yellow for favorites |
| Density | Dense -- three-pane layout with sidebar, issue list, detail |

**What makes it special:** The dark UI feels like a native macOS app, not a web page. Status indicators use small colored dots (green=in progress, yellow=warning) rather than badges. The three-pane layout (sidebar / issue list / issue detail) wastes zero space. Inline code blocks in issue descriptions use a subtle monospace treatment with slightly lighter background. The nav sidebar uses very muted text (~40% opacity) that brightens on hover, keeping visual noise minimal.

**What Ark should steal:**
- The barely-visible 1px borders on panels -- they separate content without creating visual weight
- Status dot + label pattern (colored circle + "In Progress" text) for session/agent status
- Sidebar category labels ("AUTONOMOUS-SDLC", "QUICK") in very small, muted uppercase -- mirrors how Linear shows workspace sections

---

## 2. Vercel

**URL:** https://vercel.com
**Screenshot:** `screenshots/vercel-landing.png`

| Element | Value |
|---------|-------|
| Background | #FFFFFF (pure white), with subtle warm gradient overlay in hero |
| Font | Geist Sans (custom), clean geometric sans-serif |
| Card radius | 12px |
| Border | 1px solid #EAEAEA (light gray hairline) |
| Accent color | #000000 (black CTAs), rainbow gradient for hero prism |
| Density | Sparse -- generous whitespace, centered layout |

**What makes it special:** Vercel's landing page uses a striking rainbow gradient prism as the hero focal point against pure white -- bold but restrained. CTAs are solid black with white text, creating maximum contrast without color. The nav uses dropdown menus with category icons. Typography is large and confident. The "Start Deploying" button uses inverted colors (white on black) while "Get a Demo" uses ghost style (border only).

**What Ark should steal:**
- The two-button CTA pattern: primary (filled black) + secondary (ghost/outline) for key actions
- Geist-style clean typography with generous letter-spacing in headings

---

## 3. Raycast

**URL:** https://raycast.com
**Screenshot:** `screenshots/raycast-landing.png`

| Element | Value |
|---------|-------|
| Background | #000000 (true black) with 3D abstract art |
| Font | Inter or custom sans-serif, tight leading |
| Card radius | 12-16px |
| Border | None visible -- relies on background contrast |
| Accent color | #FF6363 (coral red, from 3D art), subtle cyan in UI |
| Density | Sparse on landing -- hero-focused with bold typography |

**What makes it special:** The 3D rendered abstract art (red/coral metallic chevrons on black) creates an immediately distinctive visual identity. No other dev tool looks like this. The nav bar sits flat on pure black with no separator line. Download buttons use a frosted glass treatment (backdrop-filter blur). The hero text "Your shortcut to everything" uses very large, bold type. Category nav (Pro, AI, Teams, etc.) sits inline in the top bar, making the product's scope clear immediately.

**What Ark should steal:**
- Bold, abstract hero visuals rather than product screenshots -- creates intrigue
- The frosted glass button treatment for secondary actions (backdrop-filter: blur)
- Pure black (#000) background rather than near-black -- more dramatic contrast

---

## 4. Warp

**URL:** https://warp.dev
**Screenshot:** `screenshots/warp-landing.png`

| Element | Value |
|---------|-------|
| Background | #0F0F13 (very dark blue-black) |
| Font | Custom sans-serif (likely GT Walsheim or similar) |
| Card radius | 12px |
| Border | 1px solid rgba(255,255,255,0.1) on product cards |
| Accent color | #7B61FF (purple) for CTAs, white for text |
| Density | Medium -- two product cards side by side |

**What makes it special:** Warp shows two distinct products (Terminal and Oz) as side-by-side cards in the hero, each with its own screenshot and CTA. This is smart product architecture communication. The purple accent is used sparingly -- only for the "Deploy" CTA button and active states. Product screenshots are embedded in realistic window chrome, making them feel native. The banner at top announcing new features uses a subtle gradient background.

**What Ark should steal:**
- Side-by-side product cards when showcasing multiple capabilities (e.g., Sessions vs Flows)
- Purple accent for primary CTAs -- it stands out on dark backgrounds without feeling corporate
- Realistic window chrome around product screenshots

---

## 5. Cursor

**URL:** https://cursor.com
**Screenshot:** `screenshots/cursor-landing.png`

| Element | Value |
|---------|-------|
| Background | #F5F0EB (warm off-white / parchment) |
| Font | System serif for tagline, sans-serif for UI elements |
| Card radius | 8-12px |
| Border | 1px solid #E0D8CF (warm gray) |
| Accent color | #000000 (black for CTAs), warm tones throughout |
| Density | Medium -- product screenshot dominates center |

**What makes it special:** Cursor breaks the "dark mode dev tool" convention with a warm, parchment-toned background. The hero shows an actual product screenshot with a painted landscape desktop wallpaper visible, making it feel personal and lived-in rather than sterile. The tagline uses a serif font ("Built to make you extraordinarily productive") which is unusual in dev tools and adds gravitas. The product UI in the screenshot shows a chat panel with file references, making the AI integration tangible.

**What Ark should steal:**
- The courage to use warm/light backgrounds -- not every dev tool needs to be dark
- Showing a realistic, lived-in product screenshot rather than a sanitized mock
- Serif font for key marketing copy to differentiate from the sea of sans-serif dev tools

---

## 6. GitHub

**URL:** https://github.com/vercel/next.js
**Screenshots:** `screenshots/github-repo.png`, `screenshots/github-issues.png`, `screenshots/github-pr-diff.png`, `screenshots/github-actions.png`

| Element | Value |
|---------|-------|
| Background | #FFFFFF (white, light mode default) |
| Font | -apple-system, Segoe UI, system font stack |
| Card radius | 6px |
| Border | 1px solid #D1D9E0 (cool gray) |
| Accent color | #1F6FEB (blue for links), #238636 (green for merged), #CF222E (red for closed) |
| Density | Very dense -- information-heavy, data tables |

**What makes it special:** GitHub's design is not "pretty" -- it is functional. Every pixel serves a purpose. The repository page packs file tree, stats (stars, forks, issues), branch selector, and contributor info into a single viewport. Issue labels use colorful pills with readable text. PR pages show status with a clear merged/open/closed badge using strong semantic colors. The Actions page uses a left sidebar for workflow filtering with status icons (green check, red X, yellow dot) that are instantly scannable.

**What Ark should steal:**
- Semantic color system: green (#238636) for success, red (#CF222E) for failure, yellow (#DBAB0A) for in-progress -- these exact colors are universally understood
- The dense but scannable table layout for lists (issues, workflows) -- icon + title + labels + metadata in one row
- Status icons in the Actions sidebar (green checkmark, red X, yellow spinner) -- simple, universal
- Colorful label pills for categorization

---

## 7. Supabase

**URL:** https://supabase.com
**Screenshot:** `screenshots/supabase-landing.png`

| Element | Value |
|---------|-------|
| Background | #171717 (dark charcoal, not pure black) |
| Font | Custom sans-serif (likely based on Inter) |
| Card radius | 8px |
| Border | 1px solid rgba(255,255,255,0.05) on cards |
| Accent color | #3ECF8E (emerald green -- the Supabase brand) |
| Density | Sparse -- centered hero, generous whitespace |

**What makes it special:** The emerald green accent is used with surgical precision -- only on the second line of the hero text ("Scale to millions") and the primary CTA button. Everything else is white on dark. The hero has no product screenshot, just typography and the two CTAs (filled green + ghost outline). Customer logos are displayed in a muted monochrome row. The simplicity is the statement -- it communicates confidence.

**What Ark should steal:**
- Single accent color used with extreme discipline -- one brand color, everywhere else is neutral
- The "hero text with one colored line" pattern draws the eye to the value prop
- Ghost button variant (white text, white border, transparent fill) for secondary CTAs

---

## 8. Railway

**URL:** https://railway.com
**Screenshot:** `screenshots/railway-landing.png`

| Element | Value |
|---------|-------|
| Background | #13111C (deep purple-black) with illustrated sky gradient |
| Font | Custom geometric sans-serif |
| Card radius | 8-12px |
| Border | Subtle, near-invisible |
| Accent color | #7C5CFC (medium purple) for Deploy CTA |
| Density | Sparse -- hero-focused with illustrated background |

**What makes it special:** Railway uses illustrated backgrounds (a painted dusk/night sky with clouds and stars) rather than abstract gradients or solid colors. This creates an emotional, almost whimsical feel that is rare in infrastructure tooling. The "Ship software peacefully" tagline paired with the serene sky illustration is thematically cohesive. Below the hero, a dashboard preview is embedded in a dark panel, showing the actual deployment interface.

**What Ark should steal:**
- The illustrated/artistic background approach -- it makes infrastructure feel approachable
- Embedding a real dashboard preview below the hero fold, in context
- The purple CTA color with slight rounded pill shape

---

## 9. Neon

**URL:** https://neon.com (redirected from neon.tech)
**Screenshot:** `screenshots/neon-landing.png`

| Element | Value |
|---------|-------|
| Background | #0A0A0A (near-black) with green/cyan data visualization art |
| Font | Custom sans-serif, bold headings |
| Card radius | 8px |
| Border | Minimal, uses contrast separation |
| Accent color | #00E599 (neon green -- brand color) |
| Density | Medium -- hero with customer logos immediately below |

**What makes it special:** The hero background features abstract bar-chart-like vertical lines in green and cyan, evoking database activity or data visualization. This is thematically perfect for a database product. Customer logos (DoorDash, BCG, Retool, Meta) appear immediately under the fold, establishing enterprise credibility fast. The two CTAs use contrasting styles: "Get started" is filled (green), "Read the docs" is ghost (outline). The banner at the very top promotes a feature update.

**What Ark should steal:**
- Data-visualization-inspired background art that subtly communicates what the product does
- Top-of-page announcement banner for feature releases (subtle, dismissible)
- Immediate customer logo strip below the fold

---

## 10. v0 by Vercel

**URL:** https://v0.app (redirected from v0.dev)
**Screenshot:** `screenshots/v0-landing.png`

| Element | Value |
|---------|-------|
| Background | #FFFFFF (pure white) |
| Font | Geist Sans (same as Vercel) |
| Card radius | 12px |
| Border | 1px solid #E5E5E5 (light gray) |
| Accent color | #000000 (black), minimal color |
| Density | Medium -- chat input + template grid |

**What makes it special:** v0 is the most minimal product in this set. The landing page IS the product -- a chat input ("Ask v0 to build...") with template suggestions below. No hero text, no marketing copy beyond the question "What do you want to create?" The template cards use screenshot thumbnails with title + stats (views, forks). Quick-action chips below the input ("Contact Form", "Image Editor", "Mini Game") make the product self-explanatory without explanation.

**What Ark should steal:**
- The "landing page IS the product" pattern -- put the session launcher front and center
- Quick-action chips/suggestions below the main input for common workflows
- Template gallery with usage stats for flows/recipes

---

## 11. Open Agents

**URL:** https://open-agents.dev
**Screenshot:** `screenshots/open-agents-landing.png`

| Element | Value |
|---------|-------|
| Background | #FFFFFF (white) with #F5F5F5 (light gray) for product preview section |
| Font | System sans-serif, bold display for heading |
| Card radius | 8-12px |
| Border | 1px solid #E0E0E0 (light gray) |
| Accent color | #000000 (black for primary CTA) |
| Density | Sparse -- clean hero with product preview below |

**What makes it special:** Open Agents uses the same dark-on-light pattern as v0 with very bold, large display text for "Open Agents." The product preview below shows a session interface with chat bubbles, file references, and a sessions sidebar. The design is deliberately minimal -- just text, two CTAs ("Sign in with Vercel" + "Open Source"), and the product preview. Breadcrumb navigation in the preview (open-agents / feat/auth-flow / Auth flow) communicates the git-aware nature of the tool.

**What Ark should steal:**
- The breadcrumb pattern showing project / branch / session name -- this is exactly Ark's model
- File reference pills in chat messages (the rounded chips showing file paths)
- The clean session sidebar with time elapsed per session

---

## Cross-Product Patterns and Themes

### The Dark Mode Default
8 of 11 products use dark backgrounds (Linear, Raycast, Warp, Supabase, Railway, Neon, and partially GitHub/Cursor). Developer tools signal "for developers" through dark themes. The exceptions (Cursor, v0, Open Agents) use white backgrounds to signal accessibility and approachability.

### Typography as Identity
- **Linear**: Clean, tight, functional
- **Cursor**: Serif for headlines (differentiator)
- **Supabase**: One green line among white -- the accent IS the brand
- **Railway**: Whimsical tagline + illustration cohesion

### The Single Accent Color Rule
The best products use ONE accent color and use it sparingly:
- Supabase: emerald green
- Neon: neon green
- Railway: purple
- Warp: purple
- Linear: indigo

### Card Borders: The Invisible Art
Modern dev tools use borders that are barely visible -- `rgba(255,255,255,0.05)` to `0.1` on dark backgrounds. The border exists to create structure but should never draw attention.

### Status Indicators
- **GitHub**: Colored dots + semantic labels (most effective)
- **Linear**: Small colored dots with text labels
- **Railway/Vercel**: Check/X icons with color
- Pattern: `[colored dot/icon] + [text label]` is universal

### Data Density Spectrum
- Sparse: Supabase, Railway, Raycast (marketing-first)
- Medium: Linear, Cursor, Warp, v0 (product-forward)
- Dense: GitHub (information-first)
- Ark should target Medium-Dense -- show the product working, not marketing fluff

---

## Recommendations for Ark

### Immediate Wins
1. **Single accent color**: Pick one (the existing purple/violet works) and use it only for active states, primary CTAs, and key status indicators
2. **Barely-visible borders**: Use `rgba(255,255,255,0.06)` for panel separators on dark backgrounds
3. **Status dot system**: Green dot = running, yellow dot = waiting, red dot = failed, gray dot = stopped
4. **Dense three-pane layout** like Linear: session list (left) / session detail (center) / metadata panel (right)

### Design Language
5. **Background**: #0A0B0F or similar near-black (not pure #000 unless going for Raycast-level drama)
6. **Font**: Inter or Geist Sans -- both are industry standard for dev tools
7. **Card radius**: 8px (matches Linear, GitHub -- not too rounded, not too sharp)
8. **Border treatment**: 1px solid with very low alpha -- never more than rgba(255,255,255,0.1)

### Landing Page
9. **Show the product working** in the hero (like Linear, Open Agents) -- a real session with agents running
10. **Two CTAs**: "Launch Session" (filled) + "View Docs" (ghost)
11. **Quick-start chips** below the input for common flows (like v0's template suggestions)

### Differentiators to Explore
12. **Data visualization background** (like Neon) showing real-time agent activity -- sessions as data streams
13. **Flow stage breadcrumbs** (plan -> implement -> verify -> review -> merge) prominently in the UI, inspired by Linear's status pipeline
14. **File reference pills** in chat messages (like Open Agents) for showing which files agents touched
