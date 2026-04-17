# Plan: Update User Guide to Match Current State

## Summary

The user guide (`docs/guide.md`) is broadly accurate but has fallen behind on several fronts: the Goose runtime was added as a 5th runtime but the guide lists only 4; 5 new flow definitions exist (autonomous-sdlc, autonomous, brainstorm, conditional, docs) but the guide lists only 9; 2 new recipes exist (self-dogfood, self-quick) but the guide lists only 8; skills are now YAML files (not markdown); the web dashboard got a complete UI rebuild with a design system, pipeline visualization, and new pages (Login, DesignPreview, Tools); Tauri was removed in favor of Electron; and several minor details need correction.

## Files to modify/create

| File | Change |
|------|--------|
| `docs/guide.md` | Update all outdated sections (runtimes, flows, recipes, skills, web/desktop, goose references) |

No new files needed.

## Implementation steps

### 1. Section 1 (Quickstart) -- lines 36-67

- Update `ark flow list` comment from "9 builtin flows" to "14 builtin flows".
- The rest is accurate.

### 2. Section 3 (Flows) -- lines 161-226

- Update heading from "Builtin flows (9)" to "Builtin flows (14)".
- Add the 5 missing flows to the table:

| Name | Purpose |
|------|---------|
| `autonomous-sdlc` | Fully autonomous SDLC: plan -> implement -> verify -> review -> PR. All gates auto. |
| `autonomous` | Single agent, fully autonomous, auto-completes on agent report. |
| `brainstorm` | Explore ideas -> synthesize -> plan. Interactive ideation with human steering. |
| `conditional` | Conditional routing -- branch based on review outcome, converge at PR. |
| `docs` | Lightweight documentation flow: plan -> implement -> PR. No verify/review. |

### 3. Section 4 (Agents and Runtimes) -- lines 229-336

- Update "Runtimes (3 tools + 1 subscription variant)" heading to "Runtimes (4 tools + 1 subscription variant)".
- Add goose row to the runtime table:

| `goose` | Goose CLI (Block/AAIF) | api | goose (default model: claude-sonnet-4-6) |

- Add goose example usage:
  ```bash
  ark session start --repo . --summary "Fix tests" \
    --agent implementer --runtime goose --dispatch
  ```
- Update "Three executor types" to "Four executor types" and add the goose executor:
  - `goose` -- launches Goose CLI in tmux with worktree isolation.

### 4. Section 5 (Skills) -- lines 338-380

- Update description: skills are now **YAML files** (not markdown). The YAML contains `name`, `description`, `prompt`, and `tags` fields. The `prompt` field is what gets injected into the agent's system prompt.
- Fix the three-tier resolution paths from `.md` to `.yaml`: `.ark/skills/<name>.yaml`, `~/.ark/skills/<name>.yaml`, `skills/<name>.yaml`.

### 5. Section 6 (Recipes) -- lines 382-417

- Update "Builtin recipes (8)" to "Builtin recipes (10)".
- Add 2 new recipes to the table:

| `self-dogfood` | Dispatch an ark agent to work on the ark repo itself (full autonomous-sdlc). |
| `self-quick` | Quick single-agent dispatch against the ark repo (trivial tasks). |

### 6. Section 10 (Cost Tracking) -- lines 583-639

- Add goose to the transcript parser table. The goose runtime's billing section specifies `transcript_parser: goose`, so a `GooseTranscriptParser` exists. Add it to the table with an appropriate transcript location note.

### 7. Section 15 (Dashboards) -- lines 799-831

- **Web**: Update the description to reflect the new design system rebuild:
  - Mention the design system with theme tokens and component library.
  - Mention pipeline visualization with @xyflow/react and d3-dag for DAG flow rendering.
  - Mention the embedded web terminal for session attachment.
  - Mention the local folder picker for repository selection in session creation.
  - Update page list: Dashboard, Sessions, Agents, Flows, Compute, History, Memory, Tools, Schedules, Costs, Settings, Login.
- **Desktop**: Confirm Electron (Tauri was removed in v0.17.0). The current state is a self-contained Electron bundle. No Tauri references should remain.

### 8. Section 17 (MCP Integration) -- line 858

- Verify MCP configs list is still accurate: atlassian.json, figma.json, github.json, linear.json. (Confirmed correct.)

### 9. Appendix: Common tasks cheat sheet -- lines 1023-1053

- Add goose runtime example.
- Add self-dogfood recipe example.

## Testing strategy

- **Manual review**: Read through the updated guide end-to-end to verify all counts, names, and descriptions match the actual filesystem.
- **Cross-reference**: Verify every flow name in the table matches a file in `flows/definitions/`.
- **Cross-reference**: Verify every recipe name matches a file in `recipes/`.
- **Cross-reference**: Verify every runtime name matches a file in `runtimes/`.
- **Cross-reference**: Verify skill file extension claim (.yaml) matches `skills/` directory contents.
- **Formatting**: Run `make format` to ensure Prettier compliance.
- **Lint**: Run `make lint` to ensure no lint warnings.

## Risk assessment

- **Low risk**: This is a documentation-only change. No code is modified.
- **Accuracy**: The main risk is stating something incorrectly about a feature. Mitigate by reading actual YAML definitions and source code rather than guessing.
- **Staleness**: The guide may go stale again quickly. Counts like "14 builtin flows" will drift as new flows are added.

## Open questions

1. **GooseTranscriptParser location**: The goose runtime specifies `transcript_parser: goose`. Need to verify where `GooseTranscriptParser` reads transcripts from before documenting the exact path in the cost tracking section. Check `packages/core/` for the implementation.
2. **DesignPreviewPage**: Is this a user-facing page or a dev-only page? If dev-only, omit it from the guide's page list.
3. **LoginPage**: The login page is likely only relevant for hosted/remote mode. The guide should clarify when users see it.
