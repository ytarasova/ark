# PR #154 Design Review Findings

## Rating: 8/10

Strong foundation. The spec is comprehensive, opinionated, and implementation-ready. The mockups are polished and demonstrate real product thinking. The research is thorough. The main issues are contrast failures in the "faint" text tier, missing light-mode adaptations in the mockups, and several spec gaps around edge cases. Fixing the items below will make this a solid basis for the React implementation.

---

## Critical Issues (must fix before implementation)

### C1. `--fg-faint` fails WCAG AA across all themes

The "faint" text color is used for timestamps, session card times, pipeline arrows, model labels, tool call icons, keyboard shortcut hints, and search placeholders. Measured contrast ratios against their backgrounds:

| Theme            | fg-faint  | Background | Ratio  | Required        |
| ---------------- | --------- | ---------- | ------ | --------------- |
| Midnight Circuit | `#4A4A6A` | `#0C0C14`  | 2.30:1 | 4.5:1 (AA body) |
| Arctic Slate     | `#3F3F46` | `#09090B`  | 1.91:1 | 4.5:1           |
| Warm Obsidian    | `#4A4A4A` | `#0F0F0F`  | 2.16:1 | 4.5:1           |

Even for "decorative" elements, 3:1 is needed for UI components (WCAG 1.4.11). These values fail even that threshold except for Midnight Circuit at 2.30:1.

**Fix:** Lighten `--fg-faint` to at least 3:1 for decorative/icon use, and never use it for readable text. Timestamps, model labels, and keyboard hints should use `--fg-muted` instead.

### C2. Arctic Slate `--fg-muted` is borderline

At 4.12:1 on the background, `--fg-muted` in Arctic Slate passes for large text (3:1) but fails AA for normal body text (4.5:1 required). This token is used for secondary text that is definitely body-sized (12-13px).

**Fix:** Lighten Arctic Slate `--fg-muted` from `#71717A` to `#8A8A93` (approximately 5.1:1).

### C3. Light mode user message bubble does not adapt

In light mode, the user message `.message.user-msg .message-body` uses `--bg-card` (#FFFFFF) with a `--border` border, but the text inside remains `--fg` (#1A1A2E on #FFFFFF = fine). However, the inline code snippets inside messages use `--bg-card` for their background -- on a surface that is already `--bg-card`, the code becomes invisible (no contrast between the inline code background and the message bubble background).

**Fix:** Add a dedicated `--bg-code` token that adapts properly in both modes, or use `--bg-hover` / `--secondary` for inline code backgrounds.

### C4. Events/Diff/Todos tab panels are placeholder stubs

Three of five tab panels contain only "will render here" placeholder text. These are the tabs operators will use most after Conversation. The mockup should show at minimum a skeleton/wireframe of the intended content to validate the layout.

**Fix:** Add realistic content to the Events timeline (6-8 structured events with icons and timestamps), Diff tab (a simple file list with add/remove stats), and Todos tab (3-5 todo items with checkboxes and status).

---

## Important Issues (should fix)

### I1. Spec does not define empty states

Section 11 lists what the spec does NOT cover, but empty states are not in that list -- they are simply absent. The design system research doc (Section 16) defines empty states thoroughly, but the main spec never references it. Operators will see empty states on first use, when no sessions exist, when search returns nothing, and when Events/Diff/Todos are empty for a new session.

**Fix:** Add a Section 9.5 or equivalent defining the empty state pattern: icon (40px muted) + title + description + CTA button. Reference the content table from the research doc.

### I2. No loading/skeleton states shown in mockups

The spec mentions skeleton screens (Section 8.2) but no mockup demonstrates them. The session list, conversation view, and tab content all need skeleton states. Without them, developers will improvise (or use spinners, which the spec explicitly discourages).

**Fix:** Add a "Loading" variant screenshot or CSS class to the mockup showing skeleton placeholders in the session list.

### I3. Spec type scale conflicts with research doc type scale

The main spec (Section 4.2) defines `text-xs` as 10px. The research doc (Appendix B) defines `text-xs` as 11px (0.6875rem) and uses `text-2xs` for 10px. The research doc type scale has 9 steps; the spec has 6. These are contradictory and will confuse implementers.

**Fix:** Align the spec to the research doc's 9-step scale, or explicitly state which scale is authoritative. The 6-step scale in the spec is cleaner and sufficient for initial implementation.

### I4. Chat input visible on non-Conversation tabs

In the mockup, the chat input area is always visible at the bottom, even when viewing Terminal, Events, Diff, or Todos tabs. The chat input is only relevant on the Conversation tab. Showing it on other tabs wastes vertical space and creates confusion about where input goes.

**Fix:** The chat input should only render when the Conversation tab is active. On other tabs, the full height should be available for content.

### I5. No tooltip implementation on icon rail

The spec says tooltips appear on hover for icon rail buttons, but the mockup has `title` attributes (browser-native tooltips) instead of styled custom tooltips matching the design system. Native tooltips have inconsistent styling, delay, and positioning across browsers.

**Fix:** Note in the spec that Radix Tooltip should be used for icon rail tooltips, styled with `--bg-popover` and the design system's type scale.

### I6. List panel width is fixed, not resizable

The spec describes the list panel as "280-400px, resizable" with `react-resizable-panels`, but the mockup uses a fixed `width: 300px` with no drag handle. This means the resizing interaction cannot be evaluated.

**Fix:** Add a visual drag handle (1px border that highlights to 4px on hover) between the list panel and detail panel in the mockup CSS.

### I7. No "failed" chip in filter chips

The session list shows `7 running`, `2 waiting`, `12 completed` as filter chips, but there is no `1 failed` chip despite a failed session (s-m3n4) being in the list. Failed sessions are the most urgent and most likely to be filtered for.

**Fix:** Add a `failed` chip with appropriate red styling.

### I8. Warm Obsidian gold accent on primary-fg is dark text on dark bg

Warm Obsidian sets `--primary-fg: #0F0F0F` (dark text on gold buttons). This is correct for the gold button, but the `+ New` button in the list panel inherits `--primary-fg` for its text. When looking at the mockup, this works, but the contrast of #0F0F0F on #D4A847 is 8.66:1 -- good. However, the "Send" button in the chat area uses `color: #fff` hardcoded, not `var(--primary-fg)`. In Warm Obsidian, this means white text on gold, which is 1.88:1 -- fails AA.

**Fix:** Change `.chat-send` color from `#fff` to `var(--primary-fg)` in all theme mockups.

### I9. Spec does not specify the Cmd+B (toggle list panel) behavior

Section 8.1 lists `Cmd+B` to "Toggle list panel" but never specifies what "toggle" means: does it collapse to 0px? Animate to 0? Remember last width? Is there a collapsed state with just session IDs?

**Fix:** Add a brief description: "Cmd+B collapses the list panel to 0px width with a 200ms animation. The collapsed state removes the panel entirely. Width is restored to the previously stored value on re-toggle."

---

## Minor Issues (nice to fix)

### M1. Geist Mono may not load from Google Fonts

The mockups load fonts via `https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&...`. As of April 2026, Geist Mono is available on Google Fonts, but the `Geist+Mono` family name should be verified. If it fails, the mockups fall back to JetBrains Mono (which is fine but defeats the purpose of showing the dual-mono system).

### M2. Session card height exceeds 52px spec

The spec says session cards are 52px height. The mockup cards contain 3 rows (top, summary, bottom) plus padding, making them approximately 68-72px. Either the spec should update to the actual height or the cards should be compressed.

### M3. The `--ease-linear` CSS variable name is misleading

The variable `--ease-linear` is set to `cubic-bezier(0.32, 0.72, 0, 1)` -- this is Linear's easing curve, not a linear easing. The name will confuse developers who expect CSS `linear` timing. Rename to `--ease-default` or `--ease-ark`.

### M4. Command palette has a hardcoded light-mode background

The `.cmd-dialog` uses `--bg-card` for its background, which works in dark mode but in light mode the overlay behind it uses `--bg-overlay: rgba(0,0,0,0.3)` which is quite light. The palette could benefit from a subtle shadow in light mode.

### M5. No focus ring visible on interactive elements

The spec (Section 9) mandates "2px ring in primary color on all interactive elements via focus-visible:ring-2" but the mockup CSS has no `:focus-visible` styles on buttons, tabs, session cards, or the search input (only the search input has a `:focus` border-color change). This is an accessibility gap.

**Fix:** Add `:focus-visible` outline/ring styles to all interactive elements in the mockup CSS.

### M6. Pipeline arrow uses `&rsaquo;` HTML entity

The pipeline arrows between stages use `&rsaquo;` (right single angle quotation mark). This is semantically incorrect -- it's punctuation, not an arrow. Use an SVG chevron-right icon (consistent with Lucide) or a proper arrow character.

### M7. The spec recommends oklch but mockups use hex everywhere

Section 3.6 says "oklch for new tokens" and the research doc provides oklch values. The mockups and spec token tables all use hex. This creates ambiguity about which format to use in implementation.

**Fix:** Pick one: either provide oklch equivalents in the spec tables or defer oklch migration to post-v1 and remove the recommendation.

### M8. No hover state on cost detail tooltip

The cost tooltip in the session header appears on hover (`:hover` CSS), which does not work on touch devices and has no keyboard-accessible equivalent. The cost detail should use Radix Popover with click/focus trigger in the React implementation.

### M9. Product flow mockups use different icon sets

The 3 theme mockups use hand-drawn Lucide SVGs (24x24 viewBox). The product-flow and prd-flow mockups use Heroicons (24x24 viewBox, different path data). The spec says "Lucide at 15px, 1.5px stroke." The mockups should be consistent.

---

## Strengths (what works well)

1. **Conversation view is excellent.** The visual hierarchy (user message > agent prose > tool calls > stage transitions) is clear and comfortable to read. The tool call blocks are compact and informative. The code block rendering with file path and line range headers is professional.

2. **Three-theme system is well-designed.** All three themes feel like the same product. Color token architecture is clean -- only the values change, not the structure. Midnight Circuit is the clear hero. Arctic Slate is appropriately minimal. Warm Obsidian's gold accent is distinctive without being gimmicky.

3. **Session list panel is dense and scannable.** The 52px-ish cards pack status dot, ID, time, summary, mini pipeline, agent name, and cost into a small footprint. The mini pipeline bars are a brilliant touch -- you can see flow progress without opening the session.

4. **Session header packs maximum information.** Status dot, ID, summary, full pipeline, cost (with hover breakdown), and action buttons in a single 48px row. The itemized cost tooltip (token vs compute) is a unique differentiator.

5. **Product flow mockups extend the design system beautifully.** The stage sidebar, blocker cards, checklist items, metrics grid, acceptance criteria blocks, and feature backlog table demonstrate that the design system works beyond SDLC flows. The PRD flow with collapsible tree navigation is particularly well-executed.

6. **Meta row with integration pills and progress bar** (from v0 feedback) adds context without clutter. The "Open in Claude" / "Terminal" runtime launcher buttons are immediately useful.

7. **Command palette works.** Cmd+K opens, Escape closes, items are categorized with shortcut hints. The styling matches the design system.

8. **Keyboard shortcuts are comprehensive and work.** j/k navigation, 1-5 tab switching, / for search focus, Cmd+K for command palette -- all implemented in the mockup JavaScript.

9. **Research depth is exceptional.** The competitor analysis covers 11 products with genuine insight. The typography research justifies every font choice with evidence. The orchestration UX patterns doc is a goldmine of patterns that the spec correctly adopted or explicitly rejected.

10. **Spec is opinionated and decisive.** It says what NOT to do (no gradients on buttons, no pulsing animation, no text > 20px, max 2 hues per view). These anti-patterns will prevent scope creep during implementation.

---

## Recommendations

1. **Create a "kitchen sink" mockup page** that renders every component variant (all button sizes/variants, all badge states, all status dots, empty states, skeleton loading, error states, tooltips, dropdowns). This becomes the visual regression reference during React implementation.

2. **Add a narrow viewport variant** to the mockup. At 1024px, the session header is already cramped. Define the responsive breakpoint behavior: at what width does the list panel auto-collapse? At what width does the pipeline hide? The spec says "desktop-only" but even desktop windows can be narrow.

3. **Specify the session card click/selection animation.** The spec mentions "brief highlight (`bg-primary/5`) fading over 2s" for new items but does not specify the click feedback for selecting a session card. The mockup has instant background change -- should there be a transition?

4. **Add error state to the conversation view.** What does a failed tool call look like? The mockup only shows successful tool calls (green checkmarks). Show at least one red X with an error message to validate the error styling.

5. **Specify the grid view layout** mentioned in Section 6.3. The spec describes it but no mockup exists. This is a key differentiator for fleet monitoring and should be prototyped before implementation.

6. **Consider adding a "Live" indicator** to the session header or tab bar, as recommended in the orchestration UX research. The spec mentions it in Section 8.4 but it does not appear in any mockup.
