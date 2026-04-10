# Core Module Reorganization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `packages/core/` from 91 flat files into domain-organized directories. Each domain owns its files. Imports update accordingly.

**Architecture:** Move files into domain directories. Update all imports across the codebase. No behavior changes -- pure structural refactor.

**Tech Stack:** TypeScript, Bun (ES modules with .js extensions)

---

## Target Structure

```
packages/core/
  app.ts                        -- AppContext (stays at root -- it's the entry point)
  container.ts                  -- DI container (stays at root)
  config.ts                     -- ArkConfig (stays at root)
  constants.ts                  -- URL/port constants (stays at root)
  index.ts                      -- Barrel exports (stays at root)

  database/
    types.ts                    -- IDatabase, IStatement interfaces
    sqlite.ts                   -- BunSqliteAdapter
    postgres.ts                 -- PostgresAdapter

  repositories/                 -- (already exists, no change)
    schema.ts
    session.ts
    compute.ts
    event.ts
    message.ts
    todo.ts

  services/                     -- (already exists, no change)
    session.ts
    session-orchestration.ts
    compute.ts
    history.ts

  stores/                       -- (already exists, no change)
    flow-store.ts
    skill-store.ts
    agent-store.ts
    recipe-store.ts
    runtime-store.ts

  knowledge/                    -- (new, from knowledge plan)
    store.ts
    indexer.ts
    mcp.ts
    migration.ts
    context.ts
    types.ts

  launchers/                    -- (already exists, no change)
    tmux.ts
    container.ts
    arkd.ts

  executors/                    -- (already exists, no change)
    claude-code.ts
    subprocess.ts
    cli-agent.ts
    status-poller.ts

  auth/
    api-keys.ts                 -- from core/api-keys.ts
    auth.ts                     -- from core/auth.ts
    tenant-policy.ts            -- from core/tenant-policy.ts

  compute/
    pool.ts                     -- from core/compute-pool.ts

  conductor/
    conductor.ts                -- from core/conductor.ts
    channel.ts                  -- from core/channel.ts
    channel-types.ts            -- from core/channel-types.ts

  integrations/
    github-pr.ts                -- from core/github-pr.ts
    github-webhook.ts           -- from core/github-webhook.ts
    bridge.ts                   -- from core/bridge.ts
    pr-poller.ts                -- from core/pr-poller.ts
    issue-poller.ts             -- from core/issue-poller.ts
    rollback.ts                 -- from core/rollback.ts

  claude/
    claude.ts                   -- from core/claude.ts
    claude-sessions.ts          -- from core/claude-sessions.ts

  search/
    search.ts                   -- from core/search.ts
    global-search.ts            -- from core/global-search.ts
    hybrid-search.ts            -- from core/hybrid-search.ts

  session/
    share.ts                    -- from core/session-share.ts
    checkpoint.ts               -- from core/checkpoint.ts
    replay.ts                   -- from core/replay.ts
    guardrails.ts               -- from core/guardrails.ts
    prompt-guard.ts             -- from core/prompt-guard.ts

  agent/
    agent.ts                    -- from core/agent.ts
    skill.ts                    -- from core/skill.ts
    recipe.ts                   -- from core/recipe.ts
    skill-extractor.ts          -- from core/skill-extractor.ts
    recipe-eval.ts              -- from core/recipe-eval.ts
    evals.ts                    -- from core/evals.ts

  observability/
    costs.ts                    -- from core/costs.ts
    structured-log.ts           -- from core/structured-log.ts
    log-manager.ts              -- from core/log-manager.ts
    telemetry.ts                -- from core/telemetry.ts
    otlp.ts                     -- from core/otlp.ts
    status-detect.ts            -- from core/status-detect.ts

  hosted/
    hosted.ts                   -- from core/hosted.ts
    worker-registry.ts          -- from core/worker-registry.ts
    scheduler.ts                -- from core/scheduler.ts
    sse-bus.ts                  -- from core/sse-bus.ts
    sse-redis.ts                -- from core/sse-redis.ts
    web.ts                      -- from core/web.ts
    web-proxy.ts                -- from core/web-proxy.ts

  infra/
    tmux.ts                     -- from core/tmux.ts
    tmux-notify.ts              -- from core/tmux-notify.ts
    notify-daemon.ts            -- from core/notify-daemon.ts
    instance-lock.ts            -- from core/instance-lock.ts
    update-check.ts             -- from core/update-check.ts

  state/
    memory.ts                   -- from core/memory.ts
    learnings.ts                -- from core/learnings.ts
    flow.ts                     -- from core/flow.ts
    flow-state.ts               -- from core/flow-state.ts
    graph-flow.ts               -- from core/graph-flow.ts
    ui-state.ts                 -- from core/ui-state.ts
    profiles.ts                 -- from core/profiles.ts

  util/
    safe.ts                     -- from core/safe.ts
    template.ts                 -- from core/template.ts
    util.ts                     -- from core/util.ts
    hooks.ts                    -- from core/hooks.ts
    send-reliable.ts            -- from core/send-reliable.ts
```

## Execution Strategy

This is a massive mechanical refactor (91 files, hundreds of import paths). It should be done in phases, one domain at a time, with tests verified after each phase.

### Phase 1: database/ (3 files)

Move `database.ts`, `database-sqlite.ts`, `database-postgres.ts` to `database/types.ts`, `database/sqlite.ts`, `database/postgres.ts`.

Update imports in: `app.ts`, `container.ts`, `repositories/*.ts`, `services/history.ts`, all test files.

Verify: `make test`

### Phase 2: auth/ (3 files)

Move `api-keys.ts`, `auth.ts`, `tenant-policy.ts` to `auth/`.

Update imports in: `app.ts`, `conductor.ts`, `web.ts`, CLI commands.

### Phase 3: conductor/ (3 files)

Move `conductor.ts`, `channel.ts`, `channel-types.ts` to `conductor/`.

### Phase 4: integrations/ (6 files)

Move GitHub, bridge, poller files to `integrations/`.

### Phase 5: claude/ (2 files)

Move Claude-specific files.

### Phase 6: search/ (3 files)

Move search files.

### Phase 7: session/ (5 files)

Move session utility files.

### Phase 8: agent/ (6 files)

Move agent/skill/recipe utility files.

### Phase 9: observability/ (6 files)

Move logging, costs, telemetry files.

### Phase 10: hosted/ (7 files)

Move hosted/control plane files.

### Phase 11: infra/ (5 files)

Move tmux, notifications, system files.

### Phase 12: state/ (7 files)

Move state management files.

### Phase 13: util/ (5 files)

Move utility files.

### Phase 14: Cleanup

- Update `index.ts` barrel exports
- Remove any stale imports
- Run full test suite
- Run lint

## Important Rules

- **Each phase is one commit** -- move files + update imports
- **`git mv` for moves** -- preserves git history
- **Update ALL imports** -- grep for the old path, replace with new
- **ES module .js extensions** -- all import paths must use `.js`
- **Test after each phase** -- `make test` must pass before next phase
- **Do NOT change behavior** -- pure structural refactor
- **Update CLAUDE.md** after final phase with new structure

## Risk Mitigation

- Each phase is independently revertable
- Tests verify nothing broke
- `git mv` preserves blame history
- Barrel exports in `index.ts` can re-export from new paths for external consumers
