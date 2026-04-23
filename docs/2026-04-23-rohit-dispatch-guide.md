# Rohit -- Dispatching Ark sessions from Sage

This is the contract your Sage / Claude orchestrator uses to drive Ark. Everything
you need is in the JSON-RPC surface `session/start` plus the tree read endpoints.
No YAML files need to be pre-registered on the Ark host -- every session carries
its flow, stages, agents, runtimes, and models **inline** in the dispatch payload.

Target deployment:
- HTTP: `https://pi-team.mypaytm.com/ark-api/` (conductor, read endpoints + SSE)
- WebSocket JSON-RPC: `wss://pi-team.mypaytm.com/ark-ws/` (server daemon, dispatch)
- Web UI: `https://pi-team.mypaytm.com/ark/` (live view)

Minimum Ark version: **0.20.0** (model catalog + inline dispatch).

## 1. Taxonomy (two minute read)

```
Model      = id, aliases, provider_slugs, pricing, capabilities
Runtime    = execution mechanism (agent-sdk / claude / codex / gemini / goose) + compat + secrets
Agent      = runtime + model (a pure binding)
Stage      = agent + tools + prompt + flags    (inline inside a flow)
Flow       = stages + edges                     (depends_on / for_each / joins)
Session    = flow + orchestrator (a running instance)
```

Every nested definition in the dispatch payload can be **either** a string name
(resolves against the three-layer lookup on the Ark host -- project > global >
bundled) **or** an inline object. Mix and match as convenient.

## 2. Minimum dispatch payload

Single-stage flow, references a bundled agent by name:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/start",
  "params": {
    "repo": "/home/ec2-user/env/sage-repos/agentic-auth-service",
    "summary": "fix race condition in session refresh",
    "flow": "bare"
  }
}
```

`flow: "bare"` resolves to the bundled `flows/definitions/bare.yaml`. The bare
flow has one stage `work` with `agent: worker`, which is also bundled.

## 3. Fully-inline dispatch (Rohit's happy path)

For Sage-generated flows you typically don't want to depend on what's bundled
on the host. Inline everything:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/start",
  "params": {
    "repo": "/home/ec2-user/env/sage-repos/agentic-auth-service",
    "summary": "refactor auth retry logic per Sage plan PLAN-42",
    "flow": {
      "name": "sage-refactor-auth",
      "description": "Sage-authored execution plan",
      "stages": [
        {
          "name": "read-plan",
          "agent": {
            "runtime": "agent-sdk",
            "model": "claude-sonnet-4-6",
            "system_prompt": "Read PLAN.md and confirm the refactor target. Emit a short summary as your final message.",
            "tools": ["Read", "Glob", "Grep"],
            "max_turns": 10
          }
        },
        {
          "name": "implement",
          "depends_on": ["read-plan"],
          "agent": {
            "runtime": "agent-sdk",
            "model": "claude-sonnet-4-6",
            "system_prompt": "Implement the plan from PLAN.md. Write tests alongside. Commit each logical chunk.",
            "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            "max_turns": 80
          }
        },
        {
          "name": "verify",
          "depends_on": ["implement"],
          "agent": {
            "runtime": "agent-sdk",
            "model": "claude-sonnet-4-6",
            "system_prompt": "Run the test suite and fix anything that fails. When green, push the branch.",
            "tools": ["Read", "Edit", "Bash", "Grep"],
            "max_turns": 40
          }
        }
      ]
    },
    "max_budget_usd": 10
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "session": {
      "id": "s-abc123xyz",
      "status": "running",
      "flow": "inline-s-abc123xyz",
      "stage": "read-plan",
      "orchestrator": "custom"
    }
  }
}
```

Note the synthetic flow name (`inline-<sessionId>`) -- the inline flow is
persisted on the session so resume and event correlation work.

### 3.1. Inline models / runtimes

For experimental models not yet in the catalog, inline them:

```json
{
  "agent": {
    "runtime": {
      "name": "agent-sdk-custom",
      "type": "agent-sdk",
      "compat": ["bedrock"],
      "secrets": ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]
    },
    "model": {
      "id": "experimental-model-x",
      "provider": "anthropic",
      "provider_slugs": {
        "tf-bedrock": "pi-agentic/global.anthropic.experimental-x-v1"
      }
    },
    "system_prompt": "...",
    "tools": ["Read", "Edit"]
  }
}
```

Ark will resolve the provider slug based on the runtime's `compat` mode and
pass it through to the SDK verbatim. No launcher-side model knowledge.

## 4. Fan-out (for_each)

Sage often wants "apply this stage to each item in a list". Use `for_each`:

```json
{
  "flow": {
    "name": "sage-fan-out-repos",
    "stages": [
      {
        "name": "analyze-each-repo",
        "for_each": {
          "items": "{{inputs.params.repos | tojson}}",
          "mode": "spawn"
        },
        "agent": {
          "runtime": "agent-sdk",
          "model": "claude-sonnet-4-6",
          "system_prompt": "Analyze {{item}} for deprecated APIs.",
          "tools": ["Read", "Glob", "Grep"]
        }
      }
    ]
  },
  "param": { "repos": ["svc-a", "svc-b", "svc-c"] }
}
```

`mode: spawn` means each item becomes its own child session (with its own
compute, its own transcript, its own cost). `mode: inline` means one parent
session iterates them in sequence.

**Monitoring fan-out:** see Section 6.

## 5. Polling: curl + CLI

### 5.1. Dispatch via curl (WebSocket JSON-RPC)

The server daemon only accepts JSON-RPC over WebSocket. Use `websocat`:

```bash
websocat wss://pi-team.mypaytm.com/ark-ws/ <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"session/start","params":{
  "repo":"/home/ec2-user/env/sage-repos/agentic-auth-service",
  "summary":"demo dispatch",
  "flow":"bare"
}}
EOF
```

Or, via the `ark` CLI on the Ark host:

```bash
ark session start --repo ~/env/sage-repos/agentic-auth-service \
                  --summary "demo dispatch" \
                  --flow bare
```

(CLI doesn't yet accept a raw JSON payload file; use WebSocket for that.)

### 5.2. Poll session status (HTTP GET, no auth by default on this box)

```bash
# One session
curl -s https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz | jq

# Root sessions only (skips spawned children)
curl -s 'https://pi-team.mypaytm.com/ark-api/api/sessions?roots=true' | jq '.[] | {id, status, child_stats}'

# Direct children of a parent
curl -s https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz/children | jq

# Full recursive tree
curl -s https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz/tree | jq
```

### 5.3. Stream events (SSE)

Per-session event log:

```bash
curl -Ns https://pi-team.mypaytm.com/ark-api/api/events/s-abc123xyz
```

Emits `event: <type>\ndata: {...}` pairs as the agent progresses.

Fan-out tree live updates (root + all descendants, debounced 200 ms):

```bash
curl -Ns https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz/tree/stream
```

### 5.4. Forensic files (one-shot read)

```bash
# Raw dispatcher stdout/stderr
curl -s https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz/stdio
curl -s 'https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz/stdio?tail=200'

# Full SDK transcript (agent-sdk runtime only)
curl -s https://pi-team.mypaytm.com/ark-api/api/sessions/s-abc123xyz/transcript
```

Files over the 2 MB cap return 413; use `?tail=<N>`.

## 6. Fan-out monitoring -- the "one session spawned 20 children" problem

When you dispatch a `for_each, mode: spawn` stage, the parent session creates
N child sessions. Polling each child individually is a pain -- use the tree
endpoints.

### 6.1. One-shot tree snapshot

```bash
curl -s https://pi-team.mypaytm.com/ark-api/api/sessions/s-root/tree | jq '
  .root |
  {id, status, summary,
   children: [.children[] | {id, status, summary, child_stats,
                             children: [.children[]? | {id, status}]}]}'
```

Each node carries its own `child_stats` rollup so you can stop recursion early
once you're just counting. Max tree depth is 6 (more is almost always a bug).

### 6.2. Live stream

```bash
curl -Ns https://pi-team.mypaytm.com/ark-api/api/sessions/s-root/tree/stream \
  | grep --line-buffered "^data:" \
  | sed 's/^data: //' \
  | jq -c '.root.children | map({id, status}) | {ts: now, children: .}'
```

Opens with an initial snapshot; emits deltas every ~200 ms while any
descendant status or cost changes.

### 6.3. Sage-side monitoring pattern

For a Sage-authored flow that fans out to N repos:

```
1. POST session/start with for_each payload, get root session id
2. Open SSE stream on /tree/stream
3. Aggregate child statuses; when child_stats.total == child_stats.completed + child_stats.failed,
   the fan-out is done
4. Read each child's transcript/stdio for the summaries (cheapest is the transcript endpoint)
5. Emit rollup back to the Sage UI
```

## 7. Drop-in Claude system prompt for your orchestrator

Copy-paste this into your Sage / Claude orchestrator that drives Ark:

```text
You are the Sage execution orchestrator. You dispatch Ark sessions to run
SDLC flows.

## Dispatch contract

Ark's control plane:
- WebSocket JSON-RPC:  wss://pi-team.mypaytm.com/ark-ws/
- HTTP reads:          https://pi-team.mypaytm.com/ark-api/
- Web UI:              https://pi-team.mypaytm.com/ark/

Call `session/start` with an inline flow payload. Every agent in every stage
must carry both `runtime` (string or inline runtime object) and `model`
(string id/alias from the catalog, or inline model object). No --runtime /
--model overrides exist -- the binding lives on the agent.

Available built-in runtimes: agent-sdk, claude, codex, gemini, goose.
Available built-in models: claude-sonnet-4-6 (default), claude-opus-4-7,
claude-haiku-4-5, gpt-5-codex, gemini-2-5-pro, and a few more -- list via
`GET /ark-api/api/models`.

## Payload shape

Minimum:
{ "method": "session/start", "params": {
  "repo": "<abs path on Ark host>",
  "summary": "<one-liner>",
  "flow": { "name": "<sage-plan-id>", "stages": [ ... ] }
}}

Each stage: { name, agent, depends_on?, for_each?, on_failure?, gate? }
Each agent: { runtime, model, system_prompt, tools?, max_turns?, mcp_servers? }

## Fan-out

Use `for_each: { items: "{{...}}", mode: "spawn" }` for N-wise parallelism.
Each item becomes a child session with its own cost + transcript.

## Monitoring

Poll `GET /api/sessions/:rootId/tree` for snapshots.
Open SSE on `/api/sessions/:rootId/tree/stream` for live updates.
Per-child transcript/stdio at `/api/sessions/:id/transcript` and `/stdio`.

Final aggregate: wait until every leaf in the tree is `completed` or
`failed`; root is terminal when all descendants are terminal.

## Rules

- Never hardcode TF bedrock slugs in your payload. Always use catalog model
  ids; Ark handles the provider-slug rewrite.
- For each stage, pick ONE agent per execution. Multi-agent stages happen
  via fan-out, not via multiple agents inside one stage.
- Keep prompts short and declarative: what the agent should do, what files
  it should read/write, what "done" looks like.
- Always pass `max_budget_usd` at the session level for any multi-stage or
  fan-out flow -- defends against runaway cost.
- Use the inline-model object only when the catalog truly doesn't have the
  model you need; prefer catalog ids.
```

## 8. Error cases

- **`Model "X" not found in catalog.`** -- The `model:` string on an agent
  doesn't match any id or alias. Either fix the id or inline the model
  definition.
- **`Runtime "X" not found.`** -- Same, for the runtime. Inline or fix.
- **`Agent "X" has no model.`** -- Agents must carry `model:`. No host-side
  defaults.
- **`Parent-session required; pass the root`** -- You called `session/tree`
  on a child session. Walk up via the child's `parent_session_id`.
- **`file is <N> bytes, over the 2MB cap`** -- Use `?tail=<N>`.

## 9. Links

- Web UI (session detail with Flow tree panel): https://pi-team.mypaytm.com/ark/
- Model catalog: `GET /ark-api/api/models`
- Health: `GET /ark-api/api/sessions` (200 = control plane up)

---

_This doc tracks Ark v0.20.0. If something here doesn't match what the live
API accepts, check the version with `curl https://pi-team.mypaytm.com/ark-api/api/sessions` returning your fleet -- stale docs, not stale code._
