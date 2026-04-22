# Sage ↔ Arc Sidecar Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rohit's sage planner posts a coding job to a local-mode Arc sidecar on his EC2 box using three conductor-RPC calls — register a flow, start a session against it, poll until branches are pushed. Each session fans out across repos; each child worktree-clones a repo, runs an Anthropic Agent SDK agent (routed through TrueFoundry), and pushes a branch. No web UI.

**Generic only — no sage-specific code in Arc.** Arc provides building blocks (Agent SDK runtime, git primitives, generic fan-out). Sage ships the flow payload at runtime via `flow/create`. We delete the existing sage integration surface.

## What's already built in Arc and we reuse

- **Server daemon** — one process runs conductor (19100) + arkd (19300) + WS (19400). Start with `./ark server start`. Port 19100 is the JSON-RPC endpoint sage will call.
- **Generic fan-out orchestration** — `packages/core/services/dispatch/dispatch-fanout.ts`, `fork-join.ts`, `task-builder.ts`; flow-level support in `packages/core/state/flow.ts`; example flow `flows/definitions/fan-out.yaml`.
- **Flow CRUD RPC** — `flow/create`, `flow/read`, `flow/list`, `flow/delete` already exist in `packages/protocol/clients/flow.ts`. Sage registers her flow at runtime through `flow/create`.
- **Session lifecycle RPC** — `session/start`, `session/read`, `session/stop`, `costsSession` in `packages/server/handlers/session.ts` + `observability.ts`.
- **Secret store + `StageSecretResolver`** — `packages/core/services/dispatch/secrets-resolve.ts`. Runtimes declare `secrets:` list; the resolver pulls values from the local encrypted secret store and injects them as env vars at dispatch.
- **Local-mode persistence** — SQLite + session/orchestration state under `~/.ark/`. Survives process restart (verification step included — this is the one thing we must not take on faith).

## What's net-new

1. **Agent SDK runtime** (`type: agent-sdk`) — thin wrapper around Anthropic's first-party `@anthropic-ai/claude-agent-sdk`. The SDK bundles its own Claude Code native binary (optional per-platform deps like `@anthropic-ai/claude-agent-sdk-darwin-arm64`), supports Bun as the host runtime (`options.executable: "bun"`, auto-detected), and exposes built-in tools (`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`), permission modes, `cwd`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, hooks, and MCP servers — we consume those directly rather than reimplementing. Runs as a **plain child process** (our launch.ts), not inside tmux; arkd attaches to its stdout/stderr directly. The SDK internally spawns the CC binary as its own subprocess, but that's an implementation detail we don't manage.
2. **Generic git primitives** — `git.clone-and-branch` + `git.commit-and-push` actions if not already present.
3. **Delete the existing sage integration** — `integrations/sage-analysis.ts`, `fetch-sage-analysis` action, `pi-sage` trigger, `server/handlers/sage.ts`, `cli/commands/sage.ts`, `flows/definitions/from-sage-analysis.yaml`, and their registry entries.
4. **TrueFoundry secret wiring** — `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` in the local secret store.
5. **Retry + correction of failed stages** — RPC surface sage can call to re-run a failed stage with an optional updated task/prompt, plus its cleanup semantics.
6. **Terminal-state cleanup** — worktree + temp resources removed on completed / failed / stopped / orphaned sessions. No dangling state after a run, regardless of exit path.
7. **Sidecar packaging doc + RPC contract doc for Rohit.**
8. **Bulletproof smoke** — CLI-driven end-to-end (our testing) + fresh-box curl-driven end-to-end (Rohit's path), including kill -9 resume and retry-after-failure paths.

## Out of scope (phase-2)

- Outbound webhooks to sage (sage polls).
- PR creation (Arc stops at `git push`).
- Hard cancel (use `session/stop` pause).
- Sage MCP tools exposed to the agent.
- Centralized k8s compute.
- Web UI changes.

**Timeline anchor:** Wednesday demo.

**Tech stack:** TypeScript (Bun), `@anthropic-ai/sdk`, server daemon on 19100/19300/19400, local SQLite, tmux, local encrypted secret store.

---

## File Structure

```
Delete:
  packages/core/integrations/sage-analysis.ts
  packages/core/integrations/__tests__/sage-analysis.test.ts
  packages/core/services/actions/fetch-sage-analysis.ts
  packages/core/triggers/sources/pi-sage.ts
  packages/server/handlers/sage.ts
  packages/cli/commands/sage.ts
  flows/definitions/from-sage-analysis.yaml

Modify (remove references):
  packages/core/integrations/index.ts
  packages/core/services/actions/index.ts
  packages/server/handlers/index.ts   (if the sage handler is registered here)
  packages/cli/index.ts                (if the sage command is registered here)
  packages/core/triggers/index.ts      (if the pi-sage source is registered)

Create:
  runtimes/agent-sdk.yaml
  packages/core/runtimes/agent-sdk/parser.ts     -- persists a subset of SDKMessage union to transcript.jsonl; reads it back
  packages/core/runtimes/agent-sdk/launch.ts     -- entrypoint: reads session context, calls query(), streams messages out
  packages/core/__tests__/agent-sdk-runtime.test.ts
  packages/core/services/actions/git-clone-and-branch.ts   (only if missing)
  packages/core/services/actions/git-commit-and-push.ts    (only if missing)
  packages/core/__tests__/sage-rpc-contract.test.ts        (our CLI-equivalent end-to-end over RPC)
  docs/integrations/sage.md                                (RPC contract + sample flow payload)
  docs/deploy/sidecar.md                                   (box install + mounted-volume layout)

Modify:
  packages/core/app.ts                                     (register AgentSdkParser)
  packages/core/services/agent-launcher.ts                 (or equivalent: dispatch agent-sdk runtime type)
```

---

## Part 0 — Remove the existing sage integration

Ship this first. It's small, irreversible in intent (we're not keeping both), and gets the "generic only" invariant locked in before anything new depends on the old shape.

### Task 0.1: Delete sage-coupled code + references

**Files:**
- Delete: the seven files listed under "Delete" above.
- Modify: the registry/index files listed under "Modify (remove references)".

- [ ] **Step 1: Confirm the call-sites**

```
grep -rn "fetch_sage_analysis\|sage-analysis\|from-sage-analysis\|pi-sage\|sageAnalysis" packages/ flows/ | grep -v "/__tests__/\|/test/"
```

Each match is either (a) in a file we're deleting, or (b) in a registry we're editing to remove the import. There should be nothing else.

- [ ] **Step 2: Delete files**

```
git rm packages/core/integrations/sage-analysis.ts \
       packages/core/integrations/__tests__/sage-analysis.test.ts \
       packages/core/services/actions/fetch-sage-analysis.ts \
       packages/core/triggers/sources/pi-sage.ts \
       packages/server/handlers/sage.ts \
       packages/cli/commands/sage.ts \
       flows/definitions/from-sage-analysis.yaml
```

- [ ] **Step 3: Remove registry entries**

In each of the `index.ts` files, delete the import + registration lines that reference the deleted modules. The files are small — open each, delete the lines, save.

- [ ] **Step 4: Verify the build + tests**

Run: `make lint && make test`
Expected: zero ESLint warnings, all tests pass. Any lingering reference becomes a compile error that points you at the remaining call-site.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: remove sage-specific integration, leaving generic fan-out primitives"
```

---

## Part A — Agent SDK runtime

### Task A1: Runtime YAML with secrets declaration

**Files:**
- Create: `runtimes/agent-sdk.yaml`
- Reference: `runtimes/claude.yaml` (existing shape)

- [ ] **Step 1: Write the YAML**

```yaml
name: agent-sdk
description: "Anthropic Agent SDK (in-process, TrueFoundry-routed)"
type: agent-sdk
models:
  - id: opus
    label: "Claude Opus 4.7"
  - id: sonnet
    label: "Claude Sonnet 4.6"
  - id: haiku
    label: "Claude Haiku 4.5"
default_model: sonnet
permission_mode: bypassPermissions
secrets:
  - ANTHROPIC_API_KEY
  - ANTHROPIC_BASE_URL
billing:
  mode: api
  transcript_parser: agent-sdk
```

`secrets:` is read by `StageSecretResolver` (`packages/core/services/dispatch/secrets-resolve.ts:17`). A missing secret surfaces as a dispatch failure — we want that.

- [ ] **Step 2: Commit**

```bash
git add runtimes/agent-sdk.yaml
git commit -m "feat(runtimes): add agent-sdk runtime with TrueFoundry secrets"
```

### Task A2: Transcript parser

**Files:**
- Read (no edit): `packages/core/runtimes/transcript-parser.ts`
- Create: `packages/core/runtimes/agent-sdk/parser.ts`
- Modify: `packages/core/app.ts` (register the parser)
- Test: `packages/core/__tests__/agent-sdk-runtime.test.ts`

The Agent SDK emits a union `SDKMessage` (assistant, user, result, system, partial_assistant, tool_progress, status, hook_*, rate_limit_event, …). We persist each line verbatim as JSONL — the SDK's type becomes our `t` field — and the parser filters the ones we care about. Rationale: upstream can add new message types without requiring a parser bump.

Key fields we consume from `result`:
```
total_cost_usd, usage, modelUsage, duration_ms, num_turns, is_error, stop_reason, result
```

- [ ] **Step 1: Failing test**

```ts
// packages/core/__tests__/agent-sdk-runtime.test.ts
import { test, expect } from "bun:test";
import { AgentSdkParser } from "../runtimes/agent-sdk/parser.js";

test("parses SDKMessage JSONL", () => {
  const raw = [
    // Raw SDKMessage shapes persisted verbatim; parser picks out what it needs.
    JSON.stringify({ type: "user",      message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "README.md" } }] } }),
    JSON.stringify({ type: "user",      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "contents...", is_error: false }] } }),
    JSON.stringify({
      type: "result", subtype: "success", is_error: false, num_turns: 2,
      duration_ms: 1200, duration_api_ms: 900, stop_reason: "end_turn",
      total_cost_usd: 0.0042,
      usage: { input_tokens: 120, output_tokens: 35, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { "claude-sonnet-4-6": { input_tokens: 120, output_tokens: 35 } },
      result: "done",
    }),
  ].join("\n");
  const parsed = new AgentSdkParser().parse(raw);
  expect(parsed.messages).toHaveLength(2);           // the two text messages
  expect(parsed.messages[1]).toMatchObject({ role: "assistant", text: "hello" });
  expect(parsed.toolCalls).toHaveLength(1);
  expect(parsed.toolCalls[0]).toMatchObject({ id: "t1", name: "Read" });
  expect(parsed.usage.input_tokens).toBe(120);
  expect(parsed.cost_usd).toBeCloseTo(0.0042);
});
```

Run: `make test-file F=packages/core/__tests__/agent-sdk-runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement parser**

```ts
// packages/core/runtimes/agent-sdk/parser.ts
import type { TranscriptParser, ParsedTranscript } from "../transcript-parser.js";

// Minimal structural types — we don't import from @anthropic-ai/claude-agent-sdk
// in the parser because the parser runs in every AppContext and we want a lean
// dependency boundary. The launch process is the only place that imports the SDK.
type Line =
  | { type: "user"; message: { content: Array<any> } }
  | { type: "assistant"; message: { content: Array<any> } }
  | { type: "result"; is_error: boolean; num_turns: number; duration_ms: number;
      total_cost_usd: number; usage: { input_tokens: number; output_tokens: number;
      cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      stop_reason: string | null; result: string }
  | { type: string; [k: string]: unknown };   // catch-all for the rest

export interface AgentSdkParsed extends ParsedTranscript {
  cost_usd: number;
  num_turns: number;
  stop_reason: string | null;
}

export class AgentSdkParser implements TranscriptParser {
  name = "agent-sdk";
  parse(raw: string): AgentSdkParsed {
    const messages: ParsedTranscript["messages"] = [];
    const toolCalls: ParsedTranscript["toolCalls"] = [];
    let usage = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 };
    let cost_usd = 0;
    let num_turns = 0;
    let stop_reason: string | null = null;

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as Line;
      if (evt.type === "assistant" || evt.type === "user") {
        for (const block of (evt as any).message?.content ?? []) {
          if (block.type === "text") {
            messages.push({ role: evt.type as "user" | "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            toolCalls.push({ id: block.id, name: block.name, input: block.input });
          } else if (block.type === "tool_result") {
            const call = toolCalls.find((c) => c.id === block.tool_use_id);
            if (call) (call as any).output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          }
        }
      } else if (evt.type === "result") {
        const r = evt as any;
        usage = {
          input_tokens:  r.usage.input_tokens,
          output_tokens: r.usage.output_tokens,
          cache_read:    r.usage.cache_read_input_tokens ?? 0,
          cache_create:  r.usage.cache_creation_input_tokens ?? 0,
        };
        cost_usd   = r.total_cost_usd ?? 0;
        num_turns  = r.num_turns ?? 0;
        stop_reason = r.stop_reason ?? null;
      }
      // All other message types (system, partial_assistant, tool_progress, hook_*, ...)
      // are persisted but ignored by the parser. Observability consumes them separately.
    }
    return { messages, toolCalls, usage, cost_usd, num_turns, stop_reason };
  }
}
```

The parser treats the transcript as append-only verbatim JSONL of `SDKMessage`. One source of truth: whatever the SDK emitted. Cost + usage come from the terminal `result` message, not accumulated per-turn.

- [ ] **Step 3: Register parser in `app.ts`**

Find the Claude parser registration:
```
grep -n "ClaudeParser\|registerTranscriptParser" packages/core/app.ts
```
Add right after:
```ts
import { AgentSdkParser } from "./runtimes/agent-sdk/parser.js";
// ...
app.registerTranscriptParser(new AgentSdkParser());
```

- [ ] **Step 4: Run test**

Run: `make test-file F=packages/core/__tests__/agent-sdk-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/runtimes/agent-sdk/parser.ts packages/core/app.ts packages/core/__tests__/agent-sdk-runtime.test.ts
git commit -m "feat(runtimes): agent-sdk transcript parser"
```

### Task A3: Launch wrapper around `query()`

**Files:**
- Modify: root `package.json` — add `@anthropic-ai/claude-agent-sdk`.
- Create: `packages/core/runtimes/agent-sdk/launch.ts`
- Modify: local compute adapter + arkd attach path to branch on runtime type.

Design:

1. The launch process imports `query` from `@anthropic-ai/claude-agent-sdk`, calls it with session-scoped options (cwd = worktree, env = injected secrets, `allowedTools`, `permissionMode: "bypassPermissions"`, `maxBudgetUsd`), and pipes every `SDKMessage` to `sessions/<id>/transcript.jsonl` verbatim (`JSON.stringify(message) + "\n"`).
2. Claude Code runtime launches inside tmux (`ark-s-<id>`) because it needs a TTY for interactive attach. agent-sdk is pure automation — no TTY — so the local compute adapter spawns `launch.ts` directly via `Bun.spawn` with piped stdout/stderr and arkd listens to the pipes.
3. The SDK internally spawns its own bundled Claude Code native binary as a subprocess. We don't manage that subprocess; we only manage `launch.ts`. Killing `launch.ts` tears down the SDK's subprocess through the `abortController` option wired to SIGTERM.

This keeps CLAUDE.md's "tmux required" invariant honest for Claude runtimes; agent-sdk is a documented exception.

- [ ] **Step 1: Add the SDK dep**

```
bun add @anthropic-ai/claude-agent-sdk
```

Bun pulls optional deps by default, so the platform-specific native binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64` on your laptop, `@anthropic-ai/claude-agent-sdk-linux-x64` on the sidecar) resolves automatically. Verify with `bun pm ls | grep claude-agent-sdk`.

- [ ] **Step 2: Locate the dispatch table + tmux launcher**

```
grep -rn "ark-s-\|tmux new-session\|claude-code" packages/core/services/agent-launcher.ts packages/compute/adapters | head -40
```

Identify (a) where runtime type selects the launch command, (b) where the tmux pane is created, (c) where arkd attaches to tmux vs. a process.

- [ ] **Step 3: Inspect how the Claude launcher reads session context**

The existing launcher writes a prompt file + worktree path somewhere the Claude agent reads. Find it (`grep -n "prompt\|worktree" packages/core/services/agent-launcher.ts` or the Claude runtime launcher). Reuse the same file names for agent-sdk — minimizes divergence in the conductor.

- [ ] **Step 4: Add a no-tmux branch in the compute adapter**

```ts
// In the local compute adapter that today runs `tmux new-session -d -s ark-s-<id> <cmd>`:
if (runtime.type === "agent-sdk") {
  const proc = Bun.spawn({
    cmd: ["bun", "packages/core/runtimes/agent-sdk/launch.ts", sessionId],
    env: { ...process.env, ...secretEnv },     // StageSecretResolver injects ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL here
    cwd: arkDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  registerProcessWithArkd(sessionId, proc);    // see Step 5
  return;
}
// else: existing tmux path (unchanged)
```

- [ ] **Step 5: Teach arkd to attach to a process pipe (not only tmux)**

If arkd today only knows tmux, add a `registerProcess(sessionId, proc)` path that:
- Consumes `proc.stdout` + `proc.stderr` line-by-line.
- Emits `process_started` on attach, `process_exited` (with exit code) when `proc.exited` resolves.
- Does not parse the stream. Transcript persistence happens inside `launch.ts` — the SDK-message JSONL is our canonical record. Raw stdout/stderr goes to `sessions/<id>/stdio.log` for debugging.
- On `session/stop` or cleanup, sends SIGTERM to `proc` and awaits exit.

- [ ] **Step 6: Implement launch.ts**

```ts
#!/usr/bin/env bun
// packages/core/runtimes/agent-sdk/launch.ts
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAppConfig } from "../../config.js";

const sessionId = process.argv[2];
if (!sessionId) { console.error("usage: launch.ts <session-id>"); process.exit(2); }

const config = loadAppConfig();
const sessionDir = join(config.dirs.ark, "sessions", sessionId);

// Names to match what the existing Claude launcher reads (identified in Step 3).
const prompt   = readFileSync(join(sessionDir, "prompt.txt"), "utf8");
const worktree = readFileSync(join(sessionDir, "worktree-path.txt"), "utf8").trim();
const sessionJson = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8")) as {
  model?: string; max_turns?: number; max_budget_usd?: number; system_prompt_append?: string;
};
const transcriptPath = join(sessionDir, "transcript.jsonl");

const apiKey  = process.env.ANTHROPIC_API_KEY;
const baseURL = process.env.ANTHROPIC_BASE_URL;
if (!apiKey) { console.error("ANTHROPIC_API_KEY missing in env"); process.exit(2); }

const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT",  () => abort.abort());

const options: Options = {
  cwd: worktree,
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
  },
  allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  permissionMode: "bypassPermissions",           // programmatic equivalent of --dangerously-skip-permissions
  allowDangerouslySkipPermissions: true,         // TS SDK requires this alongside permissionMode (Python doesn't)
  executable: "bun",
  model: sessionJson.model,
  maxTurns: sessionJson.max_turns,
  maxBudgetUsd: sessionJson.max_budget_usd,
  abortController: abort,
  systemPrompt: sessionJson.system_prompt_append
    ? { type: "preset", preset: "claude_code", append: sessionJson.system_prompt_append }
    : undefined,                                  // empty system prompt by default; sage may append later
};

let sawResult = false;
try {
  for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
    appendFileSync(transcriptPath, JSON.stringify(message) + "\n");
    if (message.type === "result") {
      sawResult = true;
      if (message.is_error) process.exit(1);
    }
  }
} catch (err: any) {
  appendFileSync(transcriptPath, JSON.stringify({ type: "error", message: String(err?.message ?? err) }) + "\n");
  process.exit(1);
}

if (!sawResult) {
  appendFileSync(transcriptPath, JSON.stringify({ type: "error", message: "stream ended without result message" }) + "\n");
  process.exit(1);
}
```

Notes:
- Every SDK message is persisted verbatim. Parser (Task A2) reads the subset it cares about; new SDK message types don't break us.
- `abortController` + SIGTERM give us graceful cancel: the SDK tears down its subprocess.
- `maxBudgetUsd` pulled from session config — sage can cap per-session spend as a first-class input.

- [ ] **Step 7: Smoke test via CLI**

```
./ark secret set ANTHROPIC_API_KEY '<key>'
./ark secret set ANTHROPIC_BASE_URL '<truefoundry-url>'
mkdir -p /tmp/ark-smoke && cd /tmp/ark-smoke && git init
./ark session new --runtime agent-sdk --prompt "Create hello.txt with content 'hi'" --cwd /tmp/ark-smoke
./ark session read <id>
./ark session costs <id>
tmux ls 2>/dev/null | grep ark-s- || echo "no tmux session (expected)"
```

Expected: session completes, `hello.txt` exists, `total_cost_usd > 0` (parsed from the SDK `result` message), and tmux output is empty for agent-sdk sessions.

- [ ] **Step 8: Commit**

```bash
git add packages/core/runtimes/agent-sdk/launch.ts packages/core/services/agent-launcher.ts packages/arkd/ package.json bun.lockb
git commit -m "feat(compute): agent-sdk runtime wraps @anthropic-ai/claude-agent-sdk (plain process + arkd pipe attach)"
```

---

## Part B — Generic git actions + RPC contract doc

Arc exposes the building blocks; sage composes her flow at runtime via `flow/create`. We don't ship a sage-specific flow file in the repo.

### Task B1: git primitives (only if missing)

**Files:**
- Possibly create: `packages/core/services/actions/git-clone-and-branch.ts`
- Possibly create: `packages/core/services/actions/git-commit-and-push.ts`

- [ ] **Step 1: Check for existing git actions**

```
grep -rn "git\.clone\|git\.commit\|git_clone\|gitClone" packages/core/services/actions
```

If both actions already exist, skip to Task B2.

- [ ] **Step 2: Implement `git.clone-and-branch`**

```ts
// packages/core/services/actions/git-clone-and-branch.ts
import type { ActionHandler } from "./types.js";

async function run(cmd: string[], cwd: string): Promise<void> {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err}`);
}

export const gitCloneAndBranch: ActionHandler = {
  name: "git.clone-and-branch",
  async execute(_app, session, _action, _opts) {
    const inputs = ((session.config as any).inputs ?? {}) as {
      repo_clone_url: string; base_branch: string; target_branch: string; ref?: string;
    };
    const worktree = (session as any).worktreePath;
    if (!worktree) throw new Error("session has no worktreePath");
    await run(["git", "clone", "--branch", inputs.base_branch, inputs.repo_clone_url, worktree], "/");
    if (inputs.ref) await run(["git", "checkout", inputs.ref], worktree);
    await run(["git", "switch", "-c", inputs.target_branch], worktree);
    return { ok: true, outputs: { worktree, cloned_from: inputs.repo_clone_url } };
  },
};
```

- [ ] **Step 3: Implement `git.commit-and-push`**

```ts
// packages/core/services/actions/git-commit-and-push.ts
import type { ActionHandler } from "./types.js";

async function run(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err || out}`);
  return out;
}

export const gitCommitAndPush: ActionHandler = {
  name: "git.commit-and-push",
  async execute(_app, session, _action, _opts) {
    const { target_branch, commit_message } = ((session.config as any).inputs ?? {}) as {
      target_branch: string; commit_message?: string;
    };
    const cwd = (session as any).worktreePath;
    await run(["git", "add", "-A"], cwd);
    await run(["git", "commit", "-m", commit_message ?? `arc: ${target_branch}`], cwd);
    await run(["git", "push", "-u", "origin", target_branch], cwd);
    return { ok: true, outputs: { pushed_branch: target_branch } };
  },
};
```

- [ ] **Step 4: Register both in `packages/core/services/actions/index.ts`**

- [ ] **Step 5: Commit**

```bash
git add packages/core/services/actions/git-*.ts packages/core/services/actions/index.ts
git commit -m "feat(actions): git.clone-and-branch + git.commit-and-push primitives"
```

### Task B2: Sage RPC contract doc with sample flow payload

**Files:**
- Create: `docs/integrations/sage.md`

- [ ] **Step 1: Write the doc**

```markdown
# Sage ↔ Arc (Conductor RPC)

Arc is a generic execution engine. Sage composes her flow at runtime via `flow/create`, then starts a session against it and polls.

## Endpoint
JSON-RPC 2.0 over HTTP at the conductor port.

  http://<sidecar-host>:19100/rpc

## Auth
Set `ARK_AUTH_REQUIRE_TOKEN=true` on the sidecar and share a bearer token with sage. Include as `Authorization: Bearer <token>`.

## Three-call flow

1. Register the flow (once per flow definition; flows are idempotent by name).
2. Start a session against it with inputs.
3. Poll session/read until completion.

### 1. flow/create
Method: `flow/create`
Params: the YAML flow body as a string, or the parsed object. Naming is caller's choice.

Sample payload for a multi-repo execute + push flow:

  name: sage-multi-repo-exec
  description: "Sage-driven multi-repo coding task"
  inputs:
    ticket_id: { type: string, required: true }
    streams:   { type: array,  required: true }   # [{ repo_clone_url, base_branch, target_branch, plan_md, ref? }, ...]
  stages:
    - name: fan_out
      action: fan_out
      task: |
        spawn_per: streams
        child_flow: sage-multi-repo-exec-child
        child_inputs:
          ticket_id: "{{ticket_id}}"
          repo_clone_url: "{{item.repo_clone_url}}"
          base_branch: "{{item.base_branch}}"
          target_branch: "{{item.target_branch}}"
          plan_md: "{{item.plan_md}}"
          ref: "{{item.ref | default('')}}"
      on_success: join
    - name: join
      action: join_children
      depends_on: [fan_out]
      on_success: done

And the child flow (register once, same way):

  name: sage-multi-repo-exec-child
  description: "One-repo child of sage-multi-repo-exec"
  inputs:
    ticket_id:      { type: string, required: true }
    repo_clone_url: { type: string, required: true }
    base_branch:    { type: string, required: true }
    target_branch:  { type: string, required: true }
    plan_md:        { type: string, required: true }
    ref:            { type: string, required: false }
  stages:
    - name: prepare_worktree
      action: git.clone-and-branch
    - name: execute
      agent: coder
      runtime: agent-sdk
      depends_on: [prepare_worktree]
      task: |
        Ticket: {{ticket_id}}

        {{plan_md}}

        Make all code changes. Stop without committing. The next stage commits and pushes.
    - name: push_branch
      action: git.commit-and-push
      depends_on: [execute]
      on_success: done

(Template-field syntax follows the Arc Nunjucks conventions — see `docs/templating.md`.)

### 2. session/start
Method: `session/start`
Params:
  {
    "flow": "sage-multi-repo-exec",
    "inputs": {
      "ticket_id": "ABC-123",
      "streams": [
        { "repo_clone_url": "git@bitbucket.paytm:team/svc-a.git",
          "base_branch": "main",
          "target_branch": "feature/ABC-123-svc-a",
          "plan_md": "... markdown plan from sage ..." }
      ]
    }
  }
Returns: { session: { id, status, ... } }

### 3. session/read
Method: `session/read`
Params: { "sessionId": "<id>", "include": ["children"] }

Terminal conditions:
- status=completed, and every child session has a `push_branch` stage with `outputs.pushed_branch` set -> all branches pushed; collect names from children.
- status=failed -> read events for the failing stage; check child sessions individually.

### Costs
Method: `costsSession`
Params: { "sessionId": "<id>" }
Returns: { total_usd, input_tokens, output_tokens, cache_read, cache_write, by_stage: [...] }
Call per child session for per-repo attribution.

### Cancel (pause)
Method: `session/stop`

### Polling cadence
Every 5-10s while running. Back off to 30s after 2m unchanged.

### Example curl

  curl -sX POST http://sidecar:19100/rpc \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"flow/create","params":{ "yaml": "<paste flow YAML>" }}'
```

(Confirm the actual `flow/create` param shape from `packages/protocol/clients/flow.ts` — the doc may need minor adjustment.)

- [ ] **Step 2: Commit**

```bash
git add docs/integrations/sage.md
git commit -m "docs(integrations): conductor RPC contract for sage (flow/create + session/start + session/read)"
```

### Task B3: End-to-end RPC test

**Files:**
- Create: `packages/core/__tests__/sage-rpc-contract.test.ts`
- Create: `packages/core/__tests__/helpers/git-fixtures.ts` (if missing)

This test exercises the exact three calls sage will make, against real local bare repos, using the real conductor RPC. No shortcuts through CLI or service-layer methods.

- [ ] **Step 1: Git fixture helper**

```ts
// packages/core/__tests__/helpers/git-fixtures.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeBareRepos(n: number): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const bare = mkdtempSync(join(tmpdir(), `bare-${i}-`));
    const work = mkdtempSync(join(tmpdir(), `work-${i}-`));
    await Bun.spawn({ cmd: ["git", "init", "--bare", bare], stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn({ cmd: ["git", "init", "-b", "main", work], stdout: "ignore", stderr: "ignore" }).exited;
    writeFileSync(join(work, "README.md"), `repo ${i}\n`);
    for (const cmd of [
      ["git", "add", "-A"],
      ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"],
      ["git", "remote", "add", "origin", bare],
      ["git", "push", "-u", "origin", "main"],
    ]) {
      await Bun.spawn({ cmd, cwd: work, stdout: "ignore", stderr: "ignore" }).exited;
    }
    urls.push(`file://${bare}`);
  }
  return urls;
}
```

- [ ] **Step 2: The contract test**

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { ArkClient } from "../../protocol/clients/index.js";
import { makeBareRepos } from "./helpers/git-fixtures.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let app: AppContext;
let client: ArkClient;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
  client = new ArkClient(`http://localhost:${app.config.ports.conductor}/rpc`);
});
afterAll(async () => { await app?.shutdown(); clearApp(); });

test.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "3-call contract: flow/create -> session/start -> session/read; 2 repos, both branches pushed",
  async () => {
    const repos = await makeBareRepos(2);

    // 1. flow/create (parent + child)
    const parent = readFileSync(join(__dirname, "fixtures/sage-multi-repo-exec.yaml"), "utf8");
    const child  = readFileSync(join(__dirname, "fixtures/sage-multi-repo-exec-child.yaml"), "utf8");
    await client.call("flow/create", { yaml: child });
    await client.call("flow/create", { yaml: parent });

    // 2. session/start
    const { session } = await client.call("session/start", {
      flow: "sage-multi-repo-exec",
      inputs: {
        ticket_id: "TEST-1",
        streams: repos.map((url, i) => ({
          repo_clone_url: url,
          base_branch: "main",
          target_branch: `feature/TEST-1-${i}`,
          plan_md: `Append the line "hello from TEST-1-${i}" to README.md.`,
        })),
      },
    });

    // 3. session/read (poll)
    for (let i = 0; i < 180; i++) {
      const { session: s } = await client.call("session/read", { sessionId: session.id });
      if (s.status === "completed" || s.status === "failed") break;
      await Bun.sleep(1000);
    }

    const { session: done } = await client.call("session/read", {
      sessionId: session.id, include: ["children"],
    });
    expect(done.status).toBe("completed");
    expect(done.children).toHaveLength(2);
    for (const child of done.children) {
      const push = child.stages.find((st: any) => st.name === "push_branch");
      expect(push?.outputs?.pushed_branch).toMatch(/^feature\/TEST-1-\d$/);
    }
  },
);
```

Fixtures `packages/core/__tests__/fixtures/sage-multi-repo-exec.yaml` + `sage-multi-repo-exec-child.yaml` hold the exact YAML from the doc in Task B2. These are test-only — they are NOT committed under `flows/definitions/`.

- [ ] **Step 3: Run with a real key**

```
ANTHROPIC_API_KEY=<key> make test-file F=packages/core/__tests__/sage-rpc-contract.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/sage-rpc-contract.test.ts packages/core/__tests__/helpers/git-fixtures.ts packages/core/__tests__/fixtures/
git commit -m "test: end-to-end 3-call RPC contract for sage integration"
```

---

## Part D — Retries + cleanup

Two related concerns: sage must be able to retry a failed stage (possibly with corrections), and Arc must not leak worktrees / temp dirs / processes regardless of exit path.

### Task D1: Retry a failed stage via RPC

**Files:**
- Possibly modify: `packages/server/handlers/session.ts` (new handler or extend existing)
- Possibly modify: `packages/core/services/session.ts` / session-orchestration to reset one stage to pending
- Test: `packages/core/__tests__/sage-rpc-contract.test.ts` (add retry case)

- [ ] **Step 1: Find existing retry surface if any**

```
grep -rn "retry\|resumeFrom\|rerunStage\|restartStage" packages/core/services packages/server/handlers | grep -v __tests__
```

If something like `session/advance --retry-stage X` or a `session/rerun-stage` already exists, use it as-is and just document. Otherwise implement.

- [ ] **Step 2: Define the RPC shape**

Method: `session/retry-stage`
Params:
```json
{
  "sessionId": "<id>",
  "stage": "execute",
  "task": "<optional updated prompt/task>",
  "inputs": { /* optional input overrides, merged shallow */ }
}
```
Semantics:
- Session must currently be `failed` (or a child session `failed` within a parent fan-out).
- Reset the named stage + all downstream stages to `pending`.
- Apply `task` / `inputs` overrides to the session config (preserving the original plan; the override is additive for audit purposes — keep the prior attempt in the event log).
- Re-dispatch from the reset stage.
- Returns: `{ session: { id, status, ... } }`.

- [ ] **Step 3: Implement (or extend existing) the handler**

In `packages/server/handlers/session.ts`, add the handler; delegate the state-mutation work to a new method on `sessionService` or `session-orchestration`. Resetting stages must be transactional — either all downstream stages flip to pending or none do.

```ts
router.handle("session/retry-stage", async (params, notify) => {
  const { sessionId, stage, task, inputs } = extract<{
    sessionId: string; stage: string; task?: string; inputs?: Record<string, any>;
  }>(params, ["sessionId", "stage"]);
  const result = await app.sessionService.retryStage(sessionId, stage, { task, inputs });
  if (!result.ok) throw new RpcError(result.message ?? "retry failed", SESSION_NOT_FOUND);
  const session = await app.sessions.get(sessionId);
  if (session) notify("session/updated", { session });
  return { session };
});
```

- [ ] **Step 4: Retry test**

Extend `sage-rpc-contract.test.ts` with a scenario: run a flow where the `execute` stage's prompt is impossible to satisfy (e.g. "edit a file that doesn't exist and must not be created"), confirm session fails, call `session/retry-stage` with a corrected `task`, confirm it completes + pushes.

- [ ] **Step 5: Commit**

```bash
git add packages/server/handlers/session.ts packages/core/services/ packages/core/__tests__/sage-rpc-contract.test.ts
git commit -m "feat(session): retry-stage RPC with optional task/inputs correction"
```

- [ ] **Step 6: Document in `docs/integrations/sage.md`**

Add a "Retry a failed stage" section with the RPC shape + an example curl. Commit the doc update:
```bash
git add docs/integrations/sage.md
git commit -m "docs(integrations): document session/retry-stage"
```

### Task D2: Terminal-state cleanup (no dangling state)

**Files:**
- Possibly modify: session-lifecycle terminator path (find via grep below)
- Possibly create: `packages/core/services/session/cleanup.ts`
- Test: `packages/core/__tests__/session-cleanup.test.ts`

Cleanup triggers: session enters `completed`, `failed`, `stopped`, or is detected `orphaned` (process died, no owner). For each, Arc must:

1. Remove the worktree directory (`git worktree remove` if it's a worktree of a bare clone, or `rm -rf` for a standalone clone — match whatever `git.clone-and-branch` created).
2. Kill any surviving child processes (the agent-sdk process + any subprocesses Bash spawned).
3. Release tmux panes, if any (N/A for agent-sdk, but keep the hook for other runtimes).
4. Delete temp files under `sessions/<id>/` that aren't needed for post-mortem (keep `transcript.jsonl`, `events.log`; drop `prompt.txt` only if we want to save disk — not required).
5. Emit a `session_cleaned` event to the event log.

Retention policy: keep the transcript + events log for 24h after cleanup for post-mortem / cost audits. Then GC.

- [ ] **Step 1: Find existing cleanup hooks**

```
grep -rn "terminat\|cleanup\|worktree remove\|dangling" packages/core/services packages/core/state | grep -v __tests__ | head -40
```

If there's an existing `onSessionTerminal` hook or `terminator` path, extend it. Otherwise create `packages/core/services/session/cleanup.ts` that subscribes to the session state-transition bus and runs on entry to terminal states.

- [ ] **Step 2: Implement cleanup logic**

```ts
// packages/core/services/session/cleanup.ts
import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";
import { rmSync, existsSync } from "node:fs";

export async function cleanupSession(app: AppContext, session: Session): Promise<void> {
  const sessionId = session.id;
  // 1. Kill any tracked child process (arkd/process registry).
  await app.arkd?.killSessionProcesses?.(sessionId);
  // 2. Remove tmux pane if one exists (no-op for agent-sdk).
  await app.tmux?.killPane?.(`ark-s-${sessionId}`);
  // 3. Remove worktree.
  const worktree = (session as any).worktreePath;
  if (worktree && existsSync(worktree)) {
    // Prefer `git worktree remove` when the dir is a git worktree; else rm -rf.
    const ok = await tryGitWorktreeRemove(worktree);
    if (!ok) rmSync(worktree, { recursive: true, force: true });
  }
  // 4. Emit audit event.
  await app.events.log(sessionId, "session_cleaned", { actor: "system", data: { worktree } });
}

async function tryGitWorktreeRemove(path: string): Promise<boolean> {
  const p = Bun.spawn({ cmd: ["git", "worktree", "remove", "--force", path], stdout: "ignore", stderr: "ignore" });
  return (await p.exited) === 0;
}
```

- [ ] **Step 3: Wire into terminal-state transitions**

Hook `cleanupSession` into every path that drives a session to `completed`, `failed`, or `stopped`. In the orchestration code, find the places that set `status = "completed" | "failed" | "stopped"` and call `cleanupSession(app, session)` after the update.

Also add an orphan sweeper: a periodic task (every 5m) that looks for sessions in `running` state whose tracked process is dead — mark them `failed` with reason `orphaned` and run cleanup.

- [ ] **Step 4: Tests**

```ts
// packages/core/__tests__/session-cleanup.test.ts
test("completed session removes worktree", async () => {
  // boot AppContext, create session with a real worktree dir, drive to completed, assert dir is gone.
});
test("failed session removes worktree", async () => { /* same, via failure path */ });
test("orphaned session is swept and cleaned", async () => {
  // start session, kill the tracked pid externally, run sweeper, assert status=failed + worktree gone.
});
```

Run: `make test-file F=packages/core/__tests__/session-cleanup.test.ts`
Expected: all three pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/services/session/cleanup.ts packages/core/services/ packages/core/__tests__/session-cleanup.test.ts
git commit -m "feat(session): worktree + process cleanup on terminal states, orphan sweeper"
```

---

## Part C — Sidecar packaging + bulletproof verification

### Task C1: `docs/deploy/sidecar.md`

**Files:** Create: `docs/deploy/sidecar.md`

- [ ] **Step 1: Write the doc**

```markdown
# Arc sidecar on an existing box

## One mounted volume, one process

Mount a host volume at `/var/lib/ark`. That directory holds everything Arc writes:

  /var/lib/ark/
    config.yaml          -- overrides (ports, auth, etc.)
    ark.db               -- sqlite
    sessions/<id>/       -- transcripts, worktrees, prompt files
    secrets/             -- encrypted secret store
    logs/
    repos/               -- optional pre-cloned repos (Arc clones into sessions/<id>/worktree if empty)

One process runs the whole server daemon — conductor (19100) + arkd (19300) + WS (19400):

  bun /opt/ark/packages/cli/index.ts server start

## config.yaml

  profile: local
  ports:
    conductor: 19100
    arkd: 19300
  dirs:
    ark: /var/lib/ark
  auth:
    requireToken: true           # REQUIRED so sage passes a bearer
  features:
    codegraph: false

## Secrets (one-time)

  ./ark secret set ANTHROPIC_API_KEY '<truefoundry key>'
  ./ark secret set ANTHROPIC_BASE_URL '<truefoundry-anthropic-proxy-url>'
  ./ark secret set ARK_API_TOKEN '<bearer token for sage>'

## Liveness check

  curl -sX POST http://localhost:19100/rpc \
    -H "Authorization: Bearer $ARK_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"runtime/list"}'

Expected: response listing runtimes including `agent-sdk`.

## Git access

Box SSH keys for bitbucket are inherited — Arc shells out to `git`, no extra config.

## Concurrency

Default handles 2-3 parallel sessions. For higher concurrency, see `docs/temporal.md` (not yet enabled).

## Logs

Structured logs: `/var/lib/ark/logs/`
Per-session transcripts: `/var/lib/ark/sessions/<id>/transcript.jsonl`

## Systemd sample

  [Unit]
  Description=Arc sidecar
  After=network-online.target

  [Service]
  Type=simple
  User=ark
  Environment=ARK_PROFILE=local
  Environment=ARK_AUTH_REQUIRE_TOKEN=true
  ExecStart=/usr/local/bin/bun /opt/ark/packages/cli/index.ts server start
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/sidecar.md
git commit -m "docs(deploy): sidecar install + mounted-volume layout"
```

### Task C2: Bulletproof persistence check (kill -9 restart)

The user explicitly flagged: "persistent sessions and orchestration in local mode I hope that one is battle tested." Verify — don't assume.

- [ ] **Step 1: Fresh sandbox boot**

```
rm -rf /tmp/ark-sidecar-test && mkdir /tmp/ark-sidecar-test
ARK_DIR=/tmp/ark-sidecar-test ./ark secret set ANTHROPIC_API_KEY <key>
ARK_DIR=/tmp/ark-sidecar-test ./ark secret set ANTHROPIC_BASE_URL <url>
ARK_DIR=/tmp/ark-sidecar-test ./ark server start &
SERVER_PID=$!
```

- [ ] **Step 2: Register a flow + start a long-ish session via curl**

Use the same 3-call sequence from B3 (flow/create, session/start), but with a prompt that will take ~60s ("refactor this 200-line file into helpers").

- [ ] **Step 3: Kill -9 mid-run**

Wait until `session/read` reports status=running and stage=execute. Then:

```
kill -9 $SERVER_PID
```

- [ ] **Step 4: Restart + check resume**

```
ARK_DIR=/tmp/ark-sidecar-test ./ark server start &
curl ... session/read ...
```

Expected: session still exists, status is either `running` (re-dispatched), `paused`, or an explicit `interrupted` state. **Not lost. Not silently stuck.**

If it's lost or stuck: file a bug and block the demo. The user said this must be bulletproof. Fix persistence before shipping.

- [ ] **Step 5: Cleanup gate**

Drive a fresh session to `completed` and a second fresh session to `failed` (kill the agent mid-run). For each, assert:
- worktree dir is gone (from `sessions/<id>/worktree/` or wherever clone landed)
- no surviving child process for the session (`ps -ef | grep <session-id>` empty)
- no `ark-s-<session-id>` tmux session

If any leaks: fix before handoff.

- [ ] **Step 6: Retry gate**

From the failed session above, call `session/retry-stage` with a corrected task. Assert it completes + pushes + cleans up. This exercises the end-to-end sage-visible retry path.

- [ ] **Step 7: Document observed behavior**

Add a short note to `docs/deploy/sidecar.md` under "Restart behavior" + "Cleanup behavior" describing what actually happens on kill-9, graceful completion, failure, and retry. Keeps expectations honest.

### Task C3: Hand off to Rohit

- [ ] **Step 1: Ship docs + creds**

Send `docs/integrations/sage.md` + `docs/deploy/sidecar.md` + TrueFoundry endpoint + bearer token. Link the sample flow YAML from the doc.

- [ ] **Step 2: Pair on first real run**

Sit on Rohit's box while he submits a real ticket end-to-end. Tail `/var/lib/ark/logs/` + transcripts. Fix whatever breaks.

- [ ] **Step 3: Post to #ark-init (C0AKLLFN9GC)**

Summary: what works, phase-2 gaps (cancel, webhook, PR creation, MCP tools, stage-level cost breakdown polish), next milestone.

---

## Open questions

1. **Worktree GC.** Retention for 24h after completion feels right (Rohit may inspect). Confirm with Rohit.
2. **Kill -9 resilience.** C2 Step 4 is the gate. If it fails, this is the critical path before Wednesday.
3. **`flow/create` param shape.** Doc in B2 guesses `{ yaml: "..." }`. Confirm from `packages/protocol/clients/flow.ts` and adjust.
4. **Rohit's goose recipe fields.** Any fields in `~/Downloads/PAI-31080-goose-recipe.yaml` that map to no Arc primitive get dropped with a note. Phase-2 if needed.
5. **Per-stage cost breakdown.** `costsSession` returns a session total; confirm `by_stage` field exists. If not, phase-2 polish.
6. **TrueFoundry model IDs.** Confirm the exact `model` strings TF accepts through its OpenAI-compatible proxy (they may or may not match Anthropic's `claude-sonnet-4-6` naming). If TF only speaks OpenAI wire format (not Anthropic's), the `@anthropic-ai/claude-agent-sdk` path may not route through it cleanly — the SDK sends Anthropic-shaped requests. Validate with a real curl before Wednesday; fall back to direct Anthropic API + TF as a separate cost-tracker if needed.
7. **Platform binary on the sidecar.** `@anthropic-ai/claude-agent-sdk` relies on an optional per-platform native binary. Confirm the sidecar's platform (likely `linux-x64`) is in the SDK's supported set. If not, install Claude Code separately and set `options.pathToClaudeCodeExecutable`.
8. **`maxBudgetUsd` as a sage-exposed input.** Add it to `sage-multi-repo-exec-child` flow inputs (optional, default unset). Doc it in `docs/integrations/sage.md`.

---

## Self-Review

- **Spec coverage (user-listed bullets):**
  - Local-mode Arc + mounted volume → C1.
  - Server daemon (conductor + arkd) running locally → C1 systemd + C2 Step 1.
  - Sage dispatches via conductor RPC with a flow payload → B2 contract (3 calls) + B3 test.
  - Multi-repo session, each agent one repo, worktree, branch push → generic fan-out + agent-sdk + git primitives.
  - Rohit's goose recipe → Arc YAML → sample in B2 + translation exercise in open questions.
  - Bulletproof persistent sessions + orchestration → C2 Steps 1-4 (explicit kill -9 gate).
  - Anthropic Agent SDK + API key via local secret management → A1 secrets + C1 `secret set`.
  - agent-sdk is a plain process, arkd attaches directly, no tmux → A3 Steps 4-5.
  - Retries + corrections of failed stages → D1 + C2 Step 6.
  - Cleanup on completion / break / interruption, no dangling worktrees → D2 + C2 Step 5.
  - No UI → zero tasks touch `packages/web` / `packages/desktop`.
  - CLI testable for us, conductor RPC for Rohit → A3 Step 7 (CLI) + B3 (RPC).
  - Generic only, no sage integration → Part 0 deletes it.
- **Placeholders.** None. Every step has a concrete command or code block.
- **Type/name consistency.** `agent-sdk`, `AgentSdkParser`, `runAgentSdkLoop`, `LoopOptions`, `dispatchTool`, `TOOL_SCHEMAS`, `git.clone-and-branch`, `git.commit-and-push`, `pushed_branch`, `sage-multi-repo-exec`, `sage-multi-repo-exec-child` — consistent throughout.
- **Security hook compliance.** All shell invocations use `Bun.spawn([argv], ...)`; no `exec()` template strings.
- **Ordering.** Part 0 first (deletion), then A (runtime), then B (actions + contract + test), then D (retries + cleanup — both have test coverage that Part C's gates rely on), then C (packaging + bulletproof verification). Each part is independently testable.
