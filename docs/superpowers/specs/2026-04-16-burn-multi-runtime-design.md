# Burn Multi-Runtime Support + Completion Pipeline Integration

**Date:** 2026-04-16
**Status:** Approved for implementation
**Branch:** `feature/burn-dashboard`
**Depends on:** `2026-04-15-burn-dashboard-design.md` (v1, Claude-only)

## Problem

Burn v1 hardcodes `parseClaudeTranscript()` for all runtimes and uses a pull-from-disk sync model. This means:

1. Codex/Gemini/Goose sessions silently produce garbage or empty data
2. Remote agents (EC2/K8s) can't sync because transcripts live on the remote machine
3. Burn data only appears after manual sync, not at session completion like cost data

The Costs page works for all runtimes because it hooks into the completion pipeline (`session-hooks.ts` + `session-orchestration.ts`) via `recordSessionUsage`. Burn should follow the same pattern.

## Goals

1. Pluggable `BurnTranscriptParser` interface -- one parser per runtime kind
2. Codex parser that extracts tools from shell commands and classifies from command patterns
3. Gemini parser that handles tokens + keywords (no tool data)
4. Hook into completion pipeline -- burn data recorded at session end, same path as costs
5. Graceful UI degradation -- panels show runtime-appropriate content, not broken empties
6. Keep `syncBurn()` as backfill for historical sessions

## Non-goals

- Goose parser (no transcript data to investigate)
- Remote file fetch via arkd (deferred -- completion pipeline handles the local-agent case; remote needs a separate push protocol)

## Architecture

### BurnTranscriptParser interface

```typescript
// packages/core/observability/burn/burn-parser.ts
export interface BurnTranscriptParser {
  readonly kind: string;  // matches runtime.billing.transcript_parser

  parseTranscript(
    transcriptPath: string,
    project: string,
  ): { turns: ClassifiedTurn[]; summary: SessionSummary };
}

export class BurnParserRegistry {
  register(parser: BurnTranscriptParser): void;
  get(kind: string): BurnTranscriptParser | undefined;
  has(kind: string): boolean;
}
```

Registered in `app.ts` at boot:
```
app.burnParsers.register(new ClaudeBurnParser());   // kind: "claude"
app.burnParsers.register(new CodexBurnParser());    // kind: "codex"
app.burnParsers.register(new GeminiBurnParser());   // kind: "gemini"
```

### Completion pipeline integration

Two insertion points where burn data gets recorded alongside cost data:

**Point 1: `session-hooks.ts:226-234`** (Claude hooks with transcript_path)
```
// Existing:
recordSessionUsage(app, session, usage, "anthropic", "transcript");
// Add after:
recordBurnTurns(app, session, transcriptPath, parserKind);
```

**Point 2: `session-orchestration.ts:1030-1058`** (non-Claude runtimes at completion)
```
// Existing:
recordSessionUsage(app, session, result.usage, provider, "transcript");
// Add after:
recordBurnTurns(app, session, transcriptPath, parserKind);
```

`recordBurnTurns` resolves the burn parser from `app.burnParsers.get(parserKind)`, runs classification, and upserts into `burn_turns`. If the burn parser doesn't exist for this kind, it silently skips (no error).

### sync.ts changes

Replace hardcoded `parseClaudeTranscript` call with registry dispatch:

```typescript
// Before:
const { turns } = parseClaudeTranscript(transcriptPath, project);

// After:
const burnParser = app.burnParsers.get(kind);
if (!burnParser) { skipped++; continue; }
const { turns } = burnParser.parseTranscript(transcriptPath, project);
```

### Codex burn parser

Codex uses only `shell` as a tool. Classification needs command-level analysis:

**Tool normalization** (shell commands mapped to Claude-equivalent tool names):
```
apply_patch            -> Edit
cat, head, tail        -> Read  
ls, find               -> Glob
grep, rg               -> Grep
git push/commit/merge  -> Bash (git category)
pytest, npm test       -> Bash (testing category)
npm run build, docker  -> Bash (build category)
everything else        -> Bash
```

**Turn grouping:**
- `turn_context` marks a new turn boundary
- `function_call` entries between turn boundaries belong to that turn
- `token_count` with `last_token_usage` gives per-turn token delta

**Edit detection:** Detect `apply_patch` in shell command arguments
**Retry detection:** Detect `apply_patch -> shell(test) -> apply_patch` sequences

### Gemini burn parser

Gemini has tokens per message but no tool data:

- Group messages into turns (user -> gemini messages)
- Extract tokens from `tokens` field on gemini messages
- Classification: keyword-only from user message text (no tool patterns)
- `has_edits`: always false (can't detect)
- `retries`: always 0
- `tools_json`, `mcp_tools_json`, `bash_cmds_json`: always `[]`

### UI graceful degradation

Panels receiving empty data arrays show a contextual message instead of blank space:

```
Core Tools:    "Tool data not available for [runtime] sessions"
Shell Commands: same
MCP Servers:   same
By Activity 1-shot column: "--" for all categories (already handled)
```

The runtime name is available via `burn_turns.runtime` column. The `burn/summary` response adds a `runtimeCoverage` field:

```typescript
runtimeCoverage: {
  hasToolData: boolean;      // false for Gemini
  hasBashData: boolean;      // false for Gemini
  hasMcpData: boolean;       // false for Codex + Gemini
  hasOneShotData: boolean;   // false for Gemini
}
```

Panels check these flags and show appropriate messages.

## New files

- `packages/core/observability/burn/burn-parser.ts` -- interface + registry
- `packages/core/observability/burn/parsers/claude.ts` -- wraps existing `parseClaudeTranscript`
- `packages/core/observability/burn/parsers/codex.ts` -- Codex parser with tool normalization
- `packages/core/observability/burn/parsers/gemini.ts` -- Gemini keyword-only parser
- `packages/core/observability/burn/__tests__/codex-parser.test.ts`
- `packages/core/observability/burn/__tests__/gemini-parser.test.ts`
- `packages/core/observability/burn/__tests__/fixtures/codex-session.jsonl` -- synthetic Codex fixture
- `packages/core/observability/burn/__tests__/fixtures/gemini-session.jsonl` -- synthetic Gemini fixture

## Modified files

- `packages/core/observability/burn/sync.ts` -- dispatch via BurnParserRegistry
- `packages/core/observability/burn/classifier.ts` -- add Codex tool normalization path
- `packages/core/app.ts` -- register BurnParserRegistry + parsers
- `packages/core/services/session-hooks.ts` -- add recordBurnTurns call
- `packages/core/services/session-orchestration.ts` -- add recordBurnTurns call
- `packages/core/repositories/burn.ts` -- add runtimeCoverage query
- `packages/server/handlers/burn.ts` -- include runtimeCoverage in summary response
- `packages/web/src/components/burn/CoreToolsPanel.tsx` -- graceful degradation
- `packages/web/src/components/burn/ShellCommandsPanel.tsx` -- graceful degradation
- `packages/web/src/components/burn/McpServersPanel.tsx` -- graceful degradation
- `packages/web/src/components/burn/ByActivityPanel.tsx` -- note when 1-shot unavailable

## Implementation order

1. BurnTranscriptParser interface + registry + Claude wrapper
2. Codex parser + fixture + tests
3. Gemini parser + fixture + tests
4. Sync.ts registry dispatch (replaces hardcoded parseClaudeTranscript)
5. Completion pipeline integration (session-hooks + session-orchestration)
6. RuntimeCoverage in burn/summary response + UI degradation
7. Verification -- all runtimes tested end-to-end

## Testing strategy

- Codex parser: fixture with shell(apply_patch), shell(cat), shell(pytest), shell(git commit), token_count events. Assert: categories include coding + testing + git, has_edits detected via apply_patch, tool normalization correct.
- Gemini parser: fixture with user/gemini messages with tokens. Assert: categories keyword-based, has_edits=false, tools_json empty.
- Sync: test with sessions having different runtimes, assert correct parser dispatched.
- Completion pipeline: mock session with transcript_path, verify recordBurnTurns called.
- UI: verify panels show "not available" message when runtimeCoverage flags are false.
