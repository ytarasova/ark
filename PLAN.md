# Plan: Comprehensive CHANGELOG.md overhaul

## Summary

The existing CHANGELOG.md covers v0.9.0 through v0.12.0 in detail but leaves v0.1.0 through v0.8.0 as a one-line stub ("Previous release") and is missing v0.13.0 and unreleased changes (v0.13.0..HEAD). This plan fills in all missing version entries by mining the git history for each tagged release, and adds an Unreleased section at the top for post-v0.13.0 work.

## Files to modify/create

| File | Change |
|------|--------|
| `CHANGELOG.md` | Rewrite to include all 14 versions (v0.1.0 through v0.13.0) plus an Unreleased section. Backfill v0.1.0--v0.8.0, add v0.13.0, add Unreleased. Preserve existing v0.9.0--v0.12.0 content. |

## Implementation steps

### 1. Add Unreleased section (top of file, after `# Changelog`)

Add a section for commits after v0.13.0 (currently ~35 commits). Group by theme:

```
## Unreleased

### TUI
- **Events tab**: moved Events panel from session detail to its own dedicated tab (key `4`)
- **Virtual scrolling**: replaced custom ScrollBox with ink-scroll-view, extracted useVirtualScroll hook with AvailableHeightContext for proper height management
- **TreeList rewrite**: proper tree component with key-based selection, stable group headers
- **Selection stability**: selection stays stable after delete/archive, resets on group-by toggle
- **Layout fixes**: SplitPane content height via AvailableHeightContext, collapsed EventLog single-line

### Developer Experience
- **Hot-reload dev targets**: `make dev-daemon` and `make dev-arkd` for auto-restart on file changes
- **Dev mode checks**: `dev-tui` and `dev-web` check for running daemon before starting
- **Makefile cleanup**: renamed `make tui` to `tui-standalone`, clarified target descriptions

### Fixes
- **Action stages**: await safeAsync for action stages in mediateStageHandoff
- **Auto-PR dedup**: create_pr action skips if PR already exists
- **Message read state**: mark messages as read when session reaches terminal state
- **Costs tab**: accessible via key `0`
```

### 2. Add v0.13.0 section

Covers commits from v0.11.0..v0.13.0 (~50 commits). Key themes:

```
## v0.13.0 (2026-04-13)

### Daemon-Client Architecture
- **Server daemon**: TUI connects as thin WebSocket client to server daemon (port 19400)
- **Unified settings**: renamed writeHooksConfig to writeSettings (Claude settings bundle)

### Flow Engine
- **Action stage chaining**: consecutive action stages (create_pr + auto_merge) chain correctly
- **Auto-merge CI wait**: auto_merge waits for CI checks before completing session
- **DAG flow edges**: depends_on creates implicit graph-flow edges
- **Process tree tracking**: executor tracks process tree when launching agents

### Worktree Enhancements
- **Copy globs**: worktree.copy glob list for syncing untracked files
- **Setup script**: worktree.setup script for post-creation initialization

### Infrastructure
- **Status poller**: enabled for all runtimes (crash detection, not just Claude)
- **Hook/report extraction**: extracted hook/report status logic into session-hooks.ts
- **Test stability**: resolved pre-existing test failures across 8 root causes

### TUI
- **Group headers**: visible, distinct styling, scroll-to-header behavior
- **Onboarding**: pilot onboarding guide, Ark-on-Ark dogfooding docs
```

### 3. Backfill v0.8.0 section

Replace the one-line `## v0.8.0 — Previous release.` with a full section. Covers commits v0.7.0..v0.8.0 (~30 commits). Key themes:

- JSON-RPC protocol server (`packages/server/`, `packages/protocol/`)
- ArkClient library with typed RPC and notifications
- TUI fully migrated from polling to push-based ArkClient protocol
- Executor interface and registry (Claude Code, subprocess executors)
- Memory management in web UI
- Documentation updates (guide, CLI ref, TUI ref, config)
- Loading unification under single TabBar spinner

### 4. Backfill v0.7.0 section

Covers commits v0.6.0..v0.7.0 (~50 commits). Key themes:

- Graph-based flows and composable termination conditions
- Skills and recipes (three-tier resolution, CLI CRUD, injection at dispatch)
- Guardrails (pattern-based tool authorization)
- Sub-agent fan-out with dynamic task decomposition
- Hybrid search with LLM re-ranking
- OTLP span export, auto-rollback health poller
- Web UI expanded to full CLI parity (50+ endpoints)
- TUI parity: advance stage, worktree finish, profile + status counts
- Evals framework, structured review output
- E2E CLI tests rewritten as in-process (215s to 2.6s)

### 5. Backfill v0.6.0 section

Covers commits v0.5.1..v0.6.0 (~60 commits). Key themes:

- Rich React web dashboard with full session management, costs, live updates
- MCP Socket Pool (shared MCP processes via Unix sockets)
- Web SSE live updates
- Cost tracking (pricing, CLI summary, TUI display)
- Soft-delete with undo (90s TTL, Ctrl+Z in TUI)
- Session replay view
- Checkpoint system with crash detection and recovery
- Multi-instance coordination via SQLite heartbeat
- Docker sandbox, hotkey remapping, auto-update
- Messaging bridge (Telegram/Slack)
- Conductor learning system with auto-promotion to policy
- Profiles, themes, UI state persistence

### 6. Backfill v0.5.0/v0.5.1 section

Covers commits v0.4.0..v0.5.1 (~30 commits). Key themes:

- Tools tab with unified tool discovery (skills, recipes, MCP servers, commands)
- Skill CRUD with three-tier resolution (project > global > builtin)
- Recipe CRUD with variable instantiation and sessionToRecipe
- Guardrail rules for tool authorization
- Structured review output (P0-P3 severity)
- Sub-agent fan-out with dynamic task decomposition
- Fail-loopback with error context injection
- Remote sync (commands, skills, CLAUDE.md to remote targets)
- Refactoring: safeAsync/withProvider helpers, eliminated nested try/catch

### 7. Backfill v0.4.0 section

Covers commits v0.3.0..v0.4.0 (~50 commits). Key themes:

- Focus system for TUI keyboard input ownership (useFocus context)
- Custom agent management: create/edit/delete/copy via CLI and TUI
- Three-tier agent resolution (project > global > builtin)
- SessionsTab decomposition (SessionDetail, GroupManager, TalkToSession, CloneSession, MoveToGroup)
- Confirmation prompts for destructive TUI actions
- Comprehensive refactoring: extract helpers, fix type safety, remove circular deps
- Silent catch cleanup: error logging added to all catches across 7 modules
- CI test isolation with shared test context

### 8. Backfill v0.3.0 section

Covers commits v0.2.0..v0.3.0 (~15 commits). Key themes:

- ArkD universal agent daemon: typed JSON-over-HTTP API on port 19300
- 8 compute providers via ArkdBackedProvider base class
- ArkD as conductor transport layer
- PR monitoring: pull-based polling via gh CLI
- Rich session details: files changed, commits, clickable links
- Auto-detect PR URL from agent reports, pr-review flow

### 9. Backfill v0.2.0 section

Covers commits v0.1.0..v0.2.0 (~100 commits). Key themes:

- EC2 compute provider with SSH, auth sync, credential management
- Provider interface: capability flags, session checking, extended methods
- Channel/conductor messaging: text input nav, threads, chat overlay
- TUI polish: status bar layout, fork/clone shortcuts, TreeList navigation
- Remote dispatch: auth token, Claude auth setup, remote MCP channel
- SSH connection pool, reboot, connectivity test
- Web UI: landing page, sidebar hover, copy buttons
- OS notifications, spinner states, Ctrl+Q tmux detach
- DevContainer and Docker compose support

### 10. Backfill v0.1.0 section

Covers initial commits (~8 commits). Key themes:

- Initial release: Ark autonomous agent orchestration platform
- Claude Code agent launch in tmux sessions
- Session lifecycle: create, dispatch, stop
- TUI dashboard (React + Ink)
- Agent completion summary
- Paste support, progress reports, quit fix

### 11. Preserve existing content

Sections v0.9.0, v0.9.1, v0.10.0, v0.11.0, v0.12.0 remain unchanged (lines 3-173 of current file). Only structural adjustments needed:
- Add date to v0.8.0: `## v0.8.0 (2026-04-05)`
- No content changes to v0.9.0 through v0.12.0

### 12. Overall structure

Final file structure (top to bottom):
```
# Changelog
## Unreleased
## v0.13.0 (2026-04-13)
## v0.12.0 (2026-04-10)   [existing]
## v0.11.0 (2026-04-09)   [existing]
## v0.10.0 (2026-04-07)   [existing]
## v0.9.1 (2026-04-07)    [existing]
## v0.9.0 (2026-04-07)    [existing]
## v0.8.0 (2026-04-05)    [rewritten]
## v0.7.0 (2026-04-04)    [new]
## v0.6.0 (2026-04-03)    [new]
## v0.5.0 (2026-04-01)    [new]
## v0.4.0 (2026-04-01)    [new]
## v0.3.0 (2026-03-28)    [new]
## v0.2.0 (2026-03-27)    [new]
## v0.1.0 (2026-03-25)    [new]
```

## Testing strategy

1. **Structure validation**: Verify every git tag has a corresponding `## v<X>` section in CHANGELOG.md
2. **Content accuracy**: Spot-check 3-4 entries per version against `git log v<prev>..v<current> --oneline` to confirm key features are mentioned
3. **No regression**: Ensure v0.9.0 through v0.12.0 sections are byte-identical to the current file (diff against main)
4. **Formatting**: Verify markdown renders correctly (headings, bullet lists, code blocks)
5. **Date accuracy**: Confirm each version date matches the tag commit date from `git log --format="%ai" <tag> -1`

## Risk assessment

- **Accuracy of backfilled entries**: The git commit messages are the sole source of truth for v0.1.0--v0.8.0. Some commits may be grouped or described imprecisely. Mitigation: keep descriptions factual and tied to commit messages rather than speculating about intent.
- **Size**: The file will grow from ~174 lines to roughly 350-400 lines. This is appropriate for a project with 14 releases and 1200+ commits.
- **No breaking changes**: This is a documentation-only change to a single markdown file.
- **v0.12.0 tag missing**: There is no v0.12.0 git tag (tags jump from v0.11.0 to v0.13.0). The existing CHANGELOG has a v0.12.0 section dated 2026-04-10. Keep it as-is since it documents real features (knowledge graph, LLM router, etc.) even though no tag was cut.

## Open questions

1. **v0.12.0 phantom tag**: The CHANGELOG documents v0.12.0 (2026-04-10) but there is no v0.12.0 git tag. Should we create a retroactive tag, or just note the discrepancy? Recommendation: leave as-is, it's a documentation artifact.
2. **Granularity level**: The existing v0.9.0--v0.12.0 entries are detailed (20-40 lines each). Should backfilled versions match that granularity, or be more concise since they're historical? Recommendation: aim for 15-25 lines per version -- enough to understand what shipped, not so much that it's overwhelming for historical releases.
