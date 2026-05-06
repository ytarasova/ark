# Monitoring flow completion

Quick reference for "I dispatched a session -- how do I know when it's done?"
Companion to [`2026-04-23-rohit-dispatch-guide.md`](./2026-04-23-rohit-dispatch-guide.md)
which covers the dispatch side. This doc focuses purely on the read side.

All endpoints below are served by the **conductor** (`config.ports.conductor`,
default 19100 locally; `https://pi-team.mypaytm.com/ark-api/` on the hosted
fleet). They are plain HTTP -- no WebSocket, no auth on the local box.

## TL;DR

```bash
# Snapshot once
curl -s http://localhost:19100/api/sessions/$SID/tree | jq '.root | {id,status,stage,child_stats}'

# Live updates (SSE, debounced ~200ms)
curl -Ns http://localhost:19100/api/sessions/$SID/tree/stream
```

A session is **done** when its `status` is one of:
`completed`, `failed`, `archived`, `stopped`. (Source:
`packages/core/services/creds-secret-reconciler.ts` `TERMINAL_STATES`.)

A flow with children is done when **every leaf** in the tree is terminal.
Use `child_stats` on each node to short-circuit deep recursion.

## Endpoints

Implemented in `packages/core/conductor/server/rest-api-handler.ts`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/sessions/:id` | Single session row | `status`, `stage`, `error`, `pr_url`, `cost_usd`. |
| `GET /api/sessions/:id/tree` | Recursive tree snapshot | Each node carries a `child_stats` rollup `{total, running, completed, failed, cost_usd_sum}`. Max depth 6. |
| `GET /api/sessions/:id/tree/stream` | SSE deltas | Initial snapshot on connect, then `tree-update` events whenever a descendant's status / cost changes or a new child is created. Debounced ~200 ms. |
| `GET /api/sessions/:id/children` | Direct children | Same shape as `tree`'s top level, no recursion. |
| `GET /api/events/:id` | Event log for one session | Ordered events: `stage_start`, `stage_complete`, `agent_completed`, `report`, `hook_status`, ... |
| `GET /api/sessions/:id/transcript` | SDK transcript JSONL | claude-agent runtime only. 2 MB cap; use `?tail=<N>` for tails. |
| `GET /api/sessions/:id/stdio` | Raw dispatcher stdout/stderr | Same 2 MB cap + `?tail=<N>`. |
| `GET /api/sessions?roots=true` | Top-level sessions only | Skips spawned children; carries `child_stats` per row. |

## Status state machine

Source: `packages/types/session.ts` `sessionStatusSchema`.

```
pending -> ready -> running -> waiting -> running -> completed
                          \-> blocked -> ...      \-> failed
                                                  \-> stopped
                                                  \-> archived
```

| Status | Terminal? | Meaning |
|---|---|---|
| `pending` | no | Row created, dispatcher hasn't picked it up yet. |
| `ready` | no | Stage queued, runtime not yet launched. |
| `running` | no | Agent process / SDK loop is live. |
| `waiting` | no | Agent emitted `ask_user`; awaiting human reply. |
| `blocked` | no | Manual gate -- waiting on `session/advance`. |
| `stopped` | **yes** | User-initiated kill. |
| `completed` | **yes** | Final stage reported done. |
| `failed` | **yes** | Stage error / budget exceeded / runtime crash. |
| `archived` | **yes** | Cleaned up after completion. |
| `deleting` | no | Mid-cleanup. |

Use `TERMINAL_STATES = {completed, failed, archived, stopped}` to decide
"is this done?". Don't assume `completed` is the only terminal -- `failed`
sessions also stop emitting events and won't progress further.

## Tree polling -- two patterns

### Pattern A: one-shot, "is it done yet?"

Cheapest. Fire every few seconds in a CLI loop.

```bash
SID=s-abc123xyz
while true; do
  RESP=$(curl -s http://localhost:19100/api/sessions/$SID/tree)
  STATUS=$(jq -r '.root.status' <<<"$RESP")
  STAGE=$(jq -r '.root.stage // "-"' <<<"$RESP")
  STATS=$(jq -c '.root.child_stats // {}' <<<"$RESP")
  printf "%s  status=%s  stage=%s  children=%s\n" "$(date +%T)" "$STATUS" "$STAGE" "$STATS"
  case "$STATUS" in completed|failed|archived|stopped) break;; esac
  sleep 5
done
```

The terminal `case` in this loop is the canonical "session is done" check.

### Pattern B: SSE stream, "react to every change"

Best for dashboards and Sage-style orchestrators. Server emits an initial
`tree-update` snapshot, then debounced deltas (~200 ms) for status, cost,
or child-creation events.

```bash
curl -Ns http://localhost:19100/api/sessions/$SID/tree/stream \
  | grep --line-buffered '^data:' \
  | sed -u 's/^data: //' \
  | jq -c '.root | {ts: now, id, status, stage, children: (.children // [] | map({id,status}))}'
```

The stream stays open until the client disconnects -- there is no
"completion event". Watch the root's `status` field for the terminal
transition and disconnect yourself.

## When children matter (for_each, fan-out)

A `for_each` stage with `mode: spawn` creates one child session per item.
The parent transitions through stages but won't reach `completed` until the
auto-join condition fires (every child terminal).

For a fan-out flow you typically want:

```bash
# Done when total == completed + failed across all children
curl -s http://localhost:19100/api/sessions/$SID/tree \
  | jq '[.root.children[]?.child_stats] as $stats
       | { total: ([$stats[].total] | add // 0)
         , done:  ([$stats[].completed, $stats[].failed] | flatten | add // 0)
         }'
```

`mode: inline` `for_each` (sequential sub-stages) does NOT spawn children
-- it iterates inside the parent session. Use the per-stage event log to
track those iterations: `GET /api/events/:id` + filter `type=stage_start`.

## Forensic reads (post-mortem)

After a session is terminal, the transcript and stdio files are durable.
Read them once to grab the agent's final message, error trace, or PR URL:

```bash
# Final assistant message + tool calls (claude-agent runtime)
curl -s "http://localhost:19100/api/sessions/$SID/transcript?tail=200"

# Raw runtime stdout/stderr -- last 200 lines
curl -s "http://localhost:19100/api/sessions/$SID/stdio?tail=200"
```

Files over 2 MB return 413 unless you pass `?tail=<N>`.

## Why not WebSocket for reads?

The conductor exposes plain HTTP for reads precisely so dashboards, ops
scripts, and `curl`-based monitoring don't need a WebSocket library. The
WebSocket transport on the **server daemon** (port 19400) is dispatch-only
(JSON-RPC `session/start`, `session/steer`, `session/kill`, ...). Once
dispatched, monitoring goes over the conductor's HTTP+SSE.

## Cross-references

- Dispatch contract -- [`2026-04-23-rohit-dispatch-guide.md`](./2026-04-23-rohit-dispatch-guide.md)
- Flow definitions -- [`flows-reference.md`](./flows-reference.md)
- REST handler source -- `packages/core/conductor/server/rest-api-handler.ts`
- SSE bus source -- `packages/core/hooks.ts` (`eventBus`)
