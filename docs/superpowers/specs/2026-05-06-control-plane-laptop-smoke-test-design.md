# Control-Plane Laptop Smoke Test - Design

**Status:** Approved (option a from 2026-05-06 brainstorm)
**Implementation:** Shipped in PR #524 (ytarasova/ark) on 2026-05-06.
**Branch:** `feat/control-plane-mode`
**Worktree:** `.worktrees/feat-control-plane-mode`
**Pairs with:** `docs/control_plan_mode.md` (Goal 2 - Compose dev stack)

---

## 1. Goal

Stand up a one-command laptop dev stack that boots Ark in `control-plane` profile against a real Postgres + Redis. Health endpoints respond; the web UI loads. This is a **smoke test** of the hosted shape, not a full Goal 2 deliverable.

**Non-goals:**
- Not fixing the Postgres-dialect parity bugs surfaced by the smoke (they go on the backlog with reproductions).
- Not deleting local-mode code paths (that is Goal 1, separate work).
- Not standing up MinIO / Temporal / a real S3 snapshot store (that is the rest of Goal 2).
- Not running an end-to-end agent dispatch (no LLM key wiring, no compute target registration).

---

## 2. Scope

### In

- `.infra/docker-compose.dev.yaml` - Postgres 16 on `:15433`, Redis 7 on `:6379`. Non-default Postgres port so it can't clash with a host-side Postgres or an SSH tunnel that already grabbed `:5432`.
- `.env.control-plane` - reference env file documenting the minimum vars to boot hosted mode locally (profile, DB URL, Redis URL, blob/secrets backend overrides, auth-token disable, dev-storage override).
- `Makefile` - `dev-stack`, `dev-stack-down` targets that wrap the compose file (paralleling the existing `dev-temporal` / `dev-temporal-down` pair).
- `packages/core/di/storage.ts` and `packages/core/di/runtime.ts` - dev-only env override `ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE` that lets `LocalDiskBlobStore` + `FsSnapshotStore` run inside hosted mode. **Tagged as Goal-1 deletion candidates.** A real Goal 2 deliverable replaces both with S3-backed implementations against MinIO; once those land, the override goes away with local-mode code.
- `docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md` - this file.

### Out

- Postgres-schema parity fixes. Two real bugs surfaced during boot:
  1. `initPostgresSchema` does not create `knowledge` / `knowledge_edges`, but migration 013 issues `UPDATE knowledge ...` against both dialects.
  2. `initPostgresSchema` does not create `sessions.pty_cols` / `pty_rows`, but the drizzle session schema (and runtime queries) reference them.
  These are filed in the backlog (section 5) with manual `psql` repros. Fixing them is its own change; this PR does not touch `schema-postgres.ts`.
- Web bundle build wiring. The hosted server expects `packages/web/dist/` to exist; it doesn't in a fresh checkout. The smoke test treats `make build-web` as a prereq the operator runs separately. Wiring `dev-stack` to depend on `build-web` is a follow-up.
- LLM-router config, secret seeding, compute target registration, ArgoCD wiring.

---

## 3. Deliverables

| File | What it does |
|------|--------------|
| `.infra/docker-compose.dev.yaml` | Postgres + Redis containers with healthchecks + named volumes |
| `.env.control-plane` | Reference env with profile + DB/Redis URLs + dev overrides |
| `Makefile` (delta) | `dev-stack` / `dev-stack-down` targets |
| `packages/core/di/storage.ts` | Add `ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE` gate (clearly commented as Goal-1 deletion candidate) |
| `packages/core/di/runtime.ts` | Same gate for `snapshotStore` |
| `docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md` | This spec |

---

## 4. Acceptance

A fresh checkout on the worktree branch passes this loop:

```bash
make dev-stack
make build-web                       # one-time prereq (out of scope to wire automatically)
# Apply manual psql workaround for the Postgres parity bugs (section 5).
set -a; source .env.control-plane; set +a
bun packages/cli/index.ts server start --hosted --port 8420
```

Then in another shell:

```bash
curl -fsS http://localhost:8420/api/health    # -> {"ok":true,...}
curl -fsS http://localhost:19100/health       # -> {"status":"ok",...}
open http://localhost:8420                     # web UI renders (login or default tenant)
```

If `:8420` or `:19100` are already taken (e.g. a sibling worktree's `make dev` is running), override with `ARK_WEB_PORT` / `ARK_CONDUCTOR_PORT` and adjust the curl URLs to match.

If the three calls succeed, the smoke test passes. The smoke loop was verified locally in PR #524; the Makefile `dev-stack` target auto-detects the available docker-compose binary (`docker compose` plugin or `docker-compose` standalone v2) so the loop works on hosts that have only the standalone form.

---

## 5. Known gaps (backlog after this lands)

Each item is reproducible from the smoke loop above; entering them as their own backlog tickets:

1. **Postgres parity: `knowledge` / `knowledge_edges` tables missing** (#520). `initPostgresSchema` lacks them; migration 013 (`UPDATE knowledge SET type='eval_session' ...`) fails on a fresh Postgres DB. Manual repro: `DROP TABLE ark_schema_migrations; bun ... server start --hosted` -> crashes with `relation "knowledge" does not exist`. Manual fix: copy DDL from `initKnowledgeSchema` (in `repositories/schema.ts`) into `schema-postgres.ts`, translating SQLite idioms (`datetime('now')` -> `now()::text`).
2. **Postgres parity: `sessions.pty_cols` / `pty_rows` columns missing** (#521). Drizzle schema declares them on both dialects; `initPostgresSchema` omits them. Runtime session-list queries crash. Manual fix: `ALTER TABLE sessions ADD COLUMN pty_cols INTEGER; ADD COLUMN pty_rows INTEGER;` and add the same DDL to `schema-postgres.ts`. Note: the bootstrap SQL workaround in `.infra/dev-stack-bootstrap.sql` applies these ALTER statements before the server boots, but the `sessions` table itself is created by the server's migration 001. This ordering means the ALTER statements emit `relation "sessions" does not exist` psql errors during `make dev-stack`; these errors are non-fatal (log spam only) and do not affect smoke endpoint results. The proper fix (tracked in #521) moves the columns into `schema-postgres.ts` and removes the workaround.
3. **Web bundle build not wired into `dev-stack`** (#522). Operator must run `make build-web` separately before `server start --hosted` or the SPA returns 404.
4. **Goal 1 deletion candidates** (#523) for the dev-storage override: when local-mode code is deleted, drop the `ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE` env, `LocalDiskBlobStore` import, and `FsSnapshotStore` import from `packages/core/di/{storage,runtime}.ts`. The replacements are `S3BlobStore` (already exists) + a new `S3SnapshotStore` (TODO #fixme already noted in `runtime.ts`).
5. **`make dev-stack` Postgres on `:15433`** is a non-default port chosen to dodge a host-side Postgres collision or an SSH tunnel that already grabbed `:5432` on the author's laptop. This rationale is intentional and should be preserved in any future compose changes. If the team consolidates on a different port, update the compose port mapping + `DATABASE_URL` in `.env.control-plane`.

### 5.6 Deferred design questions (surfaced in PR #524 review)

These are not bugs; they are design gaps identified during code review that should be resolved before Goal 2 is declared production-ready:

a. **`ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE` has no production-safety guard.** A Helm/Argo misconfiguration that leaks this env var into a production pod would silently downgrade tenant isolation by substituting `LocalDiskBlobStore` for the S3-backed store. Consider gating the override on `profile === "test"` or throwing if `NODE_ENV === "production"`.

b. **Bootstrap SQL will silently diverge from `schema-postgres.ts`.** Once #520 lands (knowledge tables added to `initPostgresSchema`), the `knowledge` block in `.infra/dev-stack-bootstrap.sql` becomes redundant or conflicting. No `make drift`-style check exists to catch this divergence. Either remove the bootstrap block as part of #520, or add a CI lint step that asserts the bootstrap SQL is empty when the real schema covers it.

c. **Port `:15433` rationale should be discoverable.** The non-default Postgres host port is chosen to avoid clashing with a host-side Postgres or an SSH tunnel already bound to `:5432`. This rationale exists in the compose file as an inline comment but not in a user-facing location. Section 5.5 above captures it; ensure it is also visible in the `make dev-stack` output or in `README`-level docs when Goal 2 lands.

d. **`make dev-stack` should print a clearer "next step" hint.** Currently the trailing output shows connection URLs but the operator still needs to know to run `source .env.control-plane`. The target should print the exact command to run next (i.e. `source .env.control-plane && bun packages/cli/index.ts server start --hosted`) so the onboarding path is self-contained. Tracked as part of #522 scope.

---

## 6. Sequence

1. Write this spec, commit.
2. Confirm the existing worktree changes (`docker-compose.dev.yaml`, `.env.control-plane`, di patches) match the spec; no further edits expected.
3. Add `dev-stack` / `dev-stack-down` Makefile targets.
4. Run the acceptance loop from a clean state (`docker compose down -v` + drop migration log) and capture the output.
5. Open backlog tickets for section 5.
6. Commit + PR.

The implementation plan (next skill: `writing-plans`) breaks (3) and (4) into explicit steps.
