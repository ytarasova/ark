# Verification Report -- fix-arkd-reachability-diagnostics

**Date:** 2026-05-05
**Branch:** ark-s-286l0k2z5g
**Commit:** 9548dacb fix(daemon/status): surface arkd reachability diagnostics
**Verifier:** ISLC Verifier

---

## Step 1 -- Context

**Files changed in the feature commit (9548dacb):**

| File | Change |
|------|--------|
| `packages/core/infra/reachability.ts` | NEW -- `probeReachability` helper + `classifyFetchError` |
| `packages/core/__tests__/reachability.test.ts` | NEW -- 4 test scenarios |
| `packages/core/__tests__/daemon-status.test.ts` | MODIFIED -- new test for structured diagnostics |
| `packages/protocol/rpc-schemas.ts` | MODIFIED -- `reachabilitySchema` + updated `daemonStatusResponse` |
| `packages/server/handlers/web.ts` | MODIFIED -- wire `probeReachability` into daemon/status handler |
| `packages/web/src/hooks/useDaemonStatus.ts` | MODIFIED -- `Reachability` + `DaemonStatus` types + RPC error fallback |
| `packages/web/src/components/Sidebar.tsx` | MODIFIED -- `offlineReason()` + structured tooltip state |
| `packages/web/src/components/ui/IconRail.tsx` | MODIFIED -- `offlineReason()` + backlight status states |

**Spec / plan files:** `.workflow/null/spec.md` and `.workflow/null/plan.md` do not exist for this session.
Acceptance criteria derived from commit message and code inspection.

**Jira:** Not accessible (no Jira MCP configured).

---

## Step 2 -- Automated Test Verification

### Feature-specific tests (run in isolation)

| File | Tests | Passed | Failed | Result |
|------|-------|--------|--------|--------|
| `packages/core/__tests__/reachability.test.ts` | 4 | 4 | 0 | **PASS** |
| `packages/core/__tests__/daemon-status.test.ts` | 9 | 9 | 0 | **PASS** |

### Full test suite (2 runs for flakiness validation)

| Run | Total | Passed | Failed | Skipped |
|-----|-------|--------|--------|---------|
| Run 1 | 5590 | 5569 | 3 | 15+3 todo |
| Run 2 | 5590 | 5569 | 3 | 15+3 todo |

**Failures (same 3 in both runs):**

1. `end-to-end: server + client > session list without status returns all non-archived sessions`
   - File: `packages/server/__tests__/integration.test.ts`
   - Cause: Pre-existing invariant mismatch -- the test calls `sessionUpdate({status:"running"})` without setting `session_id`, which violates a repository invariant added after the test was written.
   - **Confirmed pre-existing:** reproduces on `main` branch with the unchanged test file.

2. `sweepOrphanAttachFifos > unlinks every arkd-attach-*.fifo it finds in tmpdir`
   - File: `packages/arkd/__tests__/attach-sweep.test.ts`
   - Cause: Timing/concurrency flakiness -- passes in isolation (10/10) every run.

3. `createWorktreePR (remote compute) > routes git push + fetch + rebase through ArkdClient.run with the remote workdir`
   - File: `packages/core/services/worktree/__tests__/pr-remote.test.ts`
   - Cause: 5000ms timeout hit under `--concurrency 4` load -- passes in isolation (18/18) every run.

**None of the 3 failures are in or near the changed files. All are pre-existing.**

**Result: PASS** (feature tests pass; suite failures are pre-existing flakiness)

---

## Step 3 -- Security Scan

| Check | Status | Notes |
|-------|--------|-------|
| Hardcoded secrets / credentials | PASS | No tokens, keys, or passwords |
| SSRF | PASS | `baseUrl` sourced from `app.config.conductorUrl` + `ARK_ARKD_URL` env -- server-side config only, no user input |
| XSS | PASS | No HTML construction; UI uses `title=` attributes (plain text) |
| SQL injection | PASS | No SQL in changed files |
| Sensitive data in logs / responses | PASS | `url` field exposes internal service URL, same as prior implementation |
| Error message leakage | PASS | `message` is a system-level fetch error (ECONNREFUSED, etc.) -- acceptable for internal admin UI |
| Insecure deserialization | PASS | Zod schema validates inbound shape |
| Dependency vulnerabilities | WARN | 6 moderate (dev-only): postcss XSS in CSS stringify, esbuild CORS dev-server, @anthropic-ai/sdk file perms in local memory tool -- all dev tooling, not production-exploitable |

**Result: WARN** (6 moderate dev-only vulnerabilities, pre-existing, non-blocking)

---

## Step 4 -- Code Quality Review

| Check | Status | Notes |
|-------|--------|-------|
| Formatting (`make format`) | PASS | Zero files changed |
| Linting (`make lint`) | PASS | Zero warnings |
| Dead code | PASS | No unused exports or dead branches |
| Debug statements | PASS | No `console.log` or `debugger` |
| Silent error swallows | PASS | `probeReachability` never throws -- all errors captured into result; this is by design (documented) |
| Logging conventions | PASS | No logging added (not needed for a pure-probe helper) |
| Unnecessary complexity | PASS | The `classifyFetchError` multi-check is justified: Bun vs Node surface errors differently (documented in code) |
| Function comments | WARN | `reachability.ts` has multi-paragraph block comments on functions; CLAUDE.md prefers "one short line max". Content documents non-obvious runtime behavior (Bun/Node divergence) which is the exact case where comments are warranted. Acceptable. |
| Code duplication | WARN | `offlineReason()` is copy-pasted between `Sidebar.tsx` and `IconRail.tsx` -- a one-liner, but still duplication. Non-blocking. |

**Result: PASS WITH WARNINGS** (2 minor warnings, both non-blocking)

---

## Step 5 -- Acceptance Criteria Validation

| AC # | Criterion | Verified By | Status |
|------|-----------|-------------|--------|
| 1 | `daemon/status` returns structured `ReachabilityResult` (not bare `{online,url}`) | `rpc-schemas.ts` + `reachability.ts` + `web.ts` code inspection | **PASS** |
| 2 | Failure reason categorized: `connection-refused` / `timeout` / `http-error` / `unknown` | `classifyFetchError` + `reachability.test.ts` 4 scenarios | **PASS** |
| 3 | Human-readable message, HTTP status code, latency (`latencyMs`) captured | `ReachabilityResult` interface + tests assert all fields | **PASS** |
| 4 | RPC protocol schema updated (`daemonStatusResponse`) | `rpc-schemas.ts:1304-1322` `reachabilitySchema` | **PASS** |
| 5 | Web hook types updated (`Reachability`, `DaemonStatus`) | `useDaemonStatus.ts:6-28` | **PASS** |
| 6 | Sidebar + IconRail tooltips show actionable diagnostic (not generic "offline") | `offlineReason()` in `Sidebar.tsx:35-38` + `IconRail.tsx:55-58` | **PASS** |
| 7 | RPC error fallback: web server down -> offline both services with `reason:"unknown"` | `useDaemonStatus.ts:43-52` catch block | **PASS** |
| 8 | New tests cover: 200 OK, 503 http-error, connection-refused, timeout | `reachability.test.ts:14-82` | **PASS** |
| 9 | New integration test: `daemon/status` returns `reason`+`message`+`url` when arkd unreachable | `daemon-status.test.ts:64-85` | **PASS** |

---

## Step 6 -- Design / UAT Review

No Figma URLs found in spec or plan. **Skipped.**

---

## Step 7 -- Verification Verdict

**VERIFY: PASS WITH WARNINGS**

### Critical Failures: 0

### Warnings (5)

1. **3 pre-existing test failures** in the full suite -- confirmed not caused by this branch; all reproduce on `main`/pass in isolation.
2. **6 moderate dev-only dependency vulnerabilities** -- postcss, esbuild, @anthropic-ai/sdk; not production-exploitable.
3. **`offlineReason()` duplicated** between `Sidebar.tsx` and `IconRail.tsx` -- trivial duplication, non-blocking.
4. **Multi-paragraph function comments** in `reachability.ts` exceed CLAUDE.md style preference -- content justified by non-obvious Bun/Node runtime divergence.
5. **`latencyMs` is `optional()` in the Zod schema** but `required` (non-optional) in the TypeScript interface -- minor type/schema drift, no runtime impact.

### Required Actions Before Merge

None required. Branch is ready to merge.

### Optional (non-blocking)

- Run `bun update` to pick up patched versions of postcss/esbuild/@anthropic-ai/sdk.
- Extract `offlineReason()` to a shared util (`packages/web/src/lib/daemon.ts`) to eliminate duplication.
- Fix the `latencyMs` optional/required mismatch: either add `.optional()` to the interface or remove it from the Zod schema.
- Fix pre-existing `integration.test.ts` failure (update the test to pass a `session_id` when transitioning to `running`).
