# Ark Hosted Readiness Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ark runnable as both a local CLI tool and a hosted multi-tenant service. No global state, injectable everything, swappable storage backends.

**Architecture:** AppContext is the single root of all state. Every service, store, and handler receives `app` as an argument. Storage backends (filesystem, SQLite, Postgres, S3) are behind interfaces. Multi-tenancy via tenant-scoped AppContext instances.

**Tech Stack:** TypeScript, Bun, SQLite (local) / Postgres (hosted), file stores (local) / DB stores (hosted)

---

## What's Done (completed 2026-04-09)

| Item | Status |
|------|--------|
| Resource stores on AppContext (`app.flows`, `app.skills`, `app.agents`, `app.recipes`) | Done |
| File-backed store implementations with interface abstraction | Done |
| CLI split into 14 command modules | Done |
| Web UI modularized by domain (queries, pages) | Done |
| TUI hints modularized per tab | Done |
| TUI all colors theme-driven (`theme.accent`) | Done |
| Fan-out / DAG flows working | Done |
| Auto-join on child completion | Done |
| `session-orchestration.ts` -- `app` passed as first arg (eliminating 127 getApp calls) | Done |
| `conductor.ts` -- receives `app` at creation | Done |
| Firecracker compute inheritance for fan-out children | Done |
| ArkD bind address `0.0.0.0` | Done |

---

## Phase 1: Finish DI Cleanup (1-2 days)

Eliminate remaining `getApp()` from production code. After this phase, `getApp()` should only exist in CLI entry points, TUI bootstrap, and deprecated backward-compat wrappers.

### Task 1.1: SessionService receives app, not getApp()

**Files:**
- Modify: `packages/core/services/session.ts`
- Modify: `packages/core/app.ts` (where SessionService is created)

SessionService currently calls `getApp()` to pass to orchestration functions. It should store `app` as a field and use it directly.

Update `app.ts` to pass `this` when creating SessionService.

### Task 1.2: Eliminate getApp() from remaining core modules

**Files to clean:**
- `packages/core/channel.ts`
- `packages/core/claude.ts`
- `packages/core/github-pr.ts`
- `packages/core/pr-poller.ts`
- `packages/core/send-reliable.ts`
- `packages/core/status-detect.ts`
- `packages/core/tmux.ts`
- `packages/core/worktree-merge.ts`
- `packages/server/handlers/*.ts` (4 remaining calls)

Each file either receives `app` as a function parameter or is a class that stores `app` in constructor.

### Task 1.3: Eliminate ARK_DIR() / paths.ts usage

Replace all 32 `ARK_DIR()` calls with `app.config.arkDir` passed through the call chain. Mark `paths.ts` functions as `@deprecated`.

### Task 1.4: Verify zero getApp() in service layer

Run: `grep -rn "getApp()" packages/core/services/ packages/core/conductor.ts packages/server/ | grep -v test | grep -v deprecated`

Expected: 0 results.

---

## Phase 2: Database Abstraction (2-3 days)

Make the database swappable so hosted mode can use Postgres.

### Task 2.1: Define IDatabase interface

**Create:** `packages/core/database.ts`

Define `IDatabase` and `IStatement` interfaces that abstract over SQL operations (prepare, exec, transaction, close).

### Task 2.2: BunSqliteAdapter implements IDatabase

**Create:** `packages/core/database-sqlite.ts`

Thin wrapper around `bun:sqlite` Database. This is what local mode uses.

### Task 2.3: Update repositories to use IDatabase

**Modify:** All files in `packages/core/repositories/`

Change constructor from `constructor(private db: Database)` (bun:sqlite) to `constructor(private db: IDatabase)`.

### Task 2.4: Update AppContext to use IDatabase

**Modify:** `packages/core/app.ts`

Parse `config.databaseUrl` to choose backend:
- `sqlite:///path/to/db` or no URL -- use `BunSqliteAdapter`
- `postgres://...` -- use `PostgresAdapter` (future)

### Task 2.5: Schema migration system

**Create:** `packages/core/migrations/`

Versioned migrations so Postgres and SQLite schemas stay in sync.

---

## Phase 3: Network and Port Abstraction (1-2 days)

Remove hardcoded localhost and port assumptions.

### Task 3.1: Config-driven URLs

Replace all hardcoded `http://localhost:PORT` with config-driven URLs from `app.config`:
- `conductorUrl`, `arkdUrl`, `channelBaseUrl`

### Task 3.2: Dynamic port allocation

Replace deterministic `19200 + hash` channel port with OS-assigned ports (port 0) registered with conductor via service discovery.

### Task 3.3: Conductor hostname env var

Add `ARK_CONDUCTOR_HOST` to constants.ts, default `0.0.0.0`.

---

## Phase 4: Auth and Multi-Tenancy (3-5 days)

### Task 4.1: Tenant model

Define `TenantContext { tenantId, userId, role }` type.

### Task 4.2: Add tenant_id to all entities

Add `tenant_id TEXT NOT NULL DEFAULT 'default'` to: sessions, computes, events, messages, todos, schedules.

### Task 4.3: Scope all queries by tenant

Every repository `list()`, `get()`, `create()` filters by `tenant_id`.

### Task 4.4: JWT auth middleware

Add JWT validation to `web.ts`. Extract tenant context from token.

### Task 4.5: Per-tenant AppContext factory

Shared DB connection, scoped repos per tenant.

---

## Phase 5: Session Launcher Abstraction (3-5 days)

### Task 5.1: SessionLauncher interface

Define `launch`, `kill`, `status`, `send`, `capture` methods.

### Task 5.2: TmuxLauncher (local)

Extract tmux logic from session-orchestration.ts.

### Task 5.3: ArkdLauncher (remote)

Adapter over existing ArkD client.

### Task 5.4: ContainerLauncher (Docker/K8s)

For hosted mode -- agents run in containers.

### Task 5.5: Wire into orchestration

`app.launcher.launch()` instead of direct tmux calls.

---

## Phase 6: Remote-First Features (3-5 days)

### Task 6.1: --remote-repo support

Clone remote repos to compute targets. No local repo needed.

### Task 6.2: Compute pools

Auto-assign compute from pool at dispatch. Scale on queue depth.

### Task 6.3: Web dashboard as primary UI

Login page, tenant switcher, user management.

### Task 6.4: SSE scaling

Redis pub/sub for multi-instance SSE broadcast.

---

## Phase 7: Foundry 2.0 Product Features

### Track 1: QA Infra in Cloud
- Test suite fan-out recipe
- CI/CD integration (GitHub Actions)
- Test result aggregation

### Track 2: AI Monitor
- Persistent agent mode
- Prometheus MCP server
- Escalation rules
- Health check schedules

---

## Timeline

```
Phase 1: DI cleanup             ██         (1-2 days)
Phase 2: Database abstraction   ███        (2-3 days)
Phase 3: Network abstraction    ██         (1-2 days)
Phase 4: Auth + tenancy         █████      (3-5 days)  -- hosted demo
Phase 5: Session launcher       █████      (3-5 days)
Phase 6: Remote-first           █████      (3-5 days)  -- full hosted
Phase 7: Foundry 2.0            ████████   (ongoing)
```

## Success Criteria

| Milestone | Criteria |
|-----------|---------|
| Phase 1 | Zero `getApp()` in services/server (only CLI/TUI entry + deprecated wrappers) |
| Phase 2 | `bun:sqlite` imported only in `database-sqlite.ts` |
| Phase 3 | Zero hardcoded `localhost` in production code |
| Phase 4 | Two tenants run sessions without seeing each other's data |
| Phase 5 | `tmux` imported only in `tmux-launcher.ts` |
| Phase 6 | Session via web dashboard on remote compute, no local CLI needed |
| Phase 7 | QA fan-out to cloud, AI monitor watches Prometheus |
