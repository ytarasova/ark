# Agent 5 -- Frontend DI Assessment

## TL;DR

No DI library is warranted. The frontend needs exactly one structural addition: a thin `WebTransport` interface injected via React context at the app root, replacing the module-level `fetch` singleton in `useApi.ts`. Electron requires no transport changes -- it already spawns a full HTTP server and loads the SPA over `http://localhost`, making the web UI identical in both modes. The real gap is the absence of any unit-test tier for data-access hooks; a swappable `MockTransport` in a `TransportProvider` context solves that without any library.

## Current State (Evidence)

- **Transport:** `packages/web/src/hooks/useApi.ts:1-27` -- module-level `rpc()` calls `fetch(window.location.origin + '/api/rpc', ...)`. Hard-coded HTTP. No interface. Imported directly by 26 files.
- **SSE:** `packages/web/src/hooks/useSse.ts:6-9` -- `new EventSource(window.location.origin + path)` constructed inline. Not injectable.
- **Data-access hooks:** `packages/web/src/hooks/useSessionQueries.ts:6` calls `api.getSessions()` directly from the static singleton. All query hooks follow the same pattern.
- **Context providers:** `packages/web/src/App.tsx:192-196` -- only `QueryClientProvider` and `ThemeProvider` wrap the tree. No transport, no services context.
- **Electron desktop:** `packages/desktop/main.js:337` -- `mainWindow.loadURL('http://localhost:${serverPort}')`. Spawns `ark web` as a child process and loads the SPA over HTTP. `packages/desktop/preload.js:11-14` exposes only `{platform, isElectron}` via `contextBridge`. Zero ark domain calls cross the IPC bridge.
- **Protocol package:** `packages/protocol/transport.ts:31-35` -- `Transport` interface exists (WS/stdio), used only by server-side `ArkClient`. Not referenced in `packages/web`.
- **Testability pain points:** all `packages/web/src/__tests__/` tests are static `readFileSync` string-assertion tests. No DOM rendering tests, no MSW, no fetch stubs exist. Behavioral tests live in `packages/e2e/web/*.spec.ts` against a live server. No middle tier (unit tests with mock transport).

## Options Evaluated

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| No DI (React context + WebTransport interface) | Matches React idioms; zero new deps; Electron unchanged; e2e stays green; enables MockTransport for unit tests | Updating 26 `api` call sites (mitigated by module-level setter pattern) | **Recommended** |
| Minimal DI via ServicesProvider context | Slightly more structured named ports | Extra layer over what `TransportContext` already gives; no concrete additional win | Overkill |
| DI library (tsyringe / awilix) | None concrete | `experimentalDecorators` off; bundle weight; React context already solves the problem; server-side concern bleeds into frontend | Rejected |

## Recommendation

**No DI library. Add `TransportContext` + `HttpTransport` adapter, injected once at the app root.**

Files to add/change:

1. **`packages/web/src/transport/types.ts`** (new) -- `WebTransport` interface: `rpc<T>(method, params): Promise<T>`, `sseUrl(): string`, `createEventSource(path): EventSource`.
2. **`packages/web/src/transport/HttpTransport.ts`** (new) -- `HttpTransport implements WebTransport`, contains current `rpc()` and `sseUrl()` bodies from `useApi.ts`.
3. **`packages/web/src/transport/TransportContext.tsx`** (new) -- `React.createContext<WebTransport>`, `useTransport()` hook, `TransportProvider`.
4. **`packages/web/src/hooks/useApi.ts`** (modify) -- replace internal `rpc()` with a module-level transport variable set by `TransportProvider` on mount; all 26 `api.*` call shapes stay unchanged.
5. **`packages/web/src/App.tsx`** (modify) -- wrap with `<TransportProvider transport={new HttpTransport()}>`.

Tests: add a `MockTransport implements WebTransport`; wrap render trees with `<TransportProvider transport={mock}>` in unit tests. No MSW needed unless true HTTP-level interception is required.

## Transport Port (proposed)

```ts
// packages/web/src/transport/types.ts
export interface WebTransport {
  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  sseUrl(path: string): string;
  createEventSource(path: string): EventSource;
}

// packages/web/src/transport/HttpTransport.ts
export class HttpTransport implements WebTransport {
  async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { /* current rpc() body */ }
  sseUrl(path: string): string { return window.location.origin + path; }
  createEventSource(path: string): EventSource { return new EventSource(this.sseUrl(path)); }
}

// packages/web/src/transport/TransportContext.tsx
const _default = new HttpTransport();
const TransportContext = React.createContext<WebTransport>(_default);
export const useTransport = () => React.useContext(TransportContext);
export function TransportProvider({ transport, children }: { transport: WebTransport; children: React.ReactNode }) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}
```

Electron loads the same `HttpTransport` unchanged -- `window.location.origin` resolves to `http://localhost:${port}`.

## Shared Types with Backend (Agent 4 interlock)

- `packages/protocol/transport.ts:31-35` (WS/stdio) stays server-side only.
- `WebTransport` above lives in `packages/web/src/transport/`. Do **not** share with `packages/protocol` -- abstraction levels differ (HTTP/fetch vs. JSONL-stream).
- What **does** belong in `packages/protocol` / `packages/types`: RPC method name constants (currently string literals in `useApi.ts`) and response-shape interfaces. `packages/protocol/client.ts` already defines typed result interfaces; `packages/web` should import those rather than using `any`. This is the natural interlock with Agent 1's type-drift work and Agent 6's Zod-at-the-boundary recommendation.

## E2e Impact

| Spec | Change Needed? | How Kept Green |
|---|---|---|
| `packages/e2e/web/*.spec.ts` (18 specs) | No | Hit real HTTP server; `HttpTransport` is identical to current `fetch` |
| `packages/desktop/tests/*.spec.ts` (6 specs) | No | Desktop loads SPA over HTTP; no IPC path introduced |
| `packages/web/src/__tests__/*.test.ts` (12 files) | No | Static source assertions; no rendering/fetch involved |

## Risks

- **Migration scope:** 26 files import `api` from `useApi.ts`. Use a module-level transport setter (set by `TransportProvider` on mount) so `api.*` call shapes remain unchanged -- zero call-site diff.
- **SSE:** `useSse.ts` constructs `EventSource` inline. Adding `createEventSource()` to `WebTransport` fixes this; one-line change in `useSse.ts`.
- **Over-engineering guard:** if Electron IPC is never used (current evidence: it won't be), the abstraction still earns its keep by enabling the missing unit-test tier for data-access hooks -- the present zero-unit-test posture for hooks is the actual risk.
