# Plan: Final Fixes -- Close Out Round-3 Audit P1 Holdouts

## Summary

Most P0/P1 items from the round-3 code-quality audit (`docs/2026-04-24-code-quality-audit-round-3.md`) have already landed in the round-2-remediation branch (compute-resolver tenant scoping, LocalWorktreeProvider in boot, dispatcher same-provider exclusion, ApiKeyManager dedup, provider-registry singleton deletion). What remains are: (1) the local-daemon WS path's asymmetry with the hosted HTTP path on per-tenant router scoping (DI-backend P1-1, latent multi-tenant correctness bug), and (2) hygiene items the audit flagged but reality has narrowed to a single oversized test file plus one stray hand-rolled status badge in CLI. This is the final remediation PR before merging the branch.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/server/index.ts` | `addConnection`: resolve a tenant-scoped `app` per request from `ctx`, dispatch via that scope (mirror `hosted/web.ts:347-351`). |
| `packages/server/router.ts` | Allow `dispatch(req, notify, ctx, app?)` to thread a per-call scoped AppContext to handlers without re-registering. |
| `packages/server/handlers/session.ts`, `history.ts`, `messaging.ts`, `conductor.ts` | Migrate handlers that close over `app` at registration to read `app` from the per-call ctx (via `resolveTenantApp(ctx)` helper, already used by `sage.ts`/`costs.ts`/`schedule.ts`/`triggers.ts`/`knowledge-rpc.ts`). |
| `packages/server/handlers/scope-helpers.ts` | If not already exported, surface `resolveTenantApp(ctx)` as the canonical helper used by both transports. |
| `packages/server/__tests__/ws-tenant-scoping.test.ts` (NEW) | Asserts that two concurrent WS connections under different `tenant_id`s see scope-isolated `sessions`/`events` repos -- mirror `tenant-scoping.test.ts` but over the WS transport. |
| `packages/core/__tests__/agent-sdk-launch.test.ts` | Split 1027 LOC into three focused suites by topic. |
| `packages/core/__tests__/agent-sdk-launch-streaming.test.ts` (NEW) | Subset: streaming + chunk handling. |
| `packages/core/__tests__/agent-sdk-launch-errors.test.ts` (NEW) | Subset: error / retry / abort paths. |
| `packages/core/__tests__/agent-sdk-launch-transcript.test.ts` (NEW) | Subset: transcript writing + parsing. |
| `packages/cli/commands/session/view.ts:303-315` | Replace inline `chalk.green("PASS")/chalk.red("FAIL")` with `coloredStatusIcon` (or new `coloredPassFail` formatter); keep the rest of the file unchanged. |
| `packages/cli/formatters.ts` | Add `coloredPassFail(exit_status: string)` if `coloredStatusIcon` is not the right fit for `exit_status` semantics. |

No schema changes, no config surface changes, no migration. Pure code cleanup + one test split.

## Implementation steps

### Step 1 -- DI-backend P1-1: WS per-tenant router scoping

This is the security/correctness change. Goal: any handler that touches per-tenant state in the WS path must close over a tenant-scoped `app`, not the root.

1. Inspect `packages/server/index.ts:84-110` (`addConnection`) and confirm `this.resolveContext(conn)` already produces a `RpcContext` carrying the caller's `tenant_id` (it does -- it uses the root `app.apiKeys` to authenticate; see `:75-77`).
2. Confirm the canonical pattern lives in `hosted/web.ts:347-351`: build `requestApp = app.forTenant(ctx.tenantId)`, then either (a) build a fresh `Router` and `registerAllHandlers(rpcRouter, requestApp)` per call, or (b) pass `requestApp` through `dispatch(...)` so each handler can read it.
3. Pick (b) -- it avoids the "242 handlers re-registered per HTTP call" P2 the audit also flagged. Add an optional 4th argument to `Router.dispatch(req, notify, ctx, scopedApp?)` and thread it into the handler signature.
4. Update `addConnection` to compute `const scopedApp = ctx.tenantId && ctx.tenantId !== app.tenantId ? app.forTenant(ctx.tenantId) : app;` and call `this.router.dispatch(msg, this.notify.bind(this), ctx, scopedApp)`.
5. Audit handler files for ones that close over the registration-time root `app`. Confirm the asymmetry list from the audit: `session.ts`, `history.ts`, `messaging.ts`, `conductor.ts`. For each, change the handler body to prefer the per-call `scopedApp` over the closed-over `app` when available.
6. Apply the same change to `hosted/web.ts:347-351` so both transports go through one code path -- this also closes the per-request router-allocation P2.
7. Don't touch `sage.ts`, `costs.ts`, `schedule.ts`, `triggers.ts`, `knowledge-rpc.ts` -- they already use `resolveTenantApp(ctx)` and produce the correct scope without help.

### Step 2 -- WS tenant-scoping integration test

1. Create `packages/server/__tests__/ws-tenant-scoping.test.ts`.
2. Boot a single `AppContext.forTestAsync()`.
3. Open two WS clients to the same `ArkServer`, authenticated as different tenants (re-use the same auth fixture pattern as `hosted-web-tenant.test.ts`).
4. Issue `session/start` over each connection and assert: (a) `await app.forTenant(t1).sessions.list()` only sees t1's session; (b) the event repo write carries the correct tenant_id; (c) cross-tenant `session/get` for the other tenant's id returns null/error, not the row.
5. This is the WS-transport mirror of `tenant-scoping.test.ts` (which tests the in-process scope tree) and of the hosted-HTTP test (which covers the HTTP transport).

### Step 3 -- Split `agent-sdk-launch.test.ts`

1. Read the 1027-line file and group tests by topic. Expected groupings (verify against the file):
   - **streaming**: tests that drive `fakeStream()` with normal assistant/system/result chunks, partial chunks, multi-turn.
   - **errors**: tests that yield `is_error: true`, throw mid-stream, abort signals, retry.
   - **transcript**: tests that read back the on-disk transcript, prompt-file handling, exit-code semantics.
2. Create three sibling files. Move tests to whichever bucket they belong to. Keep the shared `makeTmpDir()` helper in a small `agent-sdk-launch-helpers.ts` if more than one file needs it.
3. Run `make test-file F=packages/core/__tests__/agent-sdk-launch-streaming.test.ts` (and the others) one at a time to verify nothing broke in the move.
4. The original file should end up empty -- delete it.
5. Target: each new file under 600 LOC.

### Step 4 -- CLI status-icon cleanup

1. `packages/cli/commands/session/view.ts:303-315` builds `statusIcon = exitStatus === "completed" ? chalk.green("PASS") : chalk.red("FAIL")`. Search the rest of `packages/cli/` for the same `chalk.green("PASS")|chalk.red("FAIL")` pattern (`grep -rn 'chalk\.\(green\|red\)("\(PASS\|FAIL\)")' packages/cli/`).
2. If only this one site uses it, inline the helper at the top of the same file -- a one-call abstraction is over-engineering. If two or more sites use it, add `coloredPassFail(status: "completed" | string): string` to `packages/cli/formatters.ts` and migrate all callers.
3. Don't touch `packages/cli/commands/misc/pr.ts:24` or `packages/cli/conductor.ts:56` unless their pattern is identical (the audit lumped them in but their semantics may differ).

### Step 5 -- Quality gate

1. `make format` -- mandatory before commit per CLAUDE.md "Before Committing".
2. `make lint` -- must be 0 warnings.
3. `make test-file F=packages/server/__tests__/ws-tenant-scoping.test.ts` -- new test passes.
4. `make test-file F=packages/core/__tests__/agent-sdk-launch-streaming.test.ts` etc. -- split test files all pass.
5. `make test-file F=packages/core/__tests__/tenant-scoping.test.ts` -- regression check on the in-process scope tree (must remain 31/31 green).
6. `make test` -- full suite, last gate.

## Testing strategy

**Existing tests to verify still pass (regression set):**
- `packages/core/__tests__/tenant-scoping.test.ts` -- the round-2 SCOPED DI assertions; must remain 31/31.
- `packages/server/__tests__/hosted-web-tenant.test.ts` (or equivalent) -- HTTP transport tenant scoping.
- `packages/core/__tests__/agent-sdk-launch*.test.ts` (the split files) -- combined coverage must equal pre-split: zero net change in test count.
- `packages/server/__tests__/router.test.ts` -- the new optional 4th arg on `dispatch` must not break call sites that don't pass it.

**New tests to add:**
- `packages/server/__tests__/ws-tenant-scoping.test.ts` -- explicit WS-transport assertion of per-tenant repo identity (Step 2). Cross-tenant data leak attempts must return null/error, not a row.

**Manual verification (one-time):**
- Start a hosted-mode local instance with two API keys (two tenants), make `session/start` calls from both via the WS daemon (e.g. `ark acp` over stdin). Confirm `~/.ark/ark.db` writes carry the correct `tenant_id` for each.
- This is belt-and-suspenders -- the integration test in Step 2 is the durable check.

## Risk assessment

**Step 1 (WS per-tenant scoping)** is the only step with non-trivial risk:

- **Behavior change in single-tenant mode**: must be a no-op. When `ctx.tenantId === app.tenantId`, `app.forTenant(...)` returns `app` unchanged (verify in `tenant-scope.ts`). Local-daemon single-user installs see no change.
- **Handler closure refactor surface**: `session.ts`, `history.ts`, `messaging.ts`, `conductor.ts` may have dozens of references to the closed-over `app`. The mechanical change is "read `scopedApp ?? app` at each entry point". The risk is missing one. Mitigation: grep for `app\.\(sessions\|events\|computes\|messages\|todos\|artifacts\|flowState\|ledger\)` in those four files and audit each hit.
- **`Router.dispatch` signature change** is additive (new optional arg). All existing call sites continue to work. Test-call-sites that hand-build dispatch calls don't need updates.
- **Per-request router rebuild in hosted/web.ts:347-351** -- removing the rebuild is a perf win but changes the lifetime of `Router` instances. If any handler depended on per-request router identity (it shouldn't), this would surface. Mitigation: keep the rebuild path under a feature flag for one release if any tests fail.

**Step 3 (test split)** is mechanical but has a small risk that two tests in different buckets share state via filesystem fixtures. Mitigation: each test already calls `makeTmpDir()` for isolation -- verify that pattern holds before splitting.

**Step 4 (CLI cleanup)** is cosmetic, near-zero risk.

**Breaking changes:** none -- no public API surface, no protocol change, no schema change, no config change.

**Migration concerns:** none.

## Open questions

1. **Should Step 1 unify both transports through a single helper?** Building a shared `dispatchScoped(app, router, msg, ctx)` helper used by both `addConnection` (WS) and `hosted/web.ts` (HTTP) would prevent future drift. The audit's cross-cutting pattern #2 explicitly calls out the asymmetry. **Autonomous decision:** yes, factor out a helper -- the cost is one new file, the upside is the asymmetry can't return. If implementer disagrees, inline the per-transport version is acceptable.
2. **Does `Router.dispatch` need a 4th arg, or should we put `scopedApp` on the `ctx` object?** Cleaner to extend `RpcContext` with an optional `scopedApp?: AppContext` field -- handlers that opt in read it; handlers that don't keep working. **Autonomous decision:** put it on `ctx`. Less signature churn, fewer call sites to touch.
3. **Test split granularity**: three files vs. two. If the streaming + transcript paths overlap heavily, two files (`-core` + `-errors`) may read better. Implementer's call after seeing the actual groupings.
4. **Should the boot-time `throw new Error` in `packages/server/handlers/metrics-local.ts:23` become an `RpcError`?** The audit flagged it, but it fires at registration, not request -- there's no caller to receive an `RpcError`. **Autonomous decision:** leave as-is. Document the rationale in a one-line comment if a future audit re-flags it.
5. **`useSmartPoll.ts` deletion (audit P2-2)**: the audit claimed it was orphaned, but `useDaemonStatus.ts:3` still imports it. **Autonomous decision:** skip, the audit was wrong. No change.
