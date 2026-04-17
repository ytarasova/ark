# Plan: Update User Guide (docs/guide.md)

## Summary

The user guide (`docs/guide.md`) is stale -- it reflects roughly the v0.8-v0.12 era and is missing features added through v0.17.0. This plan updates the guide to match the current codebase: new flows, runtimes, recipes, CLI commands, messaging bridges, daemon architecture, desktop app, profiles, schedules, and the `ark doctor`/`ark init` commands. It also corrects outdated counts (flows: 9->14, runtimes: 4->5, recipes: 8->10).

## Files to modify/create

| File | Change |
|------|--------|
| `docs/guide.md` | Update all 20 sections plus add 5 new sections (see steps below) |

No new files needed -- this is a single-file update.

## Implementation steps

### 1. Fix counts and add missing entries in existing sections

**Section 3 -- Flows** (lines 165-226):
- Change "Builtin flows (9)" to "Builtin flows (14)"
- Add 5 missing flows to the table:
  - `autonomous` -- single-agent autonomous execution (no gates)
  - `autonomous-sdlc` -- plan -> implement -> verify -> review -> PR -> merge pipeline
  - `brainstorm` -- interactive ideation flow
  - `conditional` -- DAG with conditional edges based on stage outcome
  - `docs` -- documentation-focused flow
- Add `on_outcome` field to the YAML structure docs (conditional routing)

**Section 4 -- Runtimes** (lines 283-334):
- Change "Runtimes (3 tools + 1 subscription variant)" to "Runtimes (5)"
- Add goose runtime row to the table:
  - `goose` | Goose CLI | api | goose
- Update runtime YAML example or add goose example showing `task_delivery` and `transcript_parser` fields

**Section 6 -- Recipes** (lines 385-417):
- Change "Builtin recipes (8)" to "Builtin recipes (10)"
- Add 2 missing recipes to the table:
  - `self-dogfood` -- use Ark to build Ark
  - `self-quick` -- quick self-dogfooding recipe

**Section 15 -- Dashboards** (lines 799-830):
- Remove any lingering TUI references (the TUI was removed in v0.16.0)
- Update web section: mention `--with-daemon` flag on `ark web` that auto-starts conductor + arkd
- Mention daemon auto-detection (reuses existing daemons if already running)

### 2. Add new sections (insert after section 20, before appendices)

**Section 21 -- Daemon Architecture**
- Explain the server daemon (`ark daemon start/stop/status`) on port 19400
- Web and desktop connect as thin WebSocket clients
- `ark web --with-daemon` starts conductor (:19100) + arkd (:19300) in-process
- Desktop app uses `--with-daemon` by default for zero-config experience

**Section 22 -- Messaging Bridges**
- Telegram, Slack, Discord notification bridges
- Config file: `~/.ark/bridge.json`
- Bridge config structure (botToken/chatId for Telegram, webhookUrl for Slack/Discord)
- Notifications on session events (stage completion, failures)

**Section 23 -- Profiles**
- `ark profile list/create/delete`
- Stored in `~/.ark/profiles.json`
- Profiles persist UI preferences and settings

**Section 24 -- Schedules**
- `ark schedule add/list/delete/enable/disable`
- Cron-based recurring sessions
- Web UI scheduling page

**Section 25 -- CLI Utilities**
- `ark doctor` -- check system prerequisites (bun, tmux, git, gh, claude)
- `ark init` -- initialize Ark for a repo (creates `.ark.yaml`, runs prerequisite checks)
- `ark acp` -- headless JSON-RPC server on stdin/stdout
- `ark repo-map` -- generate repository structure map
- `ark pr list/status` -- manage PR-bound sessions
- `ark watch` -- watch GitHub issues with a label and auto-create sessions

### 3. Update Table of Contents (lines 7-29)

- Add sections 21-25 to the ToC
- Renumber if needed

### 4. Update Appendix: Key file locations (lines 1003-1020)

- Add `~/.ark/bridge.json` -- messaging bridge config (Telegram/Slack/Discord)
- Add `~/.ark/profiles.json` -- profile definitions

### 5. Update Appendix: Common tasks cheat sheet (lines 1023-1053)

- Add daemon start example: `ark daemon start`
- Add doctor example: `ark doctor`
- Add schedule example: `ark schedule add --cron "0 9 * * *" --recipe quick-fix --repo . --summary "Daily check"`
- Add goose runtime example: `ark session start --repo . --summary "..." --runtime goose --dispatch`

### 6. Update closing paragraph (line 1057)

- Add messaging bridges, profiles, schedules, daemon architecture, and CLI utilities to the enumeration

## Testing strategy

- **Manual review**: read through the updated guide end-to-end to verify accuracy against current YAML definitions in `flows/`, `runtimes/`, `agents/`, `recipes/`, `skills/`
- **Link check**: verify all internal `#anchor` links in the ToC resolve to actual section headers
- **Count verification**: grep flow/agent/runtime/skill/recipe directories to confirm counts match the updated text
- **No code changes**: this is a docs-only update, no tests to run
- **Formatting**: run `make format` to ensure Prettier compliance (120 char line width)

## Risk assessment

- **Low risk**: docs-only change, no code impact
- **Stale again quickly**: if new features land without guide updates, this will drift. Consider adding a note in CONTRIBUTING.md about updating the guide
- **Accuracy of new sections**: messaging bridges, profiles, and schedules sections are written from code inspection -- verify examples work by running the CLI commands if possible
- **Desktop section**: desktop app details come from changelog entries; verify `ark web --with-daemon` flag exists in the current codebase (confirmed in `packages/cli/commands/misc.ts`)

## Open questions

1. **Messaging bridges depth**: should the guide include step-by-step setup for Telegram/Slack/Discord, or just reference the config format? The bridge code exists but it's unclear how well-tested the Discord path is.
2. **Goose runtime**: the goose runtime YAML exists but should we document it at the same detail level as Claude/Codex/Gemini, or note it as experimental?
3. **`ark watch` command**: this watches GitHub issues with a label -- is this considered stable/documented, or still experimental?
4. **`ark eval` command**: there's an `eval.ts` CLI command file -- should this be documented in the guide or is it internal-only?
