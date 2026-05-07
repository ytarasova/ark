# Integrations

Ark's unified model: every external system Ark talks to is one "integration"
with up to two opt-in halves.

## Model

```
Integration = { trigger? , connector? }
```

- **Trigger source** (inbound) -- raw events become Ark flow dispatches.
  Four kinds: `webhook`, `schedule`, `poll`, `event` (internal bus).
- **Connector** (outbound) -- tools exposed to agents via MCP, or context
  prefills, or REST adapters.

One integration can expose only one half (`alertmanager` is trigger-only;
an internal-only tool might be connector-only). Many expose both (`github`,
`jira`, `slack`, `pi-sage`, ...).

Shared layer: auth + secrets + registry. Lookup: `listIntegrations()` in
`packages/core/integrations/registry.ts`.

## Trigger framework

```
Source -> Receiver (verify + parse) -> NormalizedEvent -> Matcher -> Dispatcher -> Flow
```

### Enabling a webhook trigger

1. Drop a YAML under `triggers/<name>.yaml` (examples ship as
   `<name>.yaml.example`). Users can also drop YAML under
   `~/.ark/triggers/`.
2. Configure a signing secret:
   - Env var: `ARK_TRIGGER_<SOURCE>_SECRET` (e.g. `ARK_TRIGGER_GITHUB_SECRET`).
   - OR `~/.ark/secrets.yaml`:
     ```yaml
     triggers:
       github:
         signing_key: "whsec_..."
     ```
3. Point the upstream webhook URL at `POST https://<ark-host>/api/webhooks/<source>`.
4. `ark trigger list` to see the config; `ark trigger test <name> --payload <file>`
   for a dry-run.

### Example trigger YAML

```yaml
name: github-pr-opened
source: github
kind: webhook
event: pull_request.opened
match:
  repo: paytmteam/foo
flow: review-pr
summary: "PR $.payload.pull_request.number: $.payload.pull_request.title"
inputs:
  prUrl: $.payload.pull_request.html_url
  branch: $.payload.pull_request.head.ref
params:
  ticket: $.payload.pull_request.title
```

`inputs.*` values are JSONPath expressions evaluated over the normalized
event. `params.*` are static literals merged into the same `inputs.params`
bag. The flow consumes them via the existing template resolver
(`{inputs.params.prUrl}`).

### Shipped sources

| Source | Kind | Status | Signature |
|---|---|---|---|
| github | webhook | full | HMAC-SHA256 / `X-Hub-Signature-256` |
| bitbucket | webhook | full | HMAC-SHA256 / `X-Hub-Signature` or `X-Bitbucket-Signature` |
| linear | webhook | full | HMAC-SHA256 / `Linear-Signature` |
| slack | webhook | full | HMAC-SHA256 of `v0:<ts>:<body>` / `X-Slack-Signature` + 5-min replay window |
| jira | webhook | full | HMAC-SHA256 / `X-Hub-Signature` or `Authorization: Bearer` |
| generic-hmac | webhook | full | HMAC-SHA256 / `X-Signature` (override via `ARK_TRIGGER_GENERIC_HMAC_HEADER`) |
| pi-sage | webhook | scaffolded | HMAC-SHA256 / `X-Sage-Signature` |
| alertmanager | webhook | scaffolded | Bearer or Basic auth |
| cloudwatch | webhook | scaffolded | Bearer (stopgap; full SNS cert verification TODO) |
| pagerduty | webhook | scaffolded | HMAC-SHA256 / `X-PagerDuty-Signature` (comma-separated list supported) |
| prometheus | webhook | scaffolded | Bearer or Basic (same shape as alertmanager) |
| email | poll | stub | IMAP -- interface only |

`full` = verify + normalize + tests. `scaffolded` = verify + normalize + TODO tests.
`stub` = interface only.

### Internal `event` kind

The `event` trigger kind is declared in `TriggerKind` but not wired yet.
Intended target: the existing event bus (`packages/core/hooks.ts`) -- an
`event` trigger with `event: session.completed` would listen for a session
lifecycle event and dispatch a follow-on flow. Plumbing TODO; see
"Known gaps" below.

## Connectors (outbound)

Connectors expose tool surfaces to running agents. Three flavours:

- `mcp` -- mount an MCP server. Either a shipped `mcp-configs/<name>.json`
  (via `mcp.configName`) or an inline `{ <server>: { command, args, env } }`
  object. Merged into `.mcp.json` alongside runtime-level and agent-level
  servers.
- `context` -- contribute prefill text (markdown) to the session context.
- `rest` -- REST adapter, defined but not yet plumbed into agents.

### Opt-in levels (highest precedence first)

1. **Flow YAML:** `connectors: [pi-sage, jira]` at the top of the flow.
   Every agent stage in the flow inherits.
2. **Session:** `ark session start --with-mcp pi-sage` (per-session).
3. **Runtime YAML:** `mcp_servers: [pi-sage]` (every session on this runtime
   inherits).

### Shipped connectors

| Name | Kind | Status | Backing |
|---|---|---|---|
| pi-sage | mcp | full | `mcp-configs/pi-sage.json` |
| jira | mcp | full | `mcp-configs/atlassian.json` |
| github | mcp | full | `mcp-configs/github.json` |
| linear | mcp | full | `mcp-configs/linear.json` |
| bitbucket | mcp | scaffolded | Inline stub (needs upstream MCP server) |
| slack | mcp | scaffolded | Inline stub (needs upstream MCP server) |

## Secrets

One file: `~/.ark/secrets.yaml` (gitignored).

```yaml
triggers:
  github:
    signing_key: "whsec_..."        # tenant-agnostic
    paytm:
      signing_key: "whsec_..."      # per-tenant override
```

Env var fallback: `ARK_TRIGGER_<SOURCE>_SECRET` (uppercased, dash -> underscore).

Connectors read their own env vars (`PI_SAGE_TOKEN`, `GITHUB_TOKEN`, etc) via
the `expandEnvPlaceholders()` substitution inside the MCP config JSON.

## Adding a new integration

### Trigger-only

1. Drop `packages/core/triggers/sources/<name>.ts` implementing
   `TriggerSource` (name, label, secretEnvVar, status, `verify`, `normalize`).
2. Register in `packages/core/triggers/registry.ts:builtinSources()`.
3. Add a `triggers/<name>.yaml.example` example.
4. Add a test under `packages/core/triggers/__tests__/sources.test.ts`.

### Connector-only

1. Drop `packages/core/connectors/definitions/<name>.ts` exporting a
   `Connector` object.
2. If it is MCP-backed, either ship a `mcp-configs/<name>.json` or supply
   `mcp.inline`.
3. Register in `packages/core/connectors/registry.ts:builtinConnectors()`.

### Both halves

Pick the same `name` in both registries. `listIntegrations()` will pair them
automatically.

## Architecture references

- Trigger pipeline: `packages/core/triggers/`
- Connectors: `packages/core/connectors/`
- Unified catalog: `packages/core/integrations/registry.ts`
- Webhook route: `packages/conductor/handlers/webhooks.ts`
- JSON-RPC CRUD: `packages/conductor/handlers/triggers.ts`
- CLI: `packages/cli/commands/trigger.ts`
- Shipped MCP configs: `mcp-configs/`
- Shipped trigger examples: `triggers/`
