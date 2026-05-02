# Ark MCP Server

Ark exposes its full read + write surface to MCP-aware clients (Claude
Code, custom agents) over an HTTP endpoint on the server daemon. Same
binary for laptop single-tenant and hosted multi-tenant control plane
-- only the URL and token differ.

## Endpoint

`POST http://localhost:19400/mcp` (local)
`POST https://<your-ark-host>/mcp` (hosted)

Transport: Streamable HTTP (MCP 2025-03-26 spec).

## Auth

`Authorization: Bearer <token>`

- **Local**: token is in `~/.ark/arkd.token` (auto-generated on first
  daemon boot -- the same one `./ark` and the web UI use).
- **Hosted**: generate a per-user API token in the web UI under
  Settings -> MCP tokens.

When `auth.requireToken` is on (control-plane profile default), missing
or invalid tokens get a 401 -- there is no anonymous fallback for the
MCP route.

## Connecting an MCP client

The endpoint speaks Streamable HTTP, so any modern MCP client works.
Configuration boils down to `{ type: "http", url, headers }` -- the
exact file each client reads differs.

### Claude Code

Edit `~/.claude.json` (or `.claude.json` in your project):

```json
{
  "mcpServers": {
    "ark": {
      "type": "http",
      "url": "http://localhost:19400/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Restart Claude Code. The 27 Ark tools (`session_start`, `agent_create`,
...) appear and are callable by name.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ark": {
      "type": "http",
      "url": "http://localhost:19400/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Quit and relaunch Claude Desktop (cmd-Q on macOS -- a window close
is not enough, the menubar process needs to restart).

### Cursor

Settings -> MCP -> Add Server, or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ark": {
      "url": "http://localhost:19400/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

### Other clients

Anything that speaks Streamable HTTP MCP. Point it at
`http://localhost:19400/mcp` and pass the bearer in `Authorization`.
Each tool call is a single POST -- no client-side state required.

### Important: this is the META surface

The `/mcp` endpoint is for clients that drive Ark: dispatching
sessions, editing agents/flows, inspecting state. It is NOT mounted
into sessions Ark itself dispatches -- those agents see only the
`ark-channel` stdio MCP (`report`, `send_to_agent`). Worker agents
cannot recursively dispatch sub-sessions, edit agent definitions, or
read other tenants' resources.

## Tool Catalogue

### Read (14)

| Tool                            | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `session_list`                  | List sessions visible to your tenant                |
| `session_show`                  | Get a session by id                                 |
| `session_events`                | Read event history for a session                    |
| `flow_list` / `flow_show`       | Inspect flow definitions                            |
| `agent_list` / `agent_show`     | Inspect agent definitions                           |
| `skill_list` / `skill_show`     | Inspect skill definitions                           |
| `recipe_list` / `recipe_show`   | Inspect recipe definitions                          |
| `compute_list` / `compute_show` | Inspect compute targets (sensitive fields stripped) |
| `secrets_list`                  | Names + types only -- never values                  |

### Write -- dispatch & runtime (5)

| Tool                             | Purpose                                   |
| -------------------------------- | ----------------------------------------- |
| `session_start`                  | Create + dispatch a new session           |
| `session_steer`                  | Send a steer message to a running session |
| `session_kill`                   | Hard terminate a session                  |
| `compute_start` / `compute_stop` | Provider-level start/stop                 |

### Write -- definition CRUD (8)

| Tool                              | Purpose                      |
| --------------------------------- | ---------------------------- |
| `agent_create` / `agent_update`   | Edit `~/.ark/agents/*.yaml`  |
| `flow_create` / `flow_update`     | Edit `~/.ark/flows/*.yaml`   |
| `skill_create` / `skill_update`   | Edit `~/.ark/skills/*.yaml`  |
| `recipe_create` / `recipe_update` | Edit `~/.ark/recipes/*.yaml` |

Tier-2 tools take structured JSON params matching the underlying
`AgentDefinition` / `FlowDefinition` / etc. types. The server validates
input with Zod schemas before calling the existing
`app.<store>.save(...)` -- the same write path the CLI uses.

Deletion tools and secret writes are intentionally not exposed.
Deletions need a confirmation/audit story; secret values would
round-trip through Claude's transcript and we don't want that.

## Multi-tenant

In hosted mode every tool call is scoped to the tenant bound to the
bearer token. A user with `Bearer abc...` cannot see or modify another
user's resources, even if they call `session_show` with a session id
that exists in another tenant -- the underlying repository's tenant
filter returns null. There is no privileged "list across tenants" tool.
