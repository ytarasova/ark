# Ark TUI Keyboard Reference

Launch the TUI with `ark tui`. All keyboard shortcuts listed below. Shortcuts are remappable via `~/.ark/config.yaml` -- see [Configuration](configuration.md#hotkey-remapping).

The TUI has 9 tabs: Sessions, Agents, Flows, Compute, History, Memory, Tools, Schedules, Costs. The web dashboard (`ark web`) mirrors these and adds a System Status view.

## Global Shortcuts

These work in any tab when no overlay is open.

| Key | Action |
|-----|--------|
| `1` | Switch to Sessions tab |
| `2` | Switch to Agents tab |
| `3` | Switch to Tools tab |
| `4` | Switch to Flows tab |
| `5` | Switch to History tab |
| `6` | Switch to Compute tab |
| `7` | Switch to Costs tab |
| `Tab` | Toggle focus between left and right pane |
| `e` | Expand event log |
| `q` | Quit |

## Navigation (All Tabs)

| Key | Action |
|-----|--------|
| `j` / `k` | Move down / up |
| `g` / `G` | Jump to top / bottom |
| `f` / `b` | Page forward / back |

## Sessions Tab (1)

### Left Pane (Session List)

| Key | Action | When |
|-----|--------|------|
| `Enter` | Dispatch agent | Session is ready or blocked |
| `Enter` | Restart agent | Session is stopped, failed, or completed |
| `a` | Attach to tmux session | Session is running or waiting |
| `s` | Stop session | Session is running or waiting |
| `d` | Mark done (press once to confirm) | Session is running |
| `t` | Talk -- send message to agent | Session is running or waiting |
| `T` | Open threads / inbox | Session is running or waiting |
| `f` | Fork session | Any session selected |
| `C` | Clone session | Any session selected |
| `A` | Advance to next stage | Session at a gate |
| `W` | Finish worktree (merge + cleanup) | Session has a worktree |
| `m` | Move to group | Any session selected |
| `M` | Open MCP manager | Any session selected |
| `u` | Mark session unread | Any session selected |
| `x` | Delete session (soft, 90s undo) | Any session selected |
| `Ctrl+Z` | Undo last delete | After deletion |
| `n` | New session | Always |
| `o` | Open group manager | Always |
| `K` | Open skills manager | Always |
| `Y` | Open memory manager | Always |
| `P` | Open settings | Always |
| `/` | Fuzzy search sessions | Always |
| `r` | Open session replay | Session is stopped, failed, or completed |

### Status Filters

| Key | Filter |
|-----|--------|
| `!` | Running sessions only |
| `@` | Waiting sessions only |
| `#` | Stopped sessions only |
| `$` | Failed sessions only |
| `0` | Clear filter (show all) |

### Right Pane (Detail)

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll down / up |
| `f` / `b` | Page forward / back |
| `g` / `G` | Scroll to top / bottom |
| `/` | Search within detail |
| `Tab` | Return focus to left pane |

## Agents Tab (2)

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate agents |
| `g` / `G` | Jump to top / bottom |
| `n` | Create new agent |
| `e` | Edit agent definition |
| `c` | Copy agent for customization |
| `x` | Delete agent (custom only) |

## Tools Tab (3)

Browse and manage tools across 6 categories: MCP Servers, Commands, Claude Skills, Ark Skills, Recipes, Context.

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate items |
| `g` / `G` | Jump to top / bottom |
| `Enter` | View / use tool |
| `x` | Delete tool |

## Flows Tab (4)

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate flows |
| `g` / `G` | Jump to top / bottom |
| `Tab` | Toggle to detail pane |

## History Tab (5)

Browse and import Claude Code sessions found on disk.

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate sessions |
| `g` / `G` | Jump to top / bottom |
| `Enter` | Import session into Ark |
| `r` | Refresh session list |
| `R` | Rebuild search index |
| `s` | Search sessions |

## Compute Tab (6)

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate compute resources |
| `g` / `G` | Jump to top / bottom |
| `Enter` | Provision compute |
| `s` | Start / stop compute |
| `R` | Reboot compute |
| `t` | Test connectivity |
| `x` | Delete compute |
| `c` | Clean compute |
| `n` | Create new compute |

## Costs Tab (7)

| Key | Action |
|-----|--------|
| `q` | Quit |

Displays per-session cost breakdown with token usage and aggregate totals.

## Overlay Shortcuts

When a form or overlay is open, these shortcuts replace the normal tab shortcuts.

### New Session Form

| Key | Action |
|-----|--------|
| `Tab` | Navigate between fields |
| `Enter` | Edit field / select option |
| `Esc` | Cancel and close form |

### Move to Group

| Key | Action |
|-----|--------|
| `Enter` | Confirm group assignment |
| `Esc` | Cancel |

### Fork Session

| Key | Action |
|-----|--------|
| `Enter` | Confirm fork |
| `Esc` | Cancel |

### Group Manager

| Key | Action |
|-----|--------|
| `Enter` | Confirm |
| `Esc` | Cancel |

### MCP Manager

| Key | Action |
|-----|--------|
| `Space` | Toggle MCP server on/off |
| `Enter` | Apply changes |
| `Esc` | Cancel |

### Talk to Session

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Esc` | Close |

### Fuzzy Search

| Key | Action |
|-----|--------|
| Type | Filter results |
| `Ctrl+j` / `Ctrl+k` | Navigate results |
| `Enter` | Select result |
| `Esc` | Close search |

### Search in History

| Key | Action |
|-----|--------|
| `Enter` | Execute search |
| `Esc` | Cancel |

### Session Replay

| Key | Action |
|-----|--------|
| `j` / `k` | Step forward / back through timeline |
| `Enter` | Expand event details |
| `/` | Search within replay |
| `Esc` | Close replay |

### Memory Manager (Y)

| Key | Action |
|-----|--------|
| `j/k` | Navigate memories |
| `n` | Add new memory |
| `x` | Delete selected memory |
| `Esc` | Close |

### Inbox / Threads

| Key | Action |
|-----|--------|
| `Esc` | Close inbox |
