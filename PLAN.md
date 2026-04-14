# Plan: Fix Web UI Session Controls, Polling, and Recipe Variables

## Summary

The web UI session detail panel shows action buttons based on session status but suffers from stale state -- it fetches once on mount and never re-polls, so buttons become stale when status changes via the pipeline. Additionally, the session list has no periodic refresh (relies solely on SSE), and recipe variable objects render as `[object Object]`. This plan fixes all three: correct action-status mapping, add smart polling to both list and detail, and properly render recipe variables.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/web/src/components/SessionDetail.tsx` | Fix `SessionActions` status-to-button mapping to match TUI; add `blocked` to dispatch, `completed` to restart |
| `packages/web/src/hooks/useSessionDetailData.ts` | Add polling for session detail (status, events, todos, messages) when session is active; stop polling on terminal states |
| `packages/web/src/hooks/useSessionQueries.ts` | Add `refetchInterval: 5000` to `useSessionsQuery` for auto-refresh of session list |
| `packages/web/src/components/ToolsView.tsx` | Fix recipe variables rendering -- variables is an array of `{name, description, required}` objects, not a key-value map |

## Implementation steps

### Step 1: Fix `SessionActions` status-to-button mapping (`SessionDetail.tsx:30-108`)

Current mapping has discrepancies with the TUI. Align to match:

**Dispatch button** (line 39): Add `blocked` to the condition.
```tsx
// Before: (s === "ready" || s === "pending")
// After:  (s === "ready" || s === "pending" || s === "blocked")
```

**Restart button** (line 57): Add `completed` to the condition. The TUI allows restarting completed sessions.
```tsx
// Before: (s === "stopped" || s === "failed")
// After:  (s === "stopped" || s === "failed" || s === "completed")
```

**Advance button** (line 51): Remove `running` and `waiting` -- advance makes sense only for sessions stuck at a gate. The TUI only shows advance for `ready`/`blocked`.
```tsx
// Before: (s === "running" || s === "waiting" || s === "blocked")
// After:  (s === "ready" || s === "blocked")
```

**Complete button** (line 54): Keep for `running`/`waiting` (matches TUI "d for done"), remove `blocked`.
```tsx
// Before: (s === "running" || s === "waiting" || s === "blocked")
// After:  (s === "running" || s === "waiting")
```

**Archive button** (line 66): Already correct -- `completed/stopped/failed`.

### Step 2: Add session detail polling (`useSessionDetailData.ts`)

Add an effect that re-fetches session detail, events, todos, messages, and cost while the session is in an active state (`running`, `waiting`, `blocked`, `pending`, `ready`). Use `setInterval` with 5s interval, gated on the current status.

```tsx
// After the initial fetch effects, add a polling effect:
const ACTIVE_STATUSES = ["running", "waiting", "blocked", "pending", "ready"];

useEffect(() => {
  if (!sessionId || !detail?.session) return;
  const status = detail.session.status;
  if (!ACTIVE_STATUSES.includes(status)) return;

  let active = true;
  const poll = () => {
    if (!active) return;
    api.getSession(sessionId).then(d => { if (active) setDetail(d); });
    api.getTodos(sessionId).then(d => { if (active) setTodos(Array.isArray(d) ? d : []); }).catch(() => {});
    api.getMessages(sessionId).then(d => {
      if (active) setMessages(Array.isArray(d?.messages) ? d.messages : Array.isArray(d) ? d : []);
    }).catch(() => {});
    api.getSessionCost(sessionId).then(d => { if (active) setCost(d); }).catch(() => setCost(null));
  };

  const iv = setInterval(poll, 5000);
  return () => { active = false; clearInterval(iv); };
}, [sessionId, detail?.session?.status]);
```

Key behavior: when `detail.session.status` changes to a terminal state (completed, stopped, failed, archived, deleting), the effect cleanup runs and no new interval starts. Polling stops automatically.

The existing output poller (lines 77-90) already polls every 2s for running/waiting sessions -- leave it as-is.

### Step 3: Add session list polling (`useSessionQueries.ts`)

Add `refetchInterval: 5000` to the `useSessionsQuery` React Query config. This is cleaner than manual `setInterval` because React Query handles deduplication, caching, and error retry. It also pauses when the window is not focused by default.

```tsx
export function useSessionsQuery(serverStatus?: string) {
  const filters = serverStatus ? { status: serverStatus } : undefined;
  return useQuery({
    queryKey: ["sessions", serverStatus || "default"],
    queryFn: () => api.getSessions(filters),
    refetchInterval: 5000,
  });
}
```

This provides automatic 5s polling alongside the existing SSE updates.

### Step 4: Fix recipe variables rendering (`ToolsView.tsx:84-95`)

Recipe variables are arrays of objects (`{ name, description, required }`), not key-value maps. The current code uses `Object.entries(selected.variables)` which treats array indices as keys and produces `[object Object]` via `String(v)`.

Replace the rendering block (lines 84-95):

```tsx
// Before:
{selected.variables && Object.keys(selected.variables).length > 0 && (
  <div className="mb-4">
    <h3 ...>Variables</h3>
    <div className="grid grid-cols-[120px_1fr] ...">
      {Object.entries(selected.variables).map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-muted-foreground">{k}</span>
          <span className="text-card-foreground font-mono">{String(v)}</span>
        </div>
      ))}
    </div>
  </div>
)}

// After:
{selected.variables && Array.isArray(selected.variables) && selected.variables.length > 0 && (
  <div className="mb-4">
    <h3 ...>Variables</h3>
    <div className="grid grid-cols-[120px_1fr] ...">
      {selected.variables.map((v: any) => (
        <div key={v.name} className="contents">
          <span className="text-muted-foreground">{v.name}{v.required ? " *" : ""}</span>
          <span className="text-card-foreground font-mono text-xs">{v.description || "-"}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

## Testing strategy

1. **Manual testing (critical path)**:
   - Start the web dev server (`make dev-web`)
   - Create a session in `ready` state -- verify only Dispatch, Advance, Fork, Delete are shown
   - Dispatch a session -- verify Stop, Pause, Interrupt, Complete, Send, Fork, Delete appear
   - Let session complete -- verify buttons update automatically (Restart, Archive, Fork, Delete) without manual refresh
   - Open a `blocked` session -- verify Dispatch and Advance buttons appear
   - Navigate to Tools > Recipes -- verify variables render as name + description, not `[object Object]`

2. **Polling verification**:
   - Open browser DevTools Network tab
   - Verify `session/list` RPC calls fire every ~5s
   - Select a running session -- verify `session/read` calls fire every ~5s
   - Wait for session to complete -- verify detail polling stops (no more `session/read` calls)
   - Switch browser tabs away and back -- verify polling pauses/resumes

3. **Stale state test**:
   - Select a running session in the web UI
   - Stop it from the CLI (`ark session stop <id>`)
   - Verify the web UI detail panel updates within ~5s to show Restart button instead of Stop

## Risk assessment

- **Low risk**: All changes are in the web frontend only. No backend, database, or API changes.
- **Polling load**: 5s intervals for both list and detail adds modest RPC load. React Query's window-focus-aware refetch and SSE deduplication prevent excess requests.
- **No breaking changes**: The action button conditions are being tightened (fewer false positives), not loosened.
- **Recipe variables**: The fix handles the array format from YAML definitions. A defensive `Array.isArray()` check prevents regressions if any recipe uses a different format.

## Open questions

1. **Pause action**: The web UI shows a "Pause" button for running/waiting sessions, but the TUI doesn't expose pause via keyboard shortcut. The `session/pause` RPC exists in the API. **Decision needed**: Keep the Pause button in web UI (it's a valid API action) or hide it for TUI parity? **Recommendation**: Keep it -- web UI can have more actions than TUI since it has more screen real estate.

2. **Fork for all statuses**: Web UI currently shows Fork for all non-deleting sessions. TUI shows fork/clone for all selected sessions too. This seems correct -- no change needed. Confirm?

3. **Advance vs Dispatch for blocked**: After the fix, both Dispatch and Advance will show for `blocked` sessions (matching TUI behavior). Confirm this is desired?
