# Ark Flows Reference

Complete reference for all builtin flow definitions. Flows define multi-stage workflows that Ark orchestrates, assigning agents to each stage and controlling progression with gates. See the [User Guide](guide.md#flow-definitions) for an overview.

## Three-Tier Resolution

Flows resolve in priority order:

1. **Project**: `.ark/flows/<name>.yaml` in the repo
2. **Global**: `~/.ark/flows/<name>.yaml`
3. **Builtin**: `flows/definitions/<name>.yaml` shipped with Ark

---

## Builtin Flows

### default

Full SDLC pipeline with planning, implementation, PR, review, build, merge, and documentation stages.

```
plan (manual) -> implement (auto) -> pr (auto) -> review (auto) -> build (auto) -> merge (manual) -> close (auto) -> docs (auto, optional)
```

| Stage | Agent/Action | Gate | Notes |
|-------|-------------|------|-------|
| plan | planner | manual | Creates PLAN.md. Human reviews before proceeding. |
| implement | implementer | auto | Implements the plan. Retries up to 3 times on failure. |
| pr | `create_pr` action | auto | Pushes branch and creates a GitHub PR. |
| review | reviewer | auto | Reviews the diff for quality, security, and correctness. |
| build | `wait_flow` action | auto | Waits for CI. Notifies on failure. |
| merge | `merge_pr` action | manual | Human approves the merge. |
| close | `close_ticket` action | auto | Closes the associated ticket. |
| docs | documenter | auto | Updates documentation. Optional -- skipped if not needed. |

**Best for**: Feature development with full human oversight.

```bash
ark session start --repo . --summary "Add OAuth2 login" --flow default --dispatch
```

### quick

Streamlined flow: implement, create PR, wait for build, then merge. No planning or review stages.

```
implement (auto) -> pr (auto) -> build (auto) -> merge (manual)
```

| Stage | Agent/Action | Gate | Notes |
|-------|-------------|------|-------|
| implement | implementer | auto | Retries up to 3 times on failure. |
| pr | `create_pr` action | auto | Pushes branch and creates a PR. |
| build | `wait_flow` action | auto | Waits for CI. Notifies on failure. |
| merge | `merge_pr` action | manual | Human approves. |

**Best for**: Bug fixes and small changes where planning is overhead.

```bash
ark session start --repo . --summary "Fix login timeout" --flow quick --dispatch
```

### bare

Single-agent session with no predefined stages beyond one. The user decides when to stop.

```
work (manual)
```

| Stage | Agent/Action | Gate | Notes |
|-------|-------------|------|-------|
| work | worker | manual | Open-ended. Human marks done when satisfied. |

**Best for**: Interactive pairing, exploration, one-off tasks, CI/CD (`ark exec`).

```bash
ark session start --repo . --summary "Explore the auth module" --flow bare --dispatch --attach
```

### parallel

Plan first, then fork the implementation into parallel child sessions, review, and merge.

```
plan (manual) -> implement[fork] (auto) -> review (auto) -> pr (auto) -> merge (manual)
```

| Stage | Agent/Action | Gate | Notes |
|-------|-------------|------|-------|
| plan | planner | manual | Creates PLAN.md with decomposed subtasks. |
| implement | implementer (forked) | auto | `type: fork`. Reads PLAN.md to split into subtasks. Up to 4 parallel children. |
| review | reviewer | auto | Reviews the combined changes. |
| pr | `create_pr` action | auto | Creates PR for the merged work. |
| merge | `merge_pr` action | manual | Human approves. |

**Best for**: Large features that can be decomposed into independent subtasks.

```bash
ark session start --repo . --summary "Migrate to new API" --flow parallel --dispatch
```

### fan-out

Plan then execute multiple tasks in parallel via the fan-out stage type.

```
plan (manual) -> execute[fan_out] (auto) -> review (auto)
```

| Stage | Agent/Action | Gate | Notes |
|-------|-------------|------|-------|
| plan | planner | manual | Decomposes the task into a JSON array of subtasks. |
| execute | fan_out | auto | Spawns parallel child sessions from the planner's subtask list. Parent auto-joins when all children complete. |
| review | reviewer | auto | Reviews the combined output. |

The planner's output must include a JSON array: `[{"summary": "...", "agent": "implementer"}, ...]`

**Best for**: Task decomposition where the planner decides the split.

```bash
ark session start --repo . --summary "Add tests for all API endpoints" --flow fan-out --dispatch
```

### pr-review

Review-focused flow: plan, implement, create PR, wait for human review approval, then merge.

```
plan (manual) -> implement (auto) -> review (review gate) -> merge (auto)
```

| Stage | Agent/Action | Gate | Notes |
|-------|-------------|------|-------|
| plan | planner | manual | Creates PLAN.md. |
| implement | implementer | auto | Implements the plan. |
| review | worker | review | Creates a PR, addresses review comments. Advances when PR is approved. |
| merge | worker | auto | Merges the approved PR and verifies the build. |

**Best for**: Workflows that need human PR review before merge.

```bash
ark session start --repo . --summary "Add rate limiting" --flow pr-review --dispatch
```

### dag-parallel

DAG-based parallel execution with explicit dependency edges between stages.

```
plan (manual) -> implement + test [parallel, depends_on: plan] -> integrate [depends_on: implement, test] -> review (manual) -> pr (auto)
```

| Stage | Agent/Action | Gate | Depends On |
|-------|-------------|------|------------|
| plan | planner | manual | -- |
| implement | implementer | auto | plan |
| test | implementer | auto | plan |
| integrate | implementer | auto | implement, test |
| review | reviewer | manual | integrate |
| pr | `create_pr` action | auto | review |

Stages with the same dependencies run in parallel. The `depends_on` field creates a directed acyclic graph (DAG) that the scheduler resolves.

**Best for**: Complex tasks where implementation and testing can proceed in parallel, then converge.

```bash
ark session start --repo . --summary "Refactor auth system" --flow dag-parallel --dispatch
```

---

## Flow YAML Fields

Full field reference for flow definition files.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Flow identifier (matches filename without extension) |
| `description` | string | yes | Short description shown in `ark flow list` |
| `stages` | array | yes | Ordered list of stage definitions |

### Stage Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Stage name (must be unique within the flow) |
| `agent` | string | no | Agent to run for this stage |
| `action` | string | no | Built-in action: `create_pr`, `merge_pr`, `wait_flow`, `close_ticket` |
| `gate` | string | yes | Gate type: `manual`, `auto`, `review`, or `condition` |
| `type` | string | no | Stage type: `fork` (parallel fork/join) or `fan_out` (dynamic fan-out) |
| `on_failure` | string | no | Failure handling: `retry(N)` or `notify` |
| `verify` | string[] | no | Shell scripts that must pass before stage completion |
| `artifacts` | string[] | no | Files produced by this stage |
| `task` | string | no | Custom task prompt (overrides auto-generated prompt) |
| `optional` | boolean | no | If true, stage can be skipped |
| `strategy` | string | no | Fork strategy: `plan` (reads PLAN.md for subtasks) |
| `max_parallel` | number | no | Max concurrent children for `fork` type |
| `depends_on` | string[] | no | Stage names this stage depends on (DAG scheduling) |

### Gate Types

| Gate | Behavior |
|------|----------|
| `manual` | Human must approve before advancing (TUI: `A` or `Enter`) |
| `auto` | Advances automatically when the agent completes |
| `review` | Advances when an external review (e.g., PR approval) is received |
| `condition` | Advances when a condition expression evaluates to true |

### Built-in Actions

| Action | Description |
|--------|-------------|
| `create_pr` | Pushes the worktree branch and creates a GitHub PR |
| `merge_pr` | Merges the PR into the target branch |
| `wait_flow` | Waits for CI check suites to complete |
| `close_ticket` | Closes the associated ticket |

### Verify Gates

The `verify` field on any stage lists shell scripts (e.g., `npm test`, `npm run lint`) that MUST pass before the agent can report the stage as complete. If any script fails, completion is blocked and the agent is automatically steered to fix the failure. Verify scripts can also be declared at the repo level via `.ark.yaml` as a default for all stages.

Todos (user-added checklist items via `ark session todo add`) also block completion. Use `--force` to override either gate.

```yaml
stages:
  - name: implement
    agent: implementer
    gate: auto
    verify:
      - "npm test"
      - "npm run lint"
```

### Fail-loopback (Retry on Failure)

The `on_failure` field on a stage controls what happens when the agent reports a failure. Use `retry(N)` to automatically retry the stage up to N times with error context injected into the agent's next turn:

```yaml
stages:
  - name: implement
    agent: implementer
    gate: auto
    on_failure: "retry(3)"    # retry up to 3 times, max
```

Other values: `notify` (notify via bridge and pause), omitted (stop on failure).

---

## Managing Flows

```bash
ark flow list              # List all available flows
ark flow show default      # Show flow definition with stages
ark flow show quick        # Show the quick flow
```

In the TUI, press `3` to switch to the Flows tab. Navigate with `j/k` and toggle to the detail pane with `Tab`.
