# DAG Visualization Library Evaluation for Ark

**Date:** 2026-04-15
**Purpose:** Select a React library for visualizing Ark's flow pipelines -- agent orchestration DAGs with stages, conditions, fan-out/converge patterns.

## Requirements

1. DAG rendering -- stages as nodes, directed edges with arrows
2. Conditional edges -- labels showing conditions ("if approved", "if rejected")
3. Fan-out/parallel -- one node to N nodes, then converge
4. Auto-layout -- automatic node positioning (LR or TB)
5. Custom node rendering -- React components showing agent name, model, status, duration, cost
6. Custom edge rendering -- labels, animated dashed lines for active edges
7. Interactive -- click to expand, pan, zoom
8. Dark theme compatible
9. TypeScript first-class
10. Reasonable bundle size
11. Actively maintained (commit within 3 months)
12. MIT or permissive license (no commercial license required)

---

## Tier 1: Full Rendering Libraries

### @xyflow/react (React Flow 12)

- **npm:** @xyflow/react
- **Weekly downloads:** ~4,800,000
- **GitHub stars:** ~35,000 (xyflow/xyflow monorepo)
- **Last update:** 2026-03-27 (v12.10.2)
- **Bundle size:** 178 kB min / 57 kB gzip
- **License:** MIT (fully free for commercial use; "Pro" is optional support tier with example access, not gated features)
- **Auto-layout:** No built-in. Requires dagre or elkjs as separate dependency.
- **Custom nodes:** Yes -- full React components
- **Custom edges:** Yes -- full React components with labels, animations
- **Interactive (pan/zoom/click):** Yes -- built-in
- **TypeScript:** Yes -- first-class, ships types
- **Dark theme:** Yes -- CSS classes, full control
- **Ark fit:** 5/5
- **Pros:** Dominant ecosystem. Massive community. Excellent docs. Battle-tested in production at hundreds of companies. Plugin ecosystem. The `@xyflow/react` package is the v12 rename of the old `reactflow` package. Works with elkjs or dagre for auto-layout. Custom nodes/edges are just React components -- perfect for rich agent cards. Actively maintained with frequent releases.
- **Cons:** No built-in auto-layout (need elkjs or d3-dag alongside). 57 kB gzip is not tiny but acceptable. Learning curve for advanced customization.

### @antv/g6

- **npm:** @antv/g6
- **Weekly downloads:** ~196,000
- **GitHub stars:** ~12,000
- **Last update:** 2026-03-30 (v5.1.0)
- **Bundle size:** ~300-400 kB gzip (estimated; bundlephobia API timed out, but v5 is a large framework)
- **License:** MIT
- **Auto-layout:** Yes -- multiple built-in layout algorithms including dagre, force, tree, circular, grid
- **Custom nodes:** Yes -- canvas-based custom nodes; React nodes via @antv/g6-react-node
- **Custom edges:** Yes -- custom edge shapes and labels
- **Interactive (pan/zoom/click):** Yes -- built-in
- **TypeScript:** Yes -- v5 is TypeScript-first
- **Dark theme:** Yes -- theme system
- **Ark fit:** 3/5
- **Pros:** Built-in auto-layout (no extra dependency). Rich out-of-the-box features. Good for complex graph analysis. WebGL rendering for large graphs. Backed by Ant Group.
- **Cons:** Canvas/WebGL-based, not DOM -- React node support is a wrapper, not native. Documentation is primarily Chinese with English translations of varying quality. Significantly larger bundle. Smaller Western community. API is more imperative than declarative-React. Overkill for Ark's use case.

### @antv/x6

- **npm:** @antv/x6
- **Weekly downloads:** ~69,000
- **GitHub stars:** ~6,500
- **Last update:** 2026-03-18 (v3.1.7)
- **Bundle size:** ~200-300 kB gzip (estimated)
- **License:** MIT
- **Auto-layout:** Yes -- built-in DAG layout, plus dagre integration
- **Custom nodes:** Yes -- HTML/React custom nodes
- **Custom edges:** Yes -- SVG custom edges with labels
- **Interactive (pan/zoom/click):** Yes
- **TypeScript:** Yes
- **Dark theme:** Yes -- theme support
- **Ark fit:** 3/5
- **Pros:** Specifically designed for DAG diagrams, ER diagrams, flowcharts. SVG + HTML rendering (DOM-based, good for React). Built-in layout.
- **Cons:** Same Chinese-first documentation issue as G6. Smaller ecosystem than React Flow. React integration via @antv/x6-react-shape plugin. Less community momentum in the West.

### reagraph

- **npm:** reagraph
- **Weekly downloads:** ~27,000
- **GitHub stars:** ~1,500
- **Last update:** 2026-02-02 (v4.30.8)
- **Bundle size:** 1,318 kB min / 367 kB gzip
- **License:** Apache-2.0
- **Auto-layout:** Yes -- built-in force-directed and hierarchical layouts
- **Custom nodes:** Limited -- WebGL-based, customization through props not full React components
- **Custom edges:** Limited -- edge styling through props
- **Interactive (pan/zoom/click):** Yes -- 3D and 2D modes
- **TypeScript:** Yes
- **Dark theme:** Yes -- theme prop
- **Ark fit:** 2/5
- **Pros:** Beautiful 3D graph rendering. Smart defaults. Good for network visualization.
- **Cons:** Massive bundle (367 kB gzip). WebGL-based -- cannot use full React components as nodes. Designed for network/relationship graphs, not workflow DAGs. 3D is overkill. Apache-2.0 (permissive but not MIT).

### Mermaid

- **npm:** mermaid
- **Weekly downloads:** ~6,600,000
- **GitHub stars:** ~75,000+
- **Last update:** 2026-04-01 (v11.14.0)
- **Bundle size:** 624 kB min / 150 kB gzip
- **License:** MIT
- **Auto-layout:** Yes -- uses dagre internally
- **Custom nodes:** No -- text-based definitions only, rendered as SVG
- **Custom edges:** No -- limited to Mermaid's built-in edge styles
- **Interactive (pan/zoom/click):** No built-in. Requires wrapper libraries (e.g., mermaidcn) for basic pan/zoom. No node click handlers.
- **TypeScript:** Yes -- ships types
- **Dark theme:** Yes -- built-in themes
- **Ark fit:** 1/5
- **Pros:** Extremely popular. Text-to-diagram is great for docs and markdown. Zero config.
- **Cons:** Not interactive. Cannot use React components as nodes. Cannot click to expand node details. Cannot animate individual edges. It renders static SVG from a text DSL -- fundamentally wrong tool for an interactive dashboard. Large bundle for what you get.

### Rete.js

- **npm:** rete
- **Weekly downloads:** ~40,000
- **GitHub stars:** ~12,000
- **Last update:** 2025-06-30 (v2.0.6)
- **Bundle size:** ~50 kB gzip (core only; plugins add more)
- **License:** MIT
- **Auto-layout:** Via plugin (uses elkjs)
- **Custom nodes:** Yes -- React components via react-plugin
- **Custom edges:** Yes
- **Interactive (pan/zoom/click):** Yes
- **TypeScript:** Yes -- TypeScript-first in v2
- **Dark theme:** Yes -- CSS
- **Ark fit:** 2/5
- **Pros:** Modular plugin architecture. Good for visual programming / node editors. Small core.
- **Cons:** Designed for visual programming (data-flow editors with input/output ports), not DAG pipeline visualization. Last release was June 2025 -- 10 months old; react-plugin updated Dec 2025. More complex setup than React Flow for a simpler use case. Overkill complexity for read-only DAG display.

### Flume

- **npm:** flume
- **Weekly downloads:** ~230
- **GitHub stars:** ~1,600
- **Last update:** 2025-11-05 (v1.2.0)
- **Bundle size:** 108 kB min / 30 kB gzip
- **License:** MIT
- **Auto-layout:** No
- **Custom nodes:** Yes -- but through Flume's port/type system, not arbitrary React
- **Custom edges:** Limited
- **Interactive (pan/zoom/click):** Yes
- **TypeScript:** No -- JS with no shipped types (open issue requesting TS support)
- **Dark theme:** Via CSS
- **Ark fit:** 1/5
- **Pros:** Small bundle. Simple API for node editors.
- **Cons:** Designed for business logic extraction (node-based programming), not DAG visualization. No TypeScript. Effectively abandoned (230 downloads/week). No auto-layout. Wrong abstraction for pipeline visualization.

---

## Tier 2: Layout Algorithms (used WITH a renderer)

### elkjs (Eclipse Layout Kernel)

- **npm:** elkjs
- **Weekly downloads:** ~1,870,000
- **GitHub stars:** ~800 (kieler/elkjs)
- **Last update:** 2026-03-03 (v0.11.1)
- **Bundle size:** 1,416 kB min / 423 kB gzip (full); ~160 kB gzip (web worker optimized build)
- **License:** EPL-2.0 (Eclipse Public License -- permissive, compatible with MIT projects)
- **What it does:** Sophisticated graph layout engine. Supports layered (Sugiyama), force, tree, and many more algorithms. Produces x/y coordinates for nodes and edge bend points.
- **Ark fit as layout engine:** 4/5
- **Pros:** Best auto-layout quality. Handles complex DAGs, fan-out/converge, and edge routing beautifully. Left-to-right and top-to-bottom. Well-documented layout options. Actively maintained. Pairs perfectly with React Flow.
- **Cons:** Huge bundle (transpiled from Java via GWT). Must run in web worker for performance. EPL-2.0 is permissive but not MIT. Async API adds complexity.

### dagre

- **npm:** dagre
- **Weekly downloads:** ~1,730,000
- **GitHub stars:** ~5,600 (dagrejs/dagre)
- **Last update:** 2019-12-03 (v0.8.5) -- UNMAINTAINED since 2019
- **Bundle size:** ~30 kB gzip (estimated)
- **License:** MIT
- **What it does:** Directed graph layout. Produces node positions for Sugiyama-style layouts.
- **Ark fit as layout engine:** 3/5
- **Pros:** Tiny bundle. Simple API. Battle-tested (used by Mermaid, many React Flow examples). Synchronous.
- **Cons:** Unmaintained since 2019 -- no bug fixes, no improvements. Limited layout options compared to elkjs. Edge routing is basic. Still works but frozen in time. A Google engineer reportedly revived it somewhat, but no new npm releases.

### d3-dag

- **npm:** d3-dag
- **Weekly downloads:** ~36,000
- **GitHub stars:** ~1,500
- **Last update:** 2026-04-14 (v1.2.1) -- updated yesterday
- **Bundle size:** ~15-20 kB gzip (estimated; described as "a fraction of elkjs")
- **License:** MIT
- **What it does:** DAG-specific layout algorithms: Sugiyama (layered), Zherebko (topological), Grid. ILP-optimal crossing minimization.
- **Ark fit as layout engine:** 4/5
- **Pros:** Tiny bundle. Actively maintained. TypeScript-first with generics. Specifically designed for DAGs (not general graphs). Superior layout quality to dagre for DAG use cases. MIT license. Can replace dagre as React Flow's layout engine.
- **Cons:** Smaller community than dagre/elkjs. Requires writing integration code to use with React Flow (no drop-in example in React Flow docs, but straightforward). D3 ecosystem conventions (functional, method-chaining).

---

## Libraries to Skip

| Library | Reason |
|---------|--------|
| **reactflow** (old npm name) | Deprecated. Use `@xyflow/react` instead. Same library, new name as of v12. |
| **Mermaid** | Static SVG renderer from text DSL. No interactivity, no custom React nodes. Wrong tool. |
| **reagraph** | WebGL/3D focus. 367 kB gzip. Cannot use React components as nodes. Network viz, not DAG pipelines. |
| **Flume** | Abandoned (230 downloads/week). No TypeScript. Wrong abstraction (logic editor, not DAG viz). |
| **Rete.js** | Visual programming framework. Overkill complexity for read-only DAG display. Stale-ish releases. |
| **dagre** | Unmaintained since 2019. Use d3-dag or elkjs instead for layout. |
| **Svelvet** | Svelte-only. No React support. |

---

## Recommendation

### 1. Best Overall: @xyflow/react + d3-dag

**@xyflow/react** (React Flow 12) is the clear winner for rendering. It is the dominant React graph/flow library with 35k stars, 4.8M weekly downloads, MIT license, active development, and first-class support for everything Ark needs: custom React node components, custom animated edges, pan/zoom/click, and dark theme via CSS. The "Pro" tier is optional support -- the core library is fully MIT with no feature gating.

Pair it with **d3-dag** for auto-layout. d3-dag is MIT, tiny (~15-20 kB gzip), actively maintained (updated April 2026), TypeScript-first, and purpose-built for DAG layouts. It produces better DAG layouts than dagre and is a fraction of elkjs's bundle size.

**Total bundle cost:** ~57 kB (React Flow) + ~18 kB (d3-dag) = ~75 kB gzip.

**Implementation approach:**
1. Define Ark flow stages as React Flow nodes with custom components (agent card showing name, model, status, duration, cost)
2. Define edges with custom labels for conditions ("if approved") and animated styles for active edges
3. Use d3-dag's Sugiyama layout to compute node positions (left-to-right)
4. Pass computed positions to React Flow for rendering
5. Handle click events on nodes to show detail panels

### 2. Best Lightweight Alternative: @xyflow/react + dagre

If d3-dag's functional API feels awkward, dagre still works fine despite being unmaintained. It is battle-tested, tiny (~30 kB gzip), and every React Flow tutorial uses it. The lack of maintenance is a risk but not a blocker -- the layout algorithm is stable and unlikely to need updates.

**Total bundle cost:** ~57 kB + ~30 kB = ~87 kB gzip.

### 3. Best If Auto-layout Quality Is Critical: @xyflow/react + elkjs

If Ark's DAGs become very complex (deep nesting, many crossing edges), elkjs produces the highest-quality layouts with sophisticated edge routing. But the bundle cost is steep (423 kB gzip). Use the web worker build and dynamic import to avoid blocking the main thread.

**Total bundle cost:** ~57 kB + ~160 kB (worker) = ~217 kB gzip.

### 4. Avoid

- **@antv/g6 and @antv/x6** -- capable libraries but Chinese-first documentation, canvas/imperative API, and unnecessary complexity for Ark's use case.
- **Everything else evaluated** -- wrong tool, abandoned, or overkill (see skip table above).

---

## Summary Matrix

| Library | Downloads/wk | Stars | Bundle (gzip) | License | Auto-layout | Custom Nodes | TS | Maintained | Ark Fit |
|---------|-------------|-------|---------------|---------|-------------|-------------|-----|-----------|---------|
| @xyflow/react | 4.8M | 35k | 57 kB | MIT | needs plugin | Yes (React) | Yes | Yes | 5/5 |
| @antv/g6 | 196k | 12k | ~350 kB | MIT | built-in | Canvas | Yes | Yes | 3/5 |
| @antv/x6 | 69k | 6.5k | ~250 kB | MIT | built-in | HTML/React | Yes | Yes | 3/5 |
| reagraph | 27k | 1.5k | 367 kB | Apache | built-in | WebGL | Yes | Yes | 2/5 |
| Rete.js | 40k | 12k | ~50 kB | MIT | via plugin | Yes (React) | Yes | Stale | 2/5 |
| Mermaid | 6.6M | 75k+ | 150 kB | MIT | built-in | No | Yes | Yes | 1/5 |
| Flume | 230 | 1.6k | 30 kB | MIT | No | Limited | No | Dead | 1/5 |
| **Layout engines** | | | | | | | | | |
| elkjs | 1.9M | 800 | 423 kB | EPL-2 | N/A | N/A | Yes | Yes | 4/5 |
| dagre | 1.7M | 5.6k | ~30 kB | MIT | N/A | N/A | No | Dead | 3/5 |
| d3-dag | 36k | 1.5k | ~18 kB | MIT | N/A | N/A | Yes | Yes | 4/5 |

**Verdict: Use `@xyflow/react` + `d3-dag`. Install both, total ~75 kB gzip, MIT licensed, actively maintained, and purpose-built for exactly what Ark needs.**
