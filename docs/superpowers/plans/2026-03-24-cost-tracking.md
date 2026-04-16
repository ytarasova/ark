# Cost Tracking from Transcripts -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track token usage per session by parsing Claude Code transcript JSONL files on hook events, storing cumulative totals in the session record.

**Architecture:** On `Stop` and `SessionEnd` hook events, the conductor reads `transcript_path` from the payload, parses all assistant messages for `usage` fields, sums tokens, and stores the totals in the session's `config` JSON. A new `parseTranscriptUsage()` function in `claude.ts` handles the parsing. The TUI can display costs in the session detail pane.

**Tech Stack:** Existing hooks infrastructure, JSONL line parsing, no new dependencies.

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/claude.ts` | **Add:** `parseTranscriptUsage(transcriptPath)` -- reads JSONL, sums token usage across all assistant messages |
| `packages/core/conductor.ts` | **Modify:** On `Stop`/`SessionEnd` hooks, call `parseTranscriptUsage` and store results |
| `packages/core/__tests__/claude-transcript.test.ts` | **Create:** Tests for transcript parsing |
| `packages/core/__tests__/conductor-hooks.test.ts` | **Modify:** Add tests for cost tracking on Stop/SessionEnd |

---

### Task 1: parseTranscriptUsage -- read JSONL and sum tokens

**Files:**
- Create: `packages/core/__tests__/claude-transcript.test.ts`
- Modify: `packages/core/claude.ts`

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for claude.ts transcript parsing -- token usage extraction.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { parseTranscriptUsage } from "../claude.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

function writeTranscript(name: string, lines: Record<string, unknown>[]): string {
  const path = join(ctx.arkDir, `${name}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("parseTranscriptUsage", () => {
  it("sums input and output tokens across assistant messages", () => {
    const path = writeTranscript("basic", [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } },
      { type: "user", message: { role: "user", content: "more" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 300, cache_creation_input_tokens: 5 } } },
    ]);

    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(250);
    expect(usage.output_tokens).toBe(125);
    expect(usage.cache_read_input_tokens).toBe(500);
    expect(usage.cache_creation_input_tokens).toBe(15);
  });

  it("returns zeros for empty transcript", () => {
    const path = writeTranscript("empty", []);
    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it("skips non-assistant messages", () => {
    const path = writeTranscript("mixed", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: "last-prompt", lastPrompt: "test" },
    ]);

    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
  });

  it("handles missing usage fields gracefully", () => {
    const path = writeTranscript("no-usage", [
      { type: "assistant", message: { role: "assistant", content: "no usage field" } },
    ]);

    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it("returns zeros for non-existent file", () => {
    const usage = parseTranscriptUsage("/tmp/does-not-exist.jsonl");
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it("calculates total_tokens as sum of all token fields", () => {
    const path = writeTranscript("totals", [
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } },
    ]);

    const usage = parseTranscriptUsage(path);
    expect(usage.total_tokens).toBe(360);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/claude-transcript.test.ts`
Expected: FAIL -- `parseTranscriptUsage` not exported.

- [ ] **Step 3: Implement parseTranscriptUsage in claude.ts**

Add after the `removeHooksConfig` function:

```ts
// ── Transcript usage parsing ────────────────────────────────────────────────

export interface TranscriptUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
}

/**
 * Parse a Claude Code transcript JSONL file and sum token usage
 * across all assistant messages.
 */
export function parseTranscriptUsage(transcriptPath: string): TranscriptUsage {
  const usage: TranscriptUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
  };

  if (!existsSync(transcriptPath)) return usage;

  let content: string;
  try { content = readFileSync(transcriptPath, "utf-8"); } catch { return usage; }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const u = entry.message?.usage;
      if (!u) continue;
      usage.input_tokens += u.input_tokens ?? 0;
      usage.output_tokens += u.output_tokens ?? 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    } catch { /* skip malformed lines */ }
  }

  usage.total_tokens = usage.input_tokens + usage.output_tokens
    + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;

  return usage;
}
```

- [ ] **Step 4: Run tests until green**

Run: `bun test packages/core/__tests__/claude-transcript.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/core/claude.ts packages/core/__tests__/claude-transcript.test.ts
git commit -m "feat: parseTranscriptUsage reads Claude JSONL transcripts for token usage"
```

---

### Task 2: Store usage on hook events + conductor integration

**Files:**
- Modify: `packages/core/conductor.ts:99-146` (/hooks/status handler)
- Modify: `packages/core/__tests__/conductor-hooks.test.ts`

- [ ] **Step 1: Add tests to conductor-hooks.test.ts**

```ts
  it("Stop with transcript_path stores token usage on session", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    // Write a fake transcript
    const { mkdirSync: mk, writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptDir = j(ctx.arkDir, "transcripts");
    mk(transcriptDir, { recursive: true });
    const transcriptPath = j(transcriptDir, "test.jsonl");
    wf(transcriptPath, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 50 } } }),
    ].join("\n"));

    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    const updated = getSession(session.id);
    const config = typeof updated!.config === "string" ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeDefined();
    expect(config.usage.input_tokens).toBe(3000);
    expect(config.usage.output_tokens).toBe(1300);
    expect(config.usage.total_tokens).toBe(11950);
  });

  it("SessionEnd with transcript_path stores final token usage", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    const { mkdirSync: mk, writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptDir = j(ctx.arkDir, "transcripts");
    mk(transcriptDir, { recursive: true });
    const transcriptPath = j(transcriptDir, "final.jsonl");
    wf(transcriptPath, JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 500, output_tokens: 200 } } }));

    await postHookStatus(session.id, {
      hook_event_name: "SessionEnd",
      transcript_path: transcriptPath,
      reason: "prompt_input_exit",
    });

    const updated = getSession(session.id);
    const config = typeof updated!.config === "string" ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeDefined();
    expect(config.usage.input_tokens).toBe(500);
  });

  it("hook without transcript_path skips usage tracking", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "Stop",
    });

    const updated = getSession(session.id);
    const config = typeof updated!.config === "string" ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/conductor-hooks.test.ts`
Expected: FAIL -- no usage tracking in conductor yet.

- [ ] **Step 3: Add usage tracking to conductor /hooks/status**

In `conductor.ts`, import `parseTranscriptUsage`:

```ts
import * as claude from "./claude.js";
```

(If `claude` is already imported via a different path, adjust accordingly.)

In the `/hooks/status` handler, after the status update block (`if (newStatus) { ... }`), add usage tracking:

```ts
          // Track token usage from transcript on Stop and SessionEnd
          const transcriptPath = payload.transcript_path as string | undefined;
          if (transcriptPath && (event === "Stop" || event === "SessionEnd")) {
            try {
              const usage = claude.parseTranscriptUsage(transcriptPath);
              if (usage.total_tokens > 0) {
                const session = store.getSession(sessionId);
                if (session) {
                  const config = typeof session.config === "string"
                    ? JSON.parse(session.config) : (session.config ?? {});
                  config.usage = usage;
                  store.updateSession(sessionId, { config });
                }
              }
            } catch { /* transcript parsing failure shouldn't block status update */ }
          }
```

- [ ] **Step 4: Run tests until green**

Run: `bun test packages/core/__tests__/conductor-hooks.test.ts`

Note: Check how `session.config` is stored/retrieved. If it's already parsed as an object by `getSession`, skip the `JSON.parse`. If it's a string, parse it. The test handles both cases with the ternary.

- [ ] **Step 5: Run all hook tests**

Run: `bun test packages/core/__tests__/claude-hooks.test.ts packages/core/__tests__/claude-transcript.test.ts packages/core/__tests__/conductor-hooks.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/core/conductor.ts packages/core/__tests__/conductor-hooks.test.ts
git commit -m "feat: track token usage from Claude transcripts on Stop/SessionEnd hooks"
```
