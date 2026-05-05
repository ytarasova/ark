# `packages/arkd/` client / server / common separation

**Status:** approved (spec)
**Date:** 2026-05-05
**Owner:** yana.tarasova@paytm.com
**Implementation:** single PR, see Section 5 for commit order
**Follow-ups (out of scope):** standalone arkd binary, breaking the `core/observability/structured-log.js` reverse-dep

## Goal

Refactor `packages/arkd/` from a flat layout (`client.ts`, `server.ts`, `internal.ts`, `types.ts`, `routes/`) into a three-bucket layout (`common/`, `client/`, `server/`) with enforced sub-path entry points, so that:

- A consumer of `ArkdClient` cannot accidentally pull in `Bun.spawn` / tmux / FIFO / `fs` server-side code via the import graph.
- Wire contracts (request/response types, control frames, error classes, name-pattern regex) live in one place that both sides depend on.
- The public surface of the package is exactly three barrels: `common/index.ts`, `client/index.ts`, `server/index.ts`. Deep imports into route files, helpers, or split internals are blocked at lint time.

## Non-goals

- Breaking the `core/observability/structured-log.js` and `core/constants.js` reverse-deps from `arkd/server/*`. Deferred.
- Producing a standalone `arkd` binary via `bun build --compile`. Deferred. Today's deployment model (`ark arkd <flags>` via the CLI subcommand on local + remote) stays.
- Renaming `routes/channel.ts` (legacy report/relay/deliver) vs `routes/channels.ts` (generic pub/sub). Names stay confusing for now; renaming is a separate decision.
- Retiring the legacy `/agent/*` tmux endpoints. Phase C work per existing comments; not this PR.
- Any wire-shape change (request, response, header, status, error envelope).
- Any behavior change to retry, FIFO sweep, control-plane heartbeat, auth path, attach lifecycle.

## Why

Current `packages/arkd/` (~3.4k LOC) has five problems:

1. **No client/server boundary.** `client.ts`, `server.ts`, and all `Bun.spawn` / `fs` route handlers sit as siblings. `compute/isolation/direct.ts` imports `ArkdClient` and is one bad import line away from dragging in `tmpdir`/`mkfifo`/tmux helpers.
2. **`internal.ts` is overloaded.** Mixes pure cross-cutting helpers, wire validators, server-only security primitives, and Bun shims under one roof.
3. **Deep imports from outside.** `compute/*` and `core/*` import from `"../arkd/client.js"` and `"../arkd/server.js"` directly. One test (`core/__tests__/arkd-events-consumer-channel.test.ts:31`) reaches into `"../arkd/routes/channels.js"` for `SUBSCRIBED_ACK`. The barrel `index.ts` exists but isn't enforced.
4. **Reverse-dep on `core`.** `arkd/server.ts` and every route module import `../core/observability/structured-log.js` and `../core/constants.js`. Acknowledged; not fixed in this PR.
5. **Wire constants live in routes.** `SUBSCRIBED_ACK` is a wire control frame consumed by the client iterator but defined inside `routes/channels.ts`.

## Decisions (locked from brainstorming)

- **Aggressiveness:** folder split + enforced sub-path exports + consumer migration in same PR. No back-compat shims at the public boundary.
- **Shipping:** one PR, authored as 7 commits for incremental review.
- **Common bucket scope:** wire types + wire constants + shared validators + error classes (`ArkdClientError`, `ArkdClientTransportError`, plus `ArkdError` envelope re-exported).
- **`index.ts` at the package root:** deleted. Bare `import "@ark/arkd"` no longer resolves -- the enforcement is structural, not advisory.
- **Tests:** stay flat under `packages/arkd/__tests__/`. One new test asserts the public barrel surface.
- **Lint enforcement:** ESLint `no-restricted-imports` blocks deep imports into `arkd/{server,client,common}/!(index).js` from outside the package.

## Section 1: Final layout

```
packages/arkd/
├── package.json                  (exports map, no `main`)
├── common/
│   ├── index.ts                  (barrel)
│   ├── types.ts                  (all wire request/response interfaces)
│   ├── constants.ts              (VERSION, DEFAULT_PORT, SAFE_TMUX_NAME_RE,
│   │                              SUBSCRIBED_ACK, AUTH_EXEMPT_PATHS)
│   ├── validation.ts             (requireSafeTmuxName)
│   └── errors.ts                 (ArkdClientError, ArkdClientTransportError;
│                                  re-exports ArkdError type from types.ts)
├── client/
│   ├── index.ts                  (barrel: ArkdClient + error class re-exports)
│   ├── client.ts                 (ArkdClient, ~350 lines)
│   ├── retry.ts                  (fetchWithRetry, isTransientTransportError)
│   └── ws-iterator.ts            (webSocketToAsyncIterable)
├── server/
│   ├── index.ts                  (barrel: startArkd, ArkdOpts, PathConfinementError)
│   ├── server.ts                 (Bun.serve loop + dispatcher, ~150 lines)
│   ├── auth.ts                   (checkAuth, token persistence, expectedAuth setup)
│   ├── control-plane.ts          (worker register / heartbeat / deregister)
│   ├── route-ctx.ts              (RouteCtx type + factory; ArkdOpts type)
│   ├── confinement.ts            (confineToWorkspace, PathConfinementError)
│   ├── exec-allowlist.ts         (EXEC_ALLOWED_COMMANDS)
│   ├── helpers.ts                (json, readStream, spawnRead, BunLike, BunSpawnProc)
│   ├── channel-bus.ts            (Map<channel,state>, publishOnChannel,
│   │                              channelWebSocketHandler, matchWsChannelPath,
│   │                              _resetForTests)
│   └── routes/
│       ├── file.ts
│       ├── exec.ts
│       ├── process.ts
│       ├── attach.ts
│       ├── agent.ts
│       ├── channels.ts           (HTTP/WS wrapper over channel-bus)
│       ├── channel.ts            (legacy report/relay/deliver)
│       ├── metrics-snapshot.ts
│       └── misc.ts
└── __tests__/                    (flat, 13 existing files + 1 new shape test)
```

## Section 2: File-by-file move map

### Top-level moves

| From | To | Notes |
|---|---|---|
| `index.ts` | *deleted* | After consumer migration |
| `types.ts` | `common/types.ts` | Content unchanged |
| `internal.ts` | *split into 6 files* | See breakdown below |
| `server.ts` | *split into 4 files* | See breakdown below |
| `client.ts` | *split into 3 files + `common/errors.ts`* | See breakdown below |
| `routes/*.ts` | `server/routes/*.ts` | Content unchanged except import paths; `routes/channels.ts` bisected |

### `internal.ts` (213 lines) split

| Symbol | New home |
|---|---|
| `VERSION`, `DEFAULT_PORT`, `AUTH_EXEMPT_PATHS`, `SAFE_TMUX_NAME_RE` | `common/constants.ts` |
| `requireSafeTmuxName` | `common/validation.ts` |
| `EXEC_ALLOWED_COMMANDS` | `server/exec-allowlist.ts` |
| `confineToWorkspace`, `PathConfinementError` | `server/confinement.ts` |
| `RouteCtx`, `ArkdOpts` | `server/route-ctx.ts` |
| `BunLike`, `BunSpawnProc` | `server/helpers.ts` |
| `json`, `readStream`, `spawnRead` | `server/helpers.ts` |

### `server.ts` (313 lines) split

| Section | New home |
|---|---|
| `checkAuth` + token persistence + `expectedAuth` setup | `server/auth.ts` |
| Control-plane register / heartbeat / deregister | `server/control-plane.ts` |
| `confine` closure + ctx construction + workspace root resolution | `server/route-ctx.ts` (factory function) |
| `Bun.serve` setup + WS upgrade + route dispatch + start/stop lifecycle | `server/server.ts` (~150 lines) |

### `client.ts` (581 lines) split

| Section | New home |
|---|---|
| `ArkdClient` class | `client/client.ts` (~350 lines) |
| `fetchWithRetry`, `isTransientTransportError`, retry delays | `client/retry.ts` |
| `webSocketToAsyncIterable` + `SUBSCRIBED_ACK` consumer logic | `client/ws-iterator.ts` |
| `ArkdClientError`, `ArkdClientTransportError` | `common/errors.ts` |

### `routes/channels.ts` (308 lines) bisection

| Section | New home |
|---|---|
| `Map<channel, state>`, `BROADCAST_CHANNELS`, `enqueue`, `publishOnChannel` | `server/channel-bus.ts` |
| `channelWebSocketHandler`, `matchWsChannelPath`, `_resetForTests` | `server/channel-bus.ts` |
| `ChannelWsData` interface | `server/channel-bus.ts` |
| `SUBSCRIBED_ACK` constant | `common/constants.ts` (also wire-relevant for the client iterator) |
| `handleChannelRoutes` (HTTP `POST /channel/{name}/publish` wrapper) | `server/routes/channels.ts` |

## Section 3: `package.json` exports + consumer migration

### `package.json`

```json
{
  "name": "@ark/arkd",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./common": "./common/index.ts",
    "./client": "./client/index.ts",
    "./server": "./server/index.ts"
  }
}
```

`"main"` removed. Bare `import "@ark/arkd"` errors with "no entry."

**Caveat:** the Ark monorepo has no Bun workspaces (per CLAUDE.md, "packages coordinated via relative imports" + "ES module `.js` extensions required"). Consumer import strings remain relative: `from "../arkd/server/index.js"` -- not `@ark/arkd/server`. The `exports` map is documentation + future tooling; enforcement is via the ESLint rule below.

### Barrel public surfaces

`common/index.ts`:
- All wire types from `common/types.ts` (`export type * from "./types.js"`)
- All wire constants from `common/constants.ts` (named re-export)
- `requireSafeTmuxName` from `common/validation.ts`
- `ArkdClientError`, `ArkdClientTransportError`, `ArkdError` (type) from `common/errors.ts`

`client/index.ts`:
- `ArkdClient` class
- Re-export of `ArkdClientError`, `ArkdClientTransportError` from `../common/errors.js` (so existing `from "../arkd/client"` usages keep both)

`server/index.ts`:
- `startArkd` function
- `ArkdOpts` type
- `PathConfinementError` (kept exported because tests assert it; `server.ts` re-exports it today)
- `VERSION` constant

### 23 consumer import sites

| File | Old | New |
|---|---|---|
| `packages/cli/commands/daemon.ts:135` | `../../arkd/index.js` | `../../arkd/server/index.js` |
| `packages/cli/commands/misc/arkd.ts:12` | `../../../arkd/index.js` | `../../../arkd/server/index.js` |
| `packages/cli/__tests__/daemon.test.ts:12` | `../../arkd/server.js` | `../../arkd/server/index.js` |
| `packages/server/index.ts:11` | `../arkd/client.js` | `../arkd/client/index.js` |
| `packages/server/__tests__/terminal-ws.test.ts:22` | `../../arkd/server.js` | `../../arkd/server/index.js` |
| `packages/server/__tests__/terminal-ws-tenant-gate.test.ts:31` | `../../arkd/server.js` | `../../arkd/server/index.js` |
| `packages/core/runtimes/claude-agent/user-message-stream.ts:32` | `../../../arkd/index.js` | `../../../arkd/client/index.js` |
| `packages/core/conductor/server/arkd-events-consumer.ts:38` | `../../../arkd/index.js` | `../../../arkd/client/index.js` |
| `packages/core/conductor/server/deliver-to-channel.ts:14` | `../../../arkd/client.js` | `../../../arkd/client/index.js` |
| `packages/core/services/worktree/pr.ts:32` | `../../../arkd/client.js` | `../../../arkd/client/index.js` |
| `packages/core/__tests__/arkd-events-consumer-channel.test.ts:31` | `../../arkd/routes/channels.js` (`SUBSCRIBED_ACK`) | `../../arkd/common/index.js` |
| `packages/compute/core/workspace-clone.ts:17` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/providers/arkd-backed.ts:10` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/isolation/direct.ts:10` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/isolation/docker.ts:23` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/isolation/devcontainer.ts:35` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/isolation/docker-compose.ts:23` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/__tests__/local-arkd.test.ts:16` | `../../arkd/server.js` | `../../arkd/server/index.js` |
| `packages/compute/__tests__/local-arkd.test.ts:17` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/__tests__/arkd-backed.test.ts:10` | `../../arkd/server.js` | `../../arkd/server/index.js` |
| `packages/compute/__tests__/devcontainer-runtime.test.ts:22` | `../../arkd/client.js` (type-only) | `../../arkd/client/index.js` |
| `packages/compute/__tests__/remote-arkd-cleanup.test.ts:23` | `../../arkd/client.js` | `../../arkd/client/index.js` |
| `packages/compute/__tests__/docker-runtime.test.ts:15` | `../../arkd/client.js` (type-only) | `../../arkd/client/index.js` |
| `packages/compute/__tests__/direct-runtime.test.ts:15` | `../../arkd/client.js` (type-only) | `../../arkd/client/index.js` |

Plus 13 internal `__tests__/` files in arkd that import from `../client.js`, `../server.js`, `../types.js`, `../internal.js`, `../routes/*.js` -- all rewritten to the new paths.

## Section 4: Tests + enforcement

### New test: `__tests__/exports-shape.test.ts`

~30 lines. Imports each barrel and asserts the public symbol set:

```ts
import * as common from "../common/index.js";
import * as client from "../client/index.js";
import * as server from "../server/index.js";

test("common barrel surface", () => {
  expect(Object.keys(common).sort()).toEqual([
    "ArkdClientError", "ArkdClientTransportError",
    "AUTH_EXEMPT_PATHS", "DEFAULT_PORT",
    "SAFE_TMUX_NAME_RE", "SUBSCRIBED_ACK",
    "VERSION", "requireSafeTmuxName",
  ]);
});
test("client barrel surface", () => {
  expect(Object.keys(client).sort()).toEqual([
    "ArkdClient", "ArkdClientError", "ArkdClientTransportError",
  ]);
});
test("server barrel surface", () => {
  expect(Object.keys(server).sort()).toEqual([
    "ArkdOpts", "PathConfinementError", "VERSION", "startArkd",
  ]);
});
```

The exact list will be confirmed during implementation; the test catches accidental re-exports (e.g. `EXEC_ALLOWED_COMMANDS` leaking into `common`) and drift from this spec.

### ESLint `no-restricted-imports` rule

Add to `eslint.config.js`:

```js
{
  files: ["packages/!(arkd)/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        {
          group: ["**/arkd/server/*", "!**/arkd/server/index.js"],
          message: "Import arkd server symbols from arkd/server/index.js (the barrel).",
        },
        {
          group: ["**/arkd/client/*", "!**/arkd/client/index.js"],
          message: "Import arkd client symbols from arkd/client/index.js (the barrel).",
        },
        {
          group: ["**/arkd/common/*", "!**/arkd/common/index.js"],
          message: "Import arkd common symbols from arkd/common/index.js (the barrel).",
        },
        {
          group: ["**/arkd/index.js", "**/arkd/index"],
          message: "The arkd top-level barrel was removed. Import from arkd/{client,server,common}/index.js.",
        },
      ],
    }],
  },
}
```

This is the structural enforcement that B (sub-path exports) was supposed to give us; without the lint rule, the "no workspaces" caveat means consumers can still type any path they want.

### Existing tests

All 13 files in `packages/arkd/__tests__/` keep their content. Updated imports only:

| File | Touch points |
|---|---|
| `client.test.ts`, `client-retry.test.ts`, `client-timeout.test.ts` | `from "../client.js"` -> `from "../client/index.js"`; `from "../internal.js"` -> appropriate split target |
| `server.test.ts`, `server-security.test.ts` | `from "../server.js"` -> `from "../server/index.js"` |
| `process.test.ts` | likely `from "../routes/process.js"` -> `from "../server/routes/process.js"` |
| `attach.test.ts`, `attach-sweep.test.ts` | `from "../routes/attach.js"` -> `from "../server/routes/attach.js"` |
| `channels.test.ts`, `channel-relay.test.ts` | `from "../routes/channels.js"` (or wherever) -> new path under `server/` |
| `codegraph-endpoint.test.ts` | route path swap |
| `security.test.ts` | likely confinement + validation -> new common/server paths |

## Section 5: Migration order within the PR

One PR, 7 commits. Each commit builds; `make test` passes; `make lint` passes after step 6.

1. **Skeleton + common types.** Create `common/`, `client/`, `server/`, `server/routes/`. Move `types.ts` -> `common/types.ts`. Make old `types.ts` re-export from new location. Internal arkd imports keep working.
2. **Split `internal.ts`.** Create `common/constants.ts`, `common/validation.ts`, `server/exec-allowlist.ts`, `server/confinement.ts`, `server/route-ctx.ts`, `server/helpers.ts`. Old `internal.ts` becomes a re-export shim that re-exports every symbol from its new home.
3. **Split `client.ts`.** Create `client/client.ts`, `client/retry.ts`, `client/ws-iterator.ts`, and `common/errors.ts`. Old `client.ts` becomes a re-export shim.
4. **Split `server.ts` + move routes.** Create `server/server.ts` (slimmed), `server/auth.ts`, `server/control-plane.ts`. Move all 9 routes under `server/routes/`. Bisect `routes/channels.ts` -> `server/channel-bus.ts` + `server/routes/channels.ts`. Move `SUBSCRIBED_ACK` to `common/constants.ts`. Old `server.ts` and `routes/` become re-export shims.
5. **Barrels + `package.json`.** Add `common/index.ts`, `client/index.ts`, `server/index.ts`. Update `package.json` (`exports`, drop `main`). Add `__tests__/exports-shape.test.ts`.
6. **Migrate consumers.** Update the 23 import sites in section 3. Add the ESLint `no-restricted-imports` rule. `make lint` now passes.
7. **Delete shims.** Remove `packages/arkd/{index.ts,types.ts,internal.ts,client.ts,server.ts}` and the old `routes/` directory (now under `server/routes/`). Run `make format && make lint && make test` clean.

## Risks

- **Test imports churn.** 13 internal test files plus 23 external consumers. Mechanical but easy to miss one. Mitigation: the `exports-shape.test.ts` plus `make lint` after step 6 would surface any miss.
- **`__tests__/codegraph-endpoint.test.ts` couples to `routes/misc.ts` internals.** Verify on read whether it imports anything beyond the route handler. If yes, decide: bend the test to the new path, or expose what it needs through a `server/routes/index.ts` test-helper barrel.
- **`server/route-ctx.ts` + `server/server.ts` cycle risk.** `server.ts` constructs the ctx; the ctx type and confine factory live in `route-ctx.ts`; routes import the type from `route-ctx.ts`. This is a tree, not a cycle. Verify nothing in `route-ctx.ts` reaches back into `server.ts`.
- **ESLint glob portability.** The `no-restricted-imports` `group` pattern uses ESLint's micromatch; the `!**/arkd/.../index.js` negation may need a different shape (`paths` rather than `patterns` with `importNames`). Verify against the project's existing `eslint.config.js` style during step 6.

## Success criteria

- `make test` green.
- `make lint` green (zero warnings, including the new `no-restricted-imports` rule).
- `make format` green.
- `__tests__/exports-shape.test.ts` passes -- public surface matches this spec.
- No deep imports survive: `grep -rn "from \"[./]*arkd/" packages/ --include="*.ts" | grep -vE "arkd/(client|server|common)/index\.js"` returns no matches outside `packages/arkd/`.
- `cat packages/arkd/index.ts` -- file does not exist.
- `cat packages/arkd/internal.ts` -- file does not exist.
