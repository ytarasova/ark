# Frontend DI Assessment

Date: 2026-04-19
Scope: `packages/web` (Vite + React) and `packages/desktop` (Electron shell).
Author: audit agent on branch `audit/a11y` worktree.

## Recommendation (TL;DR)

**Do nothing new. Keep React Context + hooks. Optionally formalize a tiny
"create-context" helper later if we grow past 3 more providers -- not now.**

The frontend already has the right shape: one root-mounted
`TransportProvider` around a `WebTransport` interface
(`packages/web/src/transport/types.ts`), a `QueryClientProvider` for
react-query, a `ThemeProvider`, and hooks that call a module-level `api`
singleton which `TransportProvider` rebinds synchronously on mount
(`packages/web/src/transport/TransportContext.tsx:35`). That pattern was
introduced explicitly to avoid a DI library (see prior note at
`.workflow/audit/5-frontend-di.md`) and it is working: `MockTransport`
swaps in cleanly for unit tests
(`packages/web/src/__tests__/transport-mock.test.ts`), Playwright e2e
hits real HTTP so no injection is needed there, and Electron piggy-backs
on the same HTTP origin without an IPC bridge
(`packages/desktop/main.js`, `packages/desktop/preload.js`).

A DI container (inversify, tsyringe, awilix) would add weight, runtime
metadata plumbing, and a second paradigm alongside React context, with
no test or ergonomics win visible in this codebase. Backend already uses
awilix; sharing it across the HTTP boundary is not a goal and would
leak server-side lifecycle concerns into the SPA.

**Agent 7 handoff:** transport injection is **not** changing. Keep using
`api` from `hooks/useApi.js` and `useTransport()` from
`transport/TransportContext.js`. Nothing to wait on.

## 1. Current state

Dependencies flow through three root providers in `App.tsx` and one
module-level setter the providers rebind on mount. Components either
call the `api.*` singleton directly or read a context via a hook.

```tsx
// packages/web/src/App.tsx:207-215
root.render(
  <TransportProvider transport={new HttpTransport()}>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="midnight-circuit">
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </TransportProvider>,
);
```

Dependency surfaces:

- **HTTP/SSE transport** -- `WebTransport` interface injected via
  context (`transport/types.ts:12`) + rebinds a module-level transport
  via `setTransport()` (`hooks/useApi.ts:66`) so the 28 files that
  import `api` directly keep working. SSE uses the context version
  (`hooks/useSse.ts:2`).
- **React-query client** -- single module-level `QueryClient`
  (`providers/QueryProvider.tsx:3`).
- **Theme + color mode** -- `ThemeProvider` context with
  `useTheme()` hook (`themes/ThemeProvider.tsx:90`).
- **Auth token** -- read from URL param or `localStorage` once inside
  `HttpTransport` (`transport/HttpTransport.ts:20`). No AuthContext.
- **Feature flags** -- `READ_ONLY` + `AUTH_REQUIRED` read once from
  `<div id="root" data-readonly data-auth>` at bootstrap
  (`App.tsx:33-34`) and then prop-drilled. No `useFeature` helper.
- **Daemon status** -- `useDaemonStatus()` hook creates its own
  polling instance in `App.tsx:53` and the result is prop-drilled.

## 2. Findings (pain points, file:line)

1. **Prop-drilling of cross-cutting concerns.** `readOnly`,
   `daemonStatus`, `onNavigate`, `onToast` are declared on every page
   component (10 page props types, 30+ declaration sites). Example:
   `packages/web/src/pages/SessionsPage.tsx:12-22`,
   `packages/web/src/pages/HistoryPage.tsx:11-13`,
   `packages/web/src/pages/ToolsPage.tsx:13-15`. These are stable,
   app-global values -- ideal context candidates, not DI-container
   candidates. Migration cost: low (one afternoon).

2. **Direct singleton import of `api`.** 28 files do
   `import { api } from "../hooks/useApi.js"` (grep result across
   `packages/web/src`). The module-level setter pattern at
   `hooks/useApi.ts:63-73` means tests can swap transports, but you
   cannot render a subtree with two different transports because the
   singleton is shared. Today nothing needs that. If we ever grow a
   storybook / split preview that does, components should move to
   `useTransport().rpc(...)` instead of `api.*`. Not urgent.

3. **`HttpTransport` is instantiated twice at bootstrap.** Once in
   `transport/TransportContext.tsx:10` (as the default for the
   context) and again in `App.tsx:208` (`new HttpTransport()` passed
   to `<TransportProvider>`). The second wins via the synchronous
   `setTransport()` in `transport/TransportContext.tsx:35`. Harmless
   but confusing. One-line cleanup -- outside DI scope.

4. **Theme coupling in CommandPalette.** `App.tsx:63-108` reads
   `useTheme()` to build `cmdkItems` at the top of the App component,
   which forces a re-render of every page on any theme change. Not a
   DI problem; a memoization refactor when Agent 7 touches App.

5. **No AuthContext / no auth observability.** Token is read once in
   `HttpTransport`'s constructor from URL or localStorage
   (`transport/HttpTransport.ts:20`). There is no way for the UI to
   observe a token expiry, refresh, or logout beyond a full reload.
   LoginPage (`App.tsx:28-31, 110-116`) sets `authenticated` state
   but does not propagate the new token into the already-constructed
   `HttpTransport`. Soft bug. Fixable with a tiny AuthContext that
   rebuilds `HttpTransport` on token change -- again, React context,
   not DI.

## 3. Options matrix

| Option | Pros | Cons | Migration cost |
|---|---|---|---|
| (a) Do nothing -- keep current context + module singleton | Zero churn; already proven; MockTransport works; Electron identical | Prop-drilling of `readOnly`/`daemonStatus`/`onNavigate`/`onToast` stays; no `AuthContext` for token rotation | 0 h |
| (b) Formalize with `createCtx<T>()` helper + small `AppShellContext` for `readOnly`, `daemonStatus`, `navigate`, `toast` | Removes ~40 prop declarations; typed-context pattern is the standard React idiom; easy to test | One new file (`lib/createCtx.ts`); small coordination with Agent 7 who is mid-migration | 4-6 h |
| (c) Adopt inversify / tsyringe | Class-based, decorator injection | Requires `experimentalDecorators` + `reflect-metadata`; `tsconfig` is `strict: false` so decorator typing is brittle; bundle weight (~15 kB gz for inversify); alien paradigm next to React hooks; cannot inject into function components without a wrapper | 3-5 days; high risk, low return |
| (d) Share awilix with backend via a composition-root module | Consistency with `packages/core/container.ts` | Awilix expects Node-y `require` resolution; ships fine to ESM but pulls polyfills; client-side code cannot meaningfully share backend lifetimes (per-request vs per-tab); couples SPA builds to server module graph | 2-3 days + permanent coupling tax; rejected |

Notes on backend choice: ADR-004 (`.workflow/audit/4-di-adr.md`)
confirms awilix for the backend specifically because it is
decorator-free and Bun-compatible. That reasoning does not transfer
to the React side, which already has React Context as its native DI
mechanism.

## 4. Recommendation

**Option (a) -- do nothing -- is the right call today.**

Reasons:

1. The transport seam that a DI library would buy us already exists as
   a one-method interface (`WebTransport`) and is already injectable
   via React context. The unit-test story works (see
   `__tests__/transport-mock.test.ts`). A DI container would re-solve
   a solved problem.
2. Electron loads the SPA over `http://localhost:<port>` and uses the
   same `HttpTransport`; there is no second transport to swap.
   `preload.js` exposes only `{platform, isElectron}` -- no ark RPC
   crosses IPC. DI would have nothing to resolve differently here.
3. Playwright e2e runs against a real server by design; it does not
   need injection. Bun component tests mount with `TransportProvider
   transport={mock}` today without module mocking -- `bun:test` is
   not even invoked with `mock.module` anywhere under
   `packages/web`.
4. The real pain points found (prop-drilling of `readOnly` /
   `daemonStatus` / `onNavigate` / `onToast`; missing AuthContext)
   are fixed by **adding one or two React contexts**, not by adopting
   a DI container. That is Option (b) and can be picked up any time
   as a small follow-up -- it is an incremental improvement, not a
   prerequisite.

If/when the app reaches about 5+ root providers or a genuine second
transport appears (e.g., a WebSocket control channel that must swap
with HTTP under a feature flag), revisit with Option (b). Do not
reopen (c) or (d) unless a concrete requirement -- scoped lifetimes,
decorator-driven metadata, or shared backend registration -- shows up.
Neither is foreseeable from the current roadmap
(`docs/2026-04-18-COLLATED_ROADMAP.md`).

## 5. Handoff note for Agent 7 (React conventions)

- **Transport injection is not changing.** Continue using
  `import { api } from "../hooks/useApi.js"` for RPC calls and
  `useTransport()` + `createEventSource()` for SSE
  (`hooks/useSse.ts:2`). No refactor blocking on this audit.
- **Safe to consolidate prop-drilling yourself.** If while migrating
  hooks/components you want to replace the `readOnly / daemonStatus /
  onNavigate / onToast` quartet with a small `AppShellContext`, that
  is Option (b) and is compatible with this recommendation. Nothing
  else in this audit depends on that work.
- **Do not wait for a DI container.** There will not be one.
- **Do not introduce `reflect-metadata` or `experimentalDecorators`.**
  `tsconfig` stays as-is (`strict: false`, no decorators). Any pattern
  that needs them is out of scope.
- **`MockTransport` is the test seam.** Wrap renders in
  `<TransportProvider transport={mock}>`; no module mocking needed.
  Example in `__tests__/transport-mock.test.ts`.
