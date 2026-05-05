# Realtime hooks

One pattern per data shape. New realtime code should follow this map; if the
existing hook list drifts, fix it there rather than adding a fourth pattern.

| Need | Use | Why |
|---|---|---|
| Periodic refresh of a JSON resource | `useQuery({ refetchInterval })` (TanStack) | Visibility-pause is built in. Cache de-duplication. Auto-cancellation on unmount. |
| Server-pushed JSON (SSE / EventSource) | `useSseSubscription({ path, eventTypes, onPayload })` | Single primitive. Caller decides whether to set local state or call `queryClient.setQueryData`. |
| Terminal byte stream (binary WebSocket) | `useTerminalSocket` | Tmux pane bytes need a binary channel and exponential-backoff reconnect. Not expressible as a TanStack query. |

## Anti-patterns

- **Don't add another `useSmartPoll` / `setInterval`.** TanStack
  `refetchInterval` covers every case the legacy hook covered, including
  pause-on-hidden-tab. The legacy hook was removed in `cd8ae046`.
- **Don't write a fresh `EventSource` lifecycle in a new hook.** Compose
  on top of `useSseSubscription` -- it owns close-on-unmount, the
  heartbeat-tolerant JSON parse, and the path/enabled gates.
- **Don't make a generic-looking SSE hook that hardcodes one event type.**
  The old `useSse<T>(path)` did this and it bit us in
  `cd8ae046`. If your stream emits multiple event names, list them in
  `eventTypes`; default is `["message"]` (the EventSource default channel).

## How the pieces fit together

```
useTerminalSocket  -----> WebSocket /terminal/:id    (binary, lazy-mounted)

useSseSubscription -----> EventSource <path>          (push)
   |
   +- useSessions          (list page; merges into ["sessions", ...] cache)
   +- useSessionTreeStream (detail tree; writes to ["session-tree", id] cache)

useQuery { refetchInterval } -----> JSON-RPC /api    (poll)
   |
   +- useSessionStream         (5s/2s based on session state)
   +- useDashboardSummaryQuery (5s)
   +- useRunningSessionsQuery  (5s)
   +- useMessages              (5s while active, shares queryKey with useSessionStream)
   +- useDaemonStatus          (15s)
```

If you're adding a streaming UI, pick one of the three rows above and
write a one-line wrapper. If none of them fit, talk to a maintainer
before introducing a fourth.
