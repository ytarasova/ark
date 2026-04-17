# Ark Web Dashboard - Design Brief

## v0.dev Aesthetic Analysis

- Dark-first with very deep background (#09090b) and subtle card elevation (#111113 -> #18181b)
- Borders are ultra-subtle (white/5 to white/8) -- separation by elevation, not lines
- Cards use rounded-xl (12px+), generous p-6 padding, and subtle shadow-lg with low opacity
- Typography: tight letter-spacing for headings, generous line-height for body
- Accent colors are muted pastels (not saturated) with glow effects on status
- Hover states: smooth 200ms transitions, slight scale(1.01) or shadow lift
- Status indicators use colored dots with matching background tint + border
- Monospace for data/metrics, sans-serif for labels/descriptions
- Section headers are small uppercase tracked labels, never large headings
- Premium feel from whitespace (generous gaps between sections) + animation
- Sidebar: minimal, icon-tinted on active, thin accent bar instead of heavy bg
- No hard borders between sections -- use spacing and bg elevation instead
- Gradients used sparingly (primary accent glow, not rainbows)
- Charts use soft, desaturated palette matching the overall theme

## Current Ark UI Gaps

- Cards use rounded-lg (too small) and visible borders (too heavy)
- p-4 padding feels cramped -- v0 uses p-6
- Status colors are direct Tailwind classes (emerald-400, amber-400) -- no token system
- No hover lift/shadow transitions on cards
- No page-level consistency (each view hand-rolls its own header/empty/list)
- Sidebar active state uses border-l which is functional but not premium
- Missing: sparklines, stat cards, section cards, empty states as components
- Color values hardcoded throughout -- no single source of truth

## Design Tokens Approach

All colors, typography, spacing, and animation go through a single tokens file.
Components import tokens. Pages import components. Zero hardcoded colors in pages.
