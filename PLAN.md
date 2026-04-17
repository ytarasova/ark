# Plan: Review and Update CHANGELOG.md

## Summary

Add a new `v0.18.0` section to `CHANGELOG.md` covering the 30 commits since the `v0.17.0` tag. These commits represent a major web UI redesign (design system, pipeline visualization, component rewrites), security hardening, DI container refactoring, and numerous bug fixes. The existing changelog entries are accurate and need no corrections.

## Files to modify/create

- `CHANGELOG.md` -- insert new `## v0.18.0 (2026-04-17)` section between `# Changelog` (line 1) and `## v0.17.0` (line 3)

## Implementation steps

### 1. Insert `## v0.18.0 (2026-04-17)` section

Edit `CHANGELOG.md` at line 3, adding the following subsections before `## v0.17.0`. Write in the project's existing style: bold lead descriptions, no commit hashes, grouped by category.

#### Web UI Redesign
- **Design system**: theme tokens (CSS custom properties) and core component library (#156)
- **Pipeline visualization**: DAG viewer using @xyflow/react + d3-dag for flow stage rendering (#158)
- **Design system migration**: all pages migrated to new design system, legacy components removed (#159)
- **Chart restyling**: removed animations, theme-aware colors, custom tooltips (#160)
- **Complete UI rebuild**: all views rebuilt to match design mockups (#161)
- **New Session form**: rich dropdowns for agent/flow/compute selection, decluttered session list
- **Compute page rewrite**: live system metrics (CPU, memory, disk) with real-time updates
- **Rich event details**: Events tab with expandable rows showing full event payloads
- **Conversation tab**: rich event details, live tool call display, smart typing indicator
- **Diff viewer**: unified diff rendering wired into SessionDetail Diff tab
- **Channel messages in conversation**: channel messages rendered inline, DAG wired into FlowsView
- **UI polish**: theme persistence, icon rail labels, dispatch retry, skeleton loading, clickable stages, dashboard attention center, aria labels
- **Component splitting**: large components decomposed, useEffect cleanup fixes (#168)
- **Daemon awareness**: offline warnings, block session creation when daemon is down, deduplicated conversation, filter chips

#### Security
- **Path traversal prevention**: block directory traversal in arkd file endpoints
- **ArkD auth hardening**: require auth token for all arkd API calls
- **Exec restrictions**: limit executable commands in agent sandbox
- **Webhook HMAC**: verify webhook payload signatures (#166)

#### Architecture
- **DI container formalization**: complete Cradle type covering all AppContext dependencies (#164)

#### Code Quality
- **Utility deduplication**: single `now()` function, descriptive catch blocks, missing `.catch()` handler (#167)
- **Agent launch safety**: Claude settings + hooks written before agent launch
- **PR action fix**: stage completion + session show + agent name display
- **Autonomous mode**: properly overrides question-asking behavior
- **Session recovery**: clear stale error on completion, recover stuck sessions
- **Branch sanitization**: remove commas and special characters from branch names (#133)
- **Agent/runtime fixes**: agent dropdown, model input, goose integration (#134)

#### Testing
- **Web UI tests**: unit + e2e tests for UI rebuild covering themes, conversation, and pipeline visualization

#### Documentation
- **User guide sync**: updated for goose runtime, new flows, recipes, web redesign (#162)
- **Codebase review report**: comprehensive architecture and quality analysis (#163)
- **Guide fixes**: session statuses, skill format, CLI count corrections (#165)
- **Design system spec**: web UI design system documentation, mockups, v0 research (#154)
- **Pipeline mockups**: DAG viewer + flow editor design documents (#157)

#### CI
- **Remove Windows desktop build**: dropped Windows CI target entirely
- **TUI cleanup**: remove remaining TUI references from forward-looking docs (#119)

### 2. Run formatting

```bash
make format
make lint
```

## Testing strategy

- Visual review: compare the new section against `git log v0.17.0..HEAD --oneline` to ensure no commits are missed
- `make format && make lint` must pass
- No code changes, so `make test` is not needed

## Risk assessment

- **Low risk**: changelog-only change, no code impact
- **Version number**: using v0.18.0 as the next minor version -- judgment call since there's no version file to cross-check. If a different version is preferred, only the section header needs updating.
- **Date**: using today's date (2026-04-17) since these changes are unreleased

## Open questions

None -- proceeding with v0.18.0 based on commit volume and major web UI redesign scope.
