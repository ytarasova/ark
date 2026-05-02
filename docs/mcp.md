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

## Configuring Claude Code

Edit `~/.claude.json` (or `.claude.json` in your project) and add:

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
...) appear in `/mcp` and are callable by name.

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
