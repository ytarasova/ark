# Plan: Update User Guide

## Summary

The user guide (`docs/guide.md`) has several factual discrepancies with the current codebase. The most critical: session statuses are completely wrong (6 of 9 are stale names from a prior refactor). Skills are described as "markdown files" but are actually YAML. The CLI command module count says 17 but should be 24. Agents (12), flows (14), recipes (10), runtimes (5), and compute providers (11) all match and need no changes.

## Files to modify/create

| File | Change |
|------|--------|
| `docs/guide.md` | Fix session statuses, skill format, CLI command count, closing summary |

## Implementation steps

### 1. Fix session statuses (Section 2, ~line 93)

**Source of truth:** `packages/types/session.ts:1-24`

The guide says:
> `pending`, `dispatched`, `running`, `busy`, `idle`, `paused`, `completed`, `error`, `archived`

Actual user-facing statuses:
> `pending`, `ready`, `running`, `waiting`, `stopped`, `blocked`, `completed`, `failed`, `archived`

Specific changes:
- `dispatched` -> `ready`
- Remove `busy` and `idle`
- `paused` -> `stopped`
- `error` -> `failed`
- Add `waiting` and `blocked`

Note: `deleting` exists in the type but is internal-only (excluded from `SESSION_STATUSES` array, line 13).

### 2. Fix skills format description (Section 5, ~line 355)

The guide says: "They are markdown files injected into an agent's system prompt when attached."

Skills are actually YAML files (`skills/*.yaml`). Structure from `skills/code-review.yaml`:
```yaml
name: code-review
description: Reviews code changes for bugs, style, and best practices
prompt: |
  Review the code changes...
tags: [review, quality]
```

Changes:
- Replace "markdown files" with "YAML files whose `prompt` field is injected into an agent's system prompt"
- Update three-tier resolution paths from `.md` to `.yaml`

### 3. Fix CLI command module count (Section 15, ~line 831)

The guide says "Seventeen command modules". Actual count is **24** in `packages/cli/commands/`:

agent, auth, compute, conductor, costs, daemon, dashboard, eval, flow, knowledge, memory, misc, profile, recipe, router, runtime, schedule, search, server, server-daemon, session, skill, tenant, worktree

Change "Seventeen" to "Twenty-four" and expand the topic list to include: conductor, daemon, eval, memory, misc, profile, server/server-daemon.

### 4. Verify session CLI commands (Section 2, ~lines 77-92)

The guide lists `session handoff` and `session clone`. Verify these exist in `packages/cli/commands/session.ts`. If not implemented, remove from the table.

### 5. Update closing summary (~line 1089)

The final paragraph restates status names and other counts. Update to match all corrections from steps 1-4.

## Testing strategy

- After editing, verify each changed claim against source files:
  - `packages/types/session.ts` for statuses
  - `skills/*.yaml` for skill format
  - `packages/cli/commands/*.ts` for command count
- Run `make format` to ensure Prettier compliance
- No code logic changes, so no test suite run needed

## Risk assessment

- **Low risk**: Documentation-only changes, no code modified
- **Session status fix is high priority**: Users scripting against the guide would get wrong results with old status names
- **No breaking changes**

## Open questions

None -- all decisions made:
- DesignPreviewPage: dev-only, omit from guide
- `session handoff`/`session clone`: verify during implementation, remove if unimplemented
- Skill format: confirmed YAML via direct file inspection
