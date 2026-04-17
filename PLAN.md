# Plan: Update the User Guide

## Summary

The user guide (`docs/guide.md`) has fallen behind the codebase in several areas. CLI command coverage is incomplete (guide says "17 command modules" but there are 25+), skills are described as "markdown files" but are actually YAML with a `prompt` field, and several new CLI features (eval, profile, schedule, memory, daemon, pr, init, repo-map) are undocumented. The web pages list also omits LoginPage and DesignPreviewPage.

## Files to modify/create

| File | Change |
|------|--------|
| `docs/guide.md` | Update all outdated sections (skills format, CLI count, new commands, web pages, misc commands) |

## Implementation steps

### Step 1: Fix Skills section (Section 5, lines 355-392)

The guide says skills are "markdown files injected into an agent's system prompt." They are actually **YAML files** with a `prompt` field (`skills/*.yaml`). Update:

- Line 355: Change "Skills are reusable prompt fragments. They are markdown files injected into an agent's system prompt when attached." to "Skills are reusable prompt fragments defined as YAML files. Their `prompt` field is injected into an agent's system prompt when attached."
- Line 357 heading "Builtin skills (7)": count is correct (7 YAML files confirmed)
- Lines 369-376 three-tier resolution: Change `.ark/skills/<name>.md` to `.ark/skills/<name>.yaml`, same for `~/.ark/skills/` and `skills/`
- Remove or correct the statement about "markdown content is inlined" at line 388 -- it's the YAML `prompt` field that is inlined

### Step 2: Fix CLI command count (Section 15, line 831)

Change "Seventeen command modules" to the accurate count. The actual command files in `packages/cli/commands/` (excluding `_shared.ts`):

1. agent
2. auth
3. compute
4. conductor
5. costs
6. daemon
7. dashboard
8. eval
9. exec-try
10. flow
11. knowledge
12. memory
13. misc (contains: pr, claude, doctor, arkd, channel, config, web, openapi, mcp-proxy, acp, repo-map, init)
14. profile
15. recipe
16. router
17. runtime
18. schedule
19. search
20. server-daemon
21. server
22. session
23. skill
24. tenant
25. worktree

Update line 831 to say "Twenty-five command modules" and note that `misc.ts` bundles several utility commands (pr, claude, doctor, web, init, repo-map, config, etc.).

### Step 3: Document new CLI commands

Add a new subsection after the CLI commands table in Section 15 (around line 830) or integrate into relevant existing sections:

**In Section 15 (Dashboards):**
- Add `ark daemon start|stop|status` -- manages the arkd agent daemon
- Add `ark eval stats|drift|list` -- agent performance evaluation
- Add `ark profile list|create|delete` -- manage profiles
- Add `ark schedule add|list|delete|enable|disable` -- manage scheduled recurring sessions
- Add `ark memory list|recall|forget|add|clear` -- manage cross-session memory (backed by knowledge graph)
- Add `ark pr list|status|watch` -- manage PR-bound sessions
- Add `ark init` -- initialize a new project
- Add `ark doctor` -- health check
- Add `ark repo-map` -- generate a repo map

### Step 4: Update web pages list (Section 15, line 840)

Current guide lists: "Dashboard, Sessions, Agents, Flows, Compute, History, Memory, Tools, Schedules, Costs, Settings"

Add missing pages:
- LoginPage (already mentioned in auth section but not in the pages list)
- DesignPreviewPage (internal/dev page -- may omit from user guide)

Update to: "Dashboard, Sessions, Agents, Flows, Compute, History, Memory, Tools, Schedules, Costs, Settings, Login"

### Step 5: Update Appendix key file locations (line 1036)

The guide says skills are at paths like `~/.ark/skills/` -- ensure the description references YAML files, not markdown.

### Step 6: Update the closing paragraph (line 1089)

The final "That is the full tour" paragraph should mention the new command areas: eval, profiles, schedules, daemon management, and memory CLI.

### Step 7: Run formatting

```bash
make format
```

## Testing strategy

- **Manual review**: Read through the updated guide for internal consistency (no leftover references to "markdown skills")
- **Grep verification**: `grep -n "\.md" docs/guide.md` to check for stale `.md` references for skills
- **Cross-reference**: Verify each CLI command mentioned in the guide exists in `packages/cli/commands/`
- **Count check**: Verify the stated counts (agents: 12, flows: 14, skills: 7, recipes: 10, runtimes: 5, commands: 25) against `ls` output

## Risk assessment

- **Low risk**: This is a documentation-only change. No code is modified.
- **Scope creep**: The guide is 1089 lines. Only targeted sections are updated -- no rewrite of sections that are already accurate.
- **Stale by merge**: If new commands or features land on main before this merges, counts may drift again. Acceptable.

## Open questions

- **DesignPreviewPage**: Likely an internal dev tool. Decision: omit from user guide (developer-facing, not user-facing).
- **exec-try command**: Appears experimental. Decision: omit from guide unless it's user-facing.
- **misc.ts commands (acp, mcp-proxy, openapi)**: Some may be internal/experimental. Decision: document only the user-facing ones (pr, web, init, doctor, repo-map, config) and skip low-level plumbing (acp, mcp-proxy, openapi).
