# Codebase Review Report

**Date:** 2026-04-15
**Branch:** `docs/code-review`
**Reviewer:** Automated deep-dive (Claude Opus 4.6)

---

## Critical Issues (fix immediately)

### SEC-1: Path traversal in static file serving (web.ts + web-proxy.ts)

**Files:** `packages/core/hosted/web.ts:385`, `packages/core/hosted/web-proxy.ts:129`

`path.join(WEB_DIST, url.pathname)` does NOT prevent directory traversal. A request to
`GET /../../etc/passwd` resolves to `/etc/passwd` because `path.join('/foo/bar', '/../../../etc/passwd')` returns `/etc/passwd`.

No path prefix validation exists after the join. An attacker can read any file the process can access.

**Fix:** After joining, verify the resolved path starts with `WEB_DIST`:
```ts
const resolved = resolve(WEB_DIST, "." + url.pathname);
if (!resolved.startsWith(resolve(WEB_DIST))) return new Response("Not Found", { status: 404 });
```

### SEC-2: ArkD has zero authentication

**File:** `packages/arkd/server.ts`

ArkD exposes arbitrary file read/write (`/file/read`, `/file/write`), arbitrary command execution (`/exec`), and directory listing -- all without any authentication. It binds to `0.0.0.0` by default.

Any host that can reach port 19300 can:
- Read/write any file on the system
- Execute arbitrary commands
- Launch/kill tmux sessions

**Fix:** Add shared-secret auth (e.g., `Authorization: Bearer <token>` checked against `ARK_ARKD_TOKEN` env var). At minimum, bind to `127.0.0.1` by default instead of `0.0.0.0`.

### SEC-3: ArkD /exec endpoint allows arbitrary command execution without input validation

**File:** `packages/arkd/server.ts:427-458`

The `/exec` endpoint takes a `command` string and `args` array directly from the request body and passes them to `Bun.spawn()` without any validation, allowlisting, or sandboxing. Combined with SEC-2 (no auth), this is a remote code execution vulnerability.

### SEC-4: GitHub webhook endpoint has no signature verification

**File:** `packages/core/hosted/web.ts:357-372`

The `/api/webhooks/github/issues` endpoint accepts webhook payloads without verifying the `X-Hub-Signature-256` header. Any party can forge webhook events to trigger session creation or dispatch.

### SEC-5: No rate limiting on authentication endpoints

**Files:** `packages/core/auth/middleware.ts`, `packages/core/hosted/web.ts`

API key validation has no rate limiting. An attacker can brute-force API keys at network speed. API keys are `ark_<tenantId>_<48-hex-chars>` -- the tenant ID portion is guessable (often "default"), reducing the search space.

---

## Important Issues (fix soon)

### SEC-6: CORS wildcard origin allows cross-origin attacks

**Files:** `packages/core/hosted/web.ts:52-56`, `packages/core/hosted/web-proxy.ts:30-34`

`Access-Control-Allow-Origin: *` with `Authorization` in allowed headers means any website can make authenticated API calls to an Ark instance if the user has the dashboard open. This enables CSRF-style attacks.

**Fix:** Restrict to specific origins or reflect the `Origin` header with validation.

### SEC-7: Conductor extracts tenant ID from unauthenticated header

**File:** `packages/core/conductor/conductor.ts:66-75`

`extractTenantId()` trusts the `X-Ark-Tenant-Id` header or parses it from the Bearer token format without actually validating the token. Any caller can impersonate any tenant by setting this header. The conductor has no auth middleware.

### SEC-8: Router server has no authentication

**File:** `packages/router/server.ts`

The LLM router server binds to `0.0.0.0` with no authentication. Anyone on the network can use it to proxy LLM API calls, consuming tokens and incurring costs.

### ARCH-1: session-orchestration.ts is a 2,995-line god file

**File:** `packages/core/services/session-orchestration.ts`

Six functions exceed 100 lines:
- `dispatch()` -- 339 lines
- `advance()` -- 240 lines
- `worktreeDiff()` -- 167 lines
- `finishWorktree()` -- 155 lines
- `executeAction()` -- 105 lines
- `_launchAgentTmux()` -- 103 lines

This file handles start, dispatch, advance, stop, resume, clone, handoff, fork/join, worktree operations, and more. It should be broken into at least 4-5 modules (dispatch, advance, worktree, lifecycle, utils).

### ARCH-2: app.ts is a 1,078-line god class

**File:** `packages/core/app.ts`

`AppContext` is the central DI container, config loader, boot orchestrator, schema migrator, plugin loader, and session-event broadcaster all in one class. The `boot()` method alone is enormous.

### ARCH-3: Excessive module-level mutable state

19+ module-level `let` variables across the codebase act as implicit singletons: `_app`, `_pool`, `_tmuxBin`, `_level`, `_components`, `_arkDir`, `_config`, `_buffer`, `_flushTimer`, `_activeProfile`, `_ghExec`, `_hotkeys`, etc.

This makes testing unreliable (global state leaks between tests) and prevents running multiple instances. The DI container (awilix) should manage these lifetimes.

### CODE-1: 311 empty catch blocks across production code

Empty `catch {}` blocks silently swallow errors. While some are legitimate (best-effort operations like tmux cleanup), many mask real failures. Each should at minimum have a comment explaining why the error is safe to ignore, and ideally log at debug level.

### CODE-2: `now()` helper duplicated 9 times

**Files:** `repositories/session.ts`, `repositories/compute.ts`, `repositories/todo.ts`, `repositories/compute-template.ts`, `repositories/message.ts`, `repositories/artifact.ts`, `repositories/event.ts`, `auth/api-keys.ts`, `schedule.ts`

The identical `function now(): string { return new Date().toISOString(); }` is copy-pasted across 9 files. Extract to a shared utility.

### CODE-3: New Router instance created per non-default tenant request

**File:** `packages/core/hosted/web.ts:343-348`

For every RPC request from a non-default tenant, a new `Router` is instantiated and all handlers are re-registered:
```ts
rpcRouter = new Router();
registerAllHandlers(rpcRouter, requestApp);
rpcRouter.markInitialized();
```
This is wasteful and could cause GC pressure under load. Cache routers per tenant.

---

## Minor Issues (fix when convenient)

### CODE-4: Excessive `any` types in repository code

**Files:** `packages/core/repositories/session.ts:158`, `compute.ts:103`

`const params: any[] = [...]` appears throughout repositories. These should be typed as `(string | number | null)[]` or use a proper union.

### CODE-5: `proxyToCondutor` typo

**File:** `packages/arkd/server.ts:857`

Function name is `proxyToCondutor` (missing 'c' in 'Conductor'). Appears in 3 call sites.

### CODE-6: Missing `.ico` and `.woff2` in static file serving

**File:** `packages/core/hosted/web.ts:377-383`

Only `.js`, `.css`, `.svg`, `.png` are served. Missing: `.ico` (favicon), `.woff`, `.woff2` (fonts), `.json` (manifest), `.map` (source maps).

### CODE-7: `Bun` type declared twice via `declare const`

**Files:** `packages/arkd/server.ts:8-29`, `packages/core/conductor/conductor.ts:15-19`

Both arkd and conductor declare their own minimal `Bun` type instead of using `@types/bun` which is already a devDependency.

### CODE-8: Dead/unreachable SPA routing

**File:** `packages/core/hosted/web.ts:394`

The SPA only serves `index.html` for `/` or `/index.html` exactly. Client-side routes like `/sessions/s-abc123` will return 404 instead of the SPA shell. This breaks browser refresh/direct navigation.

**Fix:** Serve `index.html` for all non-API, non-static routes (the standard SPA catchall pattern).

### CODE-9: Heavy AWS SDK dependencies

**File:** `package.json`

`@aws-sdk/client-ec2` and `@aws-sdk/client-cost-explorer` are top-level dependencies loaded for all users, even those not using EC2 compute. These are large packages. Consider lazy `import()` or moving to optional dependencies.

---

## Architecture Recommendations

### ARCH-R1: Break up session-orchestration.ts

Split into:
- `dispatch.ts` -- session dispatch logic
- `advance.ts` -- stage advancement and flow routing
- `worktree.ts` -- git worktree operations (diff, finish, cleanup)
- `lifecycle.ts` -- stop, resume, clone, fork/join
- `launch.ts` -- agent launching (tmux, arkd)

Each function already takes `app: AppContext` as first arg, so extraction is mechanical.

### ARCH-R2: Add auth to internal services

ArkD, conductor, and router all run as HTTP servers with no authentication. In a multi-tenant or networked deployment, any of these can be accessed by unauthorized parties. Implement a shared-secret or mTLS scheme for internal service communication.

### ARCH-R3: Reduce module-level mutable state

Move singleton state into the DI container (awilix). The `AppContext` already manages most dependencies -- extend it to cover `McpPool`, telemetry config, OTLP config, profile state, and poller exec functions.

### ARCH-R4: Consider workspace/monorepo tooling

`package.json` has a flat dependency list mixing CLI, backend, frontend, AWS SDK, Kubernetes client, React, Recharts, xterm, and Electron concerns. A user running only the CLI still installs React and AWS SDK. Consider Bun workspaces or at least splitting optional/peer dependencies.

### ARCH-R5: Standardize error handling

The codebase uses three patterns:
1. `safeAsync()` -- logs and returns boolean
2. Empty `catch {}` -- silent swallow
3. `try/catch` with `logError()` -- structured

Establish one or two patterns as standard and lint for the rest.

---

## Test Coverage Gaps

### Packages with low test-to-source ratios

| Package | Source files | Test files | Ratio |
|---------|-------------|------------|-------|
| cli     | 31          | 4          | 0.13  |
| web     | 31          | 8          | 0.26  |
| types   | 11          | 0          | 0.00  |

### Core modules with zero tests

Critical untested modules:
- `claude/claude.ts` (742 lines) -- agent launching, MCP config, settings injection
- `claude/sessions.ts` (419 lines) -- Claude session discovery and parsing
- `hosted/terminal-bridge.ts` -- WebSocket terminal bridge
- `hosted/web-proxy.ts` -- remote proxy server
- `hosted/server.ts` -- hosted mode server
- `database/postgres.ts` -- PostgreSQL adapter
- `database/sqlite.ts` -- SQLite adapter
- `executors/claude-code.ts` -- Claude Code executor
- `executors/status-poller.ts` -- session status polling
- `repositories/schema.ts` -- database schema
- `session-launcher.ts` -- session launch coordination
- `worktree-merge.ts` -- worktree merge logic
- `provider-registry.ts` -- compute provider registry

### Missing edge case coverage

- No tests for path traversal in web server static file serving
- No tests for concurrent session dispatch race conditions
- No tests for SSE client cleanup on disconnect
- No tests for tenant isolation boundaries (cross-tenant data leakage)
- No tests for API key brute-force resistance
- No tests for WebSocket terminal bridge security

---

## Security Findings

| ID    | Severity | Finding                                            | Location                       |
|-------|----------|----------------------------------------------------|---------------------------------|
| SEC-1 | Critical | Path traversal in static file serving              | web.ts:385, web-proxy.ts:129   |
| SEC-2 | Critical | ArkD has zero authentication (file/exec/agent ops) | arkd/server.ts                 |
| SEC-3 | Critical | Arbitrary command execution via /exec              | arkd/server.ts:427             |
| SEC-4 | High     | GitHub webhook has no signature verification       | web.ts:357                     |
| SEC-5 | High     | No rate limiting on API key validation             | auth/middleware.ts             |
| SEC-6 | Medium   | CORS wildcard with Authorization header            | web.ts:52, web-proxy.ts:30    |
| SEC-7 | High     | Conductor trusts unauthenticated tenant header     | conductor.ts:66                |
| SEC-8 | Medium   | Router server has no authentication                | router/server.ts               |

---

## Frontend-Specific Findings

### Oversized components (>300 lines)

| Component          | Lines | Recommendation                    |
|--------------------|-------|-----------------------------------|
| ComputeView.tsx    | 934   | Split: form, snapshot, metrics    |
| SessionDetail.tsx  | 738   | Split: tabs, timeline, actions    |
| HistoryView.tsx    | 664   | Split: list, detail, search       |
| AgentsView.tsx     | 594   | Split: list, editor, preview      |
| NewSessionModal.tsx| 534   | Split: form sections              |
| DesignPreviewPage  | 520   | Split: examples into sub-components|
| FlowsView.tsx      | 453   | Split: list, editor               |
| MemoryView.tsx     | 419   | Split: list, detail               |

### Accessibility

81 interactive elements (`<button>`, `<input>`, etc.) lack `aria-label` or `role` attributes. Screen reader support is minimal.

### useEffect without cleanup

Multiple `useEffect` hooks in `ComputeView.tsx` set up async fetches without cleanup:
```ts
useEffect(() => {
  api.listComputeTemplates().then(setTemplates).catch(() => {});
}, []);
```
If the component unmounts before the fetch resolves, this causes a setState-on-unmounted warning and potential memory leak. Use an abort controller or a `mounted` flag.

### Loading/error state coverage

Only 17 instances of loading/error state handling across all web components. Many views fetch data and render optimistically without showing loading spinners or error messages.
