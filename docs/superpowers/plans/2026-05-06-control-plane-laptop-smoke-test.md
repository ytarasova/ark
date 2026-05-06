# Control-Plane Laptop Smoke Test - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a one-command laptop dev stack that boots Ark in `control-plane` profile against real Postgres + Redis. The three-curl smoke loop in spec section 4 passes.

**Architecture:** Add a docker-compose dev stack (Postgres + Redis), an env file template, two `make dev-stack` / `make dev-stack-down` targets that mirror the existing `dev-temporal` pattern, and a sidecar bootstrap SQL file that applies the workaround DDL for two known Postgres-parity bugs (deferred to a separate PR per the spec). The `di/storage.ts` + `di/runtime.ts` env-override patches are kept under a `Goal-1 deletion candidate` comment so the laptop loop is unblocked while local-mode code paths still exist.

**Tech Stack:** docker-compose v2, Postgres 16, Redis 7, GNU Make, bash, postgres CLI (`psql`), Bun + TypeScript (existing).

**Spec:** [`docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md`](../specs/2026-05-06-control-plane-laptop-smoke-test-design.md)

**Worktree:** `.worktrees/feat-control-plane-mode` on branch `feat/control-plane-mode` (already created).

**Spec amendment (small):** The plan adds one deliverable beyond the spec's section 3 list: `.infra/dev-stack-bootstrap.sql`. It bundles the two manual `psql` workarounds from spec section 5 (knowledge tables, `pty_cols`/`pty_rows` columns) so `make dev-stack` is reproducible. It is explicitly tagged as workaround-not-fix; the real fix lands in a separate PR that updates `schema-postgres.ts`.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `.infra/docker-compose.dev.yaml` | exists in worktree (uncommitted) | Postgres 16 + Redis 7 services for local dev |
| `.infra/dev-stack-bootstrap.sql` | NEW | One-time DDL that papers over the two Postgres-parity bugs (knowledge tables, pty cols) so the smoke loop boots |
| `.env.control-plane` | exists in worktree (uncommitted) | Reference env for control-plane profile + dev overrides |
| `Makefile` | MODIFY | Add `dev-stack` / `dev-stack-down` targets after `dev-temporal-down` |
| `packages/core/di/storage.ts` | exists in worktree (uncommitted) | `ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE` gate (Goal-1 deletion candidate) |
| `packages/core/di/runtime.ts` | exists in worktree (uncommitted) | Same gate for `snapshotStore` (Goal-1 deletion candidate) |

---

## Task 1: Verify pre-existing worktree artifacts haven't drifted

The worktree already carries four uncommitted artifacts from the earlier exploratory session. Before adding more files, confirm they match what the spec describes. No edits expected.

**Files:**
- Read: `.infra/docker-compose.dev.yaml`
- Read: `.env.control-plane`
- Read: `packages/core/di/storage.ts`
- Read: `packages/core/di/runtime.ts`

- [ ] **Step 1: Inspect compose file is Postgres :15433 + Redis :6379**

Run: `grep -E '15433|6379|image:' .infra/docker-compose.dev.yaml`
Expected output contains:
```
    image: postgres:16
      - "15433:5432"
    image: redis:7-alpine
      - "6379:6379"
```

- [ ] **Step 2: Inspect env file has the five required vars**

Run: `grep -E '^ARK_PROFILE|^DATABASE_URL|^REDIS_URL|^ARK_BLOB_BACKEND|^ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE' .env.control-plane`
Expected output is exactly five lines:
```
ARK_PROFILE=control-plane
DATABASE_URL=postgres://ark:ark@localhost:15433/ark?sslmode=disable
REDIS_URL=redis://localhost:6379
ARK_BLOB_BACKEND=local
ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE=1
```

- [ ] **Step 3: Inspect the di/ patches are present**

Run: `grep -c 'ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE' packages/core/di/storage.ts packages/core/di/runtime.ts`
Expected: `3` in each file (1 in the comment, 1 in the gate, 1 in the throw text).

- [ ] **Step 4: No commit -- this is a verify-only checkpoint.**

If any of the three checks fail, STOP and report the drift. Otherwise proceed.

---

## Task 2: Add the bootstrap SQL helper

Spec section 5 documents two Postgres-parity bugs. The real fix updates `schema-postgres.ts` (separate PR). For the smoke loop, we apply the same DDL out-of-band so a fresh `make dev-stack` boots without manual `psql`.

**Files:**
- Create: `.infra/dev-stack-bootstrap.sql`

- [ ] **Step 1: Create the bootstrap SQL file**

```sql
-- Bootstrap DDL for the dev-stack smoke test.
--
-- WORKAROUND (not a fix). The real fix updates
-- packages/core/repositories/schema-postgres.ts so the legacy
-- initPostgresSchema bootstrap creates these objects on a fresh DB.
-- Tracked by:
--   * spec docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md
--     sections 5.1 (knowledge tables) and 5.2 (pty cols)
--
-- Idempotent. Safe to re-run after `docker compose down -v`.

-- ── 5.1: knowledge graph tables (referenced by migration 013) ──────────────
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_knowledge_label ON knowledge(tenant_id, label);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (now()::text),
  PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(tenant_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(relation);

-- ── 5.2: sessions.pty_cols / pty_rows (declared by drizzle, omitted by init) ─
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_cols INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_rows INTEGER;
```

Save to `.infra/dev-stack-bootstrap.sql`.

- [ ] **Step 2: Verify the file parses as valid SQL via psql --help dry style**

The Postgres container will validate it on apply. We just sanity-check the file has the expected statement count locally:

Run: `grep -c -E '^(CREATE|ALTER)' .infra/dev-stack-bootstrap.sql`
Expected: `9` (2 CREATE TABLE + 5 CREATE INDEX + 2 ALTER TABLE)

- [ ] **Step 3: Commit**

```bash
git add .infra/dev-stack-bootstrap.sql
git commit -m "chore: add dev-stack bootstrap SQL for postgres parity workarounds"
```

---

## Task 3: Add `dev-stack` and `dev-stack-down` Makefile targets

Mirror the existing `dev-temporal` / `dev-temporal-down` shape. `dev-stack` boots compose, waits for health, runs the bootstrap SQL, and prints connection info.

**Files:**
- Modify: `Makefile` (insert after the `dev-temporal-down` target, around line 116)

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n '^dev-temporal-down:' Makefile`
Expected: a single line such as `114:dev-temporal-down: ## Stop and remove the local Temporal cluster + its data volume`

Note the line number; the new targets go in the empty line after the existing target's body.

- [ ] **Step 2: Insert the two new Makefile targets**

Find the block:
```make
dev-temporal-down: ## Stop and remove the local Temporal cluster + its data volume
	docker compose -f .infra/docker-compose.temporal.yaml -p ark-temporal down -v
	@echo "Ark local Temporal cluster stopped."

spike-temporal-bun: ## Run the Phase 0 Bun / Temporal worker compat spike
```

Insert two new targets between `dev-temporal-down` and `spike-temporal-bun`:

```make
dev-stack: ## Start local Ark dev stack (Postgres :15433 + Redis :6379) and apply bootstrap SQL
	@command -v docker >/dev/null 2>&1 || { echo "Docker required. Install Docker Desktop."; exit 1; }
	@echo "\033[1mStarting Ark dev stack (Postgres + Redis)...\033[0m"
	docker compose -f .infra/docker-compose.dev.yaml -p ark-dev up -d --wait
	@echo "\033[1mApplying bootstrap SQL workarounds...\033[0m"
	docker exec -i ark-postgres psql -U ark -d ark < .infra/dev-stack-bootstrap.sql
	@echo ""
	@echo "  Postgres:  postgres://ark:ark@localhost:15433/ark"
	@echo "  Redis:     redis://localhost:6379"
	@echo ""
	@echo "  Next: source .env.control-plane && bun packages/cli/index.ts server start --hosted"

dev-stack-down: ## Stop and remove the local Ark dev stack + its data volumes
	docker compose -f .infra/docker-compose.dev.yaml -p ark-dev down -v
	@echo "Ark local dev stack stopped."

```

- [ ] **Step 3: Verify the targets parse**

Run: `make -n dev-stack 2>&1 | head -10`
Expected output begins with:
```
docker compose -f .infra/docker-compose.dev.yaml -p ark-dev up -d --wait
```
(The `-n` flag prints commands without running them.)

Run: `make -n dev-stack-down 2>&1 | head -3`
Expected output begins with:
```
docker compose -f .infra/docker-compose.dev.yaml -p ark-dev down -v
```

- [ ] **Step 4: Verify `make help` lists both targets (if `help` exists)**

Run: `grep -n '^help:' Makefile | head -1`

If `help:` exists:
Run: `make help 2>&1 | grep -E 'dev-stack'`
Expected: two lines, one each for `dev-stack` and `dev-stack-down`.

If no `help` target exists, skip this check.

- [ ] **Step 5: Commit**

```bash
git add Makefile
git commit -m "feature: add make dev-stack / dev-stack-down for local control-plane dev"
```

---

## Task 4: Stage the existing worktree artifacts (compose, env, di patches)

The four files from the earlier session are correct per Task 1. Commit them now as one logical unit so the diff against `main` is reviewable.

**Files:**
- Stage: `.infra/docker-compose.dev.yaml`
- Stage: `.env.control-plane`
- Stage: `packages/core/di/storage.ts`
- Stage: `packages/core/di/runtime.ts`

- [ ] **Step 1: Stage the four files explicitly (do NOT use `git add .`)**

```bash
git add .infra/docker-compose.dev.yaml .env.control-plane packages/core/di/storage.ts packages/core/di/runtime.ts
```

- [ ] **Step 2: Verify the staged diff is what we expect**

Run: `git diff --cached --stat`
Expected (counts may vary by ~1):
```
 .env.control-plane                | 43 +++++++++++++++++++++++++++++
 .infra/docker-compose.dev.yaml    | 63 +++++++++++++++++++++++++++++++++++++++
 packages/core/di/runtime.ts       | 12 +++++--
 packages/core/di/storage.ts       | 12 +++++--
 4 files changed, ...
```

If any other file appears, unstage it: `git restore --staged <path>`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feature: laptop dev stack for control-plane mode (compose + env + di overrides)"
```

---

## Task 5: Acceptance loop from a clean state

This is the executable form of spec section 4. Reset the running stack, bring it up via the new Make target, boot the server, and hit the three smoke endpoints.

If `:8420` or `:19100` are already taken on the host (sibling worktree, prior `make dev`, etc.), pick free ports and pass them via `ARK_WEB_PORT` / `ARK_CONDUCTOR_PORT`. The acceptance check just needs ALL three curls to succeed on whatever ports the server actually bound.

**Files:**
- Run-only (no edits)

- [ ] **Step 1: Tear down any prior dev stack (so we test from a clean DB)**

```bash
docker compose -f .infra/docker-compose.dev.yaml -p ark-dev down -v 2>/dev/null || true
```

- [ ] **Step 2: Stop any prior `server start --hosted` process from this worktree**

```bash
pkill -f 'packages/cli/index.ts server start --hosted' 2>/dev/null || true
sleep 1
```

- [ ] **Step 3: Bring up the new dev stack**

Run: `make dev-stack`
Expected: trailing output prints the Postgres + Redis URLs and a `Next:` hint. Both healthchecks should report `Healthy`.

- [ ] **Step 4: Build the web bundle (one-time prereq, out of automation scope)**

Run: `make build-web`
Expected: `packages/web/dist/index.html` exists at the end. If `make build-web` doesn't exist as a target, run the equivalent `cd packages/web && npx vite build`.

- [ ] **Step 5: Pick free ports for web + conductor**

```bash
WEB_PORT=8420
COND_PORT=19100
if lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN >/dev/null; then WEB_PORT=8421; fi
if lsof -nP -iTCP:$COND_PORT -sTCP:LISTEN >/dev/null; then COND_PORT=19101; fi
echo "WEB=$WEB_PORT COND=$COND_PORT"
```

Expected: prints two integers, neither in use.

- [ ] **Step 6: Boot the server in the background**

```bash
mkdir -p logs
set -a; source .env.control-plane; set +a
export ARK_DIR="$(pwd)/.ark-dev" \
       ARK_WEB_PORT=$WEB_PORT \
       ARK_CONDUCTOR_PORT=$COND_PORT
nohup bun packages/cli/index.ts server start --hosted --port $WEB_PORT > logs/control-plane.log 2>&1 &
echo "PID=$!"
sleep 12  # boot + migrations + lifecycle.start
```

Expected: a non-empty PID prints.

- [ ] **Step 7: Verify the boot did not crash**

```bash
pgrep -f 'server start --hosted' >/dev/null && echo OK || (echo CRASH; tail -40 logs/control-plane.log)
```

Expected: `OK`. If `CRASH` is printed, the tail of the log will show why.

- [ ] **Step 8: Hit the three smoke endpoints**

```bash
curl -fsS http://localhost:$WEB_PORT/api/health
echo
curl -fsS http://localhost:$COND_PORT/health
echo
curl -fsS -o /dev/null -w "HTTP=%{http_code} bytes=%{size_download}\n" http://localhost:$WEB_PORT/
```

Expected:
1. `{"ok":true,"version":"...","uptime":...}`
2. `{"status":"ok","arkDir":"..."}`
3. `HTTP=200 bytes=` followed by an integer > 1000 (the SPA index.html).

If all three pass, the smoke test is **green**.

- [ ] **Step 9: Tear down the server (leave the dev stack up for the next session)**

```bash
pkill -f 'packages/cli/index.ts server start --hosted'
```

- [ ] **Step 10: No commit -- this task is verification only.**

Capture the curl output in your shell scrollback or paste-into the PR description.

---

## Task 6: Open backlog issues for spec section 5 gaps

Each known gap deserves its own ticket so the deletion / fix work has a home.

**Files:**
- None (uses `gh issue create` against the upstream remote if configured; otherwise skip and leave a note in the PR description).

- [ ] **Step 1: Confirm there's an upstream `gh` remote**

Run: `gh repo view --json nameWithOwner -q .nameWithOwner 2>&1 | head -1`
Expected: a `<org>/<repo>` line. If it errors, skip Steps 2-5 and instead append a "Backlog (manual entry needed)" section at the bottom of the PR description in Task 7.

- [ ] **Step 2: File the knowledge-tables gap**

```bash
gh issue create \
  --title "postgres parity: initPostgresSchema missing knowledge / knowledge_edges tables" \
  --label bug,postgres \
  --body "Migration 013 (\`UPDATE knowledge SET type='eval_session' ...\`) crashes a fresh Postgres install because \`initPostgresSchema\` never creates the table. Repro + fix recipe in docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md section 5.1. The dev-stack bootstrap SQL papers over this; the proper fix moves the DDL into \`packages/core/repositories/schema-postgres.ts\` and removes the workaround."
```

- [ ] **Step 3: File the pty cols gap**

```bash
gh issue create \
  --title "postgres parity: sessions.pty_cols / pty_rows missing from initPostgresSchema" \
  --label bug,postgres \
  --body "The drizzle session schema declares \`pty_cols\` / \`pty_rows\` on both dialects; \`initPostgresSchema\` omits them, so runtime session-list queries crash. Repro + fix recipe in docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md section 5.2. The dev-stack bootstrap SQL papers over this; the proper fix adds the columns to \`packages/core/repositories/schema-postgres.ts\` and removes the workaround."
```

- [ ] **Step 4: File the build-web wiring gap**

```bash
gh issue create \
  --title "make dev-stack should build web bundle automatically" \
  --label enhancement \
  --body "Operator currently has to run \`make build-web\` separately before \`server start --hosted\` or the SPA returns 404. Wire it into \`make dev-stack\` (or a new \`make dev-stack-up\` aggregator)."
```

- [ ] **Step 5: File the Goal-1 cleanup ticket**

```bash
gh issue create \
  --title "Goal 1 cleanup: remove ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE override" \
  --label cleanup \
  --body "When local-mode code paths are deleted, drop the env override + LocalDiskBlobStore + FsSnapshotStore imports from \`packages/core/di/{storage,runtime}.ts\`. Replacements: \`S3BlobStore\` (already exists) and a new \`S3SnapshotStore\` against MinIO. Spec section 5.4."
```

- [ ] **Step 6: No commit; the issues are tracked in github.**

Note the issue numbers; reference them in the PR description.

---

## Task 7: Open the PR

Final integration step. The branch already has commits from Tasks 2-4; this task only handles the push + PR.

**Files:**
- None (uses `git push` and `gh pr create`).

- [ ] **Step 1: Sanity-check `make format` is clean**

Run: `make format && git diff --stat`
Expected: zero diff. If diff appears, commit it as `chore: prettier format` before continuing.

- [ ] **Step 2: Sanity-check `make lint` is clean**

Run: `make lint`
Expected: exit code 0 with zero warnings. If lint fails, address the issues and recommit.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/control-plane-mode
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat: laptop dev stack for control-plane mode" --body "$(cat <<'EOF'
## Summary
- One-command laptop dev stack (`make dev-stack`) for booting Ark in `control-plane` profile against real Postgres + Redis.
- Bootstrap SQL papers over two Postgres-parity bugs surfaced during the smoke loop (tracked separately).
- Dev-only env override (`ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE`) keeps `LocalDiskBlobStore` + `FsSnapshotStore` usable inside hosted mode while local-mode code paths still exist; tagged for deletion in Goal 1.

## Spec
docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md

## Plan
docs/superpowers/plans/2026-05-06-control-plane-laptop-smoke-test.md

## Test plan
- [ ] `make dev-stack` brings up Postgres + Redis with healthchecks
- [ ] `make build-web` succeeds (one-time prereq)
- [ ] `bun packages/cli/index.ts server start --hosted` boots without errors
- [ ] `curl http://localhost:8420/api/health` returns `{"ok":true,...}`
- [ ] `curl http://localhost:19100/health` returns `{"status":"ok",...}`
- [ ] Web UI renders at http://localhost:8420
- [ ] `make dev-stack-down` cleans up volumes

## Backlog (filed)
- [Postgres parity: knowledge tables](#)
- [Postgres parity: pty cols](#)
- [dev-stack should build web automatically](#)
- [Goal 1 cleanup: remove dev storage override](#)
EOF
)"
```

Replace the four `(#)` placeholders with the issue numbers from Task 6 before running.

- [ ] **Step 5: Capture the PR URL**

`gh pr view --json url -q .url` -- paste this back to the user.

---

## Self-Review Notes (carried out by the plan author)

1. **Spec coverage:**
   - Section 3 deliverables: docker-compose (Task 4), env file (Task 4), Makefile targets (Task 3), di patches (Task 4), spec file (already committed). The new `dev-stack-bootstrap.sql` (Task 2) is the spec amendment called out in the preamble.
   - Section 4 acceptance: Task 5 runs the three-curl loop end to end.
   - Section 5 backlog: Task 6 files all four items.
   - Section 6 sequencing: tasks 1-7 follow the spec's order with the bootstrap SQL inserted between original step 2 and step 3.

2. **Placeholder scan:** No "TBD", "later", or unresolved patterns. Each step contains the exact command/code/expected output. Issue body strings are concrete; only the `(#)` placeholders in the PR template are intentionally left for runtime substitution.

3. **Type / name consistency:** The Makefile target name is `dev-stack` everywhere. The compose project name is `ark-dev` everywhere. The bootstrap SQL filename is `.infra/dev-stack-bootstrap.sql` everywhere. The env file is `.env.control-plane` everywhere.
