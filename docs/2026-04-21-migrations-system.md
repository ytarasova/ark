# Migrations System

Date: 2026-04-21
Status: Phase 1 implemented (engine + 001_initial). Phase 2 deferred (rollback impl, code-intel absorption, data-backfill DSL).

## Background

Today's "migrations" are two ad-hoc functions:

- `packages/core/repositories/schema.ts:initSchema(db)` -- SQLite DDL, idempotent CREATE-IF-NOT-EXISTS.
- `packages/core/repositories/schema-postgres.ts:initPostgresSchema(db)` -- the Postgres equivalent.

Plus a Wave-1 internal runner in `packages/core/code-intel/migration-runner.ts` for the `code_intel_*` tables only.

This works for fresh installs but breaks down for column adds, renames, data backfills, or anything that needs an ordered apply log. It also forks the schema across two source files that are easy to drift.

## Goals

1. Real versioned migrations -- one source of truth per change, applied in monotonic order, recorded in `schema_migrations`.
2. Multi-dialect (SQLite + Postgres) from a single migration tree.
3. Bun-native -- no Node-only deps that require a separate runtime to apply.
4. Idempotent -- `boot()` re-runs are no-ops.
5. Polymorphic dialect dispatch via `AppMode` -- downstream code never branches on dialect (per `packages/core/modes/app-mode.ts`).
6. Detect partially applied migrations and refuse silently bad states.
7. Tests exercise both dialects (skip Postgres cleanly when no `DATABASE_URL`).

## Tooling survey

| Tool                      | Bun compat                       | Multi-dialect | Weight                               | Style          | Tracking  | Data backfills | Maturity |
| ------------------------- | -------------------------------- | ------------- | ------------------------------------ | -------------- | --------- | -------------- | -------- |
| **Custom Bun-native** (chosen) | Native | Yes (single tree, dialect param) | ~150 LoC, zero deps | Raw SQL or TS up()/down() | Yes (`schema_migrations`) | Yes (TS files) | New, but mirrors mature pattern |
| Drizzle Kit               | Mostly OK (CLI is Node)          | Yes (separate per-dialect SQL output) | Heavy (~10MB + drizzle-orm)         | Schema-first   | Yes       | Awkward (post-DDL hooks) | High |
| Kysely + kysely-migrate   | Works under Bun                  | Yes (one file w/ builder)            | Medium (~3MB)                        | Type-safe builder | Yes    | Yes            | Medium |
| Atlas (ariga.io)          | Requires external Go binary      | Yes           | External binary                      | Declarative HCL diffing | Yes | Limited (declarative model) | High (in Go land) |
| Umzug                     | Yes                              | Dialect-agnostic (BYO storage) | Light (~1MB)                         | TS up()/down() | Yes (BYO) | Yes            | High |
| node-pg-migrate           | Yes                              | No -- Postgres only            | Light                                | JS DSL         | Yes       | Yes            | High (PG only) |
| Prisma Migrate            | Partial (binary engine)          | Yes           | Very heavy + ORM lock-in             | Schema-first ORM | Yes     | Yes            | High but heavy |
| Knex migrations           | Works                            | Yes           | Medium (~5MB) + Knex query builder   | JS DSL         | Yes       | Yes            | High |
| dbmate                    | External Go binary               | Yes           | External binary                      | Plain SQL files | Yes      | Yes (raw SQL)  | High |

### Decision

**Primary: a small custom Bun-native runner.** It's the cheapest integration, mirrors the proven `code-intel/migration-runner.ts` pattern that's already shipping, and avoids fighting Bun (`bun:sqlite` + `postgres.js` already work; we just need an apply log and a polymorphic dispatcher). The whole runner is ~150 LoC.

Three concrete reasons:

- The dialect axis is already routed polymorphically via `AppMode` (the law of the codebase). Drizzle/Atlas/Kysely all introduce a parallel "dialect" notion that competes with that axis.
- Migration *content* in this codebase will rarely be auto-generatable from a schema diff (we have `tenant_id`, multi-PK tables, FTS5 vs tsvector vs GIN, JSON columns with dialect-specific casts). We always end up writing dialect branches by hand. A code generator wouldn't save us much.
- Backfills are required (e.g. `compute_kind` was hand-backfilled in the Wave 3 dispatch flip). A SQL-only tool won't help; we need TypeScript migration files. That's exactly what the custom runner delivers.

**Fallback if we outgrow it: Umzug.** Same TS up()/down() shape, mature, well-tested locking, and it doesn't impose a query layer. Migrating *to* Umzug from this runner is a 1:1 mechanical port of file shape and the storage adapter -- low switching cost. We can defer Umzug until we hit one of: (a) need distributed locking across control-plane replicas; (b) need migration retries/checksums; (c) want hot-reload during dev.

## Schema

```sql
CREATE TABLE IF NOT EXISTS ark_schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL          -- SQLite (ISO-8601)
              -- TIMESTAMPTZ NOT NULL on Postgres
);
```

Note the `ark_` prefix -- distinguishes it from `code_intel_schema_migrations` (which stays put for now; absorbed in Phase 2).

## Migration file layout

```
packages/core/migrations/
  runner.ts                 # the engine (apply / status / down stub)
  registry.ts               # ordered list of migration modules
  types.ts                  # Migration interface + apply context
  001_initial.ts            # canonical Ark schema (union of schema.ts + schema-postgres.ts)
  __tests__/
    runner.test.ts
```

Each migration file is **one TypeScript module**, not one-per-dialect. The runner passes a `{ db, dialect }` context; the migration body decides what to do per dialect. This matches the existing `code-intel/migrations/` pattern. SQL chunks live as plain string literals inside the module (no separate `.sql` files); when one chunk grows large, we extract a helper module per dialect (see `001_initial.ts` -> `001_initial_sqlite.ts` + `001_initial_postgres.ts`).

Why one file per migration (not per dialect):

- One PR diff per migration.
- One `version` integer per migration.
- Cross-dialect drift is caught at code review, not at runtime.

## Polymorphic dispatch via AppMode

A new `migrationsCapability` is added to `AppMode`:

```ts
export interface MigrationsCapability {
  readonly dialect: "sqlite" | "postgres";
  apply(db: DatabaseAdapter, opts?: { targetVersion?: number }): void;
  status(db: DatabaseAdapter): MigrationStatus;
  down(db: DatabaseAdapter, opts: { targetVersion: number }): never; // stub for Phase 1
}
```

- `buildLocalAppMode(app, dialect)` constructs the capability with the resolved dialect.
- `buildHostedAppMode()` constructs it with `dialect: "postgres"` (hosted is Postgres-only by definition).
- `AppContext.boot()` calls `app.mode.migrationsCapability.apply(db)` instead of the old `_initSchema`.
- The CLI's `ark db migrate / status / down` reads `app.mode.migrationsCapability` -- never `if dialect === 'postgres'`.

The capability is **always non-null** (every mode has migrations; this isn't a "hosted-can't-do-fs" scenario). The polymorphic surface is just the dialect.

## Existing schemas: absorb or parallel?

Phase 1: **absorb** `schema.ts` + `schema-postgres.ts` into `001_initial.ts`. The first migration captures the union of both files as the bootstrap.

The legacy `initSchema` / `initPostgresSchema` functions stay exported -- they're called by a handful of test fixtures and the `compute/pool.ts` reboot path. They're now thin wrappers that delegate to the migration runner. Once all callers are off them (Phase 2), they're deleted.

`code-intel/migration-runner.ts` is **not absorbed** in Phase 1. It tracks its own `code_intel_schema_migrations` table and its own ordered file list. Absorbing means:

- Renumbering code-intel migrations into the global stream, OR
- Keeping two stream IDs but unifying the runner code.

Both are mechanical but invasive. Phase 2.

### Backwards compat for existing installs

Every existing install (laptop SQLite, the running pai-risk-mlops Postgres) already ran `initSchema` to completion. The runner detects this in `apply()`:

1. If `ark_schema_migrations` doesn't exist *and* the `compute` table *does* exist -- this is an existing install. Create `ark_schema_migrations` and insert `001_initial` as already-applied. Skip its `up()`.
2. If `ark_schema_migrations` doesn't exist *and* `compute` doesn't exist -- this is a fresh install. Create `ark_schema_migrations` then run all migrations including `001_initial`.
3. If `ark_schema_migrations` exists -- standard path: apply pending versions in order.

The "presence of `compute`" probe is the cheapest universally-true signal for an existing Ark install (it's been in the schema since v0.1).

## Tests

`runner.test.ts` covers:

- Fresh apply on in-memory SQLite, then idempotent re-apply.
- Status reporting (current version, pending list, applied list).
- Backwards-compat: pre-create `compute`, run `apply()`, assert `001_initial` is marked applied without re-running its DDL.
- Postgres path: gated on `process.env.DATABASE_URL`. When unset, the test logs a skip and exits cleanly.
- Down stub: throws "Phase 1 does not implement rollback".

In-memory SQLite is created via `new Database(":memory:")` wrapped in `BunSqliteAdapter`. Postgres uses the configured URL with a per-test-run schema name to isolate.

## CLI

```
ark db migrate [--to N]    # apply pending migrations (or up to N)
ark db status              # print current version + applied/pending lists
ark db down --to N         # Phase 1: prints "rollback not implemented"
```

Registered in `packages/cli/index.ts` as `registerDbCommands(program, app)`.

## Open questions

1. **One global migration stream or two?** Today: `ark_schema_migrations` (this PR) + `code_intel_schema_migrations` (existing). Phase 2 question.
2. **Distributed locking** when multiple control-plane replicas boot simultaneously. Postgres advisory locks would solve it. Defer until we actually run multi-replica.
3. **Down migrations** -- do we ever need them? Most production teams forward-only. Stub the interface; don't implement until a real use case lands.
4. **Data backfill DSL** -- Wave 3 hand-wrote backfills as inline TS. Probably fine; revisit if backfill complexity grows.
5. **Migration checksums** -- Umzug ships them. We don't have them. Question: do we trust authors not to edit applied migrations?
