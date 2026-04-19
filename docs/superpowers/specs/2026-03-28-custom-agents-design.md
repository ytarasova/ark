# Custom Agents: Project & Global Agent Management

## Summary

Add user-created agents at two scopes -- **project-local** (`.ark/agents/`) and **global** (`~/.ark/agents/`) -- with full CRUD via CLI and TUI. Three-tier resolution: project > global > builtin.

## Resolution Order

First match wins:

1. `<project-root>/.ark/agents/<name>.yaml` -- `_source: "project"`
2. `~/.ark/agents/<name>.yaml` -- `_source: "global"` (renamed from `"user"`)
3. `<repo>/agents/<name>.yaml` -- `_source: "builtin"`

**Project root discovery**: Walk up from `cwd` looking for `.git/`. If not found, project-level agents are skipped.

`listAgents()` merges all three tiers. Later sources overlay earlier ones (builtin first, then global, then project), so project agents with the same name as a builtin win.

## Storage

**Project agents**: `<project-root>/.ark/agents/*.yaml`
- Same YAML format as existing agent definitions
- `.ark/` directory becomes the project-local config convention (future: flows, config)
- Committable or gitignore-able per team preference

**Global agents**: `~/.ark/agents/*.yaml` (existing, unchanged)

**Builtin agents**: `<ark-repo>/agents/*.yaml` (existing, unchanged)

## Core Changes (`packages/core/agent.ts`)

### New/Modified Functions

```ts
// Walk up from cwd looking for .git/
findProjectRoot(cwd?: string): string | null

// Add optional projectRoot to existing functions
loadAgent(name: string, projectRoot?: string): AgentDefinition | null
listAgents(projectRoot?: string): AgentDefinition[]
resolveAgent(name: string, session: Record<string, unknown>, projectRoot?: string): AgentDefinition | null

// Scope-aware save/delete
saveAgent(agent: AgentDefinition, scope: "project" | "global", projectRoot?: string): void
deleteAgent(name: string, scope?: "project" | "global", projectRoot?: string): boolean
```

### Path Constants

```ts
BUILTIN_DIR = join(__dirname, "..", "..", "agents")        // unchanged
GLOBAL_DIR() = join(ARK_DIR(), "agents")                   // renamed from USER_DIR
PROJECT_DIR(root: string) = join(root, ".ark", "agents")   // new
```

### Source Rename

`_source: "user"` becomes `_source: "global"` everywhere.

## CLI Commands (`packages/cli/index.ts`)

```bash
ark agent list                            # existing -- add source column (P/G/B)
ark agent show <name>                     # existing -- no changes
ark agent create <name> [--global]        # scaffold YAML, open $EDITOR. Default: project
ark agent edit <name>                     # open in $EDITOR; prompt to copy if builtin
ark agent delete <name>                   # refuse builtins, confirm for others
ark agent copy <name> [new-name] [--global]  # copy any agent to project/global
```

**Scope defaults**: `create` and `copy` default to project scope. `--global` overrides. If no project root found, falls back to global.

**`edit` for builtins**: Prompts "This is a builtin agent. Copy to [project/global] first? [y/N]" before opening.

**`delete`**: Shows file path, asks confirmation. Refuses builtins with error message.

## TUI Changes (`packages/tui/tabs/AgentsTab.tsx`)

### Left Pane -- Agent List

Source indicators in list rows:

```
  P my-agent         opus     Project-specific agent
  G custom-reviewer  sonnet   Global custom reviewer
  B implementer      opus     Implements features with tests
```

### Keybindings (status bar)

| Key     | Action                                    |
|---------|-------------------------------------------|
| `n`     | Create new agent (inline form)            |
| `e`     | Edit selected agent (inline form)         |
| `c`     | Copy agent to project/global              |
| `x`     | Delete agent (project/global only)        |
| `Enter` | Toggle edit mode                          |

### Create/Edit Form (right pane overlay)

Inline fields:
- **name**: text input (create only)
- **description**: text input
- **model**: selector (opus / sonnet / haiku)
- **max_turns**: number input
- **tools**: checkbox list (Bash, Read, Write, Edit, Glob, Grep, WebSearch)
- **permission_mode**: selector (bypassPermissions / default)
- **scope**: selector (project / global) -- create only

Hybrid field:
- **system_prompt**: "Press Enter to edit in $EDITOR" -- opens temp file, reads result back

On save: calls `saveAgent(agent, scope, projectRoot)`.

Delete: confirms, refuses for builtins with status message.

### StatusBar Integration

Agent tab hints update to show available keybindings. When form overlay is active, status bar switches to `Enter:save Esc:cancel`.

## Files Changed

| File | Change |
|------|--------|
| `packages/core/agent.ts` | 3-tier resolution, scope params, `findProjectRoot()`, rename `"user"` → `"global"` |
| `packages/cli/index.ts` | `create`, `edit`, `delete`, `copy` subcommands |
| `packages/tui/tabs/AgentsTab.tsx` | Full CRUD, inline form, source indicators |
| `packages/tui/components/StatusBar.tsx` | Agent tab keybinding hints |
| `packages/core/__tests__/agent.test.ts` | New: 3-tier resolution, save/delete with scopes |

## What Doesn't Change

- `store.ts` / `session.ts` -- sessions store agent name as string, resolution at dispatch time
- `conductor.ts` -- no agent loading
- `claude.ts` -- `buildArgs()` unchanged, receives resolved agent
- Template system -- `resolveAgent()` just threads project root through
- Flow definitions -- reference agents by name, resolution handles the rest
- Agent YAML format -- identical across all three tiers
