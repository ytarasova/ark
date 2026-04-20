# Agent Lifecycle: Spawn, Watch, Reap

Ark runs one tmux-backed agent (Claude Code, codex, gemini-cli, goose, ...) per session. The lifecycle contract below is what keeps 142 orphaned tmux sessions from accumulating in a single test run (the bug this document exists to prevent from coming back).

## Contract

```
spawn  -> executor launches tmux + creates AgentHandle + registers it
watch  -> TmuxAgentHandle polls for exit-code sentinel OR pane death
reap   -> handle.onExit fires once + kills tmux (idempotent) + registry removes it
shutdown -> AppContext.shutdown drains pending dispatches + stops every live handle
```

## The load-bearing invariants

1. **Launcher scripts do NOT end with `exec bash`.** When the agent process exits, the tmux pane dies with it. The pane's exit status reflects the agent's exit code (`exit $code` is the last line of `buildLauncher`'s output). This is a reversal of the PR #260 post-mortem behaviour -- users who want to inspect a dead session's workdir run `ark session attach <id>` (see TODO below) instead of scrolling back in the leftover tmux pane.
2. **Every executor that launches tmux registers an `AgentHandle`.** The handle polls two sources of truth in `tick()`:
   - `$ARK_SESSION_DIR/exit-code` — written by the launcher on non-zero exit (the sentinel).
   - `tmux has-session -t <name>` — `false` means pane died.

   Whichever fires first resolves `waitForExit()` with the appropriate `via: "sentinel" | "pane-death"`.
3. **`handle.stop()` is idempotent.** Calling it on an already-exited handle is a no-op. Calling it on a live handle kills tmux and resolves `waitForExit` with `via: "signal"`. Both orderings (stop-then-natural-exit, natural-exit-then-stop) converge to the same post-state: tmux dead, handle removed from registry, single `onExit` fire.
4. **`AppContext.shutdown()` drains the registry.** Via `SessionDrain` (registered in the awilix container with dispose-first ordering), shutdown calls `agentRegistry.stopAll()` after `sessionService.stopAll()`. Even if production code forgot to register / deregister correctly, this catches it.

## Key files

- `packages/types/agent-handle.ts` — `AgentHandle`, `AgentExitInfo`, `AgentExitVia`.
- `packages/core/services/agent-registry.ts` — `AgentRegistry`; a `Map<sessionId, AgentHandle>` with reap-on-register-collision semantics.
- `packages/core/services/tmux-agent-handle.ts` — `TmuxAgentHandle`; the concrete handle for tmux-backed executors.
- `packages/core/claude/claude.ts` — `buildLauncher` ends with `exit $code`, no `exec bash`.
- `packages/core/executors/{claude-code,cli-agent,goose}.ts` — each constructs a `TmuxAgentHandle` post-launch and calls `app.agentRegistry.register(handle)`.
- `packages/core/infra/session-drain.ts` — calls `app.agentRegistry.stopAll()` as the anti-regression net.
- `packages/core/__tests__/agent-registry.test.ts` — unit tests (10 cases).
- `packages/core/__tests__/agent-lifecycle-stress.test.ts` — anti-regression: 20 parallel handles + shutdown -> 0 orphans.

## Exit-code sentinel path vs pane-death path

| Signal                    | Launcher action                             | TmuxAgentHandle reports | Status-poller sets session status |
| ------------------------- | ------------------------------------------- | ----------------------- | --------------------------------- |
| Claude exits 0            | script exits 0, no sentinel                 | via: `pane-death`       | `completed`                       |
| Claude exits !=0          | script writes `exit-code`, exits with code  | via: `sentinel`         | `failed` (with code in error)     |
| `stop()` called           | not involved (tmux killed by handle)        | via: `signal`           | `stopped`                         |
| External `tmux kill-session` | not involved                             | via: `pane-death`       | `completed`                       |

The status-poller still has the authoritative say over the `failed` vs `completed` distinction (it reads `exit-code` directly and writes `session.error`). The `AgentHandle` layer is in charge of tmux reaping only; the poller is in charge of session-row state transitions. The two observers are independent and don't need to coordinate — they read the same on-disk sentinel + tmux liveness.

## Compute providers (future)

Today's `AgentHandle` lives at the executor layer. Remote compute providers (docker, ec2, k8s) still return a string handle from `provider.launch()` and rely on `provider.killAgent()` for cleanup. Moving the `AgentHandle` contract into `ComputeProvider.launchAgent(opts): Promise<AgentHandle>` is the natural next step, with per-provider concrete handle classes:

- `local + direct runtime` -> `TmuxAgentHandle` (today).
- `local + docker runtime` -> `DockerAgentHandle` (exec into sidecar container + watch container exit).
- `ec2 + direct` -> `RemoteTmuxAgentHandle` (SSH-based sentinel + tmux probe).
- `k8s + direct` -> `PodAgentHandle` (watch pod phase).

Left as a TODO.

## Attach CLI (`ark session attach <id>`)

The old `exec bash` post-mortem behaviour was users' escape hatch for "why did my session die?" -- they'd attach to the still-alive tmux pane and scroll back. Now that tmux dies with the agent, the substitute is a one-shot interactive shell over the session's workdir:

```bash
ark session attach <id>
# Resolves session.workdir
# Exports ARK_SESSION_ID + ARK_EXIT_CODE
# Prints a banner
# Exec's $SHELL -i in the workdir
```

Not wired yet — TODO in a follow-up PR. In the meantime, users can `cd $(ark session get <id> --field workdir)` manually.

## Test helpers: what NOT to do

The retired helpers `snapshotArkTmuxSessions()` and `killNewArkTmuxSessions()` used to scrape `tmux list-sessions` before a test and kill the diff in `afterAll`. They were:

1. **Racy** under `--concurrency 4` — worker A's snapshot included worker B's in-flight sessions, so worker A would kill worker B's processes mid-run.
2. **Brittle** — `pkill -9 -P <pid>` on tmux pane pids sometimes killed the parent shell out from under long-running sessions.
3. **Symptomatic** — they papered over the root cause (launcher-level lifecycle gap) instead of fixing it.

Use `expectNoLiveSessions(app)` from `packages/core/__tests__/test-helpers.ts` if you need to assert zero orphans in a specific test. Otherwise just rely on `AppContext.shutdown()` doing the right thing (it will, because the registry does).
