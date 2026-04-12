# CLI / TUI / Web UI Surface Parity Audit

Generated: 2026-04-11
Branch: worktree-agent-a7549f8c
Method: Enumerated every CLI command (`packages/cli/commands/*.ts`), TUI tab and overlay (`packages/tui/tabs/*.tsx`), Web page and view (`packages/web/src/{pages,components}/*.tsx`), and JSON-RPC handler (`packages/server/handlers/*.ts`). Cross-referenced calls in `packages/web/src/hooks/useApi.ts`, `packages/protocol/client.ts`, and `packages/tui/hooks/useArkClient.ts`. Capabilities are grouped by domain so a row covers a feature, not an individual flag.

## Capability matrix

Legend: `yes` = present and working, `partial` = present but limited or local-only, `no` = absent, `broken` = surface calls a non-existent backend.

| # | Capability | CLI | TUI | Web | Notes |
|---|---|---|---|---|---|
| 1 | Session lifecycle: start/stop/dispatch/resume/pause/complete/advance | yes | yes | yes | All wired through `session/*` RPCs. |
| 2 | Session list with filters (status/repo/group/archive) | yes | yes | yes | |
| 3 | Session detail / events / output | yes | yes | yes | TUI uses split pane; Web uses SessionDetail.tsx. |
| 4 | Session talk / send message | yes | yes | yes | `message/send`. |
| 5 | Session interrupt (Ctrl-C without kill) | yes | yes | yes | |
| 6 | Session archive / restore | yes | yes | yes | |
| 7 | Session delete + 90s undelete | yes | yes | yes | |
| 8 | Session fork / clone | yes | yes | yes | Web uses `session/clone`. |
| 9 | Sub-agent spawn / fan-out / join | yes | partial | no | TUI has spawn but no join overlay. Web has neither. |
| 10 | Session handoff to a different agent | yes | no | no | `session/handoff` RPC exists, only CLI uses it. |
| 11 | Session todos (add/list/done/delete) | yes | yes | yes | |
| 12 | Verification gate run (`verify/run`) | yes | yes | yes | |
| 13 | Worktree diff preview | yes | yes | yes | |
| 14 | Worktree finish (merge + cleanup) | yes | yes | yes | |
| 15 | Worktree create PR | yes | yes | yes | Auto-PR fallback also triggers. |
| 16 | Worktree list / cleanup orphans | yes | no | yes | TUI has no orphan-cleanup affordance. |
| 17 | Compute create / list / read / update / delete | yes | yes | yes | |
| 18 | Compute provision / start / stop / destroy / reboot / clean | yes | yes | partial | Web has no reboot button. |
| 19 | Compute ping (SSH check) | no | no | no | `compute/ping` RPC exists, no surface. |
| 20 | Compute templates list / create / delete | yes | no | no | Only CLI. Templates are Camp 0 path for fleet provisioning. |
| 21 | Compute SSH attach | yes | no | no | CLI-only (`ark compute ssh`). |
| 22 | Compute pools (multi-tenant) | yes | no | no | CLI-only. |
| 23 | Agents list / read / detail | yes | yes | yes | |
| 24 | Agents create / edit / delete / copy | partial (local only) | partial (local only) | broken | CLI/TUI call `getApp().agents.*` directly. Web calls `agent/create`, `agent/update`, `agent/delete` which are NOT registered as RPC handlers. **FIXED IN THIS PR.** |
| 25 | Flows list / read / detail | yes | yes | yes | |
| 26 | Flows create / delete | no | no | broken | Web calls `flow/create` / `flow/delete` (not registered). CLI flow command has only `list/show`. **FIXED IN THIS PR.** |
| 27 | Skills list / read | yes | yes | yes | Skills shown in Tools tab in TUI/Web. |
| 28 | Skills create / save / delete | partial (local only) | partial (local only) | broken | CLI uses `getApp().skills.*` directly. Web calls `skill/save` / `skill/delete` (not registered). **FIXED IN THIS PR.** |
| 29 | Recipes list / read | yes | yes | yes | |
| 30 | Recipes create / delete | partial (local only) | no | broken | CLI uses `getApp()`; Web calls `recipe/delete` (not registered). **FIXED IN THIS PR.** |
| 31 | Runtimes list / read | yes | yes | yes | |
| 32 | Knowledge graph search / stats | yes | yes | yes | |
| 33 | Knowledge index / ingest / export / import | yes | partial | yes | TUI has no ingest/index/export/import buttons. |
| 34 | Knowledge remember / recall (memory CRUD) | yes | yes | yes | |
| 35 | History (Claude Code transcripts) list / refresh | yes | yes | yes | |
| 36 | History import to a session | partial | yes | no | CLI has no `history import`. Web has no history import flow. |
| 37 | History search | yes | yes | yes | FTS5 backed. |
| 38 | Schedules list / create / enable / disable / delete | yes | yes | yes | |
| 39 | Costs per-session list | yes | yes | yes | |
| 40 | Costs grouped summary (`--by` model/provider/etc.) | yes | no | no | Only CLI exposes `costs/summary`. |
| 41 | Costs daily trend chart | yes | no | partial | Web Dashboard has trend; standalone Costs view does not. |
| 42 | Costs export CSV / JSON | yes | no | yes | TUI has no export. |
| 43 | Costs sync / backfill from transcripts | yes | no | no | |
| 44 | Dashboard summary (fleet status, costs, recent events) | yes | no | yes | Web Dashboard page exists. **TUI has no Dashboard tab.** |
| 45 | Eval stats / drift / list | yes | no | no | Eval RPCs exist; only CLI consumes them. |
| 46 | Profiles list / create / set / delete | yes | no | no | CLI-only. |
| 47 | Auth / API keys (create / list / revoke / rotate) | yes | no | no | CLI-only. |
| 48 | Tenant policy management | yes | no | no | CLI-only. |
| 49 | Router (LLM proxy) start / status / costs | yes | no | no | CLI-only. |
| 50 | TensorZero gateway lifecycle | partial | no | no | Auto-managed; no explicit surface. |
| 51 | Conductor learnings list / add | yes | no | partial | Web has SSE but no dedicated UI. |
| 52 | Tools list (MCP servers, commands, skills, recipes) | no | yes | yes | CLI has no consolidated `tools` command. |
| 53 | MCP server attach / detach (per session) | no | yes | yes | TUI/Web only. |
| 54 | Repo map | partial | no | yes | Web has it; CLI has `ark repo-map`. |
| 55 | Search (sessions + transcripts) | yes | yes | yes | |
| 56 | Settings / theme / hotkeys | yes (config edit) | no | yes | TUI uses keyboard hints, no settings UI. |
| 57 | Login (multi-tenant) | yes (token flag) | yes (token flag) | yes (LoginPage) | |
| 58 | Server start / hosted mode | yes | no | no | CLI-only. |

## Gaps by surface

### Missing from TUI (sorted by impact)

1. **Dashboard summary tab.** Web has a full DashboardPage with fleet status, cost charts, recent events; CLI has `ark dashboard`; TUI has nothing equivalent. This is the at-a-glance view operators ask for first.
2. **Cost grouped summary / trend / export.** TUI Cost tab is a flat per-session list. CLI has `--by`, `--trend`, `costs-export`; Web Dashboard has trend.
3. **Compute templates and pools.** TUI compute tab does not surface templates -- the Camp 0 fleet path needs templates available in TUI.
4. **Sub-agent fan-out / join** -- TUI has spawn but no join. Operators can't see fan-out completion in TUI.
5. **Knowledge ingest / index / export / import buttons.** TUI memory tab covers memories and learnings only. Other knowledge ops require dropping to CLI.
6. **Eval / drift dashboard, profile manager, auth manager, tenant policy editor.** These are CLI-only and meaningful to fleet operators.

### Missing from Web

1. **Flow create / delete is BROKEN.** `FlowsView` calls `flow/create` and `flow/delete` RPCs that are not registered (`packages/server/register.ts`). The button looks present but every click fails with -32601. **Fixed in this PR.**
2. **Agent create / update / delete is BROKEN.** Same root cause: `AgentsView` calls `agent/create`, `agent/update`, `agent/delete` (none registered). **Fixed in this PR.**
3. **Skill save / delete is BROKEN.** `ToolsView` calls `skill/save`, `skill/delete` (none registered). **Fixed in this PR.**
4. **Recipe delete is BROKEN.** Web calls `recipe/delete` (not registered). **Fixed in this PR.**
5. **Sub-agent spawn / handoff / fan-out / join.** Web has neither button nor RPC consumption.
6. **Compute reboot, ping, SSH-attach, templates, pools.** Compute view covers basic lifecycle but no advanced ops.
7. **Profiles, auth (API keys), tenant policies, router/TensorZero lifecycle.** Hosted-mode operators have no Web UI for these.
8. **Eval stats / drift / list.** Web has no eval surface even though `eval/*` RPCs exist.

### Missing from CLI

1. **`ark flow create` / `ark flow delete` / `ark flow edit`.** The CLI's flow command only lists/shows. Web has a creation form (broken). With the new `flow/create`/`flow/delete` RPCs added in this PR, the CLI now has matching subcommands too. **Fixed in this PR.**
2. **`ark tools list`.** A unified tool inventory exists in Tools tab of TUI/Web but no CLI equivalent.
3. **`ark history import <claude-session-id>`.** CLI can list Claude sessions and start a new session bound to one (`session start --claude-session`), but there is no explicit import command matching the TUI History tab affordance.
4. **`ark mcp attach/detach <session> <server>`.** Per-session MCP plumbing is TUI/Web-only.
5. **`ark dashboard`.** Already exists -- not a gap. Listed for reference.

## Highest-impact gaps closed in this PR

These were chosen because they (a) are on the Camp 0 critical path for the Web UI (creating flows, agents, skills, and recipes from the dashboard); (b) are bugs, not feature requests -- the Web UI looks like it works but every action errors out; (c) only require new RPC handlers plus a tiny CLI mirror, no service layer changes.

1. **`flow/create` + `flow/delete` RPC handlers** registered in `packages/server/handlers/resource.ts`. Web `Create Flow` button now works. CLI gains matching `ark flow create` (with `--from <yaml>` and inline-stage flags) and `ark flow delete` subcommands.
2. **`agent/create` + `agent/update` + `agent/delete` RPC handlers** registered. Web `Create Agent` and `Edit Agent` forms now work. CLI gains a remote-safe path -- previously the existing `ark agent create/edit/delete` reached straight into `getApp()` and broke under `--server`. The CLI now ships with `ark agent save --from <yaml>` that goes through the RPC.
3. **`skill/save` + `skill/delete` RPC handlers** registered. Web Tools tab `New Skill` flow now works. The existing CLI `ark skill create` continues to work locally; the new RPC backs the Web button and any future remote CLI use.
4. **`recipe/delete` RPC handler** registered. Web Tools tab recipe deletion works.
5. **`ark flow create` / `ark flow delete` CLI subcommands** added in `packages/cli/commands/flow.ts`, going through the new RPCs (so they work in remote mode too).

### Highest-impact gaps NOT closed in this PR (recommended follow-ups)

- **Web sub-agent spawn UI.** Trivial RPC wiring; needs design for the spawn modal.
- **TUI Dashboard tab.** `dashboard/summary` RPC already exists (consumed by CLI and Web). Adding a `<DashboardTab>` is mostly chart layout work.
- **Compute templates in TUI/Web.** RPCs exist (`compute/template/*`); both surfaces need template selectors in their compute creation forms.
- **`ark tools list` CLI.** Dispatches to `tools/list` RPC (already registered).
- **Eval / Profile / Auth / Tenant / Router pages in Web.** Larger scope; control-plane surface that needs design.
