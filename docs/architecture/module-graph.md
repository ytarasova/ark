# Module Graph

> generated: 1970-01-01T00:00:00.000Z  -  regenerate with `make audit`.

Tracked packages: core, server, cli, web, protocol, compute, router, arkd, types.  Total modules: **746**.

## Fan-in leaderboard (top 20)

| module | fan-in |
| --- | --- |
| `packages/core/app.ts` | 133 |
| `packages/core/observability/structured-log.ts` | 121 |
| `packages/types/index.ts` | 83 |
| `packages/web/src/lib/utils.ts` | 66 |
| `packages/core/database/index.ts` | 59 |
| `packages/server/router.ts` | 37 |
| `packages/web/src/hooks/useApi.ts` | 36 |
| `packages/web/src/components/ui/button.tsx` | 31 |
| `packages/server/validate.ts` | 29 |
| `packages/cli/app-client.ts` | 26 |
| `packages/protocol/types.ts` | 25 |
| `packages/core/constants.ts` | 22 |
| `packages/core/safe.ts` | 22 |
| `packages/compute/types.ts` | 20 |
| `packages/core/config.ts` | 20 |
| `packages/core/services/session-orchestration.ts` | 20 |
| `packages/compute/core/types.ts` | 18 |
| `packages/core/infra/tmux.ts` | 18 |
| `packages/core/triggers/types.ts` | 18 |
| `packages/web/src/hooks/useDaemonStatus.ts` | 18 |

## Orphans (91)

Modules with fan-in 0. Entry points (cli/index.ts, packages/server/index.ts, test setup) are expected here; everything else is a dead-code candidate.

- `packages/cli/client.ts`
- `packages/cli/run.ts`
- `packages/compute/adapters/legacy.ts`
- `packages/compute/core/firecracker/index.ts`
- `packages/compute/core/pool/local-firecracker-pool.ts`
- `packages/compute/flag-specs/index.ts`
- `packages/compute/providers/ec2/clipboard.ts`
- `packages/compute/providers/ec2/metrics.ts`
- `packages/compute/providers/ec2/ports.ts`
- `packages/compute/providers/ec2/queue.ts`
- `packages/compute/providers/ec2/remote-setup.ts`
- `packages/core/acp.ts`
- `packages/core/adapters/control-plane/index.ts`
- `packages/core/adapters/local/index.ts`
- `packages/core/adapters/test/index.ts`
- `packages/core/agent/index.ts`
- `packages/core/auth/middleware.ts`
- `packages/core/auth/teams.ts`
- `packages/core/auth/tenants.ts`
- `packages/core/auth/users.ts`
- `packages/core/claude/index.ts`
- `packages/core/code-intel/extractors/platform-docs/api-endpoint-registry.ts`
- `packages/core/code-intel/extractors/platform-docs/contributor-expertise-map.ts`
- `packages/core/code-intel/extractors/platform-docs/database-schema-map.ts`
- `packages/core/code-intel/extractors/platform-docs/service-dependency-graph.ts`
- `packages/core/code-intel/index.ts`
- `packages/core/code-intel/interfaces/index.ts`
- `packages/core/code-intel/interfaces/ranker.ts`
- `packages/core/code-intel/queries/index.ts`
- `packages/core/compute/index.ts`
- `packages/core/conductor/index.ts`
- `packages/core/database/sqlite.ts`
- `packages/core/drizzle/client.ts`
- `packages/core/drizzle/schema/index.ts`
- `packages/core/drizzle/types.ts`
- `packages/core/extension-catalog.ts`
- `packages/core/hosted/server.ts`
- `packages/core/infra/index.ts`
- `packages/core/infra/instance-lock.ts`
- `packages/core/infra/update-check.ts`
- `packages/core/integrations/index.ts`
- `packages/core/knowledge/codegraph-shim.ts`
- `packages/core/knowledge/index.ts`
- `packages/core/knowledge/mcp.ts`
- `packages/core/launchers/arkd.ts`
- `packages/core/launchers/container.ts`
- `packages/core/launchers/index.ts`
- `packages/core/mcp-pool.ts`
- `packages/core/observability/index.ts`
- `packages/core/repositories/secrets.ts`
- `packages/core/review.ts`
- `packages/core/sandbox.ts`
- `packages/core/search/index.ts`
- `packages/core/services/agent-launcher.ts`
- `packages/core/services/session-output.ts`
- `packages/core/services/subagents.ts`
- `packages/core/session/index.ts`
- `packages/core/state/index.ts`
- `packages/core/state/ui-state.ts`
- `packages/core/tickets/registry.ts`
- `packages/core/tickets/richtext/adf.ts`
- `packages/core/tickets/richtext/markdown.ts`
- `packages/core/tickets/richtext/prosemirror.ts`
- `packages/core/tools/registry.ts`
- `packages/core/triggers/dispatcher.ts`
- `packages/core/triggers/matcher.ts`
- `packages/core/triggers/secrets.ts`
- `packages/core/triggers/store.ts`
- `packages/core/worktree-merge.ts`
- `packages/protocol/index.ts`
- `packages/router/config.ts`
- `packages/types/artifact.ts`
- `packages/types/rpc.ts`
- `packages/types/tenant.ts`
- `packages/web/build.ts`
- `packages/web/playwright.config.ts`
- `packages/web/src/App.tsx`
- `packages/web/src/components/ChatPanel.tsx`
- `packages/web/src/components/Sidebar.tsx`
- `packages/web/src/components/Terminal.tsx`
- `packages/web/src/components/flow-editor/FlowEditor.tsx`
- `packages/web/src/components/flow-editor/index.ts`
- `packages/web/src/components/pipeline/index.ts`
- `packages/web/src/components/ui/IntegrationPill.tsx`
- `packages/web/src/components/ui/ReviewFinding.tsx`
- `packages/web/src/components/ui/WorkspacePanel.tsx`
- `packages/web/src/components/ui/styles.ts`
- `packages/web/src/hooks/useQueries.ts`
- `packages/web/src/themes/typography.ts`
- `packages/web/src/transport/MockTransport.ts`
- `packages/web/vite.config.ts`

## Full graph

<details><summary>746 modules</summary>

### `packages/arkd/client.ts`

- fan-in: 10
- fan-out: 1
- imports:
  - `packages/arkd/types.ts`

### `packages/arkd/index.ts`

- fan-in: 2
- fan-out: 0

### `packages/arkd/server.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/arkd/types.ts`
  - `packages/core/constants.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/arkd/types.ts`

- fan-in: 2
- fan-out: 0

### `packages/cli/app-client.ts`

- fan-in: 26
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/config.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/protocol/client.ts`
  - `packages/protocol/transport.ts`

### `packages/cli/client.ts`

- fan-in: 0
- fan-out: 0

### `packages/cli/commands/_shared.ts`

- fan-in: 6
- fan-out: 0

### `packages/cli/commands/agent.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/auth.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/cluster.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/code-intel.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/code-intel/util/git.ts`

### `packages/cli/commands/compute.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/cli/app-client.ts`
  - `packages/compute/adapters/provider-map.ts`
  - `packages/compute/index.ts`
  - `packages/core/compute/pool.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/types/index.ts`

### `packages/cli/commands/conductor.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/costs.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/index.ts`

### `packages/cli/commands/daemon.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/arkd/index.ts`
  - `packages/core/constants.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/cli/commands/dashboard.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/db.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/eval.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/commands/_shared.ts`

### `packages/cli/commands/exec-try.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/cli/app-client.ts`
  - `packages/cli/exec.ts`
  - `packages/core/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/cli/commands/flow.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/commands/_shared.ts`

### `packages/cli/commands/knowledge.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/knowledge/codebase-memory-finder.ts`

### `packages/cli/commands/memory.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/commands/_shared.ts`

### `packages/cli/commands/misc.ts`

- fan-in: 1
- fan-out: 12
- imports:
  - `packages/arkd/index.ts`
  - `packages/cli/app-client.ts`
  - `packages/cli/helpers.ts`
  - `packages/core/conductor/channel.ts`
  - `packages/core/conductor/conductor.ts`
  - `packages/core/constants.ts`
  - `packages/core/hosted/web-proxy.ts`
  - `packages/core/index.ts`
  - `packages/core/integrations/github-pr.ts`
  - `packages/core/integrations/issue-poller.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/prereqs.ts`

### `packages/cli/commands/profile.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/commands/_shared.ts`

### `packages/cli/commands/recipe.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/index.ts`

### `packages/cli/commands/router.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/constants.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/router/index.ts`
  - `packages/router/index.ts`

### `packages/cli/commands/runtime.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/sage.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/schedule.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/commands/_shared.ts`

### `packages/cli/commands/search.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/index.ts`

### `packages/cli/commands/secrets.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/server-daemon.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/config.ts`
  - `packages/core/constants.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/server/index.ts`
  - `packages/server/register.ts`

### `packages/cli/commands/server.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/cli/commands/server-daemon.ts`
  - `packages/core/config.ts`
  - `packages/core/hosted/index.ts`
  - `packages/core/index.ts`
  - `packages/server/index.ts`
  - `packages/server/register.ts`

### `packages/cli/commands/session.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/cli/app-client.ts`
  - `packages/cli/helpers.ts`
  - `packages/core/index.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/prereqs.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/types/index.ts`

### `packages/cli/commands/skill.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/team.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/protocol/client.ts`

### `packages/cli/commands/tenant-config.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/tenant.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/trigger.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/commands/_shared.ts`

### `packages/cli/commands/user.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/cli/app-client.ts`

### `packages/cli/commands/workspace.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/config.ts`

### `packages/cli/commands/worktree.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/cli/app-client.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/cli/exec.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/code-intel/constants.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/cli/helpers.ts`

- fan-in: 2
- fan-out: 0

### `packages/cli/index.ts`

- fan-in: 1
- fan-out: 37
- imports:
  - `packages/cli/app-client.ts`
  - `packages/cli/commands/agent.ts`
  - `packages/cli/commands/auth.ts`
  - `packages/cli/commands/cluster.ts`
  - `packages/cli/commands/code-intel.ts`
  - `packages/cli/commands/compute.ts`
  - `packages/cli/commands/conductor.ts`
  - `packages/cli/commands/costs.ts`
  - `packages/cli/commands/daemon.ts`
  - `packages/cli/commands/dashboard.ts`
  - `packages/cli/commands/db.ts`
  - `packages/cli/commands/eval.ts`
  - `packages/cli/commands/exec-try.ts`
  - `packages/cli/commands/flow.ts`
  - `packages/cli/commands/knowledge.ts`
  - `packages/cli/commands/memory.ts`
  - `packages/cli/commands/misc.ts`
  - `packages/cli/commands/profile.ts`
  - `packages/cli/commands/recipe.ts`
  - `packages/cli/commands/router.ts`
  - `packages/cli/commands/runtime.ts`
  - `packages/cli/commands/sage.ts`
  - `packages/cli/commands/schedule.ts`
  - `packages/cli/commands/search.ts`
  - `packages/cli/commands/secrets.ts`
  - `packages/cli/commands/server.ts`
  - `packages/cli/commands/session.ts`
  - `packages/cli/commands/skill.ts`
  - `packages/cli/commands/team.ts`
  - `packages/cli/commands/tenant-config.ts`
  - `packages/cli/commands/tenant.ts`
  - `packages/cli/commands/trigger.ts`
  - `packages/cli/commands/user.ts`
  - `packages/cli/commands/workspace.ts`
  - `packages/cli/commands/worktree.ts`
  - `packages/core/index.ts`
  - `packages/core/version.ts`

### `packages/cli/run.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/cli/index.ts`

### `packages/compute/adapters/legacy.ts`

- fan-in: 0
- fan-out: 14
- imports:
  - `packages/compute/core/compute-target.ts`
  - `packages/compute/core/ec2.ts`
  - `packages/compute/core/firecracker/compute.ts`
  - `packages/compute/core/k8s-kata.ts`
  - `packages/compute/core/k8s.ts`
  - `packages/compute/core/local.ts`
  - `packages/compute/providers/k8s.ts`
  - `packages/compute/providers/local-arkd.ts`
  - `packages/compute/providers/remote-arkd.ts`
  - `packages/compute/runtimes/devcontainer.ts`
  - `packages/compute/runtimes/direct.ts`
  - `packages/compute/runtimes/docker.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`

### `packages/compute/adapters/provider-map.ts`

- fan-in: 5
- fan-out: 1
- imports:
  - `packages/compute/core/types.ts`

### `packages/compute/arc-json.ts`

- fan-in: 5
- fan-out: 2
- imports:
  - `packages/compute/types.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/core/compute-target.ts`

- fan-in: 3
- fan-out: 3
- imports:
  - `packages/compute/core/pool/types.ts`
  - `packages/compute/core/types.ts`
  - `packages/core/app.ts`

### `packages/compute/core/ec2.ts`

- fan-in: 2
- fan-out: 8
- imports:
  - `packages/compute/core/types.ts`
  - `packages/compute/providers/ec2/cloud-init.ts`
  - `packages/compute/providers/ec2/provision.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/compute/util.ts`
  - `packages/core/app.ts`
  - `packages/core/config/port-allocator.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/core/firecracker/availability.ts`

- fan-in: 1
- fan-out: 0

### `packages/compute/core/firecracker/compute.ts`

- fan-in: 3
- fan-out: 8
- imports:
  - `packages/compute/core/firecracker/availability.ts`
  - `packages/compute/core/firecracker/network.ts`
  - `packages/compute/core/firecracker/paths.ts`
  - `packages/compute/core/firecracker/rootfs.ts`
  - `packages/compute/core/firecracker/vm.ts`
  - `packages/compute/core/types.ts`
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/core/firecracker/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/compute/core/firecracker/network.ts`

- fan-in: 1
- fan-out: 0

### `packages/compute/core/firecracker/paths.ts`

- fan-in: 3
- fan-out: 0

### `packages/compute/core/firecracker/rootfs.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/compute/core/firecracker/paths.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/core/firecracker/vm.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/core/firecracker/paths.ts`

### `packages/compute/core/k8s-kata.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/compute/core/k8s.ts`
  - `packages/compute/core/types.ts`

### `packages/compute/core/k8s.ts`

- fan-in: 3
- fan-out: 4
- imports:
  - `packages/compute/core/types.ts`
  - `packages/core/app.ts`
  - `packages/core/config/port-allocator.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/core/local.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/compute/core/types.ts`
  - `packages/core/app.ts`

### `packages/compute/core/pool/local-firecracker-pool.ts`

- fan-in: 0
- fan-out: 4
- imports:
  - `packages/compute/core/firecracker/compute.ts`
  - `packages/compute/core/pool/types.ts`
  - `packages/compute/core/types.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/core/pool/types.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/compute/core/types.ts`

### `packages/compute/core/snapshot-store-fs.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/core/snapshot-store.ts`

### `packages/compute/core/snapshot-store.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/compute/core/types.ts`

### `packages/compute/core/types.ts`

- fan-in: 18
- fan-out: 1
- imports:
  - `packages/core/app.ts`

### `packages/compute/flag-spec.ts`

- fan-in: 6
- fan-out: 0

### `packages/compute/flag-specs/docker.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/flag-spec.ts`

### `packages/compute/flag-specs/ec2.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/compute/flag-spec.ts`
  - `packages/compute/providers/ec2/provision.ts`

### `packages/compute/flag-specs/firecracker.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/flag-spec.ts`

### `packages/compute/flag-specs/index.ts`

- fan-in: 0
- fan-out: 6
- imports:
  - `packages/compute/flag-spec.ts`
  - `packages/compute/flag-specs/docker.ts`
  - `packages/compute/flag-specs/ec2.ts`
  - `packages/compute/flag-specs/firecracker.ts`
  - `packages/compute/flag-specs/k8s.ts`
  - `packages/compute/flag-specs/local.ts`

### `packages/compute/flag-specs/k8s.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/flag-spec.ts`

### `packages/compute/flag-specs/local.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/flag-spec.ts`

### `packages/compute/index.ts`

- fan-in: 10
- fan-out: 7
- imports:
  - `packages/compute/providers/docker/index.ts`
  - `packages/compute/providers/k8s.ts`
  - `packages/compute/providers/local-arkd.ts`
  - `packages/compute/providers/local/index.ts`
  - `packages/compute/providers/remote-arkd.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`

### `packages/compute/providers/arkd-backed.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/arkd/client.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`

### `packages/compute/providers/docker/compose.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/compute/arc-json.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/providers/docker/devcontainer-resolve.ts`

- fan-in: 1
- fan-out: 0

### `packages/compute/providers/docker/devcontainer.ts`

- fan-in: 3
- fan-out: 0

### `packages/compute/providers/docker/helpers.ts`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/compute/providers/docker/index.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/compute/providers/docker/devcontainer.ts`
  - `packages/compute/providers/docker/helpers.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/safe.ts`
  - `packages/types/index.ts`

### `packages/compute/providers/ec2/clipboard.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/providers/ec2/cloud-init.ts`

- fan-in: 2
- fan-out: 0

### `packages/compute/providers/ec2/constants.ts`

- fan-in: 3
- fan-out: 0

### `packages/compute/providers/ec2/cost.ts`

- fan-in: 1
- fan-out: 0

### `packages/compute/providers/ec2/metrics.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/compute/providers/ec2/constants.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/compute/types.ts`

### `packages/compute/providers/ec2/pool.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/safe.ts`

### `packages/compute/providers/ec2/ports.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/compute/types.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/providers/ec2/provision.ts`

- fan-in: 3
- fan-out: 0

### `packages/compute/providers/ec2/queue.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/compute/providers/ec2/pool.ts`

### `packages/compute/providers/ec2/remote-setup.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/compute/providers/ec2/constants.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/compute/util.ts`

### `packages/compute/providers/ec2/shell-escape.ts`

- fan-in: 3
- fan-out: 0

### `packages/compute/providers/ec2/ssh.ts`

- fan-in: 10
- fan-out: 2
- imports:
  - `packages/compute/providers/ec2/shell-escape.ts`
  - `packages/compute/util.ts`

### `packages/compute/providers/ec2/sync.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/compute/providers/ec2/constants.ts`
  - `packages/compute/providers/ec2/shell-escape.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/core/safe.ts`

### `packages/compute/providers/k8s.ts`

- fan-in: 3
- fan-out: 6
- imports:
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/config/clusters.ts`
  - `packages/core/constants.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/dispatch-claude-auth.ts`

### `packages/compute/providers/local-arkd.ts`

- fan-in: 2
- fan-out: 8
- imports:
  - `packages/compute/providers/arkd-backed.ts`
  - `packages/compute/providers/docker/devcontainer.ts`
  - `packages/compute/providers/docker/helpers.ts`
  - `packages/compute/types.ts`
  - `packages/core/config/port-allocator.ts`
  - `packages/core/constants.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/safe.ts`

### `packages/compute/providers/local/index.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/compute/providers/local/metrics.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/constants.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/safe.ts`

### `packages/compute/providers/local/metrics.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/compute/types.ts`
  - `packages/core/executors/process-tree.ts`
  - `packages/core/infra/tmux.ts`

### `packages/compute/providers/remote-arkd.ts`

- fan-in: 2
- fan-out: 11
- imports:
  - `packages/compute/providers/arkd-backed.ts`
  - `packages/compute/providers/ec2/cloud-init.ts`
  - `packages/compute/providers/ec2/cost.ts`
  - `packages/compute/providers/ec2/pool.ts`
  - `packages/compute/providers/ec2/provision.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/compute/providers/ec2/sync.ts`
  - `packages/compute/types.ts`
  - `packages/compute/util.ts`
  - `packages/core/constants.ts`
  - `packages/core/safe.ts`

### `packages/compute/runtimes/devcontainer.ts`

- fan-in: 2
- fan-out: 6
- imports:
  - `packages/arkd/client.ts`
  - `packages/compute/core/types.ts`
  - `packages/compute/providers/docker/devcontainer-resolve.ts`
  - `packages/compute/providers/docker/helpers.ts`
  - `packages/core/app.ts`
  - `packages/core/config/port-allocator.ts`

### `packages/compute/runtimes/direct.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/arkd/client.ts`
  - `packages/compute/core/types.ts`
  - `packages/core/app.ts`

### `packages/compute/runtimes/docker-compose.ts`

- fan-in: 1
- fan-out: 10
- imports:
  - `packages/arkd/client.ts`
  - `packages/compute/arc-json.ts`
  - `packages/compute/core/types.ts`
  - `packages/compute/providers/docker/compose.ts`
  - `packages/compute/providers/docker/helpers.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/config/port-allocator.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/safe.ts`

### `packages/compute/runtimes/docker-config.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/compute/providers/docker/helpers.ts`

### `packages/compute/runtimes/docker.ts`

- fan-in: 2
- fan-out: 7
- imports:
  - `packages/arkd/client.ts`
  - `packages/compute/core/types.ts`
  - `packages/compute/providers/docker/helpers.ts`
  - `packages/compute/runtimes/docker-config.ts`
  - `packages/core/app.ts`
  - `packages/core/config/port-allocator.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/compute/types.ts`

- fan-in: 20
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/compute/util.ts`

- fan-in: 4
- fan-out: 0

### `packages/core/acp.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/core/adapters/control-plane/clock.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/clock.ts`

### `packages/core/adapters/control-plane/compute-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/compute-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/control-plane/event-bus.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/event-bus.ts`

### `packages/core/adapters/control-plane/event-store.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/ports/event-store.ts`
  - `packages/core/repositories/event.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/control-plane/index.ts`

- fan-in: 0
- fan-out: 11
- imports:
  - `packages/core/adapters/control-plane/clock.ts`
  - `packages/core/adapters/control-plane/compute-store.ts`
  - `packages/core/adapters/control-plane/event-bus.ts`
  - `packages/core/adapters/control-plane/event-store.ts`
  - `packages/core/adapters/control-plane/logger.ts`
  - `packages/core/adapters/control-plane/process-runner.ts`
  - `packages/core/adapters/control-plane/secret-store.ts`
  - `packages/core/adapters/control-plane/session-store.ts`
  - `packages/core/adapters/control-plane/tracer.ts`
  - `packages/core/adapters/control-plane/workspace.ts`
  - `packages/core/ports/index.ts`

### `packages/core/adapters/control-plane/logger.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/logger.ts`

### `packages/core/adapters/control-plane/process-runner.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/process-runner.ts`

### `packages/core/adapters/control-plane/secret-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/secret-store.ts`

### `packages/core/adapters/control-plane/session-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/session-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/control-plane/tracer.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/tracer.ts`

### `packages/core/adapters/control-plane/workspace.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/workspace.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/local/clock.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/clock.ts`

### `packages/core/adapters/local/compute-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/compute-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/local/event-bus.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/event-bus.ts`

### `packages/core/adapters/local/event-store.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/ports/event-store.ts`
  - `packages/core/repositories/event.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/local/index.ts`

- fan-in: 0
- fan-out: 11
- imports:
  - `packages/core/adapters/local/clock.ts`
  - `packages/core/adapters/local/compute-store.ts`
  - `packages/core/adapters/local/event-bus.ts`
  - `packages/core/adapters/local/event-store.ts`
  - `packages/core/adapters/local/logger.ts`
  - `packages/core/adapters/local/process-runner.ts`
  - `packages/core/adapters/local/secret-store.ts`
  - `packages/core/adapters/local/session-store.ts`
  - `packages/core/adapters/local/tracer.ts`
  - `packages/core/adapters/local/workspace.ts`
  - `packages/core/ports/index.ts`

### `packages/core/adapters/local/logger.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/logger.ts`

### `packages/core/adapters/local/process-runner.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/process-runner.ts`

### `packages/core/adapters/local/secret-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/secret-store.ts`

### `packages/core/adapters/local/session-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/session-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/local/tracer.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/tracer.ts`

### `packages/core/adapters/local/workspace.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/workspace.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/test/clock.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/clock.ts`

### `packages/core/adapters/test/compute-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/compute-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/test/event-bus.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/event-bus.ts`

### `packages/core/adapters/test/event-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/event-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/test/index.ts`

- fan-in: 0
- fan-out: 11
- imports:
  - `packages/core/adapters/test/clock.ts`
  - `packages/core/adapters/test/compute-store.ts`
  - `packages/core/adapters/test/event-bus.ts`
  - `packages/core/adapters/test/event-store.ts`
  - `packages/core/adapters/test/logger.ts`
  - `packages/core/adapters/test/process-runner.ts`
  - `packages/core/adapters/test/secret-store.ts`
  - `packages/core/adapters/test/session-store.ts`
  - `packages/core/adapters/test/tracer.ts`
  - `packages/core/adapters/test/workspace.ts`
  - `packages/core/ports/index.ts`

### `packages/core/adapters/test/logger.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/logger.ts`

### `packages/core/adapters/test/process-runner.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/process-runner.ts`

### `packages/core/adapters/test/secret-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/secret-store.ts`

### `packages/core/adapters/test/session-store.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/session-store.ts`
  - `packages/types/index.ts`

### `packages/core/adapters/test/tracer.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/ports/tracer.ts`

### `packages/core/adapters/test/workspace.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/ports/workspace.ts`
  - `packages/types/index.ts`

### `packages/core/agent/agent.ts`

- fan-in: 5
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/template.ts`

### `packages/core/agent/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/agent/recipe.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/types/index.ts`

### `packages/core/agent/skill-extractor.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/agent/skill.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/app.ts`

- fan-in: 133
- fan-out: 40
- imports:
  - `packages/compute/core/pool/types.ts`
  - `packages/compute/core/snapshot-store.ts`
  - `packages/compute/core/types.ts`
  - `packages/compute/types.ts`
  - `packages/core/auth/index.ts`
  - `packages/core/code-intel/deployment.ts`
  - `packages/core/code-intel/interfaces/deployment.ts`
  - `packages/core/code-intel/store.ts`
  - `packages/core/compute-registries.ts`
  - `packages/core/compute-resolver.ts`
  - `packages/core/config.ts`
  - `packages/core/container.ts`
  - `packages/core/database/index.ts`
  - `packages/core/database/postgres.ts`
  - `packages/core/di/index.ts`
  - `packages/core/di/seed-builtins.ts`
  - `packages/core/drizzle/index.ts`
  - `packages/core/hooks.ts`
  - `packages/core/hosted/scheduler.ts`
  - `packages/core/hosted/worker-registry.ts`
  - `packages/core/knowledge/store.ts`
  - `packages/core/launchers/noop.ts`
  - `packages/core/launchers/tmux.ts`
  - `packages/core/modes/app-mode.ts`
  - `packages/core/observability/pricing.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/observability/telemetry.ts`
  - `packages/core/observability/usage.ts`
  - `packages/core/plugins/registry.ts`
  - `packages/core/repositories/index.ts`
  - `packages/core/router/tensorzero.ts`
  - `packages/core/runtimes/transcript-parser.ts`
  - `packages/core/services/creds-secret-reconciler.ts`
  - `packages/core/services/index.ts`
  - `packages/core/session-launcher.ts`
  - `packages/core/state/profiles.ts`
  - `packages/core/storage/blob-store.ts`
  - `packages/core/stores/index.ts`
  - `packages/core/tenant-scope.ts`
  - `packages/types/index.ts`

### `packages/core/auth/api-keys.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`
  - `packages/types/index.ts`

### `packages/core/auth/context.ts`

- fan-in: 11
- fan-out: 3
- imports:
  - `packages/core/auth/api-keys.ts`
  - `packages/protocol/types.ts`
  - `packages/types/index.ts`

### `packages/core/auth/index.ts`

- fan-in: 8
- fan-out: 0

### `packages/core/auth/middleware.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/auth/api-keys.ts`
  - `packages/types/index.ts`

### `packages/core/auth/teams.ts`

- fan-in: 0
- fan-out: 4
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repositories/memberships.ts`
  - `packages/core/repositories/teams.ts`

### `packages/core/auth/tenant-claude-auth.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repositories/tenant_claude_auth.ts`

### `packages/core/auth/tenant-policy.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/auth/tenants.ts`

- fan-in: 0
- fan-out: 5
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repositories/memberships.ts`
  - `packages/core/repositories/teams.ts`
  - `packages/core/repositories/tenants.ts`

### `packages/core/auth/users.ts`

- fan-in: 0
- fan-out: 4
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repositories/memberships.ts`
  - `packages/core/repositories/users.ts`

### `packages/core/claude/claude.ts`

- fan-in: 9
- fan-out: 6
- imports:
  - `packages/arkd/client.ts`
  - `packages/core/constants.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/knowledge/codebase-memory-finder.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/claude/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/claude/sessions.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/code-intel/constants.ts`

- fan-in: 6
- fan-out: 0

### `packages/core/code-intel/deployment.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/code-intel/executor/local.ts`
  - `packages/core/code-intel/interfaces/deployment.ts`
  - `packages/core/code-intel/observability/stderr.ts`
  - `packages/core/code-intel/policy/allow-all.ts`
  - `packages/core/code-intel/storage/local-fs.ts`
  - `packages/core/code-intel/vendor.ts`

### `packages/core/code-intel/executor/local.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/code-intel/interfaces/executor.ts`
  - `packages/core/code-intel/interfaces/vendor.ts`

### `packages/core/code-intel/extractors/dependencies-syft.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/code-intel/interfaces/extractor.ts`
  - `packages/core/code-intel/interfaces/types.ts`

### `packages/core/code-intel/extractors/files.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/code-intel/interfaces/extractor.ts`
  - `packages/core/code-intel/interfaces/types.ts`
  - `packages/core/code-intel/util/git.ts`

### `packages/core/code-intel/extractors/git-contributors.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/code-intel/interfaces/extractor.ts`
  - `packages/core/code-intel/interfaces/types.ts`
  - `packages/core/code-intel/util/git.ts`

### `packages/core/code-intel/extractors/index.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/code-intel/extractors/dependencies-syft.ts`
  - `packages/core/code-intel/extractors/files.ts`
  - `packages/core/code-intel/extractors/git-contributors.ts`
  - `packages/core/code-intel/interfaces/extractor.ts`

### `packages/core/code-intel/extractors/platform-docs/api-endpoint-registry.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/platform-doc-extractor.ts`

### `packages/core/code-intel/extractors/platform-docs/contributor-expertise-map.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/platform-doc-extractor.ts`

### `packages/core/code-intel/extractors/platform-docs/database-schema-map.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/platform-doc-extractor.ts`

### `packages/core/code-intel/extractors/platform-docs/service-dependency-graph.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/platform-doc-extractor.ts`

### `packages/core/code-intel/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/code-intel/interfaces/deployment.ts`

- fan-in: 2
- fan-out: 5
- imports:
  - `packages/core/code-intel/interfaces/executor.ts`
  - `packages/core/code-intel/interfaces/observability.ts`
  - `packages/core/code-intel/interfaces/policy.ts`
  - `packages/core/code-intel/interfaces/storage.ts`
  - `packages/core/code-intel/interfaces/vendor.ts`

### `packages/core/code-intel/interfaces/executor.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/interfaces/extractor.ts`

- fan-in: 5
- fan-out: 3
- imports:
  - `packages/core/code-intel/interfaces/types.ts`
  - `packages/core/code-intel/interfaces/vendor.ts`
  - `packages/core/code-intel/store.ts`

### `packages/core/code-intel/interfaces/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/code-intel/interfaces/observability.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/interfaces/pipeline.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/types.ts`

### `packages/core/code-intel/interfaces/platform-doc-extractor.ts`

- fan-in: 5
- fan-out: 1
- imports:
  - `packages/core/code-intel/store.ts`

### `packages/core/code-intel/interfaces/policy.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/code-intel/interfaces/query.ts`
  - `packages/core/code-intel/interfaces/types.ts`

### `packages/core/code-intel/interfaces/query.ts`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/core/code-intel/store.ts`

### `packages/core/code-intel/interfaces/ranker.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/query.ts`

### `packages/core/code-intel/interfaces/storage.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/interfaces/types.ts`

- fan-in: 8
- fan-out: 0

### `packages/core/code-intel/interfaces/vendor.ts`

- fan-in: 5
- fan-out: 0

### `packages/core/code-intel/migration-runner.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/code-intel/migrations/001_initial_schema.ts`
  - `packages/core/code-intel/migrations/002_workspaces.ts`
  - `packages/core/code-intel/migrations/003_platform_docs.ts`
  - `packages/core/code-intel/schema/schema-migrations.ts`
  - `packages/core/database/index.ts`

### `packages/core/code-intel/migrations/001_initial_schema.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/code-intel/constants.ts`
  - `packages/core/code-intel/schema/index.ts`
  - `packages/core/code-intel/schema/tenants.ts`
  - `packages/core/database/index.ts`

### `packages/core/code-intel/migrations/002_workspaces.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/code-intel/schema/repos.ts`
  - `packages/core/code-intel/schema/tenants.ts`
  - `packages/core/code-intel/schema/workspaces.ts`
  - `packages/core/database/index.ts`

### `packages/core/code-intel/migrations/003_platform_docs.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/code-intel/schema/platform-doc-versions.ts`
  - `packages/core/code-intel/schema/platform-docs.ts`
  - `packages/core/database/index.ts`

### `packages/core/code-intel/observability/stderr.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/code-intel/interfaces/observability.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/code-intel/pipeline.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/code-intel/interfaces/extractor.ts`
  - `packages/core/code-intel/interfaces/pipeline.ts`
  - `packages/core/code-intel/interfaces/types.ts`
  - `packages/core/code-intel/interfaces/vendor.ts`
  - `packages/core/code-intel/store.ts`

### `packages/core/code-intel/policy/allow-all.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/code-intel/interfaces/policy.ts`
  - `packages/core/code-intel/interfaces/query.ts`

### `packages/core/code-intel/queries/get-context.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/code-intel/interfaces/query.ts`
  - `packages/core/code-intel/store.ts`

### `packages/core/code-intel/queries/index.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/core/code-intel/interfaces/query.ts`
  - `packages/core/code-intel/queries/get-context.ts`
  - `packages/core/code-intel/queries/search.ts`

### `packages/core/code-intel/queries/search.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/query.ts`

### `packages/core/code-intel/schema/chunks.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/contributions.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/dependencies.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/edges.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/embeddings.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/external-refs.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/file-hotspots.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/files.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/index.ts`

- fan-in: 1
- fan-out: 17
- imports:
  - `packages/core/code-intel/schema/chunks.ts`
  - `packages/core/code-intel/schema/contributions.ts`
  - `packages/core/code-intel/schema/dependencies.ts`
  - `packages/core/code-intel/schema/edges.ts`
  - `packages/core/code-intel/schema/embeddings.ts`
  - `packages/core/code-intel/schema/external-refs.ts`
  - `packages/core/code-intel/schema/file-hotspots.ts`
  - `packages/core/code-intel/schema/files.ts`
  - `packages/core/code-intel/schema/indexing-runs.ts`
  - `packages/core/code-intel/schema/people.ts`
  - `packages/core/code-intel/schema/platform-doc-versions.ts`
  - `packages/core/code-intel/schema/platform-docs.ts`
  - `packages/core/code-intel/schema/repos.ts`
  - `packages/core/code-intel/schema/schema-migrations.ts`
  - `packages/core/code-intel/schema/symbols.ts`
  - `packages/core/code-intel/schema/tenants.ts`
  - `packages/core/code-intel/schema/workspaces.ts`

### `packages/core/code-intel/schema/indexing-runs.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/people.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/platform-doc-versions.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/code-intel/schema/platform-docs.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/code-intel/schema/repos.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/code-intel/schema/schema-migrations.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/symbols.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/code-intel/schema/tenants.ts`

- fan-in: 4
- fan-out: 0

### `packages/core/code-intel/schema/workspaces.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/code-intel/storage/local-fs.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/storage.ts`

### `packages/core/code-intel/store.ts`

- fan-in: 7
- fan-out: 22
- imports:
  - `packages/core/app.ts`
  - `packages/core/code-intel/constants.ts`
  - `packages/core/code-intel/interfaces/platform-doc-extractor.ts`
  - `packages/core/code-intel/interfaces/types.ts`
  - `packages/core/code-intel/migration-runner.ts`
  - `packages/core/code-intel/schema/chunks.ts`
  - `packages/core/code-intel/schema/contributions.ts`
  - `packages/core/code-intel/schema/dependencies.ts`
  - `packages/core/code-intel/schema/edges.ts`
  - `packages/core/code-intel/schema/embeddings.ts`
  - `packages/core/code-intel/schema/external-refs.ts`
  - `packages/core/code-intel/schema/file-hotspots.ts`
  - `packages/core/code-intel/schema/files.ts`
  - `packages/core/code-intel/schema/indexing-runs.ts`
  - `packages/core/code-intel/schema/people.ts`
  - `packages/core/code-intel/schema/platform-doc-versions.ts`
  - `packages/core/code-intel/schema/platform-docs.ts`
  - `packages/core/code-intel/schema/repos.ts`
  - `packages/core/code-intel/schema/symbols.ts`
  - `packages/core/code-intel/schema/tenants.ts`
  - `packages/core/code-intel/schema/workspaces.ts`
  - `packages/core/database/index.ts`

### `packages/core/code-intel/util/git.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/code-intel/vendor.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/code-intel/interfaces/vendor.ts`

### `packages/core/compute-registries.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/compute/core/pool/types.ts`
  - `packages/compute/core/types.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`

### `packages/core/compute-resolver.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/compute/adapters/provider-map.ts`
  - `packages/compute/core/compute-target.ts`
  - `packages/compute/core/types.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/util.ts`
  - `packages/types/index.ts`

### `packages/core/compute/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/compute/pool.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/types/index.ts`

### `packages/core/conductor/channel-types.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/conductor/channel.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/conductor/channel-types.ts`
  - `packages/core/constants.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/conductor/conductor.ts`

- fan-in: 4
- fan-out: 23
- imports:
  - `packages/arkd/client.ts`
  - `packages/compute/index.ts`
  - `packages/core/app.ts`
  - `packages/core/conductor/channel-types.ts`
  - `packages/core/constants.ts`
  - `packages/core/hooks.ts`
  - `packages/core/integrations/issue-poller.ts`
  - `packages/core/integrations/pr-merge-poller.ts`
  - `packages/core/integrations/pr-poller.ts`
  - `packages/core/integrations/rollback.ts`
  - `packages/core/knowledge/evals.ts`
  - `packages/core/knowledge/indexer.ts`
  - `packages/core/ledger.ts`
  - `packages/core/notify.ts`
  - `packages/core/observability/otlp.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repo-config.ts`
  - `packages/core/safe.ts`
  - `packages/core/schedule.ts`
  - `packages/core/search/search.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/session/guardrails.ts`
  - `packages/types/index.ts`

### `packages/core/conductor/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/config.ts`

- fan-in: 20
- fan-out: 7
- imports:
  - `packages/core/auth/index.ts`
  - `packages/core/config/clusters.ts`
  - `packages/core/config/env-source.ts`
  - `packages/core/config/profiles.ts`
  - `packages/core/config/types.ts`
  - `packages/core/config/yaml-source.ts`
  - `packages/core/constants.ts`

### `packages/core/config/clusters.ts`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/tenant-policy.ts`

### `packages/core/config/env-source.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/config/types.ts`

### `packages/core/config/port-allocator.ts`

- fan-in: 7
- fan-out: 0

### `packages/core/config/profiles.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/config/port-allocator.ts`
  - `packages/core/config/types.ts`

### `packages/core/config/types.ts`

- fan-in: 4
- fan-out: 0

### `packages/core/config/yaml-source.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/config/env-source.ts`
  - `packages/core/config/types.ts`

### `packages/core/connectors/definitions/bitbucket.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/definitions/github.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/definitions/jira.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/definitions/linear.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/definitions/pi-sage.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/definitions/slack.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/index.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/connectors/registry.ts`

- fan-in: 2
- fan-out: 7
- imports:
  - `packages/core/connectors/definitions/bitbucket.ts`
  - `packages/core/connectors/definitions/github.ts`
  - `packages/core/connectors/definitions/jira.ts`
  - `packages/core/connectors/definitions/linear.ts`
  - `packages/core/connectors/definitions/pi-sage.ts`
  - `packages/core/connectors/definitions/slack.ts`
  - `packages/core/connectors/types.ts`

### `packages/core/connectors/resolve.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/connectors/registry.ts`
  - `packages/types/index.ts`

### `packages/core/connectors/types.ts`

- fan-in: 8
- fan-out: 1
- imports:
  - `packages/core/app.ts`

### `packages/core/constants.ts`

- fan-in: 22
- fan-out: 0

### `packages/core/container.ts`

- fan-in: 8
- fan-out: 41
- imports:
  - `packages/compute/core/snapshot-store.ts`
  - `packages/core/app.ts`
  - `packages/core/auth/index.ts`
  - `packages/core/config.ts`
  - `packages/core/database/index.ts`
  - `packages/core/hosted/scheduler.ts`
  - `packages/core/hosted/worker-registry.ts`
  - `packages/core/infra/arkd-launcher.ts`
  - `packages/core/infra/compute-providers-boot.ts`
  - `packages/core/infra/conductor-launcher.ts`
  - `packages/core/infra/maintenance-pollers.ts`
  - `packages/core/infra/metrics-poller.ts`
  - `packages/core/infra/router-launcher.ts`
  - `packages/core/infra/service-wiring.ts`
  - `packages/core/infra/session-drain.ts`
  - `packages/core/infra/signal-handlers.ts`
  - `packages/core/infra/stale-state-detector.ts`
  - `packages/core/infra/tensorzero-launcher.ts`
  - `packages/core/knowledge/store.ts`
  - `packages/core/lifecycle.ts`
  - `packages/core/modes/app-mode.ts`
  - `packages/core/observability/pricing.ts`
  - `packages/core/observability/usage.ts`
  - `packages/core/plugins/registry.ts`
  - `packages/core/repositories/artifact.ts`
  - `packages/core/repositories/compute-template.ts`
  - `packages/core/repositories/compute.ts`
  - `packages/core/repositories/event.ts`
  - `packages/core/repositories/message.ts`
  - `packages/core/repositories/session.ts`
  - `packages/core/repositories/todo.ts`
  - `packages/core/runtimes/transcript-parser.ts`
  - `packages/core/services/compute.ts`
  - `packages/core/services/history.ts`
  - `packages/core/services/session.ts`
  - `packages/core/storage/blob-store.ts`
  - `packages/core/stores/agent-store.ts`
  - `packages/core/stores/flow-store.ts`
  - `packages/core/stores/recipe-store.ts`
  - `packages/core/stores/runtime-store.ts`
  - `packages/core/stores/skill-store.ts`

### `packages/core/database/index.ts`

- fan-in: 59
- fan-out: 0

### `packages/core/database/postgres.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/database/types.ts`

### `packages/core/database/sqlite.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/database/types.ts`

### `packages/core/database/types.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/di/index.ts`

- fan-in: 1
- fan-out: 9
- imports:
  - `packages/core/app.ts`
  - `packages/core/config.ts`
  - `packages/core/container.ts`
  - `packages/core/database/index.ts`
  - `packages/core/di/mode.ts`
  - `packages/core/di/persistence.ts`
  - `packages/core/di/runtime.ts`
  - `packages/core/di/services.ts`
  - `packages/core/di/storage.ts`

### `packages/core/di/mode.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/config.ts`
  - `packages/core/container.ts`
  - `packages/core/modes/app-mode.ts`

### `packages/core/di/persistence.ts`

- fan-in: 1
- fan-out: 8
- imports:
  - `packages/core/config.ts`
  - `packages/core/container.ts`
  - `packages/core/database/index.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/knowledge/store.ts`
  - `packages/core/repositories/index.ts`
  - `packages/core/stores/db-resource-store.ts`
  - `packages/core/stores/index.ts`

### `packages/core/di/runtime.ts`

- fan-in: 1
- fan-out: 25
- imports:
  - `packages/compute/core/snapshot-store-fs.ts`
  - `packages/core/app.ts`
  - `packages/core/config.ts`
  - `packages/core/container.ts`
  - `packages/core/database/index.ts`
  - `packages/core/infra/arkd-launcher.ts`
  - `packages/core/infra/compute-providers-boot.ts`
  - `packages/core/infra/conductor-launcher.ts`
  - `packages/core/infra/maintenance-pollers.ts`
  - `packages/core/infra/metrics-poller.ts`
  - `packages/core/infra/router-launcher.ts`
  - `packages/core/infra/service-wiring.ts`
  - `packages/core/infra/session-drain.ts`
  - `packages/core/infra/signal-handlers.ts`
  - `packages/core/infra/stale-state-detector.ts`
  - `packages/core/infra/tensorzero-launcher.ts`
  - `packages/core/lifecycle.ts`
  - `packages/core/observability/pricing.ts`
  - `packages/core/observability/usage.ts`
  - `packages/core/plugins/registry.ts`
  - `packages/core/repositories/session.ts`
  - `packages/core/runtimes/claude/parser.ts`
  - `packages/core/runtimes/codex/parser.ts`
  - `packages/core/runtimes/gemini/parser.ts`
  - `packages/core/runtimes/transcript-parser.ts`

### `packages/core/di/seed-builtins.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/di/services.ts`

- fan-in: 1
- fan-out: 8
- imports:
  - `packages/core/app.ts`
  - `packages/core/container.ts`
  - `packages/core/database/index.ts`
  - `packages/core/repositories/compute.ts`
  - `packages/core/repositories/event.ts`
  - `packages/core/repositories/message.ts`
  - `packages/core/repositories/session.ts`
  - `packages/core/services/index.ts`

### `packages/core/di/storage.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/config.ts`
  - `packages/core/container.ts`
  - `packages/core/storage/blob-store.ts`
  - `packages/core/storage/local-disk.ts`
  - `packages/core/storage/s3.ts`

### `packages/core/drizzle/client.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/drizzle/schema/postgres.ts`
  - `packages/core/drizzle/schema/sqlite.ts`

### `packages/core/drizzle/index.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/drizzle/schema/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/drizzle/schema/postgres.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/drizzle/schema/sqlite.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/drizzle/types.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/drizzle/schema/sqlite.ts`

### `packages/core/executor.ts`

- fan-in: 10
- fan-out: 0

### `packages/core/executors/claude-code.ts`

- fan-in: 1
- fan-out: 11
- imports:
  - `packages/compute/arc-json.ts`
  - `packages/compute/index.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/connectors/index.ts`
  - `packages/core/constants.ts`
  - `packages/core/executor.ts`
  - `packages/core/executors/router-env.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/recordings.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/core/executors/cli-agent.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/executor.ts`
  - `packages/core/executors/router-env.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/recordings.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/core/executors/goose.ts`

- fan-in: 1
- fan-out: 10
- imports:
  - `packages/compute/arc-json.ts`
  - `packages/compute/index.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/constants.ts`
  - `packages/core/executor.ts`
  - `packages/core/executors/router-env.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/knowledge/codebase-memory-finder.ts`
  - `packages/core/recordings.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/core/executors/index.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/executor.ts`
  - `packages/core/executors/claude-code.ts`
  - `packages/core/executors/cli-agent.ts`
  - `packages/core/executors/goose.ts`
  - `packages/core/executors/subprocess.ts`

### `packages/core/executors/process-tree.ts`

- fan-in: 3
- fan-out: 3
- imports:
  - `packages/core/executor.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/executors/router-env.ts`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/core/config.ts`
  - `packages/core/constants.ts`

### `packages/core/executors/status-poller.ts`

- fan-in: 3
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/executor.ts`
  - `packages/core/executors/process-tree.ts`
  - `packages/core/notify.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/core/executors/subprocess.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/executor.ts`

### `packages/core/extension-catalog.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/handoff.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/hooks.ts`

- fan-in: 5
- fan-out: 0

### `packages/core/hosted/index.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/hosted/scheduler.ts`

- fan-in: 3
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/index.ts`
  - `packages/core/hosted/worker-registry.ts`
  - `packages/types/index.ts`

### `packages/core/hosted/server.ts`

- fan-in: 0
- fan-out: 9
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/index.ts`
  - `packages/core/config.ts`
  - `packages/core/hosted/scheduler.ts`
  - `packages/core/hosted/sse-redis.ts`
  - `packages/core/hosted/web.ts`
  - `packages/core/hosted/worker-registry.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/router/server.ts`

### `packages/core/hosted/sse-bus.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/hosted/sse-redis.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/hosted/sse-bus.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/hosted/terminal-bridge.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/infra/tmux.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/hosted/web-proxy.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/install-paths.ts`

### `packages/core/hosted/web.ts`

- fan-in: 1
- fan-out: 14
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/index.ts`
  - `packages/core/constants.ts`
  - `packages/core/hooks.ts`
  - `packages/core/hosted/sse-bus.ts`
  - `packages/core/hosted/terminal-bridge.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/integrations/github-webhook.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/version.ts`
  - `packages/server/handlers/webhooks.ts`
  - `packages/server/register.ts`
  - `packages/server/router.ts`
  - `packages/types/index.ts`

### `packages/core/hosted/worker-registry.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/core/database/index.ts`

### `packages/core/hotkeys.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/config.ts`

### `packages/core/index.ts`

- fan-in: 12
- fan-out: 0

### `packages/core/infra/arkd-launcher.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/arkd/server.ts`
  - `packages/core/config.ts`
  - `packages/core/safe.ts`

### `packages/core/infra/compute-providers-boot.ts`

- fan-in: 2
- fan-out: 14
- imports:
  - `packages/compute/core/ec2.ts`
  - `packages/compute/core/firecracker/compute.ts`
  - `packages/compute/core/k8s-kata.ts`
  - `packages/compute/core/k8s.ts`
  - `packages/compute/core/local.ts`
  - `packages/compute/index.ts`
  - `packages/compute/providers/k8s.ts`
  - `packages/compute/runtimes/devcontainer.ts`
  - `packages/compute/runtimes/direct.ts`
  - `packages/compute/runtimes/docker-compose.ts`
  - `packages/compute/runtimes/docker.ts`
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/safe.ts`

### `packages/core/infra/conductor-launcher.ts`

- fan-in: 2
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/conductor/conductor.ts`
  - `packages/core/config.ts`
  - `packages/core/safe.ts`

### `packages/core/infra/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/infra/instance-lock.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/infra/maintenance-pollers.ts`

- fan-in: 2
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/infra/notify-daemon.ts`
  - `packages/core/infra/tmux-notify.ts`
  - `packages/core/observability/log-manager.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/safe.ts`

### `packages/core/infra/metrics-poller.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/compute/index.ts`
  - `packages/core/app.ts`
  - `packages/core/safe.ts`

### `packages/core/infra/notify-daemon.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/integrations/bridge.ts`

### `packages/core/infra/router-launcher.ts`

- fan-in: 2
- fan-out: 6
- imports:
  - `packages/core/config.ts`
  - `packages/core/infra/tensorzero-launcher.ts`
  - `packages/core/observability/usage.ts`
  - `packages/core/safe.ts`
  - `packages/router/index.ts`
  - `packages/router/server.ts`

### `packages/core/infra/service-wiring.ts`

- fan-in: 2
- fan-out: 11
- imports:
  - `packages/core/app.ts`
  - `packages/core/executor.ts`
  - `packages/core/executors/index.ts`
  - `packages/core/executors/status-poller.ts`
  - `packages/core/hooks.ts`
  - `packages/core/observability/otlp.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/observability/telemetry.ts`
  - `packages/core/plugins/registry.ts`
  - `packages/core/provider-registry.ts`
  - `packages/types/index.ts`

### `packages/core/infra/session-drain.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/infra/signal-handlers.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/infra/stale-state-detector.ts`

- fan-in: 2
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/safe.ts`
  - `packages/core/session/checkpoint.ts`
  - `packages/types/index.ts`

### `packages/core/infra/tensorzero-launcher.ts`

- fan-in: 3
- fan-out: 3
- imports:
  - `packages/core/config.ts`
  - `packages/core/router/tensorzero.ts`
  - `packages/core/safe.ts`

### `packages/core/infra/tmux-notify.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/infra/tmux.ts`

- fan-in: 18
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/infra/update-check.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/version.ts`

### `packages/core/install-paths.ts`

- fan-in: 12
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/integrations/bridge.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/types/index.ts`

### `packages/core/integrations/github-pr.ts`

- fan-in: 2
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/conductor/conductor.ts`
  - `packages/core/constants.ts`
  - `packages/core/safe.ts`
  - `packages/core/util.ts`
  - `packages/types/index.ts`

### `packages/core/integrations/github-webhook.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/services/session-orchestration.ts`

### `packages/core/integrations/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/integrations/issue-poller.ts`

- fan-in: 2
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/safe.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/types/index.ts`

### `packages/core/integrations/pr-merge-poller.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/types/index.ts`

### `packages/core/integrations/pr-poller.ts`

- fan-in: 1
- fan-out: 9
- imports:
  - `packages/core/app.ts`
  - `packages/core/conductor/conductor.ts`
  - `packages/core/constants.ts`
  - `packages/core/integrations/github-pr.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/safe.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/state/flow.ts`
  - `packages/types/index.ts`

### `packages/core/integrations/registry.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/connectors/registry.ts`
  - `packages/core/connectors/types.ts`
  - `packages/core/triggers/registry.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/integrations/rollback.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/hooks.ts`

### `packages/core/integrations/sage-analysis.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/knowledge/codebase-memory-finder.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/knowledge/codegraph-shim.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/knowledge/context.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/knowledge/store.ts`
  - `packages/core/knowledge/types.ts`

### `packages/core/knowledge/evals.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/types/index.ts`

### `packages/core/knowledge/export.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/knowledge/store.ts`
  - `packages/core/knowledge/types.ts`

### `packages/core/knowledge/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/knowledge/indexer.ts`

- fan-in: 3
- fan-out: 3
- imports:
  - `packages/core/knowledge/store.ts`
  - `packages/core/knowledge/types.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/knowledge/mcp.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/knowledge/store.ts`
  - `packages/core/knowledge/types.ts`

### `packages/core/knowledge/store.ts`

- fan-in: 8
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/knowledge/types.ts`

### `packages/core/knowledge/types.ts`

- fan-in: 9
- fan-out: 0

### `packages/core/launchers/arkd.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/arkd/client.ts`
  - `packages/core/session-launcher.ts`
  - `packages/types/index.ts`

### `packages/core/launchers/container.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/arkd/client.ts`
  - `packages/core/session-launcher.ts`
  - `packages/types/index.ts`

### `packages/core/launchers/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/launchers/noop.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/session-launcher.ts`
  - `packages/types/index.ts`

### `packages/core/launchers/tmux.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/infra/tmux.ts`
  - `packages/core/session-launcher.ts`
  - `packages/types/index.ts`

### `packages/core/ledger.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/lifecycle.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/container.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/mcp-pool.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/message-filter.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/migrations/001_initial.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/migrations/001_initial_postgres.ts`
  - `packages/core/migrations/001_initial_sqlite.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/001_initial_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/repositories/schema-postgres.ts`

### `packages/core/migrations/001_initial_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/repositories/schema.ts`

### `packages/core/migrations/002_compute_unify.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/migrations/002_compute_unify_postgres.ts`
  - `packages/core/migrations/002_compute_unify_sqlite.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/002_compute_unify_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/002_compute_unify_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/003_tenants_teams.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/runner.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/003_tenants_teams_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/003_tenants_teams_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/004_soft_delete.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/migrations/004_soft_delete_postgres.ts`
  - `packages/core/migrations/004_soft_delete_sqlite.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/004_soft_delete_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/004_soft_delete_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/005_deleted_by.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/migrations/005_deleted_by_postgres.ts`
  - `packages/core/migrations/005_deleted_by_sqlite.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/005_deleted_by_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/005_deleted_by_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/006_apikeys_soft_delete.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/migrations/006_apikeys_soft_delete_postgres.ts`
  - `packages/core/migrations/006_apikeys_soft_delete_sqlite.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/006_apikeys_soft_delete_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/006_apikeys_soft_delete_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/007_tenant_claude_auth.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/migrations/007_tenant_claude_auth_postgres.ts`
  - `packages/core/migrations/007_tenant_claude_auth_sqlite.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/007_tenant_claude_auth_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/007_tenant_claude_auth_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/008_tenant_compute_config.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/migrations/008_tenant_compute_config_postgres.ts`
  - `packages/core/migrations/008_tenant_compute_config_sqlite.ts`
  - `packages/core/migrations/runner.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/008_tenant_compute_config_postgres.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/008_tenant_compute_config_sqlite.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/migrations/009_drizzle_cutover.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/index.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/migrations/registry.ts`

- fan-in: 1
- fan-out: 10
- imports:
  - `packages/core/migrations/001_initial.ts`
  - `packages/core/migrations/002_compute_unify.ts`
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/004_soft_delete.ts`
  - `packages/core/migrations/005_deleted_by.ts`
  - `packages/core/migrations/006_apikeys_soft_delete.ts`
  - `packages/core/migrations/007_tenant_claude_auth.ts`
  - `packages/core/migrations/008_tenant_compute_config.ts`
  - `packages/core/migrations/009_drizzle_cutover.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/runner.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/migrations/registry.ts`
  - `packages/core/migrations/types.ts`

### `packages/core/migrations/types.ts`

- fan-in: 11
- fan-out: 1
- imports:
  - `packages/core/database/index.ts`

### `packages/core/modes/app-mode.ts`

- fan-in: 6
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/config.ts`
  - `packages/core/modes/hosted-app-mode.ts`
  - `packages/core/modes/local-app-mode.ts`
  - `packages/core/secrets/types.ts`

### `packages/core/modes/hosted-app-mode.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/config.ts`
  - `packages/core/modes/app-mode.ts`
  - `packages/core/modes/migrations-capability.ts`
  - `packages/core/secrets/aws-provider.ts`
  - `packages/core/secrets/file-provider.ts`
  - `packages/core/secrets/types.ts`

### `packages/core/modes/local-app-mode.ts`

- fan-in: 1
- fan-out: 16
- imports:
  - `packages/core/app.ts`
  - `packages/core/claude/sessions.ts`
  - `packages/core/knowledge/export.ts`
  - `packages/core/knowledge/indexer.ts`
  - `packages/core/modes/app-mode.ts`
  - `packages/core/modes/migrations-capability.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repo-map.ts`
  - `packages/core/repositories/schema-postgres.ts`
  - `packages/core/repositories/schema.ts`
  - `packages/core/search/search.ts`
  - `packages/core/secrets/aws-provider.ts`
  - `packages/core/secrets/file-provider.ts`
  - `packages/core/secrets/types.ts`
  - `packages/core/tools.ts`
  - `packages/protocol/types.ts`

### `packages/core/modes/migrations-capability.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/migrations/index.ts`
  - `packages/core/modes/app-mode.ts`

### `packages/core/notify.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/observability.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/observability/costs.ts`

- fan-in: 4
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/pricing.ts`
  - `packages/types/index.ts`

### `packages/core/observability/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/observability/log-manager.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/observability/otlp.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/observability/pricing.ts`

- fan-in: 6
- fan-out: 0

### `packages/core/observability/status-detect.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/infra/tmux.ts`

### `packages/core/observability/structured-log.ts`

- fan-in: 121
- fan-out: 0

### `packages/core/observability/telemetry.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/observability/usage.ts`

- fan-in: 5
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/pricing.ts`

### `packages/core/openapi.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/plugins/registry.ts`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/core/executor.ts`

### `packages/core/ports/clock.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/compute-store.ts`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/ports/event-bus.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/event-store.ts`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/ports/index.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/logger.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/process-runner.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/secret-store.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/session-store.ts`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/ports/tracer.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/ports/workspace.ts`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/prereqs.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/infra/tmux.ts`

### `packages/core/provider-registry.ts`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/compute/types.ts`
  - `packages/types/index.ts`

### `packages/core/recordings.ts`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/repo-config.ts`

- fan-in: 5
- fan-out: 0

### `packages/core/repo-map.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/repositories/artifact.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/util/time.ts`
  - `packages/types/index.ts`

### `packages/core/repositories/compute-template.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/compute/adapters/provider-map.ts`
  - `packages/core/database/index.ts`
  - `packages/core/repositories/compute.ts`
  - `packages/types/index.ts`

### `packages/core/repositories/compute.ts`

- fan-in: 4
- fan-out: 4
- imports:
  - `packages/compute/adapters/provider-map.ts`
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`
  - `packages/types/index.ts`

### `packages/core/repositories/event.ts`

- fan-in: 5
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`
  - `packages/types/index.ts`

### `packages/core/repositories/index.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/repositories/memberships.ts`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`

### `packages/core/repositories/message.ts`

- fan-in: 3
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`
  - `packages/types/index.ts`

### `packages/core/repositories/schema-postgres.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/repositories/schema.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/core/compute/pool.ts`
  - `packages/core/database/index.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/repositories/secrets.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/secrets/types.ts`

### `packages/core/repositories/session.ts`

- fan-in: 4
- fan-out: 3
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`
  - `packages/types/index.ts`

### `packages/core/repositories/teams.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`

### `packages/core/repositories/tenant_claude_auth.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`

### `packages/core/repositories/tenants.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`

### `packages/core/repositories/todo.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`

### `packages/core/repositories/users.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/database/index.ts`
  - `packages/core/util/time.ts`

### `packages/core/review.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/router/index.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/router/tensorzero-config.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/router/tensorzero.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/core/router/tensorzero-config.ts`

### `packages/core/runtimes/claude/parser.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/core/runtimes/transcript-parser.ts`

### `packages/core/runtimes/codex/parser.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/core/runtimes/transcript-parser.ts`

### `packages/core/runtimes/gemini/parser.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/core/runtimes/transcript-parser.ts`

### `packages/core/runtimes/transcript-parser.ts`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/core/observability/pricing.ts`

### `packages/core/safe.ts`

- fan-in: 22
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/sandbox.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/schedule.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/util/time.ts`

### `packages/core/search/global-search.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/search/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/search/search.ts`

- fan-in: 5
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/secrets/aws-provider.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/secrets/blob.ts`
  - `packages/core/secrets/types.ts`

### `packages/core/secrets/blob.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/secrets/types.ts`

### `packages/core/secrets/file-provider.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/secrets/blob.ts`
  - `packages/core/secrets/types.ts`

### `packages/core/secrets/types.ts`

- fan-in: 8
- fan-out: 0

### `packages/core/send-reliable.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/infra/tmux.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/services/actions/auto-merge.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/services/actions/types.ts`
  - `packages/core/services/workspace-service.ts`

### `packages/core/services/actions/close.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/services/actions/types.ts`

### `packages/core/services/actions/create-pr.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/actions/types.ts`
  - `packages/core/services/workspace-service.ts`

### `packages/core/services/actions/fetch-sage-analysis.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/integrations/sage-analysis.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/actions/types.ts`

### `packages/core/services/actions/index.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/services/actions/auto-merge.ts`
  - `packages/core/services/actions/close.ts`
  - `packages/core/services/actions/create-pr.ts`
  - `packages/core/services/actions/fetch-sage-analysis.ts`
  - `packages/core/services/actions/merge-pr.ts`
  - `packages/core/services/actions/types.ts`

### `packages/core/services/actions/merge-pr.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/services/actions/types.ts`
  - `packages/core/services/workspace-service.ts`

### `packages/core/services/actions/types.ts`

- fan-in: 6
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/types/index.ts`

### `packages/core/services/agent-launcher.ts`

- fan-in: 0
- fan-out: 15
- imports:
  - `packages/compute/arc-json.ts`
  - `packages/compute/index.ts`
  - `packages/compute/providers/docker/devcontainer.ts`
  - `packages/compute/providers/ec2/shell-escape.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/compute/types.ts`
  - `packages/core/agent/agent.ts`
  - `packages/core/app.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/connectors/index.ts`
  - `packages/core/constants.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/services/workspace-service.ts`
  - `packages/types/index.ts`

### `packages/core/services/compute-lifecycle.ts`

- fan-in: 2
- fan-out: 4
- imports:
  - `packages/compute/index.ts`
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/types/compute.ts`

### `packages/core/services/compute.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/repositories/compute.ts`
  - `packages/types/index.ts`

### `packages/core/services/creds-secret-reconciler.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/dispatch-claude-auth.ts`

### `packages/core/services/dispatch-claude-auth.ts`

- fan-in: 4
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/tenant-claude-auth.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/types/index.ts`

### `packages/core/services/dispatch-context.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/knowledge/context.ts`
  - `packages/core/knowledge/indexer.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repo-map.ts`
  - `packages/types/index.ts`

### `packages/core/services/dispatch.ts`

- fan-in: 4
- fan-out: 19
- imports:
  - `packages/arkd/client.ts`
  - `packages/core/agent/agent.ts`
  - `packages/core/app.ts`
  - `packages/core/executor.ts`
  - `packages/core/executors/status-poller.ts`
  - `packages/core/observability.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/observability/telemetry.ts`
  - `packages/core/services/actions/index.ts`
  - `packages/core/services/dispatch-claude-auth.ts`
  - `packages/core/services/dispatch-context.ts`
  - `packages/core/services/fork-join.ts`
  - `packages/core/services/session-hooks.ts`
  - `packages/core/services/task-builder.ts`
  - `packages/core/session/checkpoint.ts`
  - `packages/core/session/prompt-guard.ts`
  - `packages/core/state/flow-state.ts`
  - `packages/core/state/flow.ts`
  - `packages/types/index.ts`

### `packages/core/services/fork-join.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/services/dispatch.ts`
  - `packages/core/services/stage-advance.ts`
  - `packages/core/state/flow.ts`

### `packages/core/services/history.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/database/index.ts`

### `packages/core/services/index.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/services/session-hooks.ts`

- fan-in: 1
- fan-out: 11
- imports:
  - `packages/core/app.ts`
  - `packages/core/conductor/channel-types.ts`
  - `packages/core/handoff.ts`
  - `packages/core/observability/status-detect.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repo-config.ts`
  - `packages/core/safe.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/state/flow.ts`
  - `packages/core/termination.ts`
  - `packages/types/index.ts`

### `packages/core/services/session-lifecycle.ts`

- fan-in: 2
- fan-out: 23
- imports:
  - `packages/compute/core/compute-target.ts`
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/executors/process-tree.ts`
  - `packages/core/executors/status-poller.ts`
  - `packages/core/observability.ts`
  - `packages/core/observability/otlp.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/observability/telemetry.ts`
  - `packages/core/provider-registry.ts`
  - `packages/core/recordings.ts`
  - `packages/core/repo-config.ts`
  - `packages/core/safe.ts`
  - `packages/core/services/compute-lifecycle.ts`
  - `packages/core/services/dispatch-claude-auth.ts`
  - `packages/core/services/workspace-service.ts`
  - `packages/core/session/checkpoint.ts`
  - `packages/core/state/flow.ts`
  - `packages/core/state/profiles.ts`
  - `packages/core/template.ts`
  - `packages/core/workspace/provisioner.ts`
  - `packages/types/index.ts`

### `packages/core/services/session-orchestration.ts`

- fan-in: 20
- fan-out: 4
- imports:
  - `packages/core/services/dispatch.ts`
  - `packages/core/services/session-lifecycle.ts`
  - `packages/core/services/stage-orchestrator.ts`
  - `packages/core/services/workspace-service.ts`

### `packages/core/services/session-output.ts`

- fan-in: 0
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/provider-registry.ts`
  - `packages/core/recordings.ts`
  - `packages/core/send-reliable.ts`
  - `packages/core/session/prompt-guard.ts`

### `packages/core/services/session-snapshot.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/compute/core/snapshot-store.ts`
  - `packages/compute/core/types.ts`
  - `packages/core/app.ts`

### `packages/core/services/session.ts`

- fan-in: 1
- fan-out: 8
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repositories/event.ts`
  - `packages/core/repositories/message.ts`
  - `packages/core/repositories/session.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/storage/blob-store.ts`
  - `packages/types/index.ts`

### `packages/core/services/stage-advance.ts`

- fan-in: 1
- fan-out: 15
- imports:
  - `packages/core/agent/skill-extractor.ts`
  - `packages/core/app.ts`
  - `packages/core/observability.ts`
  - `packages/core/observability/otlp.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repo-config.ts`
  - `packages/core/search/search.ts`
  - `packages/core/services/compute-lifecycle.ts`
  - `packages/core/services/dispatch.ts`
  - `packages/core/services/session-lifecycle.ts`
  - `packages/core/session/checkpoint.ts`
  - `packages/core/state/flow-state.ts`
  - `packages/core/state/flow.ts`
  - `packages/core/state/graph-flow.ts`
  - `packages/types/index.ts`

### `packages/core/services/stage-orchestrator.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/services/subagents.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/services/dispatch.ts`
  - `packages/core/state/flow.ts`

### `packages/core/services/task-builder.ts`

- fan-in: 1
- fan-out: 8
- imports:
  - `packages/core/agent/agent.ts`
  - `packages/core/app.ts`
  - `packages/core/integrations/sage-analysis.ts`
  - `packages/core/message-filter.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/state/flow.ts`
  - `packages/core/template.ts`
  - `packages/types/index.ts`

### `packages/core/services/workspace-service.ts`

- fan-in: 6
- fan-out: 7
- imports:
  - `packages/compute/types.ts`
  - `packages/core/app.ts`
  - `packages/core/claude/claude.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/repo-config.ts`
  - `packages/core/safe.ts`
  - `packages/types/index.ts`

### `packages/core/session-launcher.ts`

- fan-in: 5
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/session/checkpoint.ts`

- fan-in: 4
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/types/index.ts`

### `packages/core/session/guardrails.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/observability/structured-log.ts`

### `packages/core/session/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/session/prompt-guard.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/session/replay.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/types/index.ts`

### `packages/core/session/share.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/types/index.ts`

### `packages/core/state/flow-state.ts`

- fan-in: 2
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/state/flow.ts`

- fan-in: 9
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/template.ts`

### `packages/core/state/graph-flow.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/state/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/state/profiles.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/state/ui-state.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/storage/blob-store.ts`

- fan-in: 7
- fan-out: 0

### `packages/core/storage/local-disk.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/storage/blob-store.ts`

### `packages/core/storage/s3.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/storage/blob-store.ts`

### `packages/core/stores/agent-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/agent/agent.ts`

### `packages/core/stores/db-resource-store.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/database/index.ts`

### `packages/core/stores/flow-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/state/flow.ts`

### `packages/core/stores/index.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/stores/recipe-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/agent/recipe.ts`

### `packages/core/stores/runtime-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/stores/skill-store.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/core/agent/skill.ts`

### `packages/core/template.ts`

- fan-in: 4
- fan-out: 0

### `packages/core/tenant-scope.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/knowledge/store.ts`
  - `packages/core/observability/usage.ts`
  - `packages/core/repositories/index.ts`
  - `packages/core/stores/db-resource-store.ts`

### `packages/core/termination.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/types/index.ts`

### `packages/core/theme.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/tickets/registry.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/core/tickets/types.ts`

### `packages/core/tickets/richtext/adf.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/tickets/richtext/markdown.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/tickets/richtext/prosemirror.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/tickets/types.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/tool-driver.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/tools.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`

### `packages/core/tools/claude-driver.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/claude/claude.ts`
  - `packages/core/tool-driver.ts`

### `packages/core/tools/gemini-driver.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/claude/claude.ts`
  - `packages/core/tool-driver.ts`

### `packages/core/tools/registry.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/core/tool-driver.ts`
  - `packages/core/tools/claude-driver.ts`
  - `packages/core/tools/gemini-driver.ts`

### `packages/core/triggers/dispatcher.ts`

- fan-in: 0
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/index.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/triggers/matcher.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/normalizer.ts`

- fan-in: 14
- fan-out: 1
- imports:
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/registry.ts`

- fan-in: 1
- fan-out: 13
- imports:
  - `packages/core/triggers/sources/alertmanager.ts`
  - `packages/core/triggers/sources/bitbucket.ts`
  - `packages/core/triggers/sources/cloudwatch.ts`
  - `packages/core/triggers/sources/email.ts`
  - `packages/core/triggers/sources/generic-hmac.ts`
  - `packages/core/triggers/sources/github.ts`
  - `packages/core/triggers/sources/jira.ts`
  - `packages/core/triggers/sources/linear.ts`
  - `packages/core/triggers/sources/pagerduty.ts`
  - `packages/core/triggers/sources/pi-sage.ts`
  - `packages/core/triggers/sources/prometheus.ts`
  - `packages/core/triggers/sources/slack.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/secrets.ts`

- fan-in: 0
- fan-out: 0

### `packages/core/triggers/sources/alertmanager.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/bitbucket.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/cloudwatch.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/email.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/generic-hmac.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/github.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/jira.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/linear.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/pagerduty.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/pi-sage.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/prometheus.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/sources/slack.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/triggers/normalizer.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/store.ts`

- fan-in: 0
- fan-out: 2
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/core/triggers/types.ts`

### `packages/core/triggers/types.ts`

- fan-in: 18
- fan-out: 0

### `packages/core/util.ts`

- fan-in: 2
- fan-out: 0

### `packages/core/util/time.ts`

- fan-in: 13
- fan-out: 0

### `packages/core/version.ts`

- fan-in: 3
- fan-out: 0

### `packages/core/workspace/manifest.ts`

- fan-in: 1
- fan-out: 0

### `packages/core/workspace/provisioner.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/code-intel/constants.ts`
  - `packages/core/code-intel/store.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/workspace/manifest.ts`
  - `packages/types/index.ts`

### `packages/core/worktree-merge.ts`

- fan-in: 0
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/types/index.ts`

### `packages/protocol/client.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/protocol/transport.ts`
  - `packages/protocol/types.ts`
  - `packages/types/index.ts`

### `packages/protocol/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/protocol/rpc-schemas.ts`

- fan-in: 1
- fan-out: 0

### `packages/protocol/transport.ts`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/core/observability/structured-log.ts`
  - `packages/protocol/types.ts`

### `packages/protocol/types.ts`

- fan-in: 25
- fan-out: 0

### `packages/router/classifier.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/router/types.ts`

### `packages/router/config.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/router/types.ts`

### `packages/router/dispatch.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/router/providers.ts`
  - `packages/router/types.ts`

### `packages/router/engine.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/router/classifier.ts`
  - `packages/router/providers.ts`
  - `packages/router/types.ts`

### `packages/router/feedback.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/router/types.ts`

### `packages/router/index.ts`

- fan-in: 2
- fan-out: 0

### `packages/router/providers.ts`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/router/types.ts`

### `packages/router/server.ts`

- fan-in: 2
- fan-out: 7
- imports:
  - `packages/core/constants.ts`
  - `packages/router/classifier.ts`
  - `packages/router/dispatch.ts`
  - `packages/router/engine.ts`
  - `packages/router/feedback.ts`
  - `packages/router/providers.ts`
  - `packages/router/types.ts`

### `packages/router/types.ts`

- fan-in: 7
- fan-out: 0

### `packages/server/handlers/admin-apikey.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/admin-policy.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/auth/index.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/admin.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/auth/index.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/clusters.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/auth/tenant-policy.ts`
  - `packages/core/config/clusters.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/code-intel.ts`

- fan-in: 1
- fan-out: 10
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/code-intel/constants.ts`
  - `packages/core/code-intel/extractors/index.ts`
  - `packages/core/code-intel/pipeline.ts`
  - `packages/core/code-intel/queries/get-context.ts`
  - `packages/core/code-intel/queries/search.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/conductor.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/integrations/bridge.ts`
  - `packages/core/knowledge/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/config.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/index.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/connectors.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/connectors/index.ts`
  - `packages/core/connectors/resolve.ts`
  - `packages/core/install-paths.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/costs.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/costs.ts`
  - `packages/server/router.ts`

### `packages/server/handlers/dashboard.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/observability/costs.ts`
  - `packages/server/router.ts`

### `packages/server/handlers/eval.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/knowledge/evals.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/fs.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`

### `packages/server/handlers/history-local.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/server/router.ts`

### `packages/server/handlers/history.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/index.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/integrations.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/core/integrations/registry.ts`
  - `packages/server/router.ts`

### `packages/server/handlers/knowledge-local.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/knowledge-rpc.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/knowledge.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/knowledge/codebase-memory-finder.ts`
  - `packages/core/knowledge/types.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/memory.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/knowledge/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/messaging.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/metrics-local.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/core/app.ts`
  - `packages/server/router.ts`

### `packages/server/handlers/metrics.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/compute/index.ts`
  - `packages/core/app.ts`
  - `packages/core/observability/costs.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/resource-crud.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/protocol/types.ts`
  - `packages/server/handlers/scope-helpers.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/resource.ts`

- fan-in: 1
- fan-out: 11
- imports:
  - `packages/compute/adapters/provider-map.ts`
  - `packages/compute/index.ts`
  - `packages/compute/providers/ec2/ssh.ts`
  - `packages/core/agent/recipe.ts`
  - `packages/core/app.ts`
  - `packages/core/infra/tmux.ts`
  - `packages/protocol/types.ts`
  - `packages/server/handlers/scope-helpers.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/sage.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/integrations/sage-analysis.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/schedule.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/index.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/scope-helpers.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/core/agent/agent.ts`

### `packages/server/handlers/secrets.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/secrets/types.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/session.ts`

- fan-in: 1
- fan-out: 12
- imports:
  - `packages/core/app.ts`
  - `packages/core/recordings.ts`
  - `packages/core/search/search.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/services/session-snapshot.ts`
  - `packages/core/session/replay.ts`
  - `packages/core/session/share.ts`
  - `packages/core/storage/blob-store.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/tenant-auth.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/auth/tenant-claude-auth.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/tools.ts`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/core/app.ts`
  - `packages/core/index.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`
  - `packages/types/index.ts`

### `packages/server/handlers/triggers.ts`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/core/app.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/triggers/index.ts`
  - `packages/protocol/types.ts`
  - `packages/server/handlers/webhooks.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/web-local.ts`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/core/app.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/web.ts`

- fan-in: 1
- fan-out: 14
- imports:
  - `packages/core/app.ts`
  - `packages/core/constants.ts`
  - `packages/core/hotkeys.ts`
  - `packages/core/knowledge/types.ts`
  - `packages/core/observability/costs.ts`
  - `packages/core/openapi.ts`
  - `packages/core/search/global-search.ts`
  - `packages/core/search/search.ts`
  - `packages/core/services/session-orchestration.ts`
  - `packages/core/session/share.ts`
  - `packages/core/state/profiles.ts`
  - `packages/core/theme.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/handlers/webhooks.ts`

- fan-in: 2
- fan-out: 4
- imports:
  - `packages/core/app.ts`
  - `packages/core/install-paths.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/core/triggers/index.ts`

### `packages/server/handlers/workspace.ts`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/core/app.ts`
  - `packages/core/auth/context.ts`
  - `packages/core/code-intel/constants.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`
  - `packages/server/validate.ts`

### `packages/server/index.ts`

- fan-in: 2
- fan-out: 5
- imports:
  - `packages/core/auth/context.ts`
  - `packages/core/observability/structured-log.ts`
  - `packages/protocol/transport.ts`
  - `packages/protocol/types.ts`
  - `packages/server/router.ts`

### `packages/server/register.ts`

- fan-in: 3
- fan-out: 37
- imports:
  - `packages/core/app.ts`
  - `packages/protocol/types.ts`
  - `packages/server/handlers/admin-apikey.ts`
  - `packages/server/handlers/admin-policy.ts`
  - `packages/server/handlers/admin.ts`
  - `packages/server/handlers/clusters.ts`
  - `packages/server/handlers/code-intel.ts`
  - `packages/server/handlers/conductor.ts`
  - `packages/server/handlers/config.ts`
  - `packages/server/handlers/connectors.ts`
  - `packages/server/handlers/costs.ts`
  - `packages/server/handlers/dashboard.ts`
  - `packages/server/handlers/eval.ts`
  - `packages/server/handlers/fs.ts`
  - `packages/server/handlers/history-local.ts`
  - `packages/server/handlers/history.ts`
  - `packages/server/handlers/integrations.ts`
  - `packages/server/handlers/knowledge-local.ts`
  - `packages/server/handlers/knowledge-rpc.ts`
  - `packages/server/handlers/knowledge.ts`
  - `packages/server/handlers/memory.ts`
  - `packages/server/handlers/messaging.ts`
  - `packages/server/handlers/metrics-local.ts`
  - `packages/server/handlers/metrics.ts`
  - `packages/server/handlers/resource-crud.ts`
  - `packages/server/handlers/resource.ts`
  - `packages/server/handlers/sage.ts`
  - `packages/server/handlers/schedule.ts`
  - `packages/server/handlers/secrets.ts`
  - `packages/server/handlers/session.ts`
  - `packages/server/handlers/tenant-auth.ts`
  - `packages/server/handlers/tools.ts`
  - `packages/server/handlers/triggers.ts`
  - `packages/server/handlers/web-local.ts`
  - `packages/server/handlers/web.ts`
  - `packages/server/handlers/workspace.ts`
  - `packages/server/router.ts`

### `packages/server/router.ts`

- fan-in: 37
- fan-out: 3
- imports:
  - `packages/core/auth/context.ts`
  - `packages/protocol/types.ts`
  - `packages/server/validate.ts`

### `packages/server/validate.ts`

- fan-in: 29
- fan-out: 2
- imports:
  - `packages/protocol/rpc-schemas.ts`
  - `packages/protocol/types.ts`

### `packages/types/agent.ts`

- fan-in: 1
- fan-out: 0

### `packages/types/artifact.ts`

- fan-in: 0
- fan-out: 0

### `packages/types/common.ts`

- fan-in: 1
- fan-out: 0

### `packages/types/compute.ts`

- fan-in: 2
- fan-out: 0

### `packages/types/event.ts`

- fan-in: 1
- fan-out: 0

### `packages/types/flow.ts`

- fan-in: 1
- fan-out: 0

### `packages/types/index.ts`

- fan-in: 83
- fan-out: 0

### `packages/types/message.ts`

- fan-in: 1
- fan-out: 0

### `packages/types/rpc.ts`

- fan-in: 0
- fan-out: 7
- imports:
  - `packages/types/agent.ts`
  - `packages/types/common.ts`
  - `packages/types/compute.ts`
  - `packages/types/event.ts`
  - `packages/types/flow.ts`
  - `packages/types/message.ts`
  - `packages/types/session.ts`

### `packages/types/session.ts`

- fan-in: 1
- fan-out: 0

### `packages/types/tenant.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/build.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/playwright.config.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/src/App.tsx`

- fan-in: 0
- fan-out: 27
- imports:
  - `packages/web/src/components/Toast.tsx`
  - `packages/web/src/components/ui/CommandPalette.tsx`
  - `packages/web/src/components/ui/ErrorBoundary.tsx`
  - `packages/web/src/components/ui/PageFallback.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/hooks/useHashRouter.ts`
  - `packages/web/src/pages/AdminPage.tsx`
  - `packages/web/src/pages/AgentsPage.tsx`
  - `packages/web/src/pages/ComputePage.tsx`
  - `packages/web/src/pages/CostsPage.tsx`
  - `packages/web/src/pages/DesignPreviewPage.tsx`
  - `packages/web/src/pages/FlowsPage.tsx`
  - `packages/web/src/pages/HistoryPage.tsx`
  - `packages/web/src/pages/IntegrationsPage.tsx`
  - `packages/web/src/pages/LoginPage.tsx`
  - `packages/web/src/pages/MemoryPage.tsx`
  - `packages/web/src/pages/SchedulesPage.tsx`
  - `packages/web/src/pages/SecretsPage.tsx`
  - `packages/web/src/pages/SessionsPage.tsx`
  - `packages/web/src/pages/SettingsPage.tsx`
  - `packages/web/src/pages/ToolsPage.tsx`
  - `packages/web/src/providers/AppModeProvider.tsx`
  - `packages/web/src/providers/QueryProvider.tsx`
  - `packages/web/src/styles.css`
  - `packages/web/src/themes/ThemeProvider.tsx`
  - `packages/web/src/transport/HttpTransport.ts`
  - `packages/web/src/transport/TransportContext.tsx`

### `packages/web/src/components/AgentsView.tsx`

- fan-in: 1
- fan-out: 8
- imports:
  - `packages/web/src/components/ui/RichSelect.tsx`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useAgentQueries.ts`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useRuntimeQueries.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ChatPanel.tsx`

- fan-in: 0
- fan-out: 6
- imports:
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useMessages.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/util.ts`

### `packages/web/src/components/CodebaseMemoryPanel.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/components/ComputeView.tsx`

- fan-in: 1
- fan-out: 9
- imports:
  - `packages/web/src/components/compute/ComputeDetailPanel.tsx`
  - `packages/web/src/components/compute/NewComputeForm.tsx`
  - `packages/web/src/components/compute/helpers.ts`
  - `packages/web/src/components/compute/types.ts`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useComputeQueries.ts`
  - `packages/web/src/hooks/useSmartPoll.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/CostsView.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/ui/card.tsx`
  - `packages/web/src/components/ui/chart.tsx`
  - `packages/web/src/hooks/useCostQueries.ts`
  - `packages/web/src/util.ts`

### `packages/web/src/components/DashboardView.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/hooks/useDashboardQuery.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/util.ts`

### `packages/web/src/components/FlowsView.tsx`

- fan-in: 1
- fan-out: 11
- imports:
  - `packages/web/src/components/pipeline/PipelineViewer.tsx`
  - `packages/web/src/components/pipeline/types.ts`
  - `packages/web/src/components/ui/RichSelect.tsx`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/components/ui/separator.tsx`
  - `packages/web/src/hooks/useAgentQueries.ts`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useFlowQueries.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/FolderPickerModal.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/components/ui/modal.tsx`
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/components/HistoryView.tsx`

- fan-in: 1
- fan-out: 8
- imports:
  - `packages/web/src/components/StatusDot.tsx`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useHistoryQueries.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/util.ts`

### `packages/web/src/components/Layout.tsx`

- fan-in: 13
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/IconRail.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/components/MemoryView.tsx`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/web/src/components/ui/RichSelect.tsx`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useMemoryQueries.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/NewSessionModal.tsx`

- fan-in: 1
- fan-out: 9
- imports:
  - `packages/web/src/components/FolderPickerModal.tsx`
  - `packages/web/src/components/session/InputsSection.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useFilePreviews.ts`
  - `packages/web/src/hooks/usePasteImageUpload.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/providers/AppModeProvider.tsx`
  - `packages/web/src/util.ts`

### `packages/web/src/components/PageShell.tsx`

- fan-in: 12
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ScheduleView.tsx`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/web/src/components/ui/RichSelect.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useScheduleQueries.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/SessionDetail.tsx`

- fan-in: 1
- fan-out: 25
- imports:
  - `packages/web/src/components/StaticTerminal.tsx`
  - `packages/web/src/components/session/event-builder.tsx`
  - `packages/web/src/components/session/timeline-builder.ts`
  - `packages/web/src/components/ui/AgentMessage.tsx`
  - `packages/web/src/components/ui/ChatInput.tsx`
  - `packages/web/src/components/ui/ConfirmDialog.tsx`
  - `packages/web/src/components/ui/ContentTabs.tsx`
  - `packages/web/src/components/ui/DetailDrawer.tsx`
  - `packages/web/src/components/ui/DiffViewer.tsx`
  - `packages/web/src/components/ui/EventTimeline.tsx`
  - `packages/web/src/components/ui/MarkdownContent.tsx`
  - `packages/web/src/components/ui/ScrollProgress.tsx`
  - `packages/web/src/components/ui/SessionHeader.tsx`
  - `packages/web/src/components/ui/SessionSummary.tsx`
  - `packages/web/src/components/ui/SystemEvent.tsx`
  - `packages/web/src/components/ui/TodoList.tsx`
  - `packages/web/src/components/ui/ToolCallFailed.tsx`
  - `packages/web/src/components/ui/ToolCallRow.tsx`
  - `packages/web/src/components/ui/TypingIndicator.tsx`
  - `packages/web/src/components/ui/UserMessage.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useMessages.ts`
  - `packages/web/src/hooks/useSessionStream.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/util.ts`

### `packages/web/src/components/SessionList.tsx`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/web/src/components/ui/FilterChip.tsx`
  - `packages/web/src/components/ui/SessionList.tsx`
  - `packages/web/src/components/ui/StageProgressBar.tsx`
  - `packages/web/src/components/ui/StatusDot.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/util.ts`

### `packages/web/src/components/SettingsView.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/ui/card.tsx`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/themes/ThemeProvider.tsx`
  - `packages/web/src/themes/tokens.ts`

### `packages/web/src/components/Sidebar.tsx`

- fan-in: 0
- fan-out: 4
- imports:
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/tooltip.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/StaticTerminal.tsx`

- fan-in: 1
- fan-out: 0

### `packages/web/src/components/StatusDot.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/Terminal.tsx`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/web/src/components/ui/button.tsx`

### `packages/web/src/components/Toast.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ToolsView.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useToolQueries.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/admin/TeamsTab.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/admin/adminApi.ts`
  - `packages/web/src/components/admin/types.ts`
  - `packages/web/src/components/ui/button.tsx`

### `packages/web/src/components/admin/TenantsTab.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/admin/adminApi.ts`
  - `packages/web/src/components/admin/types.ts`
  - `packages/web/src/components/ui/button.tsx`

### `packages/web/src/components/admin/UsersTab.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/admin/adminApi.ts`
  - `packages/web/src/components/admin/types.ts`
  - `packages/web/src/components/ui/button.tsx`

### `packages/web/src/components/admin/adminApi.ts`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/web/src/components/admin/types.ts`
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/components/admin/types.ts`

- fan-in: 4
- fan-out: 0

### `packages/web/src/components/compute/ComputeActions.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/ui/button.tsx`

### `packages/web/src/components/compute/ComputeDetailPanel.tsx`

- fan-in: 1
- fan-out: 10
- imports:
  - `packages/web/src/components/compute/ComputeActions.tsx`
  - `packages/web/src/components/compute/ComputeDrawer.tsx`
  - `packages/web/src/components/compute/MetricBar.tsx`
  - `packages/web/src/components/compute/MetricSparkline.tsx`
  - `packages/web/src/components/compute/MetricsSkeleton.tsx`
  - `packages/web/src/components/compute/helpers.ts`
  - `packages/web/src/components/compute/types.ts`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/card.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/compute/ComputeDrawer.tsx`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/web/src/components/compute/helpers.ts`
  - `packages/web/src/components/compute/types.ts`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/compute/MetricBar.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/compute/helpers.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/compute/MetricSparkline.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/compute/types.ts`
  - `packages/web/src/components/ui/chart.tsx`

### `packages/web/src/components/compute/MetricsSkeleton.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/ui/card.tsx`

### `packages/web/src/components/compute/NewComputeForm.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/ui/RichSelect.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/compute/helpers.ts`

- fan-in: 4
- fan-out: 0

### `packages/web/src/components/compute/types.ts`

- fan-in: 4
- fan-out: 0

### `packages/web/src/components/flow-editor/FlowEdgeLabel.tsx`

- fan-in: 1
- fan-out: 0

### `packages/web/src/components/flow-editor/FlowEditor.tsx`

- fan-in: 0
- fan-out: 7
- imports:
  - `packages/web/src/components/flow-editor/FlowEdgeLabel.tsx`
  - `packages/web/src/components/flow-editor/FlowPropertiesPanel.tsx`
  - `packages/web/src/components/flow-editor/FlowStageNode.tsx`
  - `packages/web/src/components/flow-editor/FlowToolbar.tsx`
  - `packages/web/src/components/pipeline/layout.ts`
  - `packages/web/src/components/pipeline/pipeline.css`
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/flow-editor/FlowPropertiesPanel.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/pipeline/types.ts`
  - `packages/web/src/components/ui/RichSelect.tsx`

### `packages/web/src/components/flow-editor/FlowStageNode.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/flow-editor/FlowToolbar.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/flow-editor/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/src/components/mode/binding-types.ts`

- fan-in: 10
- fan-out: 0

### `packages/web/src/components/mode/file-input-row-shell.tsx`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/mode/hosted-binding.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/hosted-file-input-add-editor.tsx`
  - `packages/web/src/components/mode/hosted-file-input-row.tsx`
  - `packages/web/src/components/mode/hosted-repo-picker.tsx`

### `packages/web/src/components/mode/hosted-file-input-add-editor.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/file-input-row-shell.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/mode/hosted-file-input-row.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/file-input-row-shell.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/mode/hosted-repo-picker.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/repo-picker-shell.tsx`

### `packages/web/src/components/mode/local-binding.ts`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/local-file-input-add-editor.tsx`
  - `packages/web/src/components/mode/local-file-input-row.tsx`
  - `packages/web/src/components/mode/local-repo-picker.tsx`

### `packages/web/src/components/mode/local-file-input-add-editor.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/file-input-row-shell.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/mode/local-file-input-row.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/file-input-row-shell.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/mode/local-repo-picker.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/repo-picker-shell.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/mode/repo-picker-shell.tsx`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/util.ts`

### `packages/web/src/components/pipeline/PipelineEdge.tsx`

- fan-in: 1
- fan-out: 0

### `packages/web/src/components/pipeline/PipelineFanoutGroup.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/pipeline/PipelineStageNode.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/pipeline/PipelineViewer.tsx`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/web/src/components/pipeline/PipelineEdge.tsx`
  - `packages/web/src/components/pipeline/PipelineFanoutGroup.tsx`
  - `packages/web/src/components/pipeline/PipelineStageNode.tsx`
  - `packages/web/src/components/pipeline/StageDetailPanel.tsx`
  - `packages/web/src/components/pipeline/layout.ts`
  - `packages/web/src/components/pipeline/pipeline.css`
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/pipeline/StageDetailPanel.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/pipeline/index.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/src/components/pipeline/layout.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/components/pipeline/types.ts`

### `packages/web/src/components/pipeline/pipeline.css`

- fan-in: 2
- fan-out: 0

### `packages/web/src/components/pipeline/types.ts`

- fan-in: 10
- fan-out: 0

### `packages/web/src/components/secrets/NewSecretForm.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`

### `packages/web/src/components/secrets/SecretsList.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/components/ui/button.tsx`

### `packages/web/src/components/session/InputsSection.tsx`

- fan-in: 2
- fan-out: 4
- imports:
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/lib/utils.ts`
  - `packages/web/src/providers/AppModeProvider.tsx`

### `packages/web/src/components/session/event-builder.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/session/timeline-builder.ts`
  - `packages/web/src/components/ui/EventTimeline.tsx`
  - `packages/web/src/components/ui/MarkdownContent.tsx`

### `packages/web/src/components/session/timeline-builder.ts`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/web/src/components/ui/DiffViewer.tsx`
  - `packages/web/src/components/ui/StageProgressBar.tsx`
  - `packages/web/src/components/ui/StatusDot.tsx`

### `packages/web/src/components/ui/AgentMessage.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/Avatar.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/Avatar.tsx`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ChatInput.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/CommandPalette.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ConfirmDialog.tsx`

- fan-in: 3
- fan-out: 3
- imports:
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/modal.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ContentTabs.tsx`

- fan-in: 3
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/TabBadge.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/DetailDrawer.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/DiffViewer.tsx`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ErrorBoundary.tsx`

- fan-in: 2
- fan-out: 0

### `packages/web/src/components/ui/EventTimeline.tsx`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/FilterChip.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/StatusDot.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/IconRail.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/IntegrationPill.tsx`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/MarkdownContent.tsx`

- fan-in: 2
- fan-out: 0

### `packages/web/src/components/ui/PageFallback.tsx`

- fan-in: 1
- fan-out: 0

### `packages/web/src/components/ui/ReviewFinding.tsx`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/RichSelect.tsx`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ScrollProgress.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/SessionHeader.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/ui/StagePipeline.tsx`
  - `packages/web/src/components/ui/StageProgressBar.tsx`
  - `packages/web/src/components/ui/StatusDot.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/SessionList.tsx`

- fan-in: 1
- fan-out: 3
- imports:
  - `packages/web/src/components/ui/StageProgressBar.tsx`
  - `packages/web/src/components/ui/StatusDot.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/SessionSummary.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/StagePipeline.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/StageProgressBar.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/StageProgressBar.tsx`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/StatusDot.tsx`

- fan-in: 6
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/SystemEvent.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/TabBadge.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/TodoList.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ToolCallFailed.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/ToolCallRow.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/TypingIndicator.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/UserMessage.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/Avatar.tsx`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/WorkspacePanel.tsx`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/badge.tsx`

- fan-in: 10
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/button.tsx`

- fan-in: 31
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/card.tsx`

- fan-in: 4
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/chart.tsx`

- fan-in: 2
- fan-out: 0

### `packages/web/src/components/ui/index.ts`

- fan-in: 1
- fan-out: 0

### `packages/web/src/components/ui/input.tsx`

- fan-in: 11
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/modal.tsx`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/separator.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/components/ui/styles.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/src/components/ui/tooltip.tsx`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/hooks/useAgentQueries.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useApi.ts`

- fan-in: 36
- fan-out: 2
- imports:
  - `packages/web/src/transport/HttpTransport.ts`
  - `packages/web/src/transport/types.ts`

### `packages/web/src/hooks/useComputeQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useCostQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useDaemonStatus.ts`

- fan-in: 18
- fan-out: 2
- imports:
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useSmartPoll.ts`

### `packages/web/src/hooks/useDashboardQuery.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useFilePreviews.ts`

- fan-in: 1
- fan-out: 0

### `packages/web/src/hooks/useFlowQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useHashRouter.ts`

- fan-in: 1
- fan-out: 0

### `packages/web/src/hooks/useHistoryQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useIntegrationQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useMemoryQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useMessages.ts`

- fan-in: 2
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/usePasteImageUpload.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/session/InputsSection.tsx`
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useQueries.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/src/hooks/useRuntimeQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useScheduleQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useServerConfig.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useSessionQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useSessionStream.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/hooks/useSessions.ts`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/hooks/useSessionQueries.ts`
  - `packages/web/src/hooks/useSse.ts`

### `packages/web/src/hooks/useSmartPoll.ts`

- fan-in: 2
- fan-out: 0

### `packages/web/src/hooks/useSse.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/transport/TransportContext.tsx`

### `packages/web/src/hooks/useToolQueries.ts`

- fan-in: 1
- fan-out: 1
- imports:
  - `packages/web/src/hooks/useApi.ts`

### `packages/web/src/lib/utils.ts`

- fan-in: 66
- fan-out: 0

### `packages/web/src/pages/AdminPage.tsx`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/admin/TeamsTab.tsx`
  - `packages/web/src/components/admin/TenantsTab.tsx`
  - `packages/web/src/components/admin/UsersTab.tsx`
  - `packages/web/src/components/ui/ContentTabs.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/AgentsPage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/AgentsView.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/ComputePage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/ComputeView.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/CostsPage.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/CostsView.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/DesignPreviewPage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/ui/StageProgressBar.tsx`
  - `packages/web/src/components/ui/StatusDot.tsx`
  - `packages/web/src/components/ui/index.ts`
  - `packages/web/src/themes/ThemeProvider.tsx`
  - `packages/web/src/themes/tokens.ts`

### `packages/web/src/pages/FlowsPage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/FlowsView.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/HistoryPage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/HistoryView.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/pages/IntegrationsPage.tsx`

- fan-in: 1
- fan-out: 9
- imports:
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ui/ContentTabs.tsx`
  - `packages/web/src/components/ui/badge.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/hooks/useIntegrationQueries.ts`

### `packages/web/src/pages/LoginPage.tsx`

- fan-in: 1
- fan-out: 2
- imports:
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/components/ui/input.tsx`

### `packages/web/src/pages/MemoryPage.tsx`

- fan-in: 1
- fan-out: 6
- imports:
  - `packages/web/src/components/CodebaseMemoryPanel.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/MemoryView.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/SchedulesPage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ScheduleView.tsx`
  - `packages/web/src/components/ui/button.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/SecretsPage.tsx`

- fan-in: 1
- fan-out: 7
- imports:
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/secrets/NewSecretForm.tsx`
  - `packages/web/src/components/secrets/SecretsList.tsx`
  - `packages/web/src/components/ui/ConfirmDialog.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/SessionsPage.tsx`

- fan-in: 1
- fan-out: 10
- imports:
  - `packages/web/src/components/DashboardView.tsx`
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/NewSessionModal.tsx`
  - `packages/web/src/components/SessionDetail.tsx`
  - `packages/web/src/components/SessionList.tsx`
  - `packages/web/src/components/ui/ConfirmDialog.tsx`
  - `packages/web/src/components/ui/ErrorBoundary.tsx`
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/hooks/useSessions.ts`

### `packages/web/src/pages/SettingsPage.tsx`

- fan-in: 1
- fan-out: 4
- imports:
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/SettingsView.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`

### `packages/web/src/pages/ToolsPage.tsx`

- fan-in: 1
- fan-out: 5
- imports:
  - `packages/web/src/components/Layout.tsx`
  - `packages/web/src/components/PageShell.tsx`
  - `packages/web/src/components/ToolsView.tsx`
  - `packages/web/src/hooks/useDaemonStatus.ts`
  - `packages/web/src/lib/utils.ts`

### `packages/web/src/providers/AppModeProvider.tsx`

- fan-in: 3
- fan-out: 4
- imports:
  - `packages/web/src/components/mode/binding-types.ts`
  - `packages/web/src/components/mode/hosted-binding.ts`
  - `packages/web/src/components/mode/local-binding.ts`
  - `packages/web/src/hooks/useServerConfig.ts`

### `packages/web/src/providers/QueryProvider.tsx`

- fan-in: 1
- fan-out: 0

### `packages/web/src/styles.css`

- fan-in: 1
- fan-out: 0

### `packages/web/src/themes/ThemeProvider.tsx`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/web/src/themes/tokens.ts`

### `packages/web/src/themes/tokens.ts`

- fan-in: 3
- fan-out: 0

### `packages/web/src/themes/typography.ts`

- fan-in: 0
- fan-out: 0

### `packages/web/src/transport/HttpTransport.ts`

- fan-in: 3
- fan-out: 1
- imports:
  - `packages/web/src/transport/types.ts`

### `packages/web/src/transport/MockTransport.ts`

- fan-in: 0
- fan-out: 1
- imports:
  - `packages/web/src/transport/types.ts`

### `packages/web/src/transport/TransportContext.tsx`

- fan-in: 2
- fan-out: 3
- imports:
  - `packages/web/src/hooks/useApi.ts`
  - `packages/web/src/transport/HttpTransport.ts`
  - `packages/web/src/transport/types.ts`

### `packages/web/src/transport/types.ts`

- fan-in: 4
- fan-out: 0

### `packages/web/src/util.ts`

- fan-in: 8
- fan-out: 0

### `packages/web/vite.config.ts`

- fan-in: 0
- fan-out: 0

</details>
