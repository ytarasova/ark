# Frontend React audit -- 2026-04-19

Status: first implementation PR has landed (this audit's companion). The
"remaining work" section below tracks what's still outstanding after that
landed.

Scope: `packages/web` (Vite + React 19 + TypeScript) and the Electron wrapper
in `packages/desktop`. `@tanstack/react-query`, `zod`, `react-hook-form`,
`@hookform/resolvers`, and `eslint-plugin-react-hooks` are now installed deps.

## Ranked hook / component smells

Ranking is by severity (1 = crash / bug; 3 = style only). `packages/web/src/`
is implied in every path.

### Fixed in this PR

| # | Severity | Location | Smell | Fix |
|---|---|---|---|---|
| F1 | 1 | `hooks/useSessionDetailData.ts` (deleted) | 7 useEffect blocks, 2 manually-polled intervals, `active` flags on every promise chain, `detail?.session?.status` in effect dep implying re-render on every cosmetic session update. | Replaced with `hooks/useSessionStream.ts`: one TanStack Query per sub-resource, `refetchInterval` driven by the computed `status`, automatic cancellation on unmount. |
| F2 | 1 | `components/SessionDetail.tsx:199` | Diff fetch effect kept a `cancelled` flag and `diffData` in the dep array, re-fetching every time the tab was opened after being non-null. | Replaced with `useQuery({ enabled: activeTab === "diff" })`. TanStack caches per sessionId. |
| F3 | 1 | `components/DashboardView.tsx:53-80` | `mountedRef.current` anti-pattern (writing-during-render via the ref init), `useState` mirroring two separate server queries, manual `useSmartPoll`. | Replaced with `useDashboardSummaryQuery` + `useRunningSessionsQuery`. `refetchInterval: 5000` preserves cadence. |
| F4 | 1 | `components/HistoryView.tsx:37-90` | Three inline fetch effects with per-effect cancellation flags; `loadingRecent` / `loadingClaude` / `refreshing` state mirrors that TanStack already tracks. | Extracted to `useHistoryQueries.ts` (recent + claude + refresh mutation). Removed three pieces of `useState`. |
| F5 | 1 | `components/flow-editor/FlowEditor.tsx:199` | `useMemo` running a `setNodes` / `setEdges` side-effect -- violates "useMemo must be pure". Triggered setState during render under some rerender sequences. | Changed to `useEffect` with proper dep array. |
| F6 | 2 | `components/compute/NewComputeForm.tsx` | `useState` chain for 8 fields, two `.then(...)` fetches inside a single useEffect with a bespoke `mountedRef` cancellation flag. | Full RHF + zod rewrite; schema exported and unit-tested. |
| F7 | 2 | `components/NewSessionModal.tsx` | 8+ `useState` fields for the main form; 3 inline fetch effects; keyboard-shortcut useEffect with 10-item dep array. | Main-form fields migrated to RHF + zod (`NewSessionSchema`). Fetches migrated to TanStack Query. Attachments/inputs/references remain local state because they have non-trivial client-only semantics. |
| F8 | 2 | `pages/SessionsPage.tsx:80` | Effect re-ran on every `sessions` delta and re-fetched every flow stage because `flowStagesMap` lookup was inside the dep array. | Reworked the effect to read from the setState updater, so only `sessions` triggers it; the internal updater skips fetches for already-known flows. |
| F9 | 3 | Several views | Wrote `useState` with `[] as any[]` defaults that create a new empty array every render, cascading into needless re-renders of child memoized components. | Wrapped with `useMemo(() => q.data ?? [], [q.data])` where it mattered (CostsView, NewSessionModal, NewComputeForm). |
| F10 | 3 | Root (no eslint-plugin-react-hooks) | The rules-of-hooks / exhaustive-deps lint plugin was not enabled. 11 pre-existing violations went unnoticed. | Added plugin at `error` level, scoped to `packages/web/**` and `packages/desktop/**`. All 11 violations fixed. CI now enforces. |

### Remaining smells (follow-up PRs)

| # | Severity | Location | Smell | Recommendation |
|---|---|---|---|---|
| R1 | 2 | `hooks/useSmartPoll.ts:8` | `savedCallback.current = callback` is assigned during render. TanStack Query's `refetchInterval` already covers the smart-poll behaviour (pause in background). | Migrate the remaining `useSmartPoll` callers (`components/ComputeView.tsx`, `hooks/useDaemonStatus.ts`) to TanStack Query's `refetchInterval` and delete the hook. |
| R2 | 2 | `hooks/useMessages.ts` | Local-state list that mirrors `session/messages` RPC, with bespoke optimistic updates and a manual `setInterval`. Could become a `useMutation` + `useQuery` pair. | Replace with `useSessionStream`-style hook + `useMutation` for the send flow; use `onMutate` for the optimistic message. |
| R3 | 2 | `hooks/useDaemonStatus.ts` | Same shape as Dashboard: `useState` + `useEffect` + `useSmartPoll`. | Migrate to `useQuery({ queryKey: ["daemon", "status"], refetchInterval: 15000 })`. |
| R4 | 2 | `hooks/useSse.ts` | Subscribes inside `useEffect` but never re-subscribes on transport change; error handler is a no-op comment so reconnection failures are silent. | Accept a `channels: string[]` prop, wire into TanStack Query's `queryClient.setQueryData` for the relevant keys (the SSE+Query primitive promised in the brief). |
| R5 | 2 | `pages/SessionsPage.tsx` | Keyboard shortcut effect with 5-item dep array. Effect recreates its listener on every sessions poll. | Split the `setSelectedId` action into a stable `useEvent`-style ref and depend only on `[filteredSessions, selectedId, readOnly, showNew]`. |
| R6 | 3 | `components/AgentsView.tsx`, `ScheduleView.tsx`, `MemoryView.tsx` | Forms still use `useState` chains (3-6 fields each). Already zod-schema friendly. | Same RHF + zod migration as NewComputeForm. |
| R7 | 3 | `components/NewSessionModal.tsx` | 4 nested sub-components (FlowDropdown, RepoDropdown, ComputeDropdown, RichTaskInput) are declared inline in the same file (1056 LOC). | Move each to `components/session/*.tsx`. Makes the modal itself a presenter over its RHF form. |
| R8 | 3 | `components/ComputeView.tsx` | State split across `selectedInternal`, `selected`, `setSelected` with an initial-value fallback pattern. Candidate for URL search params (`?name=foo`) to persist selection across reloads. | Migrate to `useSearchParams`-style helper once we add one. |
| R9 | 3 | `hooks/useQueries.ts` | Barrel re-exporting from 8 domain files. Consumers already import from the specific files -- safe to delete. | Delete after confirming no external consumers. |
| R10 | 3 | Widespread `as any` casts on `api` responses. | Tracked under the protocol Zod-schema migration (see `hooks/useApi.ts` TODOs). Not a React concern per se but compounds the ergonomics problem whenever a new query wraps a TODO'd endpoint. |

## State management migration plan for remaining pages

Target split (restated here as the agreed convention, in order of decreasing
preference):

| Category | Target | Where it lives |
|---|---|---|
| Server state | TanStack Query | `hooks/use*Queries.ts` (domain-grouped) |
| SSE live updates | `useSse` -> `queryClient.setQueryData` | TBD: extract a `useSSE(channel, mutator)` primitive |
| Global UI (theme, auth) | React Context | `themes/ThemeProvider.tsx`, a future `AuthProvider` |
| Cross-page selection / filters | URL search params | TBD: thin `useSearchParams()` helper |
| Forms with 3+ fields | react-hook-form + zod | Co-located with the component |
| Local ephemeral UI (menu open, toast key) | `useState` | Inline |

### Per-page remaining work

| Page | What's left | Blast radius |
|---|---|---|
| `AgentsView` | AgentForm (~8 useState fields) -> RHF+zod. Inline sub-component. | Self-contained; mirrors NewComputeForm. |
| `MemoryView` | `searchResults` / `_loading` / 3 form fields -> RHF + a `useMutation` for `addMemory`. | Self-contained. |
| `ScheduleView` | Same shape as MemoryView. 3 form fields. | Self-contained. |
| `ComputeView` | Remove local `snapshot`/`metricHistory` local state; move metrics into TanStack Query with `refetchInterval` and keep the ref only for the history sparkline buffer. | Needs to coordinate with the ongoing metric-sparkline work. |
| `SessionsPage` | Collapse the flow-stages side-fetch into a `useFlowStagesMap` hook built on TanStack Query. | Medium -- same effect drives pipeline rendering. |
| `HistoryView` | Replace `useState` for `searchResults` with a manual `useQuery({ enabled: searched })` keyed on `[query, mode]` so repeat searches are cached. | Medium. |
| `NewSessionModal` | Split into inline-dropdown modules; replace `attachments` optimistic-id counter with a proper UUID; move reference detection into a `useMemo` keyed on `summary`. | Medium. |

## Agreed conventions

The following have been codified in the ErrorBoundary + useSessionStream +
form schema patterns shipped with this PR.

### Presenter / container split

- `components/ui/*` is pure. Props in, JSX out, no data-fetching, no context
  usage beyond theme + transport tokens.
- `components/*` (non-ui) owns layout and glue. May consume query hooks.
- `pages/*` owns routing params + top-level query hook invocations. Pages
  compose layout + non-ui components.
- `hooks/*` owns all network + server-state logic. Anything that calls `api.*`
  belongs in a hook, never inline in a component.

### File layout

```
packages/web/src/
  App.tsx                    # root, error boundary, routing, providers
  pages/                     # route components (container)
  components/                # app-level layout components (mixed)
    ui/                      # pure presentational primitives
    compute/ session/ ...    # domain-grouped feature components
  hooks/
    use<Domain>Queries.ts    # TanStack Query wrappers per API domain
    use<Domain>.ts           # composite hooks (useSessionStream, useMessages)
  providers/                 # QueryProvider + future AuthProvider
  transport/                 # WebTransport interface + impls (Http, Mock)
  themes/                    # design tokens + ThemeProvider
  __tests__/                 # bun:test (schema, pure logic, hook smoke)
```

### Naming

- Query hooks: `use<Domain>Query` for a single resource, `use<Domain>sQuery`
  for a list. Mutations: `use<Action>Mutation`.
- Composite hooks that aggregate >1 query or own cross-cutting state:
  `use<Domain>` (e.g. `useSessionStream`).
- Zod schemas used by forms: `<Name>Schema`; inferred types: `<Name>Values`.
- Query keys: tuples starting with the domain. `["session", id, "todos"]`
  beats `["session-todos", id]` because `invalidateQueries({ queryKey: ["session", id] })`
  cascades without a custom predicate.

### Testing

- Pure functions and zod schemas: `bun:test`.
- Component behaviour: Playwright e2e (`packages/e2e/web/*.spec.ts`).
- Hooks: SSR smoke test with `react-dom/server` + MockTransport + fresh
  QueryClient. Full mount cycles require the e2e runner.

### Ref / effect discipline

- No ref writes during render. If the eslint plugin fires, move it into a
  commit-phase `useEffect`.
- No `setState` inside `useMemo`. If you catch yourself doing it, the result
  is a side-effect -- use `useEffect`.
- `setInterval`/`setTimeout` inside `useEffect` MUST have a cleanup; MUST NOT
  close over stale props. Preferred alternative: TanStack Query's
  `refetchInterval`.
- `AbortController`s + SSE connections always need a cleanup returning from
  the effect. TanStack Query wraps the AbortController case for us.

## Coordination with Agent 6 (DI audit)

Agent 6's transport-DI doc has not landed at time of writing. The transport
layer is unchanged here: `HttpTransport` is still mounted at module scope via
`setTransport()` in tests, and `TransportContext` is still the React-side
accessor. When Agent 6's recommendation is available we can revisit, but
the TanStack Query migrations above do not depend on which transport
implementation is bound.
