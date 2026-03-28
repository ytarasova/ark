# ArkD as Conductor Transport Layer

## Problem

Currently 3 HTTP servers participate in agent communication:
1. **channel.ts** (:ARK_CHANNEL_PORT) - MCP server inside Claude's process, per-session
2. **conductor.ts** (:19100) - singleton on user machine, receives reports + delivers tasks
3. **arkd** (:19300) - per-compute daemon, agent lifecycle + metrics + files

For local compute this works (everything is localhost). For remote compute, channel.ts on the remote machine needs to reach conductor on the user's machine - requiring the user's IP to be routable from the remote, which breaks behind NAT/firewalls.

## Design

**ArkD becomes the transport layer between agents and conductor.**

```
Agent (Claude Code)
  | stdio (MCP)
channel.ts :CHANNEL_PORT (per-session, on compute)
  | HTTP POST to localhost:19300
arkd :19300 (on compute - always reachable as localhost)
  | HTTP forward to conductorUrl
conductor :19100 (on user machine - stateful brain)
  | SQLite
store (sessions, events, messages)
```

### Data flows

**Agent → Conductor (reports):**
1. Agent calls `report` tool in channel.ts
2. channel.ts POSTs to `arkd/channel/{sessionId}` (localhost:19300)
3. arkd forwards to `{conductorUrl}/api/channel/{sessionId}`
4. Conductor handles report (update store, advance session, etc.)

**Conductor → Agent (tasks/steers):**
1. Conductor POSTs to `arkd/channel/deliver` on the compute's arkd
2. arkd POSTs to `localhost:{channelPort}` on the compute
3. channel.ts pushes to Claude via MCP notification

**Agent → Agent (relay):**
1. Agent calls `send_to_agent` in channel.ts
2. channel.ts POSTs to `arkd/channel/relay`
3. arkd forwards to `{conductorUrl}/api/relay`
4. Conductor resolves target session, POSTs to target compute's arkd
5. Target arkd delivers to target channel port

### conductorUrl resolution

- **Local arkd:** started by TUI/CLI, conductorUrl = `http://localhost:19100` (default)
- **Remote arkd:** set via cloud-init env or `/config` endpoint at provision time
- Passed as `--conductor-url` flag to `ark arkd` CLI command
- Stored in arkd process memory (not persisted)

### What changes

| Component | Before | After |
|-----------|--------|-------|
| channel.ts | POSTs to `CONDUCTOR_URL` (19100) | POSTs to `ARKD_URL` (19300) |
| conductor relay | Direct HTTP to channel port | Via ArkdClient → arkd → channel |
| conductor delivery | Direct HTTP to channel port | Via ArkdClient → arkd → channel |
| arkd | No channel awareness | 3 new endpoints |
| pr-poller/github-pr | Direct HTTP to channel port | Via ArkdClient |

### New arkd endpoints

```
POST /channel/:sessionId    - receive agent report, forward to conductorUrl
POST /channel/relay          - receive relay request, forward to conductorUrl
POST /channel/deliver        - receive task/steer from conductor, deliver to local channel port
POST /config                 - set runtime config (conductorUrl)
```

### What stays the same

- Conductor HTTP server stays (:19100) - still serves TUI REST API, hook status
- channel.ts MCP protocol unchanged - still stdio to Claude
- channel.ts HTTP inbound unchanged - still accepts POSTs on CHANNEL_PORT
- All session lifecycle logic stays in conductor
- SQLite store stays on user machine

## Non-goals

- Replacing conductor entirely (Phase 2 - websockets/long-poll)
- Changing the MCP channel protocol
- Moving the SQLite store
