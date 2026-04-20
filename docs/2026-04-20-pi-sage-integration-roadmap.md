# Pi-sage integration roadmap (2026-04-20)

## Context

Pi-sage (`bitbucket.org/paytmteam/pi-sage`) is Paytm's internal Jira+KB intelligence layer. Ships a worktree-based plan executor today that shells out to `goose`, `claude-code`, or `dry-run`. Ark is the orchestrator (11 compute targets, multi-runtime, DAG flows, control plane). The two are complementary, not competitors -- pi-sage owns analysis + recipe + worktree + Jira sync; Ark owns compute + runtime + fleet orchestration.

## What we agreed to build

### 1. Pi-sage calls Ark directly -- **pi-sage side change, owned by pi-sage maintainers**

Pi-sage adds `SAGE_EXECUTOR=ark` to `_run_executor()`. Calls:

```
ark exec \
  --repo <worktree> \
  --flow <autonomous-flow> \
  --compute $SAGE_ARK_COMPUTE \
  --input recipe=.sage-task.md \
  --output json
```

Env vars on pi-sage side: `SAGE_ARK_BIN`, `SAGE_ARK_RUNTIME`, `SAGE_ARK_COMPUTE`. No new pi-sage schema. Autonomy is encoded in the flow, not a flag. We will ask pi-sage maintainers to implement this and hand them the bridge spec we already drafted.

### 2. Ark-side support for the handoff -- **ark side, owned by us**

**a. `--input <key=path>` on `ark exec`.** Today's CLI accepts `--summary` and sanitizes to a 60-char alphanumeric label, which mangles recipes. `startSession` already accepts `inputs.files: Record<string, string>` (role -> path); template resolver flattens to `{inputs.files.<role>}` placeholders. Only the CLI surface is missing. Small fix.

**b. A goose flow that consumes `{inputs.files.recipe}`.** One new flow definition + one new agent (`runtime: goose`, `recipe: {inputs.files.recipe}`). Single stage, no gates, fully autonomous. Works for Claude / Codex / Gemini too by swapping runtime in the flow.

**c. Same capability via webhook.** Webhook POST into `/webhooks/pi-sage` (or `/webhooks/generic-hmac`) -> dispatcher writes payload recipe to disk -> calls the same flow path with `inputs.files.recipe = <written path>`. Parity with CLI entry. Requires Agent C's dispatcher (see item 5).

### 3. Connector framework + pi-sage connector -- **ark side**

External systems unified as "integrations" with two opt-in capabilities: **trigger source** (inbound) and **connector** (outbound tools for agents). Connector replaces the earlier idea of mounting pi-sage's MCP server into the Claude runtime. Per-session / per-flow / per-agent opt-in. Shared auth + config registry.

First connector shipped: `pi-sage` (MCP-backed: `kb_search`, `kb_search_repo`, `kb_blast_radius`, `kb_graph`, `jira_get_issue`, etc.). Shape must generalize to Jira, GitHub, Linear, Slack, Confluence follow-on connectors.

### 4. `from-sage-analysis` flow -- **ark side**

The runtime-neutral replacement for pi-sage's Goose-specific recipe generator. Takes a pi-sage analysis JSON (by ID + pi-sage base URL, or by file path) and fans out one Ark stream per affected repo. Each TDD task in a stream becomes one agent step in a DAG sequenced by dependency order.

Prompts for each step are built from: ticket summary, repo context, resolved gap decisions, the task's own description/files/validation block. Runtime and compute are flow-level config, so any supported runtime executes.

CLI: `ark sage <analysis-ref>` or `ark flow run from-sage-analysis --analysis <ref>` (match existing CLI conventions).

### 5. Trigger framework -- **ark side**

One canonical pipeline: `Source -> Receiver (verify/parse) -> NormalizedEvent -> Matcher -> Dispatcher -> Flow`. Four trigger kinds: `webhook`, `schedule`, `poll`, `event` (last one interface-only for now).

Per-source connectors shipped fully: `github`, `bitbucket`, `slack`, `generic-hmac`. Scaffolded: `linear`, `pagerduty`, `prometheus`, `jira`. Stub config example for `pi-sage` (points at `from-sage-analysis` flow).

Signature verification mandatory for every public source. Secrets stored in the existing auth layer keyed by source + tenant. Trigger configs YAML-first at `triggers/*.yaml`, DB-registerable later in control-plane mode. Server route `POST /webhooks/:source` returns 2xx fast; flow dispatch is enqueued.

### 6. KB migration plan + Phase 1 -- **ark side**

Long-term: collapse pi-sage's 8-language indexer / 65K chunks / pgvector embeddings / blast-radius queries into Ark's `packages/core/knowledge`. Short-term: ship a phased migration plan + one concrete slice. Candidates for Phase 1 (pick smallest high-value): multi-repo support, blast-radius query, one missing language extractor (Java highest-value for Paytm).

## Current state

| # | Item | Status |
|---|------|--------|
| 1 | Pi-sage `SAGE_EXECUTOR=ark` | Spec handed off; pi-sage team implements |
| 2a | `--input` on `ark exec` | In progress (this session) |
| 2b | Goose flow using `inputs.files.recipe` | In progress (this session) |
| 2c | Webhook parity for the same flow | Depends on 5 (Agent C review) |
| 3 | Connector framework + pi-sage connector | Queued, agent dispatch after API cools |
| 4 | `from-sage-analysis` flow | Queued, agent dispatch after API cools |
| 5 | Trigger framework | Agent C code landed in `worktree-agent-adc83575`; tests + docs + pi-sage stub missing. Review + finish pending. |
| 6 | KB migration plan + Phase 1 | Queued, agent dispatch after API cools |

## Sequential plan from here

1. Wire `--input` through `ark exec` (2a). Add a test.
2. Ship the goose flow definition + goose agent referencing `{inputs.files.recipe}` (2b). Manual smoke test.
3. Review Agent C's worktree for quality; finish tests + pi-sage stub + docs (5). Merge.
4. Webhook dispatcher routes the same goose flow path as the CLI -- verify parity (2c).
5. Dispatch single fresh agent for item 3 (connector framework). One at a time now, not parallel.
6. Dispatch single agent for item 4 (`from-sage-analysis`).
7. Dispatch single agent for item 6 (KB migration plan + Phase 1).

## Design decisions locked

- **Autonomy is a flow property, not a CLI flag.** Drop `--autonomy` plumbing. Pick an autonomous flow instead.
- **No bridge command in Ark.** Pi-sage calls `ark exec` directly with `--input`. The only reason we'd add a subcommand is if the invocation gets complex enough to warrant a wrapper, which it does not.
- **Recipe is an opaque prompt.** Pi-sage's multi-step plan structure stays in pi-sage's stream orchestrator. Per-task recipe is a single instruction. If we want Ark-side DAG decomposition of a full analysis, that's `from-sage-analysis`, not per-task recipe parsing.
- **Integration = trigger source + connector, both opt-in.** Covers pi-sage, Jira, GitHub, Bitbucket, Linear, Slack, Confluence, PagerDuty, Prometheus uniformly.
- **Goose is one runtime among many.** Goose-specific recipe YAML format is not the serialization layer; Ark flows are.
- **CLI entry and webhook entry hit the same flow path.** Anything you can do via `ark exec` you can do via webhook, and vice versa.
