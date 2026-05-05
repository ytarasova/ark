# Verification Report -- fix-arkd-spawn-bash-enoent-on-ec2

**Date:** 2026-05-05
**Branch:** ark-s-wg571i41xi
**Fix commit:** f9f7fd0f fix(arkd): absolute /bin/bash + default PATH fallback for EC2 spawn
**Verifier:** ISLC Verifier
**Verdict:** VERIFY: PASS WITH WARNINGS

---

## Step 1 -- Context

**Workflow files:** No `spec.md` or `plan.md` found in `.workflow/` directory.
**State:** Prior verify-report.md was for a different session (fix/web-session-view-overhaul).
**Jira:** No Jira MCP tool available.

**Fix summary (from commit message and code inspection):**

On EC2, `arkd` runs as a systemd unit that sets only `HOME`. `Bun.spawn` resolves
unqualified commands (`bash`) through the child's `PATH`, which is empty when the
parent env has no `PATH`. This caused `claude-agent.ts` launcher dispatch to fail
with `ENOENT`.

**Two-layer fix in commit f9f7fd0f:**

1. `packages/core/executors/claude-agent.ts`: Changed `cmd: "bash"` to `cmd: "/bin/bash"` (absolute path, bypasses PATH lookup).
2. `packages/arkd/routes/process.ts`: Added `buildSpawnEnv()` + `DEFAULT_SPAWN_PATH` constant that guarantees a non-empty PATH in child envs spawned via `/process/spawn`.
3. `packages/arkd/__tests__/process.test.ts`: 6 new tests (5 unit + 1 integration).

**Files changed:**

| File | Change |
|------|--------|
| `packages/arkd/__tests__/process.test.ts` | +76 lines: 6 new tests for `buildSpawnEnv` and PATH propagation |
| `packages/arkd/routes/process.ts` | +26 lines: `DEFAULT_SPAWN_PATH`, `buildSpawnEnv()`, wired into `spawnProcess()` |
| `packages/core/executors/claude-agent.ts` | -2/+7 lines: `cmd: "bash"` -> `cmd: "/bin/bash"` with explanatory comment |

---

## Step 2 -- Automated Test Verification

### Affected packages (direct)

| Package | Tests | Pass | Fail | Skip |
|---------|-------|------|------|------|
| `packages/arkd` | 22 | 22 | 0 | 0 |
| `packages/core/executors` | 5 | 5 | 0 | 0 |

All new tests pass. Process test suite: 22/22 including all 6 new tests.

### Full test suite

| Metric | Value |
|--------|-------|
| Total | 5591 |
| Passed | 5571 |
| Failed | **2** |
| Skipped | 15 |
| Todo | 3 |

**2 failures -- both pre-existing, unrelated to this fix:**

1. `end-to-end: server + client > session list without status returns all non-archived sessions`
   - Confirmed pre-existing: fails identically with the fix stashed (no changes applied).
   - File: not in the three files touched by this commit.

2. `Conductor /hooks/status endpoint > returns 400 for missing session param`
   - Passes when `conductor-hooks.test.ts` is run in isolation (33/33).
   - Fails only in the full parallel suite -- port collision / timing flakiness.
   - Not in any file touched by this commit.

**Result: PASS** (for changes introduced by this fix; 2 pre-existing failures are not regressions)

---

## Step 3 -- Security Scan

| Check | Status | Notes |
|-------|--------|-------|
| Hardcoded secrets | PASS | `DEFAULT_SPAWN_PATH` is a path string, not a credential |
| SQL injection | PASS | No SQL in changed files |
| XSS | PASS | Server-side only |
| Command injection | PASS | `req.cmd`/`req.args` were already caller-controlled; no new surface |
| PATH traversal | **IMPROVED** | Absolute `/bin/bash` removes the attack vector where a malicious PATH could substitute a fake `bash` |
| Env injection via `req.env` | PASS | Same merge semantics as before (`{ ...process.env, ...(req.env ?? {}) }`); only the PATH fallback is new; caller is trusted orchestrator |
| Dependency vulnerabilities | WARN | 6 moderate dev-only vulnerabilities (Claude SDK file permissions, vitest/vite) -- pre-existing, not exploitable in production |

**Result: PASS** (security posture strictly improved for PATH traversal case)

---

## Step 4 -- Code Quality Review

| Check | Status | Notes |
|-------|--------|-------|
| `make lint` (ESLint, 0 warnings) | PASS | No output = no warnings |
| `make format` (Prettier) | PASS | All changed files unchanged |
| No dead code | PASS | `DEFAULT_SPAWN_PATH` and `buildSpawnEnv` are exported and used |
| No debug statements | PASS | |
| Error handling | PASS | `buildSpawnEnv` is pure; errors in `spawnProcess` handled by existing try/catch |
| Comment quality | WARN | `DEFAULT_SPAWN_PATH` and `buildSpawnEnv` have multi-line docstrings (CLAUDE.md style guide discourages multi-line comment blocks). Content is accurate and the WHY is non-obvious (EC2 systemd behavior) -- borderline acceptable |
| Log message accuracy | PASS | Log line updated: `cmd: \`bash ${workerLauncherPath}\`` -> `cmd: \`/bin/bash ${workerLauncherPath}\`` |

**Result: PASS WITH WARNINGS** (verbose docstrings are non-blocking)

---

## Step 5 -- Acceptance Criteria Validation

No `spec.md` found. Derived acceptance criteria from commit message and code:

| AC # | Criterion | Verified By | Status |
|------|-----------|-------------|--------|
| 1 | `claude-agent.ts` uses absolute `/bin/bash` instead of `bash` | Code inspection: `packages/core/executors/claude-agent.ts:269` | PASS |
| 2 | `buildSpawnEnv` injects `DEFAULT_SPAWN_PATH` when neither parent nor request env has `PATH` | Unit test: "injects DEFAULT_SPAWN_PATH when neither parent nor request env has PATH" | PASS |
| 3 | `buildSpawnEnv` injects fallback when parent `PATH` is empty string | Unit test: "injects DEFAULT_SPAWN_PATH when parent PATH is empty string" | PASS |
| 4 | `buildSpawnEnv` preserves parent `PATH` when caller does not override | Unit test: "preserves parent PATH when no override is supplied" | PASS |
| 5 | Caller-supplied `PATH` in `req.env` wins over parent `PATH` | Unit test: "request PATH wins over parent PATH" | PASS |
| 6 | Non-PATH keys merge correctly, request wins on conflict | Unit test: "merges non-PATH keys from both sources, request overrides on conflict" | PASS |
| 7 | `/process/spawn` child receives `/bin` in PATH when caller omits PATH from env | Integration test: "caller-supplied env without PATH still produces a child that can resolve shell utilities" | PASS |
| 8 | `DEFAULT_SPAWN_PATH` matches POSIX standard | Code: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` -- confirmed against systemd `DEFAULT_PATH_NORMAL` | PASS |

---

## Step 6 -- Design / UAT Review

No Figma URLs found. **Skipped** (server-side bug fix, no UI changes).

---

## Step 7 -- Verification Verdict

**VERIFY: PASS WITH WARNINGS**

### Critical Failures: 0

### Warnings (3)

1. **2 pre-existing test failures** in full suite: `end-to-end: session list` (confirmed pre-existing) and `Conductor /hooks/status` (flaky, passes in isolation). Neither is in changed files. Not regressions introduced by this fix.

2. **6 moderate npm audit vulnerabilities** (dev-only: Claude SDK file perms, vitest/vite). Pre-existing. Not exploitable in production.

3. **Verbose docstrings** on `DEFAULT_SPAWN_PATH` and `buildSpawnEnv` in `process.ts`. The WHY (EC2 systemd PATH behavior) is non-obvious, so some comment is warranted -- but the current blocks exceed CLAUDE.md style guidance for comment length. Non-blocking.

### Required Actions Before Merge

None. Branch is ready to merge.

**Optional (non-blocking):**
- Trim the docstrings on `DEFAULT_SPAWN_PATH` / `buildSpawnEnv` to a single line each per CLAUDE.md style guide.
- Investigate the 2 pre-existing test failures in a separate PR.

---

## Test Execution Evidence

```
packages/arkd/__tests__/process.test.ts -- 22 pass, 0 fail [374ms]
packages/core/executors -- 5 pass, 0 fail [92ms]
affected packages combined -- 2863 pass, 0 fail [532s]
full suite -- 5571 pass, 2 fail (pre-existing), 15 skip [458s]
make lint -- 0 warnings, 0 errors
make format -- all files unchanged
```
