# Arkd → Conductor outbound WebSocket — Design

**Status:** Queued. Not yet implemented. Replaces the SSH `-R` reverse tunnel that carries hook callbacks today.

## Problem

Live evidence from `s-n4vst3b80i` (2026-05-01, EC2 dispatch via `ec2-ssm`):

- Conductor ran `ssh -R 19100:localhost:19100 ubuntu@<instance>` to forward EC2:19100 → conductor:19100.
- The SSH process stayed alive on conductor (PID 65436, 14m uptime).
- On EC2, `ss -tln` showed **no** listener on `127.0.0.1:19100`. The remote bind silently failed.
- Every hook the agent fired (`AgentMessage`, `PreToolUse`, `PostToolUse`, `Stop`, etc.) `curl`'d `http://localhost:19100/hooks/status` and got connection-refused, swallowed by `|| true` in the launcher.
- Result: zero `agent_message` / `hook_status` events landed on the conductor for the dispatch. The conversation tab was empty, the timeline only had conductor-side events (`stage_started`, `stage_ready`, action results), and no live agent narration was visible.

The reverse tunnel is a fundamentally fragile transport for this:

1. **Silent bind failure.** OpenSSH default is `ExitOnForwardFailure no`. The SSH client keeps the connection up even if the remote bind fails. Our `findReverseTunnelPid` happily reuses a dead-forwarded process.
2. **No probe.** We never verify the remote port is actually listening. Adding a `curl localhost:19100` probe from EC2 would catch it — but that's a band-aid, not the architecture.
3. **NAT / corp-network hostility.** Reverse forwards over SSM SSH work most days but break under network reshuffles. Outbound HTTPS/WS from EC2 is the universally allowed direction.
4. **One channel, mixed concerns.** Hooks (small structured POSTs), agent narration (text), tool blocks (structured), terminal frames (binary), log tails (large) all funnel through the same `localhost:19100` HTTP listener. No backpressure, no framing.
5. **Conductor restart leaves arkd disconnected.** When the conductor restarts, the EC2-side endpoint silently disappears. Arkd has no way to notice or reconnect.

## Goals

- Replace the SSH `-R` reverse tunnel with **arkd → conductor outbound WebSocket**.
- Carry every event arkd / the agent currently push back via `/hooks/status` (and intends to push for transcript / stdio): hook events, agent messages, channel reports, log tails, terminal output frames.
- Survive conductor restarts (arkd reconnects with backoff).
- Survive arkd restarts (conductor accepts a fresh connection keyed on `compute_id`).
- Authenticated by the same shared token arkd already accepts (`ARK_ARKD_TOKEN`) — or a per-compute issued token at provision time.
- Work over plain outbound HTTPS through any NAT / corp-network. No remote port binding.

## Non-goals

- Replacing the **forward** tunnel (conductor → arkd HTTP for `/exec`, `/file/read`, `/agent/launch`). That's bidirectional in nature (conductor initiates) and works fine over SSH-over-SSM today. Different lifecycle.
- Changing the local-mode arkd path. Local arkd shares a host with the conductor; the WS dial-out works identically (`ws://localhost:<conductor_port>`) and is no worse than today.
- Multi-tenant authentication redesign. Use the existing token mechanism; layer tenant-scoped WS auth on later if needed.

## Proposed architecture

### Wire shape

```
Arkd                         Conductor (server-daemon)
  ─────────────────────────────────────────────────►
  WS dial: wss://<conductor-public-or-tunnel>/arkd?compute=<name>&token=<...>
  ◄──── { hello, sessionFilter, since? }
  ───── { type: "hook_event", session, payload } ────►
  ───── { type: "agent_message", session, text } ───►
  ───── { type: "channel_report", session, ... } ───►
  ───── { type: "log_chunk", session, file, bytes } ►
  ───── { type: "term_frame", session, bytes } ─────►
  ◄──── { type: "ack", seq } ──────────────────────
  ◄──── { type: "subscribe_terminal", session } ───
  ◄──── { type: "subscribe_logs", session } ───────
```

- **Direction:** arkd is the dialer. Conductor is the listener. This is the entire architectural reversal.
- **Framing:** each frame is a JSON envelope `{type, ...}`; binary payloads (terminal, log bytes) are base64-encoded inside JSON to keep one transport. We can switch to binary WS frames + a JSON sidecar later if perf demands.
- **Multiplexing:** all sessions on this arkd flow through one WS. The `session` field disambiguates.
- **Backpressure:** if the conductor stops reading, arkd's WS send buffer fills and arkd starts dropping `log_chunk` and `term_frame` (lossy by design); `hook_event` / `agent_message` / `channel_report` are queued with a hard cap and a "dropped N events" warning.
- **Resume:** on reconnect, arkd sends a `resume` hello with the last-acked seq. Conductor decides whether to replay buffered events or skip.

### Endpoints

**On conductor:** `GET /arkd` upgrade, accepts `?compute=<name>&token=<...>`. Validates token, looks up compute by name, gates by tenant, and registers the connection in a `ComputeConnections` map keyed by compute name.

**On arkd:** new module `packages/arkd/conductor-ws.ts`. Reads `ARK_CONDUCTOR_URL` (already exists, set by `client.setConfig` post-provision). Dials on boot if URL is set. Reconnects with exponential backoff (250ms → 30s, jitter).

### Replacing existing flows

| Today | Tomorrow |
|---|---|
| Agent hook curls `http://localhost:19100/hooks/status` over SSH `-R` | Agent hook curls `http://localhost:<arkd_port>/hooks/forward` (loopback to local arkd). Arkd forwards over WS. |
| `arkdClient.attachStream(handle)` (HTTP chunked stream pull, conductor initiates) | Conductor sends `subscribe_terminal` over WS. Arkd opens `attach_open` locally and pushes `term_frame` events back. Same WS used for input via `term_input` events. |
| `LogsTab` reads conductor-local `tracks/<sid>/stdio.log` | Conductor sends `subscribe_logs` over WS. Arkd tails the remote file and pushes `log_chunk` back. Conductor caches into local `tracks/<sid>/stdio.log` so existing `readForensicFile` keeps working. |
| Channel reports POST'd from MCP `ark-channel` over `-R` tunnel to `localhost:19100/channel` | Same hook-forward pattern: MCP → local arkd → WS → conductor. |

### Authentication

- Reuse `ARK_ARKD_TOKEN` (shared secret, set on conductor + every arkd instance at provision). Token is presented as `?token=<...>` on the WS upgrade and as a `Bearer` header. Conductor enforces both.
- Compute name is the WS-level identity (`?compute=<name>`). Conductor verifies the compute exists in the requesting tenant; cross-tenant connect is rejected at upgrade.
- Per-compute distinct tokens are a future hardening (provision-time mint), not in scope here.

### Failure modes

- **Conductor down:** arkd reconnect loop with backoff. Local-arkd events queue (bounded) until reconnect. Dropped excess events surface as a `dropped` notification on next reconnect so the conductor can mark the session "may be missing events".
- **Arkd down:** conductor's compute connection map drops the entry. Existing dispatch fails fast on the next `client.run` (forward tunnel HTTP is independent).
- **Network partition:** WS heartbeats every 15s. Either side closes after 2 missed pings.
- **WS not yet connected at dispatch start:** dispatch waits up to N seconds for the WS to come up; if not, fail dispatch with a clear error rather than launch into a black hole.

### What stays identical

- The conductor's `/hooks/status` HTTP endpoint stays — local-mode arkd and legacy paths still POST to it directly. The new path is internal arkd → WS forwarding; the conductor-side handler dispatches to `report-pipeline` / `events.log` / `messages.create` exactly as today.
- All existing event types (`agent_message`, `hook_status`, `channel_report`) are unchanged. The WS is purely a transport swap.
- Forward tunnel (conductor → arkd HTTP) is untouched.

## Migration path

Phase 1: build the WS endpoint + arkd dialer behind a flag (`ARK_USE_OUTBOUND_WS=1` on arkd). Default off. Old SSH `-R` path stays primary.

Phase 2: smoke-test on local arkd → local conductor. Validate hook forwarding, terminal subscribe, log subscribe.

Phase 3: smoke-test on EC2-arkd → conductor. Validate over the SSM-tunneled forward connection (the WS dial uses the same SSM-routable conductor URL, or a public conductor URL if available).

Phase 4: flip the default to outbound-WS for new computes. Old computes keep using `-R` until next provision. Add `ExitOnForwardFailure=yes` + a probe step to the legacy `-R` path so we don't ship two silently-broken transports during the cutover.

Phase 5: delete `setupReverseTunnel` and `findReverseTunnelPid`. Drop `-R` from `SSH_OPTS`. Keep the forward `-L` tunnel.

## Open questions

- Conductor URL discoverability: in a hosted deployment, arkd needs to know `wss://ark.company.com/arkd`. Today `setConfig` plumbs a `conductorUrl` post-provision; that needs to be the public endpoint, not `http://localhost:19100`. Confirm both modes (local dev where arkd dials `ws://localhost:19400` vs hosted where arkd dials a public DNS).
- Conductor scaling: when there are multiple conductor instances behind a load balancer, how does a session's events route to the right one? Sticky compute-id routing at the LB, or events through a shared bus (Redis stream / NATS)? Out of scope for v1 — single conductor.
- Buffering caps: pick concrete numbers for hook-event queue (proposal: 10k events, 50MB total) and log-chunk drop policy (proposal: drop oldest 10s of chunks when over 5MB queue).
- Replay semantics on reconnect: do we replay missed `agent_message` events (small, structured) or just notify? Proposal: replay all hook/message/report types up to the queue cap, drop term_frame and log_chunk.

## Test plan

- Unit: arkd dialer reconnect/backoff behavior (mocked WS server that closes / hangs).
- Unit: conductor `/arkd` upgrade rejects bad tokens, missing compute, cross-tenant.
- Integration: local arkd → local conductor, drive a session, assert `agent_message` events land on conductor and the timeline renders.
- Integration: kill conductor mid-dispatch, restart, assert arkd reconnects and queued events flush.
- Integration: kill arkd mid-dispatch, restart, assert conductor accepts the new connection and dispatch can continue (forward-tunnel side).
- E2E: full EC2 dispatch with the new transport. Compare event count (`hook_status`, `agent_message`) against today's broken baseline.

## Out of scope

- Streaming the full Claude transcript JSONL (`~/.claude/projects/.../<sid>.jsonl`). That's a separate capture story — could ride this WS later as a `transcript_chunk` event type.
- TLS / mutual auth between arkd and conductor.
- Multi-region routing.
- Compression of WS payloads.
