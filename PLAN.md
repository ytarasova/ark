# PLAN: Documentation Completeness Pass for v0.14.0 Release

## Summary

Update all user-facing documentation to reflect the current state of Ark v0.14.0. The primary issues are: the TUI now has 10 tabs (Events tab added at position 3, shifting all subsequent tabs), there are 5 runtimes (Goose missing from most docs), 13 flows on disk (4 undocumented), and the agents-reference omits 7 SDLC agents. Additionally, the CHANGELOG incorrectly states the Events tab key is `4` when the source code shows it's `3`.

## Files to modify/create

| # | File | Change |
|---|------|--------|
| 1 | `CHANGELOG.md` | Fix Events tab key from `4` to `3`; finalize Unreleased section header for v0.14.0 |
| 2 | `README.md` | Update "9 tabs" to "10 tabs" (line 102); update "4 runtimes" to "5 runtimes" + add Goose (lines 56, 113); update "9 flow definitions" to "13 flow definitions" + add missing flows (line 114-115) |
| 3 | `docs/tui-reference.md` | Update "9 tabs" to "10 tabs" (line 5); add Events tab section; update ALL tab numbers (Events=3, Flows=4, Compute=5, History=6, Memory=7, Tools=8, Schedules=9, Costs=0); update global shortcuts table |
| 4 | `docs/tui.html` | Update "9 tabs" to "10 tabs" (line 60); add Events tab to tab list with key 3; renumber all subsequent tabs |
| 5 | `docs/quickstart.html` | Update "9 tabs" to "10 tabs" (line 88); add Events to tab list; renumber |
| 6 | `docs/cli.html` | Update "9 tabs" to "10 tabs" (line 63); add Events to tab list; renumber |
| 7 | `docs/index.html` | Fix "9 tabs" at lines 374 and 424; fix "4 runtimes" at line 389; all to reflect 10 tabs, 5 runtimes |
| 8 | `docs/architecture.html` | Update SVG text "9 tabs" to "10 tabs" (line 96) |
| 9 | `docs/comparison-goose.html` | Update "9 tabs" to "10 tabs" (line 88) |
| 10 | `docs/guide.md` | Update "9 tabs" to "10 tabs" (line 822); update tab list to include Events |
| 11 | `docs/flows-reference.md` | Add 4 missing flows: autonomous, autonomous-sdlc, brainstorm, conditional |
| 12 | `docs/agents-reference.md` | Add 7 missing SDLC agents: ticket-intake, spec-planner, plan-auditor, task-implementer, verifier, closer, retro; add Goose to runtime overrides section (line 171) |
| 13 | `docs/roadmap.html` | Fix "4 runtimes" to "5 runtimes" + add Goose (line 117); fix "9 flow definitions" to "13 flow definitions" (line 119) |
| 14 | `docs/runtimes-reference.html` | Add Goose runtime section if missing |
| 15 | `CLAUDE.md` | Update "10 flow definitions" to "13 flow definitions" (line 102); add brainstorm, conditional, autonomous-sdlc to flow list; update TUI Keyboard Shortcuts section tab numbering |

## Implementation steps

### Step 1: Fix CHANGELOG.md
- Change `(key \`4\`)` to `(key \`3\`)` in the Unreleased section Events tab entry (line 6)
- Optionally rename `## Unreleased` to `## v0.14.0 (2026-04-13)` if release is being cut now

### Step 2: Update tab counts and numbering across all docs
For every file that says "9 tabs", update to "10 tabs" and ensure the Events tab is listed at position 3 with key `3`. The full tab order (from `packages/tui/components/TabBar.tsx:8-21`) is:

```
1:Sessions  2:Agents  3:Events  4:Flows  5:Compute  6:History  7:Memory  8:Tools  9:Schedules  0:Costs
```

Files to update (search for "9 tab" case-insensitive):
- `README.md:102` -- "(9 tabs)" in architecture tree
- `docs/tui-reference.md:5` -- tab list + all tab-specific sections need renumbering
- `docs/tui.html:60`
- `docs/quickstart.html:88`
- `docs/cli.html:63`
- `docs/index.html:374,424`
- `docs/architecture.html:96`
- `docs/comparison-goose.html:88`
- `docs/guide.md:822`

### Step 3: Update docs/tui-reference.md global shortcuts and tab sections
Replace the global shortcuts table with corrected tab numbers:

| Key | Action |
|-----|--------|
| `1` | Switch to Sessions tab |
| `2` | Switch to Agents tab |
| `3` | Switch to Events tab |
| `4` | Switch to Flows tab |
| `5` | Switch to Compute tab |
| `6` | Switch to History tab |
| `7` | Switch to Memory tab |
| `8` | Switch to Tools tab |
| `9` | Switch to Schedules tab |
| `0` | Switch to Costs tab |

Add a new "## Events Tab (3)" section between "Agents Tab (2)" and what is now "Flows Tab (4)". Read `packages/tui/tabs/EventsTab.tsx` for actual shortcuts. Renumber all subsequent tab section headers (Flows from 3->4, Compute from 4->5, History from 5->6, Memory from 6->7, Tools from 7->8, Schedules from 8->9, Costs from 9->0).

### Step 4: Update runtime counts
Replace "4 runtimes" with "5 runtimes" and add Goose to runtime lists in:
- `README.md:56` -- feature table row: add ", Goose" after Gemini
- `README.md:113` -- architecture tree: "5 runtime definitions (claude, claude-max, codex, gemini, goose)"
- `docs/index.html:389` -- "5 runtimes (Claude, Claude Max, Codex, Gemini, Goose)"
- `docs/roadmap.html:117` -- "5 runtimes: Claude, Claude Max, Codex, Gemini, Goose"
- `docs/agents-reference.md:171` -- add `goose` to "Built-in runtimes" list

### Step 5: Update flow counts
Replace flow counts with the actual 13 flows on disk:
- `README.md:114-115` -- "13 flow definitions (default, quick, bare, autonomous, autonomous-sdlc, parallel, fan-out, pr-review, dag-parallel, islc, islc-quick, brainstorm, conditional)"
- `CLAUDE.md:102` -- "13 flow definitions (...)" with full list
- `docs/roadmap.html:119` -- "13 flow definitions"

### Step 6: Add missing flows to docs/flows-reference.md
Read the YAML definitions for each missing flow and add documentation sections:
- `flows/definitions/autonomous.yaml` -- add "autonomous" section
- `flows/definitions/autonomous-sdlc.yaml` -- add "autonomous-sdlc" section
- `flows/definitions/brainstorm.yaml` -- add "brainstorm" section
- `flows/definitions/conditional.yaml` -- add "conditional" section

Each section should follow the existing format: description, stage diagram, stage table, "Best for" note, and example CLI command.

### Step 7: Add missing agents to docs/agents-reference.md
Read the YAML definitions for each missing agent and add documentation sections. Add a new "## SDLC Pipeline Agents" heading between "Claude Code Agents" and "CLI Agents":
- `agents/ticket-intake.yaml`
- `agents/spec-planner.yaml`
- `agents/plan-auditor.yaml`
- `agents/task-implementer.yaml`
- `agents/verifier.yaml`
- `agents/closer.yaml`
- `agents/retro.yaml`

Each section follows the existing format: description, field table (Model, Max turns, Tools, Memories, Context), system prompt summary, and "Used by flows" note.

### Step 8: Add Goose to docs/agents-reference.md runtime overrides
Update the "Runtime Overrides" section (around line 171) to list `goose` alongside claude, claude-max, codex, gemini. Add a Goose runtime example command.

### Step 9: Check and update docs/runtimes-reference.html
Read the file. If Goose is missing, add a section covering: native executor type, recipe dispatch (`--recipe`/`--sub-recipe`/`--params`), channel MCP via `--with-extension`, `api` billing mode, `goose` transcript parser.

### Step 10: Update CLAUDE.md
- Line 102: "10 flow definitions" -> "13 flow definitions", add autonomous-sdlc, brainstorm, conditional to the parenthetical list
- TUI Keyboard Shortcuts section (around line 166): verify tab numbers match actual source (Events should not appear since CLAUDE.md only documents Sessions tab shortcuts -- but if tab numbers are referenced elsewhere in CLAUDE.md, update them)

### Step 11: Final verification grep
Run these greps to confirm zero stale references remain in user-facing docs:
```bash
grep -rn "9 tab" docs/ README.md --include="*.md" --include="*.html"
grep -rn "4 runtime" docs/ README.md --include="*.md" --include="*.html"
grep -rn "10 flow" CLAUDE.md README.md docs/ --include="*.md" --include="*.html"
```

## Testing strategy

1. **Grep verification**: After all edits, grep for "9 tab", "4 runtime", "10 flow" across all `.md` and `.html` files -- zero matches expected.
2. **Tab count audit**: Confirm `packages/tui/components/TabBar.tsx` TABS array length (10) matches documented count.
3. **Flow count audit**: `ls flows/definitions/*.yaml | wc -l` should return 13, matching documented count.
4. **Agent count audit**: `ls agents/*.yaml | wc -l` should return 12, matching documented count.
5. **Runtime count audit**: `ls runtimes/*.yaml | wc -l` should return 5, matching documented count.
6. **Link check**: Verify internal doc links still resolve (especially `guide.md#...` anchors).
7. **HTML spot-check**: Open `docs/index.html` in browser and visually confirm tab count, runtime count, and flow count in the hero section and feature cards.
8. **CHANGELOG accuracy**: Confirm Events tab key matches `TabBar.tsx` line 14: `events: "3"`.

## Risk assessment

- **Low risk overall**: Documentation-only changes with no code modifications.
- **Tab renumbering is the highest-impact change**: Users who memorized shortcuts will notice the shift. Docs must match the source of truth (`TabBar.tsx`).
- **Flow count discrepancy**: CLAUDE.md says 10 flows but 13 exist on disk. All 13 have YAML files in `flows/definitions/`, so they should all be documented.
- **No breaking changes**: Documentation corrections don't affect runtime behavior.

## Open questions

1. **v0.14.0 release date**: Should CHANGELOG `## Unreleased` be renamed to `## v0.14.0 (2026-04-13)` now? The version bump commit (`5f1b35c`) already landed.
2. **Goose runtime maturity**: Is Goose considered GA for v0.14.0 or experimental? Affects how prominently it's documented.
3. **Events tab shortcuts**: Need to read `packages/tui/tabs/EventsTab.tsx` to determine what shortcuts the Events tab exposes before writing its section in tui-reference.md.
4. **Aider runtime**: `docs/ROADMAP.md:108` mentions "Aider" as a runtime but no `aider.yaml` exists in `runtimes/`. Should the roadmap reference be corrected to remove Aider, or is an Aider runtime planned?
