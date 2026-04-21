# Agent Client Protocol (ACP) runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `agent-acp` runtime type to Ark that speaks the Agent Client Protocol, and upgrade the chat UI to render ACP-native events (streaming messages, thoughts, plans, tool calls, permission prompts).

**Architecture:** ACP agent runs as a subprocess inside arkd (local or remote, uniform code path). A new `packages/core/agent-acp/` module holds protocol types + codec + mappers. A new executor (`packages/core/executors/agent-acp.ts`) speaks HTTP to arkd's new `/agent-acp/*` endpoints. arkd answers host-side ACP methods locally (`fs/*`, `terminal/*`, permission) and forwards `session/update` notifications as channel reports into the conductor's existing `/api/channel/<sid>` endpoint. UI layer extends `event-builder.tsx` with `agent_acp_*` dispatch and ships streaming-aware components.

**Tech Stack:** TypeScript (strict: false), Bun, `bun:test`, `bun:sqlite` + PostgreSQL, `Bun.spawn` (stdio pipes), React + TanStack Query, SSE, tmux is NOT used for ACP sessions.

**Spec reference:** `docs/superpowers/specs/2026-04-21-agent-acp-runtime-design.md`

**Commits per task:** every task ends with a commit. Follow the repo's commit-message style (`feat(agent-acp): ...`, `fix(agent-acp): ...`, etc.). Every commit must pass `make format && make lint`.

**Local dev note:** SQLite schema is authoritative in `packages/core/repositories/schema.ts`. After landing Task 7, delete `~/.ark/ark.db` before running tests or the dev server locally (see CLAUDE.md gotcha).

---

## Phase 1 -- Protocol foundation (core, no infra)

### Task 1: Scaffold `packages/core/agent-acp/` with type definitions

**Files:**
- Create: `packages/core/agent-acp/types.ts`

- [ ] **Step 1: Create the types file.**

```ts
// packages/core/agent-acp/types.ts
/**
 * JSON-RPC 2.0 envelopes + ACP method and notification param shapes.
 * Hand-typed from the Agent Client Protocol spec
 * (https://agentclientprotocol.com). Keep this file free of runtime logic --
 * pure types only so importers can use `import type`.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// -- ACP content blocks --

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

// -- initialize --

export interface InitializeParams {
  protocolVersion: string;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: Record<string, boolean>;
  };
  availableCommands?: AcpSlashCommand[];
}

export interface AcpSlashCommand {
  name: string;
  description?: string;
  parameters?: unknown;
}

// -- session lifecycle --

export interface SessionNewParams {
  workingDirectory: string;
  mcpServers?: AcpMcpServer[];
  _meta?: Record<string, unknown>;
}

export type AcpMcpServer =
  | { name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: "http"; url: string; headers?: Record<string, string> };

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionLoadParams {
  sessionId: string;
  workingDirectory: string;
  mcpServers?: AcpMcpServer[];
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export interface SessionPromptResult {
  stopReason: AcpStopReason;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface SessionCancelParams {
  sessionId: string;
}

// -- session/update (agent -> client notification) --

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "plan"; entries: AcpPlanEntry[] }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; kind?: string; status: AcpToolStatus; content?: AcpContentBlock[]; locations?: AcpLocation[] }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status?: AcpToolStatus; content?: AcpContentBlock[]; locations?: AcpLocation[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AcpSlashCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface AcpPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpLocation {
  path: string;
  line?: number;
}

export interface SessionUpdateNotifParams {
  sessionId: string;
  update: SessionUpdate;
}

// -- host-side methods (agent -> client) --

export interface FsReadTextFileParams {
  path: string;
  line?: number;
  limit?: number;
}
export interface FsReadTextFileResult {
  content: string;
}

export interface FsWriteTextFileParams {
  path: string;
  content: string;
}
export type FsWriteTextFileResult = null;

export interface TerminalCreateParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalOutputParams {
  terminalId: string;
  truncateLineCount?: number;
}
export interface TerminalOutputResult {
  output: string;
  exitStatus?: { exitCode: number | null; signal: string | null };
}

export interface TerminalWaitParams {
  terminalId: string;
}
export interface TerminalWaitResult {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalKillParams {
  terminalId: string;
}
export type TerminalKillResult = null;

export interface TerminalReleaseParams {
  terminalId: string;
}
export type TerminalReleaseResult = null;

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; kind?: string };
  options: Array<{ optionId: string; label: string; kind?: "allow_once" | "allow_always" | "deny" }>;
}
export interface PermissionRequestResult {
  outcome: { kind: "selected"; optionId: string } | { kind: "cancelled" };
}

// -- Ark internal event shapes (what arkd POSTs as channel reports) --

export type ArkAcpEventType =
  | "agent_acp_ready"
  | "agent_acp_message_chunk"
  | "agent_acp_thought_chunk"
  | "agent_acp_plan"
  | "agent_acp_tool_call"
  | "agent_acp_tool_call_update"
  | "agent_acp_mode_change"
  | "agent_acp_permission_request"
  | "agent_acp_permission_resolved"
  | "agent_acp_turn_completed"
  | "agent_acp_agent_exited"
  | "agent_acp_fs_write"
  | "agent_acp_protocol_violation"
  | "agent_acp_resume_fallback"
  | "agent_acp_frame";

export type ArkAcpStopReason = AcpStopReason | "timeout" | "interrupted";
```

- [ ] **Step 2: Smoke-compile.**

Run: `bun run tsc --noEmit packages/core/agent-acp/types.ts`
Expected: exits 0.

- [ ] **Step 3: Commit.**

```bash
git add packages/core/agent-acp/types.ts
git commit -m "feat(agent-acp): scaffold protocol type definitions"
```

---

### Task 2: JSON-RPC codec with framing tests

**Files:**
- Create: `packages/core/agent-acp/codec.ts`
- Create: `packages/core/agent-acp/__tests__/codec.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
// packages/core/agent-acp/__tests__/codec.test.ts
import { describe, test, expect } from "bun:test";
import { LineDelimitedDecoder, encodeFrame, nextId } from "../codec.js";
import type { JsonRpcFrame } from "../types.js";

describe("encodeFrame", () => {
  test("appends newline + JSON", () => {
    const bytes = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    const s = new TextDecoder().decode(bytes);
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s.trimEnd())).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });
});

describe("nextId", () => {
  test("monotonic per instance", () => {
    const gen = nextId();
    expect(gen()).toBe(1);
    expect(gen()).toBe(2);
    expect(gen()).toBe(3);
  });
});

describe("LineDelimitedDecoder", () => {
  test("yields one frame per newline", () => {
    const dec = new LineDelimitedDecoder();
    const frames: JsonRpcFrame[] = [];
    dec.push(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":null}\n'), f => frames.push(f));
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  test("buffers partial frames across pushes", () => {
    const dec = new LineDelimitedDecoder();
    const frames: JsonRpcFrame[] = [];
    dec.push(new TextEncoder().encode('{"jsonrpc":"2.0"'), f => frames.push(f));
    dec.push(new TextEncoder().encode(',"id":2,"result":null}\n'), f => frames.push(f));
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual({ jsonrpc: "2.0", id: 2, result: null });
  });

  test("yields multiple frames in one chunk", () => {
    const dec = new LineDelimitedDecoder();
    const frames: JsonRpcFrame[] = [];
    dec.push(
      new TextEncoder().encode(
        '{"jsonrpc":"2.0","id":1,"result":null}\n{"jsonrpc":"2.0","method":"x"}\n',
      ),
      f => frames.push(f),
    );
    expect(frames.length).toBe(2);
  });

  test("drops and logs malformed frames without throwing", () => {
    const dec = new LineDelimitedDecoder();
    const frames: JsonRpcFrame[] = [];
    const errors: string[] = [];
    dec.onError = (e) => errors.push(String(e));
    dec.push(new TextEncoder().encode("not json\n"), f => frames.push(f));
    expect(frames.length).toBe(0);
    expect(errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/core/agent-acp/__tests__/codec.test.ts`
Expected: FAIL (`Cannot find module "../codec.js"`).

- [ ] **Step 3: Implement codec.**

```ts
// packages/core/agent-acp/codec.ts
import type { JsonRpcFrame } from "./types.js";

export function encodeFrame(frame: JsonRpcFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame) + "\n");
}

export function nextId(): () => number {
  let n = 0;
  return () => ++n;
}

export class LineDelimitedDecoder {
  private buf = "";
  /** Called with the raw decoder error when a frame fails to parse. */
  onError: (err: unknown) => void = () => {};

  push(chunk: Uint8Array, onFrame: (frame: JsonRpcFrame) => void): void {
    this.buf += new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line));
      } catch (e) {
        this.onError(e);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/core/agent-acp/__tests__/codec.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/core/agent-acp/codec.ts packages/core/agent-acp/__tests__/codec.test.ts
git commit -m "feat(agent-acp): line-delimited JSON-RPC codec"
```

---

### Task 3: ACP `session/update` -> Ark event mapper

**Files:**
- Create: `packages/core/agent-acp/updates.ts`
- Create: `packages/core/agent-acp/__tests__/updates.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
// packages/core/agent-acp/__tests__/updates.test.ts
import { describe, test, expect } from "bun:test";
import { mapAcpUpdateToArkEvent } from "../updates.js";

describe("mapAcpUpdateToArkEvent", () => {
  test("agent_message_chunk -> agent_acp_message_chunk", () => {
    const ev = mapAcpUpdateToArkEvent("turn-42", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect(ev).toEqual({
      type: "agent_acp_message_chunk",
      data: { turn_id: "turn-42", role: "assistant", block: { type: "text", text: "hello" } },
    });
  });

  test("agent_thought_chunk -> agent_acp_thought_chunk", () => {
    const ev = mapAcpUpdateToArkEvent("turn-42", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    });
    expect(ev.type).toBe("agent_acp_thought_chunk");
    expect((ev.data as any).turn_id).toBe("turn-42");
  });

  test("plan -> agent_acp_plan", () => {
    const ev = mapAcpUpdateToArkEvent("turn-1", {
      sessionUpdate: "plan",
      entries: [{ content: "step 1", priority: "high", status: "pending" }],
    });
    expect(ev.type).toBe("agent_acp_plan");
    expect((ev.data as any).entries.length).toBe(1);
  });

  test("tool_call -> agent_acp_tool_call", () => {
    const ev = mapAcpUpdateToArkEvent("t1", {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "read config",
      kind: "read",
      status: "pending",
    });
    expect(ev.type).toBe("agent_acp_tool_call");
    expect((ev.data as any).tool_call_id).toBe("tc-1");
    expect((ev.data as any).status).toBe("pending");
  });

  test("tool_call_update -> agent_acp_tool_call_update with patch subset", () => {
    const ev = mapAcpUpdateToArkEvent("t1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
    });
    expect(ev.type).toBe("agent_acp_tool_call_update");
    expect((ev.data as any).status).toBe("completed");
  });

  test("current_mode_update -> agent_acp_mode_change", () => {
    const ev = mapAcpUpdateToArkEvent("t", {
      sessionUpdate: "current_mode_update",
      currentModeId: "thorough",
    });
    expect(ev.type).toBe("agent_acp_mode_change");
    expect((ev.data as any).current).toBe("thorough");
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/core/agent-acp/__tests__/updates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement mapper.**

```ts
// packages/core/agent-acp/updates.ts
import type { SessionUpdate, ArkAcpEventType } from "./types.js";

export interface ArkEvent {
  type: ArkAcpEventType;
  data: Record<string, unknown>;
}

export function mapAcpUpdateToArkEvent(turnId: string, update: SessionUpdate): ArkEvent {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        type: "agent_acp_message_chunk",
        data: { turn_id: turnId, role: "assistant", block: update.content },
      };
    case "agent_thought_chunk":
      return {
        type: "agent_acp_thought_chunk",
        data: { turn_id: turnId, block: update.content },
      };
    case "plan":
      return {
        type: "agent_acp_plan",
        data: { turn_id: turnId, entries: update.entries },
      };
    case "tool_call":
      return {
        type: "agent_acp_tool_call",
        data: {
          turn_id: turnId,
          tool_call_id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? null,
          status: update.status,
          content: update.content ?? [],
          locations: update.locations ?? [],
        },
      };
    case "tool_call_update":
      return {
        type: "agent_acp_tool_call_update",
        data: {
          turn_id: turnId,
          tool_call_id: update.toolCallId,
          status: update.status ?? null,
          content: update.content ?? null,
          locations: update.locations ?? null,
        },
      };
    case "available_commands_update":
      return {
        type: "agent_acp_mode_change",
        data: { turn_id: turnId, available_commands: update.availableCommands },
      };
    case "current_mode_update":
      return {
        type: "agent_acp_mode_change",
        data: { turn_id: turnId, current: update.currentModeId },
      };
    default: {
      const _exhaustive: never = update;
      throw new Error("Unknown session/update variant: " + JSON.stringify(_exhaustive));
    }
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/core/agent-acp/__tests__/updates.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/core/agent-acp/updates.ts packages/core/agent-acp/__tests__/updates.test.ts
git commit -m "feat(agent-acp): session/update -> Ark event mapper"
```

---

### Task 4: MCP entries -> ACP `mcpServers` adapter

**Files:**
- Create: `packages/core/agent-acp/mcp-adapter.ts`
- Create: `packages/core/agent-acp/__tests__/mcp-adapter.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
// packages/core/agent-acp/__tests__/mcp-adapter.test.ts
import { describe, test, expect } from "bun:test";
import { toAcpMcpServers } from "../mcp-adapter.js";

describe("toAcpMcpServers", () => {
  test("stdio entry -> command/args/env shape", () => {
    const result = toAcpMcpServers([
      { name: "fs", command: "mcp-fs", args: ["--root", "/tmp"], env: { DEBUG: "1" } },
    ]);
    expect(result).toEqual([
      { name: "fs", command: "mcp-fs", args: ["--root", "/tmp"], env: { DEBUG: "1" } },
    ]);
  });

  test("url entry -> http type", () => {
    const result = toAcpMcpServers([
      { name: "github", type: "url", url: "https://mcp.github.com", headers: { Authorization: "Bearer x" } },
    ]);
    expect(result).toEqual([
      { name: "github", type: "http", url: "https://mcp.github.com", headers: { Authorization: "Bearer x" } },
    ]);
  });

  test("string reference entry skipped with warning", () => {
    const warnings: string[] = [];
    const result = toAcpMcpServers(["github"], (w) => warnings.push(w));
    expect(result).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  test("empty input -> empty array", () => {
    expect(toAcpMcpServers([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/core/agent-acp/__tests__/mcp-adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement adapter.**

```ts
// packages/core/agent-acp/mcp-adapter.ts
import type { AcpMcpServer } from "./types.js";

type McpEntry = string | Record<string, unknown>;

/**
 * Convert an aggregated MCP entry list (from `collectMcpEntries`) into
 * ACP's `mcpServers` params shape. String references (e.g. `"github"`)
 * should have already been resolved into inline objects by the caller --
 * any remaining strings are dropped with a warning because arkd has no
 * access to the filesystem config the string would point to.
 */
export function toAcpMcpServers(
  entries: McpEntry[],
  warn: (msg: string) => void = () => {},
): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      warn("toAcpMcpServers: unresolved string reference '" + entry + "' skipped");
      continue;
    }
    // entry is Record<string, unknown>; ACP server objects live under their name key
    // in our internal format: { name: { command, args, env } } or { name: { type: "url", url, headers } }
    // (see RuntimeDefinition.mcp_servers JSDoc). Flatten them.
    for (const [name, raw] of Object.entries(entry)) {
      if (!raw || typeof raw !== "object") continue;
      const cfg = raw as Record<string, unknown>;
      if (cfg.type === "url" && typeof cfg.url === "string") {
        out.push({
          name,
          type: "http",
          url: cfg.url,
          headers: (cfg.headers as Record<string, string>) ?? {},
        });
      } else if (typeof cfg.command === "string") {
        out.push({
          name,
          command: cfg.command,
          args: (cfg.args as string[]) ?? [],
          env: (cfg.env as Record<string, string>) ?? {},
        });
      } else {
        warn("toAcpMcpServers: entry '" + name + "' skipped (unrecognized shape)");
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Update tests to match the `{ name: {...} }` wrapper structure.**

Review the test cases: the adapter unwraps the name key. Update tests to wrap entries:

```ts
test("stdio entry -> command/args/env shape", () => {
  const result = toAcpMcpServers([
    { fs: { command: "mcp-fs", args: ["--root", "/tmp"], env: { DEBUG: "1" } } },
  ]);
  expect(result).toEqual([
    { name: "fs", command: "mcp-fs", args: ["--root", "/tmp"], env: { DEBUG: "1" } },
  ]);
});

test("url entry -> http type", () => {
  const result = toAcpMcpServers([
    { github: { type: "url", url: "https://mcp.github.com", headers: { Authorization: "Bearer x" } } },
  ]);
  expect(result).toEqual([
    { name: "github", type: "http", url: "https://mcp.github.com", headers: { Authorization: "Bearer x" } },
  ]);
});
```

- [ ] **Step 5: Run tests, expect pass.**

Run: `make test-file F=packages/core/agent-acp/__tests__/mcp-adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Lint + commit.**

```bash
make format
make lint
git add packages/core/agent-acp/mcp-adapter.ts packages/core/agent-acp/__tests__/mcp-adapter.test.ts
git commit -m "feat(agent-acp): MCP entries -> ACP mcpServers adapter"
```

---

## Phase 2 -- Runtime type + YAML samples

### Task 5: Extend `RuntimeDefinition` with `agent-acp` type

**Files:**
- Modify: `packages/types/agent.ts`

- [ ] **Step 1: Add type + block.**

Insert into the `RuntimeDefinition` interface in `packages/types/agent.ts` after the `billing?` line:

```ts
  /**
   * Configuration specific to type === "agent-acp". Ignored otherwise.
   * See docs/superpowers/specs/2026-04-21-agent-acp-runtime-design.md §7.
   */
  agent_acp?: {
    command: string[];
    acp_flags?: string[];
    grant_all_permissions?: boolean;
    host_capabilities?: {
      fs?: { read_text_file?: boolean; write_text_file?: boolean };
      terminal?: boolean;
    };
    protocol_version?: string;
    max_terminals_per_session?: number;
    inactivity_timeout_seconds?: number;
    pre_first_update_timeout_seconds?: number;
    model_delivery?: "cli_flag" | "env" | "meta";
    model_cli_flag?: string[];
    model_env?: string;
    model_meta_key?: string;
  };
```

Update the `type` union:

```ts
  type: "claude-code" | "cli-agent" | "subprocess" | "goose" | "agent-acp";
```

- [ ] **Step 2: Smoke-compile.**

Run: `bun run tsc --noEmit packages/types/agent.ts`
Expected: exits 0.

- [ ] **Step 3: Commit.**

```bash
make format
make lint
git add packages/types/agent.ts
git commit -m "feat(agent-acp): extend RuntimeDefinition with agent_acp block"
```

---

### Task 6: Ship reference runtime YAMLs

**Files:**
- Create: `runtimes/gemini-acp.yaml`
- Create: `runtimes/zed-acp.yaml`

- [ ] **Step 1: Write `gemini-acp.yaml`.**

```yaml
# runtimes/gemini-acp.yaml
name: gemini-acp
description: "Gemini CLI via Agent Client Protocol"
type: agent-acp
agent_acp:
  command: ["gemini"]
  acp_flags: ["--experimental-acp"]
  model_delivery: cli_flag
  model_cli_flag: ["-m", "{model}"]
  grant_all_permissions: true
  host_capabilities:
    fs: { read_text_file: true, write_text_file: true }
    terminal: true
models:
  - id: gemini-2.5-pro
    label: "Gemini 2.5 Pro"
  - id: gemini-2.5-flash
    label: "Gemini 2.5 Flash"
default_model: gemini-2.5-pro
billing:
  mode: api
  transcript_parser: gemini
```

- [ ] **Step 2: Write `zed-acp.yaml`.**

```yaml
# runtimes/zed-acp.yaml
name: zed-acp
description: "Any Zed-compatible ACP agent (user-configurable)"
type: agent-acp
agent_acp:
  command: ["${ACP_AGENT_CMD}"]
  model_delivery: meta
  model_meta_key: "model"
  grant_all_permissions: false
  host_capabilities:
    fs: { read_text_file: true, write_text_file: true }
    terminal: true
models:
  - id: "${ACP_DEFAULT_MODEL_ID}"
    label: "Configured model"
default_model: "${ACP_DEFAULT_MODEL_ID}"
billing:
  mode: api
```

- [ ] **Step 3: Verify YAML loads via existing runtime store.**

Run: `bun -e "import('./packages/core/stores/runtime-store.js').then(m => { const s = new m.RuntimeStore({ arkDir: '/tmp/ark-test', projectDir: process.cwd() }); console.log(s.list().filter(r => r.type === 'agent-acp').map(r => r.name)); })"`
Expected: prints `[ "gemini-acp", "zed-acp" ]` (order may vary).

- [ ] **Step 4: Commit.**

```bash
git add runtimes/gemini-acp.yaml runtimes/zed-acp.yaml
git commit -m "feat(agent-acp): add gemini-acp and zed-acp runtime YAMLs"
```

---

## Phase 3 -- Database schema

### Task 7: Extend SQLite schema + session column whitelist + messages repo

**Files:**
- Modify: `packages/core/repositories/schema.ts`
- Modify: `packages/core/repositories/session.ts`
- Modify: `packages/core/repositories/message.ts`

- [ ] **Step 1: Add columns to the `sessions` CREATE TABLE.**

In `packages/core/repositories/schema.ts`, locate the `CREATE TABLE IF NOT EXISTS sessions` statement and add before the closing `)`:

```sql
        ,
        agent_acp_session_id TEXT,
        agent_acp_capabilities_json TEXT
```

- [ ] **Step 2: Add columns to the `messages` CREATE TABLE.**

In the same file, add to the `messages` CREATE TABLE:

```sql
        ,
        streaming INTEGER NOT NULL DEFAULT 0,
        turn_id TEXT,
        stop_reason TEXT,
        partial INTEGER NOT NULL DEFAULT 0
```

- [ ] **Step 3: Extend session column whitelist.**

In `packages/core/repositories/session.ts`, locate the `SESSION_COLUMNS` set and add:

```ts
  "agent_acp_session_id",
  "agent_acp_capabilities_json",
```

- [ ] **Step 4: Extend messages repo to write the new columns.**

In `packages/core/repositories/message.ts`, add a new method alongside `send()`:

```ts
/**
 * Upsert a streaming message row matched by (session_id, turn_id, role).
 * Used by the agent-acp conductor handler to persist chunks in place so
 * the UI renders one message that grows as tokens arrive. Creates the
 * row on first call; appends to `content` on subsequent calls.
 */
upsertStreamingChunk(
  sessionId: string,
  turnId: string,
  role: MessageRole,
  chunkText: string,
): Message {
  const existing = this.db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND turn_id = ? AND role = ? AND streaming = 1",
  ).get(sessionId, turnId, role) as any;
  if (existing) {
    const newContent = existing.content + chunkText;
    this.db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(newContent, existing.id);
    return { ...existing, content: newContent };
  }
  const stmt = this.db.prepare(
    "INSERT INTO messages (session_id, role, content, type, read, streaming, turn_id, partial) " +
    "VALUES (?, ?, ?, 'text', 0, 1, ?, 0) RETURNING *",
  );
  return stmt.get(sessionId, role, chunkText, turnId) as Message;
}

/**
 * Finalize every streaming row in a turn: flip streaming=0, set stop_reason,
 * and mark partial iff the turn ended abnormally.
 */
finalizeTurn(
  sessionId: string,
  turnId: string,
  stopReason: string,
  partial: boolean,
): number {
  const res = this.db.prepare(
    "UPDATE messages SET streaming = 0, stop_reason = ?, partial = ? WHERE session_id = ? AND turn_id = ? AND streaming = 1",
  ).run(stopReason, partial ? 1 : 0, sessionId, turnId);
  return res.changes as number;
}
```

- [ ] **Step 5: Remove old local DB so schema recreates.**

Run: `rm -f ~/.ark/ark.db`

- [ ] **Step 6: Smoke-boot.**

Run: `bun -e "import('./packages/core/app.js').then(m => m.AppContext.forTestAsync().then(a => a.boot().then(() => { console.log('ok'); a.shutdown(); })))"`
Expected: prints `ok`.

- [ ] **Step 7: Lint + commit.**

```bash
make format
make lint
git add packages/core/repositories/schema.ts packages/core/repositories/session.ts packages/core/repositories/message.ts
git commit -m "feat(agent-acp): extend schema for streaming messages and acp session id"
```

---

### Task 8: Add Postgres migration for the new columns

**Files:**
- Create: `packages/core/migrations/XXX_agent_acp.ts` (pick the next available version number by listing `packages/core/migrations/` and incrementing)
- Modify: `packages/core/migrations/registry.ts`

- [ ] **Step 1: Determine next migration version.**

Run: `ls packages/core/migrations/ | sort`
Note the highest numbered file. The new version is that number + 1. Call it `NNN` below.

- [ ] **Step 2: Write the migration.**

```ts
// packages/core/migrations/NNN_agent_acp.ts
import type { MigrationContext } from "./runner.js";

export default {
  version: NNN,
  name: "agent_acp_schema",
  async up(ctx: MigrationContext) {
    await ctx.exec(`
      ALTER TABLE sessions ADD COLUMN agent_acp_session_id TEXT;
      ALTER TABLE sessions ADD COLUMN agent_acp_capabilities_json TEXT;
      ALTER TABLE messages ADD COLUMN streaming INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN turn_id TEXT;
      ALTER TABLE messages ADD COLUMN stop_reason TEXT;
      ALTER TABLE messages ADD COLUMN partial INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
```

Replace `NNN` with the integer version number.

- [ ] **Step 3: Register in migrations registry.**

Edit `packages/core/migrations/registry.ts` and add an import + registry entry for the new migration, following the existing pattern.

- [ ] **Step 4: Smoke-test in Postgres profile if available.**

If you have a Postgres instance available, set `DATABASE_URL` and boot once. Otherwise skip -- SQLite is the authoritative dev path.

- [ ] **Step 5: Commit.**

```bash
make format
make lint
git add packages/core/migrations/
git commit -m "feat(agent-acp): postgres migration for streaming messages and acp session id"
```

---

## Phase 4 -- Arkd subprocess infrastructure

### Task 9: Stdio JSON-RPC transport for subprocess

**Files:**
- Create: `packages/arkd/agent-acp/transport.ts`
- Create: `packages/arkd/agent-acp/__tests__/transport.test.ts`

- [ ] **Step 1: Write failing test using a cat subprocess as echo loop.**

```ts
// packages/arkd/agent-acp/__tests__/transport.test.ts
import { describe, test, expect } from "bun:test";
import { AcpTransport } from "../transport.js";

describe("AcpTransport", () => {
  test("round-trips a JSON-RPC frame through cat", async () => {
    const proc = Bun.spawn({
      cmd: ["cat"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const received: any[] = [];
    const transport = new AcpTransport(proc);
    transport.onFrame = (f) => received.push(f);
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "echo", params: { hello: "world" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);
    expect(received[0].method).toBe("echo");
    transport.close();
    await proc.exited;
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/transport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement transport.**

```ts
// packages/arkd/agent-acp/transport.ts
import { LineDelimitedDecoder, encodeFrame } from "../../core/agent-acp/codec.js";
import type { JsonRpcFrame } from "../../core/agent-acp/types.js";

export class AcpTransport {
  private decoder = new LineDelimitedDecoder();
  private readerTask: Promise<void> | null = null;
  private closed = false;

  onFrame: (f: JsonRpcFrame) => void = () => {};
  onDecodeError: (err: unknown) => void = () => {};
  onExit: (code: number | null, signal: string | null) => void = () => {};

  constructor(private proc: Bun.Subprocess<"pipe", "pipe", "inherit" | "pipe">) {
    this.decoder.onError = (e) => this.onDecodeError(e);
  }

  start(): void {
    this.readerTask = (async () => {
      const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.decoder.push(value, (f) => this.onFrame(f));
      }
    })();
    this.proc.exited.then((code) => {
      this.onExit(code ?? null, null);
    });
  }

  send(frame: JsonRpcFrame): void {
    if (this.closed) throw new Error("transport closed");
    const bytes = encodeFrame(frame);
    (this.proc.stdin as WritableStream<Uint8Array>).getWriter().write(bytes).catch(() => {
      // Writer locked or stream closed; swallow
    });
  }

  close(): void {
    this.closed = true;
    try {
      (this.proc.stdin as WritableStream<Uint8Array>).getWriter().close();
    } catch {
      // already closed
    }
    try {
      this.proc.kill();
    } catch {
      // already dead
    }
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/
git commit -m "feat(agent-acp): stdio JSON-RPC transport for subprocess"
```

---

### Task 10: PTY manager (skipped when no PTY library available)

**Files:**
- Create: `packages/arkd/agent-acp/pty-manager.ts`
- Create: `packages/arkd/agent-acp/__tests__/pty-manager.test.ts`

- [ ] **Step 1: Probe for a usable PTY library.**

Run: `bun add node-pty || bun add @homebridge/node-pty-prebuilt-multiarch`
Verify one installs cleanly under Bun. If neither does, skip this task for now: in `packages/arkd/agent-acp/pty-manager.ts` write a stub whose `create()` throws "terminal capability disabled" and record this in the open-questions tracker. The rest of the plan continues unchanged; the host layer will advertise `terminal: false` when the runtime declares `host_capabilities.terminal` on a PTY-less build.

- [ ] **Step 2: Write tests (assuming PTY library landed).**

```ts
// packages/arkd/agent-acp/__tests__/pty-manager.test.ts
import { describe, test, expect } from "bun:test";
import { PtyManager } from "../pty-manager.js";

describe("PtyManager", () => {
  test("create + wait + output + release for /bin/echo", async () => {
    const mgr = new PtyManager({ maxPerSession: 4 });
    const tid = await mgr.create("s1", { command: "/bin/echo", args: ["hello"] });
    const exit = await mgr.wait("s1", tid);
    expect(exit.exitCode).toBe(0);
    const out = await mgr.output("s1", tid);
    expect(out.output).toContain("hello");
    await mgr.release("s1", tid);
  });

  test("enforces per-session cap", async () => {
    const mgr = new PtyManager({ maxPerSession: 2 });
    await mgr.create("s2", { command: "/bin/sleep", args: ["60"] });
    await mgr.create("s2", { command: "/bin/sleep", args: ["60"] });
    await expect(mgr.create("s2", { command: "/bin/sleep", args: ["60"] })).rejects.toThrow(/cap/i);
    mgr.killAll("s2");
  });

  test("kill terminates the process", async () => {
    const mgr = new PtyManager({ maxPerSession: 4 });
    const tid = await mgr.create("s3", { command: "/bin/sleep", args: ["60"] });
    await mgr.kill("s3", tid);
    const exit = await mgr.wait("s3", tid);
    expect(exit.signal ?? exit.exitCode).not.toBe(null);
  });
});
```

- [ ] **Step 3: Implement `PtyManager`.**

```ts
// packages/arkd/agent-acp/pty-manager.ts
// Dynamic import so the module loads even if no PTY library is installed.
let ptyLib: any = null;
try {
  ptyLib = await import("node-pty");
} catch {
  try {
    ptyLib = await import("@homebridge/node-pty-prebuilt-multiarch");
  } catch {
    ptyLib = null;
  }
}

interface PtyEntry {
  proc: any;
  buf: string;
  exitCode: number | null;
  signal: string | null;
  waiters: Array<(res: { exitCode: number | null; signal: string | null }) => void>;
}

export class PtyManager {
  private map = new Map<string, Map<string, PtyEntry>>(); // sessionId -> terminalId -> entry
  private counter = 0;

  constructor(private opts: { maxPerSession: number }) {}

  static isAvailable(): boolean {
    return ptyLib !== null;
  }

  async create(
    sessionId: string,
    req: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> },
  ): Promise<string> {
    if (!ptyLib) throw new Error("terminal capability disabled (no PTY library)");
    const bucket = this.map.get(sessionId) ?? new Map<string, PtyEntry>();
    if (bucket.size >= this.opts.maxPerSession) {
      throw new Error("terminal cap reached for session " + sessionId);
    }
    const proc = ptyLib.spawn(req.command, req.args ?? [], {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) },
      cols: 80,
      rows: 24,
    });
    const terminalId = "t" + ++this.counter;
    const entry: PtyEntry = { proc, buf: "", exitCode: null, signal: null, waiters: [] };
    proc.onData((d: string) => {
      entry.buf += d;
      if (entry.buf.length > 1_048_576) entry.buf = entry.buf.slice(-1_048_576);
    });
    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      entry.exitCode = exitCode;
      entry.signal = signal != null ? String(signal) : null;
      for (const w of entry.waiters) w({ exitCode, signal: entry.signal });
      entry.waiters = [];
    });
    bucket.set(terminalId, entry);
    this.map.set(sessionId, bucket);
    return terminalId;
  }

  async output(sessionId: string, terminalId: string): Promise<{ output: string; exitStatus?: { exitCode: number | null; signal: string | null } }> {
    const entry = this.get(sessionId, terminalId);
    return {
      output: entry.buf,
      exitStatus: entry.exitCode !== null ? { exitCode: entry.exitCode, signal: entry.signal } : undefined,
    };
  }

  async wait(sessionId: string, terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const entry = this.get(sessionId, terminalId);
    if (entry.exitCode !== null) return { exitCode: entry.exitCode, signal: entry.signal };
    return new Promise((r) => entry.waiters.push(r));
  }

  async kill(sessionId: string, terminalId: string): Promise<void> {
    const entry = this.get(sessionId, terminalId);
    try { entry.proc.kill("SIGTERM"); } catch { /* already dead */ }
    await new Promise((r) => setTimeout(r, 200));
    try { entry.proc.kill("SIGKILL"); } catch { /* already dead */ }
  }

  async release(sessionId: string, terminalId: string): Promise<void> {
    this.map.get(sessionId)?.delete(terminalId);
  }

  killAll(sessionId: string): void {
    const bucket = this.map.get(sessionId);
    if (!bucket) return;
    for (const [, entry] of bucket) {
      try { entry.proc.kill("SIGKILL"); } catch { /* already dead */ }
    }
    this.map.delete(sessionId);
  }

  private get(sessionId: string, terminalId: string): PtyEntry {
    const entry = this.map.get(sessionId)?.get(terminalId);
    if (!entry) throw new Error("unknown terminal " + terminalId + " for session " + sessionId);
    return entry;
  }
}
```

- [ ] **Step 4: Run tests.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/pty-manager.test.ts`
Expected: PASS if PTY library installed; skip with a warning if not.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/pty-manager.ts packages/arkd/agent-acp/__tests__/pty-manager.test.ts package.json bun.lock
git commit -m "feat(agent-acp): PTY manager for terminal/* host methods"
```

---

### Task 11: ACP client (per-session subprocess owner)

**Files:**
- Create: `packages/arkd/agent-acp/client.ts`
- Create: `packages/arkd/agent-acp/__tests__/client.test.ts`
- Create: `packages/core/agent-acp/__tests__/fixtures/mock-agent.ts`

- [ ] **Step 1: Write the mock agent fixture.**

```ts
// packages/core/agent-acp/__tests__/fixtures/mock-agent.ts
// Standalone Bun script that behaves like a minimal ACP agent.
// Controlled via env vars so tests can script behavior.
import type { JsonRpcFrame, SessionUpdate } from "../../types.js";

const MODE = process.env.MOCK_ACP_MODE ?? "well_behaved";

function write(frame: JsonRpcFrame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}
function notify(sessionId: string, update: SessionUpdate): void {
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let idx: number;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.method === "initialize") {
      write({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-01-01", agentCapabilities: { loadSession: true } } });
    } else if (frame.method === "session/new") {
      write({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "mock-acp-sid" } });
    } else if (frame.method === "session/load") {
      write({ jsonrpc: "2.0", id: frame.id, result: null });
    } else if (frame.method === "session/prompt") {
      const sid = frame.params.sessionId;
      if (MODE === "well_behaved") {
        notify(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
        notify(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
        write({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
      } else if (MODE === "hang") {
        // never reply
      } else if (MODE === "crash") {
        process.exit(2);
      }
    } else if (frame.method === "session/cancel") {
      // no-op notification
    }
  }
});
```

- [ ] **Step 2: Write client tests.**

```ts
// packages/arkd/agent-acp/__tests__/client.test.ts
import { describe, test, expect } from "bun:test";
import { AgentAcpClient } from "../client.js";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "../../../core/agent-acp/__tests__/fixtures/mock-agent.ts");

describe("AgentAcpClient", () => {
  test("launch -> initialize -> session/new emits ready", async () => {
    const events: any[] = [];
    const client = new AgentAcpClient({
      sessionId: "s1",
      command: ["bun", "run", FIXTURE],
      acpFlags: [],
      workdir: process.cwd(),
      env: { MOCK_ACP_MODE: "well_behaved" },
      grantAllPermissions: true,
      hostCapabilities: { fs: {}, terminal: false },
      channelReport: async (r) => { events.push(r); return { ok: true }; },
    });
    await client.launch();
    expect(events.some((e) => e.type === "agent_acp_ready")).toBe(true);
    await client.close();
  });

  test("sendPrompt streams chunks + turn_completed", async () => {
    const events: any[] = [];
    const client = new AgentAcpClient({
      sessionId: "s2",
      command: ["bun", "run", FIXTURE],
      acpFlags: [],
      workdir: process.cwd(),
      env: { MOCK_ACP_MODE: "well_behaved" },
      grantAllPermissions: true,
      hostCapabilities: { fs: {}, terminal: false },
      channelReport: async (r) => { events.push(r); return { ok: true }; },
    });
    await client.launch();
    await client.sendPrompt("turn-1", "hello");
    await new Promise((r) => setTimeout(r, 200));
    const chunks = events.filter((e) => e.type === "agent_acp_message_chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const done = events.find((e) => e.type === "agent_acp_turn_completed");
    expect(done?.data?.stop_reason).toBe("end_turn");
    await client.close();
  });
});
```

- [ ] **Step 3: Run tests, expect failure.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/client.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `client.ts`.**

```ts
// packages/arkd/agent-acp/client.ts
import { AcpTransport } from "./transport.js";
import { nextId } from "../../core/agent-acp/codec.js";
import { mapAcpUpdateToArkEvent } from "../../core/agent-acp/updates.js";
import type {
  AcpMcpServer,
  InitializeResult,
  JsonRpcFrame,
  JsonRpcRequest,
  SessionNewResult,
  SessionUpdateNotifParams,
} from "../../core/agent-acp/types.js";

export interface AgentAcpClientOpts {
  sessionId: string;
  command: string[];
  acpFlags?: string[];
  workdir: string;
  env: Record<string, string>;
  grantAllPermissions: boolean;
  hostCapabilities: {
    fs?: { read_text_file?: boolean; write_text_file?: boolean };
    terminal?: boolean;
  };
  mcpServers?: AcpMcpServer[];
  acpSessionId?: string;
  protocolVersion?: string;
  /** Extra key/value pairs merged into the `_meta` field of `session/new`. */
  sessionNewMeta?: Record<string, unknown>;
  channelReport: (report: Record<string, unknown>) => Promise<unknown>;
}

export class AgentAcpClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private transport: AcpTransport | null = null;
  private pending = new Map<string | number, (frame: JsonRpcFrame) => void>();
  private pendingPermissions = new Map<string, (optionId: string | "cancelled") => void>();
  private activeTurns = new Map<string, string>(); // acp request id -> turn_id
  private caps: InitializeResult | null = null;
  private acpSessionId: string | null = null;
  private idGen = nextId();
  private hostFrom: ((frame: JsonRpcRequest) => Promise<unknown>) | null = null;

  constructor(private opts: AgentAcpClientOpts) {}

  /** Register the host-side method dispatcher (from host.ts). */
  bindHost(dispatch: (frame: JsonRpcRequest) => Promise<unknown>): void {
    this.hostFrom = dispatch;
  }

  async launch(): Promise<void> {
    const cmd = [...this.opts.command, ...(this.opts.acpFlags ?? [])];
    this.proc = Bun.spawn({
      cmd,
      cwd: this.opts.workdir,
      env: { ...process.env, ...this.opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.transport = new AcpTransport(this.proc);
    this.transport.onFrame = (f) => this.onFrame(f);
    this.transport.onExit = (code, signal) => this.onExit(code, signal);
    this.transport.start();

    const initRes = (await this.rpc("initialize", {
      protocolVersion: this.opts.protocolVersion ?? "2025-01-01",
      clientCapabilities: {
        fs: this.opts.hostCapabilities.fs ?? {},
        terminal: this.opts.hostCapabilities.terminal ?? false,
      },
    })) as InitializeResult;
    this.caps = initRes;

    if (this.opts.acpSessionId && initRes.agentCapabilities?.loadSession) {
      try {
        await this.rpc("session/load", {
          sessionId: this.opts.acpSessionId,
          workingDirectory: this.opts.workdir,
          mcpServers: this.opts.mcpServers ?? [],
        });
        this.acpSessionId = this.opts.acpSessionId;
      } catch {
        await this.opts.channelReport({
          type: "agent_acp_resume_fallback",
          data: { reason: "context_lost" },
        });
        const nr = (await this.rpc("session/new", {
          workingDirectory: this.opts.workdir,
          mcpServers: this.opts.mcpServers ?? [],
          ...(this.opts.sessionNewMeta && Object.keys(this.opts.sessionNewMeta).length > 0
            ? { _meta: this.opts.sessionNewMeta }
            : {}),
        })) as SessionNewResult;
        this.acpSessionId = nr.sessionId;
      }
    } else {
      const nr = (await this.rpc("session/new", {
        workingDirectory: this.opts.workdir,
        mcpServers: this.opts.mcpServers ?? [],
        ...(this.opts.sessionNewMeta && Object.keys(this.opts.sessionNewMeta).length > 0
          ? { _meta: this.opts.sessionNewMeta }
          : {}),
      })) as SessionNewResult;
      this.acpSessionId = nr.sessionId;
    }

    await this.opts.channelReport({
      type: "agent_acp_ready",
      data: { acp_session_id: this.acpSessionId, agent_capabilities: initRes.agentCapabilities },
    });
  }

  async sendPrompt(turnId: string, text: string): Promise<void> {
    if (!this.acpSessionId) throw new Error("not launched");
    const promise = this.rpc("session/prompt", {
      sessionId: this.acpSessionId,
      prompt: [{ type: "text", text }],
    });
    // Track turn id on the *request id* we just sent so that incoming
    // session/update notifications can attribute themselves. rpc() stores the
    // id as the last assigned id; read it via a side channel.
    const requestId = this.lastId;
    this.activeTurns.set(String(requestId), turnId);

    promise.then(
      async (res: any) => {
        this.activeTurns.delete(String(requestId));
        await this.opts.channelReport({
          type: "agent_acp_turn_completed",
          data: { turn_id: turnId, stop_reason: res?.stopReason ?? "end_turn", partial: false },
        });
      },
      async (err) => {
        this.activeTurns.delete(String(requestId));
        await this.opts.channelReport({
          type: "agent_acp_turn_completed",
          data: { turn_id: turnId, stop_reason: "interrupted", partial: true, error: String(err) },
        });
      },
    );
  }

  async cancel(turnId: string): Promise<void> {
    if (!this.acpSessionId || !this.transport) return;
    this.transport.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.acpSessionId },
    });
  }

  async respondPermission(requestId: string, outcome: "granted" | "denied" | "cancelled", optionId?: string): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    if (outcome === "cancelled") pending("cancelled");
    else if (outcome === "granted") pending(optionId ?? "allow_once");
    else pending("deny");
  }

  async close(): Promise<void> {
    this.transport?.close();
    this.transport = null;
    this.proc = null;
  }

  /** Call from host.ts when a session/request_permission arrives. */
  parkPermissionPromise(requestId: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
    });
  }

  get capabilities(): InitializeResult | null {
    return this.caps;
  }
  get arkSessionId(): string {
    return this.opts.sessionId;
  }
  get activeTurnId(): string | undefined {
    // Any in-flight turn; if multiple, return the most recent.
    const ids = Array.from(this.activeTurns.values());
    return ids[ids.length - 1];
  }

  // -- internals --

  private lastId: string | number = 0;

  private rpc<R = unknown>(method: string, params: unknown): Promise<R> {
    if (!this.transport) return Promise.reject(new Error("transport closed"));
    const id = this.idGen();
    this.lastId = id;
    const frame = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, (res: any) => {
        if (res.error) reject(new Error(res.error.message));
        else resolve(res.result as R);
      });
      this.transport!.send(frame);
    });
  }

  private onFrame(frame: JsonRpcFrame): void {
    if ("method" in frame && !("id" in frame)) {
      // notification from agent
      if (frame.method === "session/update") {
        const params = frame.params as SessionUpdateNotifParams;
        // Which turn is this update for? Any active turn.
        const turnId = this.activeTurnId ?? "unknown";
        const ark = mapAcpUpdateToArkEvent(turnId, params.update);
        this.opts.channelReport(ark).catch(() => {});
      }
      return;
    }
    if ("id" in frame && "method" in frame) {
      // request from agent (host-side method)
      if (!this.hostFrom) {
        this.transport?.send({
          jsonrpc: "2.0",
          id: frame.id!,
          error: { code: -32601, message: "host dispatcher not bound" },
        });
        return;
      }
      this.hostFrom(frame as JsonRpcRequest).then(
        (result) => this.transport?.send({ jsonrpc: "2.0", id: frame.id!, result }),
        (err) => this.transport?.send({ jsonrpc: "2.0", id: frame.id!, error: { code: -32603, message: String(err) } }),
      );
      return;
    }
    // response to a request we sent
    const pending = this.pending.get(frame.id!);
    if (pending) {
      this.pending.delete(frame.id!);
      pending(frame);
    }
  }

  private async onExit(code: number | null, signal: string | null): Promise<void> {
    // Finalize any in-flight turns.
    for (const [, turnId] of this.activeTurns) {
      await this.opts.channelReport({
        type: "agent_acp_turn_completed",
        data: { turn_id: turnId, stop_reason: "interrupted", partial: true, exit_code: code, signal },
      });
    }
    this.activeTurns.clear();
    await this.opts.channelReport({
      type: "agent_acp_agent_exited",
      data: { exit_code: code, signal },
    });
  }
}
```

- [ ] **Step 5: Run tests, expect pass.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/client.ts packages/arkd/agent-acp/__tests__/client.test.ts packages/core/agent-acp/__tests__/fixtures/
git commit -m "feat(agent-acp): per-session ACP client with mock-agent fixture"
```

---

### Task 12: Host-side handlers: fs/*

**Files:**
- Create: `packages/arkd/agent-acp/host.ts`
- Create: `packages/arkd/agent-acp/__tests__/host-fs.test.ts`

- [ ] **Step 1: Write tests.**

```ts
// packages/arkd/agent-acp/__tests__/host-fs.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AcpHost } from "../host.js";

describe("AcpHost fs/*", () => {
  let workdir: string;
  let host: AcpHost;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "acp-fs-"));
    host = new AcpHost({
      workspaceRoot: workdir,
      sessionId: "s1",
      grantAllPermissions: true,
      pty: null,
      channelReport: async () => ({ ok: true }),
      client: null as any,
    });
  });

  test("read_text_file returns file contents when inside workspace", async () => {
    writeFileSync(join(workdir, "a.txt"), "hi");
    const res = await host.dispatch({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file", params: { path: join(workdir, "a.txt") } });
    expect(res).toEqual({ content: "hi" });
  });

  test("read outside workspace is refused", async () => {
    await expect(
      host.dispatch({ jsonrpc: "2.0", id: 2, method: "fs/read_text_file", params: { path: "/etc/passwd" } }),
    ).rejects.toThrow(/outside/i);
  });

  test("write_text_file writes and emits audit event", async () => {
    const audits: any[] = [];
    const h = new AcpHost({
      workspaceRoot: workdir,
      sessionId: "s1",
      grantAllPermissions: true,
      pty: null,
      channelReport: async (r) => { audits.push(r); return { ok: true }; },
      client: null as any,
    });
    await h.dispatch({ jsonrpc: "2.0", id: 3, method: "fs/write_text_file", params: { path: join(workdir, "b.txt"), content: "bye" } });
    expect(readFileSync(join(workdir, "b.txt"), "utf-8")).toBe("bye");
    expect(audits.some((a) => a.type === "agent_acp_fs_write")).toBe(true);
  });

  test("write to symlink target outside workspace is refused", async () => {
    const target = join(tmpdir(), "acp-outside-" + Date.now());
    writeFileSync(target, "safe");
    const linkPath = join(workdir, "link");
    symlinkSync(target, linkPath);
    await expect(
      host.dispatch({ jsonrpc: "2.0", id: 4, method: "fs/write_text_file", params: { path: linkPath, content: "x" } }),
    ).rejects.toThrow(/symlink|outside/i);
    expect(readFileSync(target, "utf-8")).toBe("safe");
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/host-fs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `host.ts` (fs only for now; terminal + permission in next tasks).**

```ts
// packages/arkd/agent-acp/host.ts
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from "fs";
import { resolve } from "path";
import type { JsonRpcRequest } from "../../core/agent-acp/types.js";
import type { PtyManager } from "./pty-manager.js";
import type { AgentAcpClient } from "./client.js";

export interface AcpHostOpts {
  workspaceRoot: string;
  sessionId: string;
  grantAllPermissions: boolean;
  pty: PtyManager | null;
  channelReport: (report: Record<string, unknown>) => Promise<unknown>;
  client: AgentAcpClient | null;
}

export class AcpHost {
  constructor(private opts: AcpHostOpts) {}

  async dispatch(frame: JsonRpcRequest): Promise<unknown> {
    switch (frame.method) {
      case "fs/read_text_file": return this.fsRead(frame.params as any);
      case "fs/write_text_file": return this.fsWrite(frame.params as any);
      // terminal/* and session/request_permission handled in later tasks
      default: {
        const err = new Error("method not implemented: " + frame.method);
        (err as any).code = -32601;
        throw err;
      }
    }
  }

  private fsRead(p: { path: string; line?: number; limit?: number }): { content: string } {
    this.confine(p.path);
    let content = readFileSync(p.path, "utf-8");
    if (p.line !== undefined) {
      const lines = content.split("\n");
      const start = Math.max(0, p.line - 1);
      const end = p.limit !== undefined ? start + p.limit : undefined;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  private async fsWrite(p: { path: string; content: string }): Promise<null> {
    this.confine(p.path);
    // Refuse to overwrite a symlink whose target escapes the workspace.
    if (existsSync(p.path)) {
      const st = lstatSync(p.path);
      if (st.isSymbolicLink()) {
        try {
          const real = realpathSync(p.path);
          this.confine(real);
        } catch {
          throw new Error("refusing to write symlink with unresolvable target");
        }
        // Even if target resolves inside, refuse symlink writes by policy.
        throw new Error("refusing to write through symlink");
      }
    }
    writeFileSync(p.path, p.content, "utf-8");
    await this.opts.channelReport({
      type: "agent_acp_fs_write",
      data: { path: p.path, bytes: Buffer.byteLength(p.content, "utf-8") },
    });
    return null;
  }

  private confine(path: string): void {
    const absRoot = resolve(this.opts.workspaceRoot);
    const absPath = resolve(path);
    if (!absPath.startsWith(absRoot + "/") && absPath !== absRoot) {
      throw new Error("path outside workspace: " + absPath);
    }
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/host-fs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/host.ts packages/arkd/agent-acp/__tests__/host-fs.test.ts
git commit -m "feat(agent-acp): host fs/* handlers with workspace confinement"
```

---

### Task 13: Host terminal/* handlers

**Files:**
- Modify: `packages/arkd/agent-acp/host.ts`
- Create: `packages/arkd/agent-acp/__tests__/host-terminal.test.ts`

- [ ] **Step 1: Write tests.**

```ts
// packages/arkd/agent-acp/__tests__/host-terminal.test.ts
import { describe, test, expect } from "bun:test";
import { AcpHost } from "../host.js";
import { PtyManager } from "../pty-manager.js";

describe("AcpHost terminal/*", () => {
  if (!PtyManager.isAvailable()) {
    test.skip("terminal PTY not available in this environment", () => {});
    return;
  }
  test("create -> wait -> output -> release", async () => {
    const host = new AcpHost({
      workspaceRoot: process.cwd(),
      sessionId: "s",
      grantAllPermissions: true,
      pty: new PtyManager({ maxPerSession: 4 }),
      channelReport: async () => ({ ok: true }),
      client: null as any,
    });
    const create = await host.dispatch({ jsonrpc: "2.0", id: 1, method: "terminal/create", params: { command: "/bin/echo", args: ["hi"] } }) as any;
    expect(create.terminalId).toBeDefined();
    await host.dispatch({ jsonrpc: "2.0", id: 2, method: "terminal/wait_for_exit", params: { terminalId: create.terminalId } });
    const out = await host.dispatch({ jsonrpc: "2.0", id: 3, method: "terminal/output", params: { terminalId: create.terminalId } }) as any;
    expect(out.output).toContain("hi");
    await host.dispatch({ jsonrpc: "2.0", id: 4, method: "terminal/release", params: { terminalId: create.terminalId } });
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/host-terminal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `host.ts` with terminal cases.**

Add to the `dispatch` switch:

```ts
      case "terminal/create": return this.termCreate(frame.params as any);
      case "terminal/output": return this.termOutput(frame.params as any);
      case "terminal/wait_for_exit": return this.termWait(frame.params as any);
      case "terminal/kill": return this.termKill(frame.params as any);
      case "terminal/release": return this.termRelease(frame.params as any);
```

Add the methods to the class:

```ts
  private async termCreate(p: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<{ terminalId: string }> {
    if (!this.opts.pty) throw new Error("terminal capability disabled");
    const cwd = p.cwd ? this.confineAndReturn(p.cwd) : this.opts.workspaceRoot;
    const terminalId = await this.opts.pty.create(this.opts.sessionId, { command: p.command, args: p.args, cwd, env: p.env });
    return { terminalId };
  }
  private async termOutput(p: { terminalId: string; truncateLineCount?: number }): Promise<{ output: string; exitStatus?: { exitCode: number | null; signal: string | null } }> {
    if (!this.opts.pty) throw new Error("terminal capability disabled");
    const r = await this.opts.pty.output(this.opts.sessionId, p.terminalId);
    if (p.truncateLineCount !== undefined) {
      const lines = r.output.split("\n");
      return { output: lines.slice(-p.truncateLineCount).join("\n"), exitStatus: r.exitStatus };
    }
    return r;
  }
  private async termWait(p: { terminalId: string }): Promise<{ exitCode: number | null; signal: string | null }> {
    if (!this.opts.pty) throw new Error("terminal capability disabled");
    return this.opts.pty.wait(this.opts.sessionId, p.terminalId);
  }
  private async termKill(p: { terminalId: string }): Promise<null> {
    if (!this.opts.pty) throw new Error("terminal capability disabled");
    await this.opts.pty.kill(this.opts.sessionId, p.terminalId);
    return null;
  }
  private async termRelease(p: { terminalId: string }): Promise<null> {
    if (!this.opts.pty) throw new Error("terminal capability disabled");
    await this.opts.pty.release(this.opts.sessionId, p.terminalId);
    return null;
  }
  private confineAndReturn(path: string): string {
    this.confine(path);
    return path;
  }
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/host-terminal.test.ts`
Expected: PASS or skipped (if PTY unavailable).

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/host.ts packages/arkd/agent-acp/__tests__/host-terminal.test.ts
git commit -m "feat(agent-acp): host terminal/* handlers"
```

---

### Task 14: Host permission handlers (grant-all + park-reply)

**Files:**
- Modify: `packages/arkd/agent-acp/host.ts`
- Create: `packages/arkd/agent-acp/__tests__/host-permission.test.ts`

- [ ] **Step 1: Write tests.**

```ts
// packages/arkd/agent-acp/__tests__/host-permission.test.ts
import { describe, test, expect } from "bun:test";
import { AcpHost } from "../host.js";

const fakeClient = {
  parkPermissionPromise: (id: string) => new Promise<string>((r) => setTimeout(() => r("allow_once"), 20)),
};

describe("AcpHost session/request_permission", () => {
  test("grant-all path resolves immediately", async () => {
    const reports: any[] = [];
    const host = new AcpHost({
      workspaceRoot: process.cwd(),
      sessionId: "s",
      grantAllPermissions: true,
      pty: null,
      channelReport: async (r) => { reports.push(r); return { ok: true }; },
      client: fakeClient as any,
    });
    const res = await host.dispatch({
      jsonrpc: "2.0", id: 1, method: "session/request_permission",
      params: { sessionId: "acp-s", request_id: "req-1", toolCall: { toolCallId: "tc", title: "Read foo" }, options: [{ optionId: "allow_once", label: "Allow" }] },
    }) as any;
    expect(res.outcome.kind).toBe("selected");
    expect(reports.some((r) => r.type === "agent_acp_permission_request")).toBe(true);
    expect(reports.some((r) => r.type === "agent_acp_permission_resolved" && r.data.actor === "auto")).toBe(true);
  });

  test("park-reply path waits for client resolution", async () => {
    const reports: any[] = [];
    const host = new AcpHost({
      workspaceRoot: process.cwd(),
      sessionId: "s",
      grantAllPermissions: false,
      pty: null,
      channelReport: async (r) => { reports.push(r); return { ok: true }; },
      client: fakeClient as any,
    });
    const res = await host.dispatch({
      jsonrpc: "2.0", id: 1, method: "session/request_permission",
      params: { sessionId: "acp-s", request_id: "req-2", toolCall: { toolCallId: "tc", title: "x" }, options: [{ optionId: "allow_once", label: "Allow" }] },
    }) as any;
    expect(res.outcome.kind).toBe("selected");
    expect(res.outcome.optionId).toBe("allow_once");
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/host-permission.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `host.ts`.**

Add to the dispatch switch:

```ts
      case "session/request_permission": return this.permissionRequest(frame.params as any);
```

Add the method:

```ts
  private async permissionRequest(p: {
    sessionId: string;
    request_id: string;
    toolCall: { toolCallId: string; title: string; kind?: string };
    options: Array<{ optionId: string; label: string; kind?: string }>;
  }): Promise<{ outcome: { kind: "selected"; optionId: string } | { kind: "cancelled" } }> {
    await this.opts.channelReport({
      type: "agent_acp_permission_request",
      data: { request_id: p.request_id, tool_call: p.toolCall, options: p.options },
    });

    if (this.opts.grantAllPermissions) {
      const optionId = p.options[0]?.optionId ?? "allow_once";
      await this.opts.channelReport({
        type: "agent_acp_permission_resolved",
        data: { request_id: p.request_id, outcome: "granted", actor: "auto", selected_option_id: optionId },
      });
      return { outcome: { kind: "selected", optionId } };
    }

    if (!this.opts.client) throw new Error("no client bound to park permission promise");
    const result = await this.opts.client.parkPermissionPromise(p.request_id);
    if (result === "cancelled") {
      await this.opts.channelReport({
        type: "agent_acp_permission_resolved",
        data: { request_id: p.request_id, outcome: "cancelled", actor: "user" },
      });
      return { outcome: { kind: "cancelled" } };
    }
    if (result === "deny") {
      await this.opts.channelReport({
        type: "agent_acp_permission_resolved",
        data: { request_id: p.request_id, outcome: "denied", actor: "user" },
      });
      // ACP treats deny as selection of a "deny" option; fall back to cancelled if none offered.
      const deny = p.options.find((o) => o.kind === "deny");
      return deny ? { outcome: { kind: "selected", optionId: deny.optionId } } : { outcome: { kind: "cancelled" } };
    }
    await this.opts.channelReport({
      type: "agent_acp_permission_resolved",
      data: { request_id: p.request_id, outcome: "granted", actor: "user", selected_option_id: result },
    });
    return { outcome: { kind: "selected", optionId: result } };
  }
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/arkd/agent-acp/__tests__/host-permission.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire host -> client.**

Still in `client.ts`, in the `launch()` method -- after transport setup and before `initialize` -- bind the host dispatcher:

```ts
    if (this.host) this.bindHost((frame) => this.host!.dispatch(frame));
```

Add a `host?: AcpHost` field to `AgentAcpClient` and a setter so arkd's session controller can wire them up. Update `AgentAcpClientOpts` or add a separate setter method `setHost(host: AcpHost)`.

Keep it minimal: add to `AgentAcpClient` class:

```ts
  private host: AcpHost | null = null;
  setHost(host: AcpHost): void { this.host = host; }
```

And in `launch()`, after `this.transport.start()`:

```ts
    if (this.host) this.bindHost((frame) => this.host!.dispatch(frame));
```

- [ ] **Step 6: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/host.ts packages/arkd/agent-acp/client.ts packages/arkd/agent-acp/__tests__/host-permission.test.ts
git commit -m "feat(agent-acp): permission request handler with grant-all and park-reply"
```

---

## Phase 5 -- Arkd HTTP endpoints

### Task 15: Arkd session controller + `/agent-acp/launch` + `/close`

**Files:**
- Create: `packages/arkd/agent-acp/controller.ts`
- Modify: `packages/arkd/server.ts`
- Create: `packages/arkd/__tests__/agent-acp-endpoints.test.ts`

- [ ] **Step 1: Create the controller.**

```ts
// packages/arkd/agent-acp/controller.ts
import { AgentAcpClient, type AgentAcpClientOpts } from "./client.js";
import { AcpHost } from "./host.js";
import { PtyManager } from "./pty-manager.js";

export interface LaunchBody {
  sessionId: string;
  command: string[];
  acpFlags?: string[];
  workdir: string;
  env?: Record<string, string>;
  hostCapabilities: AgentAcpClientOpts["hostCapabilities"];
  grantAllPermissions: boolean;
  mcpServers?: AgentAcpClientOpts["mcpServers"];
  acpSessionId?: string;
  protocolVersion?: string;
  maxTerminalsPerSession?: number;
  /** Forwarded as `_meta` on the initial `session/new` call (model delivery). */
  sessionNewMeta?: Record<string, unknown>;
}

const MAX_SESSIONS = Number(process.env.ARK_AGENT_ACP_MAX_SESSIONS ?? 10);

export class AgentAcpController {
  private sessions = new Map<string, { client: AgentAcpClient; host: AcpHost; pty: PtyManager | null }>();

  constructor(
    private reportChannel: (sessionId: string, report: Record<string, unknown>) => Promise<unknown>,
  ) {}

  size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async launch(body: LaunchBody): Promise<{ ok: true; acp_session_id: string | null }> {
    if (this.sessions.has(body.sessionId)) {
      const { client } = this.sessions.get(body.sessionId)!;
      return { ok: true, acp_session_id: (client as any).acpSessionId ?? null };
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      const err: any = new Error("max agent-acp sessions reached");
      err.status = 503;
      err.retryAfter = 5;
      throw err;
    }
    const pty = body.hostCapabilities.terminal && PtyManager.isAvailable()
      ? new PtyManager({ maxPerSession: body.maxTerminalsPerSession ?? 4 })
      : null;
    const client = new AgentAcpClient({
      sessionId: body.sessionId,
      command: body.command,
      acpFlags: body.acpFlags,
      workdir: body.workdir,
      env: body.env ?? {},
      grantAllPermissions: body.grantAllPermissions,
      hostCapabilities: body.hostCapabilities,
      mcpServers: body.mcpServers,
      acpSessionId: body.acpSessionId,
      protocolVersion: body.protocolVersion,
      sessionNewMeta: body.sessionNewMeta,
      channelReport: (r) => this.reportChannel(body.sessionId, r),
    });
    const host = new AcpHost({
      workspaceRoot: body.workdir,
      sessionId: body.sessionId,
      grantAllPermissions: body.grantAllPermissions,
      pty,
      channelReport: (r) => this.reportChannel(body.sessionId, r),
      client,
    });
    client.setHost(host);
    this.sessions.set(body.sessionId, { client, host, pty });
    await client.launch();
    return { ok: true, acp_session_id: (client as any).acpSessionId ?? null };
  }

  async send(sessionId: string, turnId: string, text: string): Promise<void> {
    const s = this.require(sessionId);
    await s.client.sendPrompt(turnId, text);
  }

  async cancel(sessionId: string, turnId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.client.cancel(turnId);
  }

  async permissionReply(sessionId: string, requestId: string, outcome: "granted" | "denied" | "cancelled", optionId?: string): Promise<void> {
    const s = this.require(sessionId);
    await s.client.respondPermission(requestId, outcome, optionId);
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.pty?.killAll(sessionId);
    await s.client.close();
    this.sessions.delete(sessionId);
  }

  private require(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) {
      const err: any = new Error("no agent-acp session: " + sessionId);
      err.status = 404;
      throw err;
    }
    return s;
  }
}
```

- [ ] **Step 2: Wire controller into `packages/arkd/server.ts`.**

Near the top of `server.ts`, import and instantiate:

```ts
import { AgentAcpController } from "./agent-acp/controller.js";

const agentAcp = new AgentAcpController(async (sessionId, report) => {
  return channelReport(sessionId, report, conductorUrl, tenantId);
});
```

Inside the `fetch(req)` handler, add the branches. Find the existing if-else chain (search for `req.method === "POST" && path === "/agent/launch"`) and add alongside:

```ts
    if (req.method === "POST" && path === "/agent-acp/launch") {
      if (!authorized(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json();
      try {
        const res = await agentAcp.launch(body);
        return Response.json(res);
      } catch (e: any) {
        if (e?.status === 503) {
          return new Response(e.message, { status: 503, headers: { "Retry-After": String(e.retryAfter ?? 5) } });
        }
        return new Response(String(e?.message ?? e), { status: e?.status ?? 500 });
      }
    }
    if (req.method === "POST" && path === "/agent-acp/close") {
      if (!authorized(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json();
      await agentAcp.close(body.sessionId);
      return Response.json({ ok: true });
    }
```

(Replace `authorized(req)` with whatever the file uses today -- grep for existing auth checks in server.ts and match the same pattern.)

- [ ] **Step 3: Write endpoint tests.**

```ts
// packages/arkd/__tests__/agent-acp-endpoints.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "../../core/agent-acp/__tests__/fixtures/mock-agent.ts");

describe("arkd /agent-acp/* endpoints", () => {
  let app: AppContext;
  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });
  afterAll(async () => {
    await app?.shutdown();
    clearApp();
  });

  test("launch + close", async () => {
    const arkdUrl = "http://127.0.0.1:" + app.config.ports.arkd;
    const launch = await fetch(arkdUrl + "/agent-acp/launch", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + (process.env.ARK_ARKD_TOKEN ?? "dev-token") },
      body: JSON.stringify({
        sessionId: "test-s1",
        command: ["bun", "run", FIXTURE],
        workdir: process.cwd(),
        env: { MOCK_ACP_MODE: "well_behaved" },
        hostCapabilities: { fs: { read_text_file: true, write_text_file: true }, terminal: false },
        grantAllPermissions: true,
      }),
    });
    expect(launch.status).toBe(200);
    const j = await launch.json();
    expect(j.ok).toBe(true);
    expect(j.acp_session_id).toBe("mock-acp-sid");

    const close = await fetch(arkdUrl + "/agent-acp/close", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + (process.env.ARK_ARKD_TOKEN ?? "dev-token") },
      body: JSON.stringify({ sessionId: "test-s1" }),
    });
    expect(close.status).toBe(200);
  });
});
```

Note: if arkd does not require auth in test mode, drop the `authorization` header. Check `packages/arkd/server.ts` for the test behavior.

- [ ] **Step 4: Run tests.**

Run: `make test-file F=packages/arkd/__tests__/agent-acp-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/agent-acp/controller.ts packages/arkd/server.ts packages/arkd/__tests__/agent-acp-endpoints.test.ts
git commit -m "feat(agent-acp): arkd /agent-acp/launch and /close endpoints"
```

---

### Task 16: `/agent-acp/send`, `/cancel`, `/permission-reply`

**Files:**
- Modify: `packages/arkd/server.ts`
- Modify: `packages/arkd/__tests__/agent-acp-endpoints.test.ts`

- [ ] **Step 1: Add the three endpoints to `server.ts` fetch handler.**

```ts
    if (req.method === "POST" && path === "/agent-acp/send") {
      if (!authorized(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json();
      try {
        await agentAcp.send(body.sessionId, body.turnId, body.text);
        return Response.json({ ok: true });
      } catch (e: any) {
        return new Response(String(e?.message ?? e), { status: e?.status ?? 500 });
      }
    }
    if (req.method === "POST" && path === "/agent-acp/cancel") {
      if (!authorized(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json();
      await agentAcp.cancel(body.sessionId, body.turnId);
      return Response.json({ ok: true });
    }
    if (req.method === "POST" && path === "/agent-acp/permission-reply") {
      if (!authorized(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json();
      await agentAcp.permissionReply(body.sessionId, body.requestId, body.outcome, body.selectedOptionId);
      return Response.json({ ok: true });
    }
```

- [ ] **Step 2: Add an end-to-end test for send -> chunks -> turn completion.**

Append to `agent-acp-endpoints.test.ts`:

```ts
test("send streams chunks then turn_completed", async () => {
  const arkdUrl = "http://127.0.0.1:" + app.config.ports.arkd;
  await fetch(arkdUrl + "/agent-acp/launch", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + (process.env.ARK_ARKD_TOKEN ?? "dev-token") },
    body: JSON.stringify({
      sessionId: "test-send-1",
      command: ["bun", "run", FIXTURE],
      workdir: process.cwd(),
      env: { MOCK_ACP_MODE: "well_behaved" },
      hostCapabilities: { fs: {}, terminal: false },
      grantAllPermissions: true,
    }),
  });
  await fetch(arkdUrl + "/agent-acp/send", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + (process.env.ARK_ARKD_TOKEN ?? "dev-token") },
    body: JSON.stringify({ sessionId: "test-send-1", turnId: "turn-1", text: "hi" }),
  });
  // Wait briefly for events to flow through the channel pipeline.
  await new Promise((r) => setTimeout(r, 500));
  const events = app.events.list({ trackId: "test-send-1" });
  expect(events.some((e) => e.type === "agent_acp_message_chunk")).toBe(true);
  expect(events.some((e) => e.type === "agent_acp_turn_completed")).toBe(true);
  await fetch(arkdUrl + "/agent-acp/close", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + (process.env.ARK_ARKD_TOKEN ?? "dev-token") },
    body: JSON.stringify({ sessionId: "test-send-1" }),
  });
});
```

- [ ] **Step 3: Run tests.**

Run: `make test-file F=packages/arkd/__tests__/agent-acp-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 4: Lint + commit.**

```bash
make format
make lint
git add packages/arkd/server.ts packages/arkd/__tests__/agent-acp-endpoints.test.ts
git commit -m "feat(agent-acp): arkd /agent-acp/send, /cancel, /permission-reply"
```

---

## Phase 6 -- Core executor + orchestration wiring

### Task 17: HTTP wrapper for `/agent-acp/*`

**Files:**
- Create: `packages/core/agent-acp/arkd-client.ts`

- [ ] **Step 1: Implement wrapper.**

```ts
// packages/core/agent-acp/arkd-client.ts
export interface ArkdAcpLaunchReq {
  sessionId: string;
  command: string[];
  acpFlags?: string[];
  workdir: string;
  env?: Record<string, string>;
  hostCapabilities: { fs?: { read_text_file?: boolean; write_text_file?: boolean }; terminal?: boolean };
  grantAllPermissions: boolean;
  mcpServers?: unknown[];
  acpSessionId?: string;
  protocolVersion?: string;
  maxTerminalsPerSession?: number;
  sessionNewMeta?: Record<string, unknown>;
}

export interface ArkdAcpClient {
  launch(req: ArkdAcpLaunchReq): Promise<{ ok: true; acp_session_id: string | null }>;
  send(sessionId: string, turnId: string, text: string): Promise<{ ok: true }>;
  cancel(sessionId: string, turnId: string): Promise<{ ok: true }>;
  permissionReply(sessionId: string, requestId: string, outcome: "granted" | "denied" | "cancelled", selectedOptionId?: string): Promise<{ ok: true }>;
  close(sessionId: string): Promise<{ ok: true }>;
}

export function createArkdAcpClient(opts: { baseUrl: string; token?: string | null; tenantId?: string | null }): ArkdAcpClient {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = "Bearer " + opts.token;
  if (opts.tenantId) headers["x-ark-tenant-id"] = opts.tenantId;

  async function call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(opts.baseUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("arkd " + path + " " + res.status + ": " + (await res.text()));
    return res.json() as Promise<T>;
  }

  return {
    launch: (req) => call("/agent-acp/launch", req),
    send: (sid, tid, text) => call("/agent-acp/send", { sessionId: sid, turnId: tid, text }),
    cancel: (sid, tid) => call("/agent-acp/cancel", { sessionId: sid, turnId: tid }),
    permissionReply: (sid, rid, outcome, opt) => call("/agent-acp/permission-reply", { sessionId: sid, requestId: rid, outcome, selectedOptionId: opt }),
    close: (sid) => call("/agent-acp/close", { sessionId: sid }),
  };
}
```

- [ ] **Step 2: Lint + commit.**

```bash
make format
make lint
git add packages/core/agent-acp/arkd-client.ts
git commit -m "feat(agent-acp): ArkdAcpClient HTTP wrapper for executor"
```

---

### Task 18: `agent-acp` executor

**Files:**
- Create: `packages/core/executors/agent-acp.ts`
- Create: `packages/core/executors/__tests__/agent-acp.test.ts`

- [ ] **Step 1: Write failing test.**

```ts
// packages/core/executors/__tests__/agent-acp.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import { agentAcpExecutor } from "../agent-acp.js";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "../../agent-acp/__tests__/fixtures/mock-agent.ts");

describe("agentAcpExecutor", () => {
  let app: AppContext;
  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });
  afterAll(async () => {
    await app?.shutdown();
    clearApp();
  });

  test("launch stores acp_session_id on the session row", async () => {
    const session = app.sessions.create({
      ticket: "T-1",
      summary: "test",
      repo: process.cwd(),
      branch: "main",
      compute_name: "local-arkd",
      agent: "gemini-acp",
      flow: "quick",
      workdir: process.cwd(),
    });
    // Stub a minimal runtime lookup for the executor (normally via app.runtimes).
    const runtime = {
      name: "mock-acp",
      type: "agent-acp" as const,
      agent_acp: {
        command: ["bun", "run", FIXTURE],
        grant_all_permissions: true,
        host_capabilities: { fs: { read_text_file: true, write_text_file: true }, terminal: false },
        model_delivery: "env" as const,
        model_env: "MOCK_MODEL",
      },
      models: [{ id: "mock-a", label: "A" }],
      default_model: "mock-a",
    };
    // Patch the runtime store for this test.
    (app.runtimes as any).get = (name: string) => name === "mock-acp" ? runtime : null;
    session.agent = "mock-acp";
    app.sessions.update(session.id, { agent: "mock-acp" });

    const res = await agentAcpExecutor.launch({ app, session, env: { MOCK_ACP_MODE: "well_behaved" } });
    expect(res.ok).toBe(true);
    const fresh = app.sessions.get(session.id)!;
    expect((fresh as any).agent_acp_session_id).toBe("mock-acp-sid");

    await agentAcpExecutor.kill(session.id);
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/core/executors/__tests__/agent-acp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `agent-acp.ts`.**

```ts
// packages/core/executors/agent-acp.ts
import type { AppContext } from "../app.js";
import type { Session } from "../../types/session.js";
import { createArkdAcpClient } from "../agent-acp/arkd-client.js";
import { toAcpMcpServers } from "../agent-acp/mcp-adapter.js";
import { collectMcpEntries } from "../connectors/resolve.js";
import { resolveProvider } from "../provider-registry.js";

export const agentAcpExecutor = {
  name: "agent-acp",

  async launch(opts: { app: AppContext; session: Session; env?: Record<string, string> }) {
    const { app, session } = opts;
    const runtimeName = session.agent;
    const runtime = app.runtimes.get(runtimeName);
    if (!runtime || runtime.type !== "agent-acp") throw new Error("not an agent-acp runtime: " + runtimeName);
    const cfg = runtime.agent_acp ?? {};

    const { arkdUrl, tenantId, token } = resolveArkdEndpoint(app, session);
    const client = createArkdAcpClient({ baseUrl: arkdUrl, token, tenantId });

    // Assemble command with model injection per runtime config.
    let command = [...(cfg.command ?? [])];
    const acpFlags = [...(cfg.acp_flags ?? [])];
    const env: Record<string, string> = { ...(runtime.env ?? {}), ...(opts.env ?? {}) };
    const metaExtras: Record<string, unknown> = {};
    const model = (session as any).model ?? runtime.default_model ?? null;
    if (model) {
      const delivery = cfg.model_delivery ?? "cli_flag";
      if (delivery === "cli_flag") {
        const tmpl = cfg.model_cli_flag ?? ["--model", "{model}"];
        command = [...command, ...tmpl.map((t) => t.replace("{model}", model))];
      } else if (delivery === "env" && cfg.model_env) {
        env[cfg.model_env] = model;
      } else if (delivery === "meta" && cfg.model_meta_key) {
        metaExtras[cfg.model_meta_key] = model;
      }
    }

    // MCP: reuse the existing aggregation pipeline.
    const entries = collectMcpEntries(app, session, { runtimeName });
    const mcpServers = toAcpMcpServers(entries);

    const res = await client.launch({
      sessionId: session.id,
      command,
      acpFlags,
      workdir: session.workdir ?? process.cwd(),
      env,
      hostCapabilities: {
        fs: cfg.host_capabilities?.fs ?? { read_text_file: true, write_text_file: true },
        terminal: cfg.host_capabilities?.terminal ?? true,
      },
      grantAllPermissions: !!cfg.grant_all_permissions && runtime._source !== "global",
      mcpServers,
      acpSessionId: (session as any).agent_acp_session_id ?? undefined,
      protocolVersion: cfg.protocol_version,
      maxTerminalsPerSession: cfg.max_terminals_per_session ?? 4,
      sessionNewMeta: Object.keys(metaExtras).length > 0 ? metaExtras : undefined,
    });

    if (res.acp_session_id) {
      app.sessions.update(session.id, { agent_acp_session_id: res.acp_session_id } as any);
    }
    return { ok: true as const, handle: session.id };
  },

  async send(handle: string, text: string): Promise<void> {
    const app = (await import("../app.js")).getApp();
    const session = app.sessions.get(handle);
    if (!session) throw new Error("no session: " + handle);
    const { arkdUrl, tenantId, token } = resolveArkdEndpoint(app, session);
    const client = createArkdAcpClient({ baseUrl: arkdUrl, token, tenantId });
    const turnId = crypto.randomUUID();
    await client.send(handle, turnId, text);
  },

  async kill(handle: string): Promise<void> {
    const app = (await import("../app.js")).getApp();
    const session = app.sessions.get(handle);
    if (!session) return;
    const { arkdUrl, tenantId, token } = resolveArkdEndpoint(app, session);
    const client = createArkdAcpClient({ baseUrl: arkdUrl, token, tenantId });
    await client.close(handle);
  },

  async status(): Promise<"running" | "stopped" | "unknown"> {
    return "unknown";
  },

  async capture(): Promise<string> {
    return "";
  },
};

function resolveArkdEndpoint(app: AppContext, session: Session): { arkdUrl: string; tenantId: string | null; token: string | null } {
  const { compute } = resolveProvider(session);
  const baseUrl = (compute as any)?.arkd_url ?? "http://127.0.0.1:" + app.config.ports.arkd;
  return {
    arkdUrl: baseUrl,
    tenantId: (session as any).tenant_id ?? null,
    token: process.env.ARK_ARKD_TOKEN ?? null,
  };
}
```

- [ ] **Step 4: Run tests, expect pass.**

Run: `make test-file F=packages/core/executors/__tests__/agent-acp.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/core/executors/agent-acp.ts packages/core/executors/__tests__/agent-acp.test.ts
git commit -m "feat(agent-acp): core executor for agent-acp runtime type"
```

---

### Task 19: Register executor in dispatch registry

**Files:**
- Modify: `packages/core/services/dispatch.ts` (or wherever `getExecutor` is defined -- grep if needed)

- [ ] **Step 1: Find registration site.**

Run: `grep -rn "getExecutor\|pluginRegistry.executor" packages/core --include="*.ts" | head -20`

- [ ] **Step 2: Add entry.**

Wherever runtime-type-to-executor mapping lives (e.g. an `executorByRuntimeType` map or similar), add:

```ts
  "agent-acp": agentAcpExecutor,
```

Add import:

```ts
import { agentAcpExecutor } from "../executors/agent-acp.js";
```

- [ ] **Step 3: Smoke-test by launching a session through the full orchestration stack.**

Write a short integration test at `packages/core/__tests__/agent-acp-orchestration.test.ts` that creates a session with `agent: "gemini-acp"` pointed at the mock agent and verifies the session row ends up with `agent_acp_session_id` populated. (Build on the existing session-service tests for the exact pattern.)

- [ ] **Step 4: Run tests.**

Run: `make test-file F=packages/core/__tests__/agent-acp-orchestration.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/core/services/dispatch.ts packages/core/__tests__/agent-acp-orchestration.test.ts
git commit -m "feat(agent-acp): register executor in dispatch registry"
```

---

## Phase 7 -- Conductor-side channel handling + watchdogs

### Task 20: Conductor channel handler for `agent_acp_*` events

**Files:**
- Modify: the file that owns `/api/channel/<sid>` POST handling. Locate via `grep -rn "api/channel" packages/core packages/server --include="*.ts"`.

- [ ] **Step 1: Find the handler.**

Typical location: `packages/core/services/channel.ts` or `packages/server/channel.ts`. Search for `channel_report` or the string `/api/channel/`.

- [ ] **Step 2: Add branch for agent-acp events.**

Inside the existing handler that receives channel reports, add a branch that recognizes `agent_acp_*` event types and:

- For `agent_acp_message_chunk` and `agent_acp_thought_chunk`: call `app.messages.upsertStreamingChunk(sessionId, data.turn_id, data.role ?? "assistant", extractText(data.block))`.
- For `agent_acp_turn_completed`: call `app.messages.finalizeTurn(sessionId, data.turn_id, data.stop_reason, !!data.partial)`. Cancel the inactivity watchdog for that session.
- For `agent_acp_ready`: persist `agent_acp_capabilities_json` on the session.
- For every `agent_acp_*` event: reset the inactivity watchdog (see Task 22).

```ts
function extractText(block: any): string {
  if (!block) return "";
  if (block.type === "text") return block.text ?? "";
  if (block.type === "image") return "[image]";
  if (block.type === "diff") return "[diff]";
  if (block.type === "terminal") return "[terminal:" + block.terminalId + "]";
  if (block.type === "resource_link") return block.uri ?? "";
  return "";
}
```

- [ ] **Step 3: Write a test that POSTs a sequence of agent_acp_message_chunk events and checks messages table.**

```ts
// packages/core/__tests__/agent-acp-channel-handler.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";

describe("channel handler for agent_acp_*", () => {
  let app: AppContext;
  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });
  afterAll(async () => {
    await app?.shutdown();
    clearApp();
  });

  test("chunks upsert one streaming row and finalize flips it", async () => {
    const session = app.sessions.create({ ticket: "T", summary: "x", repo: ".", branch: "main", compute_name: "local", agent: "gemini-acp", flow: "quick", workdir: "." });
    const url = "http://127.0.0.1:" + app.config.ports.conductor + "/api/channel/" + session.id;
    const headers = { "content-type": "application/json" };
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ type: "agent_acp_message_chunk", data: { turn_id: "t1", role: "assistant", block: { type: "text", text: "hello" } } }) });
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ type: "agent_acp_message_chunk", data: { turn_id: "t1", role: "assistant", block: { type: "text", text: " world" } } }) });
    let msgs = app.messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("hello world");
    expect((msgs[0] as any).streaming).toBe(1);
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ type: "agent_acp_turn_completed", data: { turn_id: "t1", stop_reason: "end_turn", partial: false } }) });
    msgs = app.messages.list(session.id);
    expect((msgs[0] as any).streaming).toBe(0);
    expect((msgs[0] as any).stop_reason).toBe("end_turn");
  });
});
```

- [ ] **Step 4: Run tests.**

Run: `make test-file F=packages/core/__tests__/agent-acp-channel-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/core/services/channel.ts packages/core/__tests__/agent-acp-channel-handler.test.ts
git commit -m "feat(agent-acp): conductor channel handler upserts streaming messages"
```

---

### Task 21: Inactivity + pre-first-update watchdogs (conductor)

**Files:**
- Create: `packages/core/agent-acp/watchdog.ts`
- Modify: the channel handler file from Task 20 to hook in/out of the watchdog.
- Create: `packages/core/__tests__/agent-acp-watchdog.test.ts`

- [ ] **Step 1: Write tests with compressed timeouts.**

```ts
// packages/core/__tests__/agent-acp-watchdog.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { AgentAcpWatchdog } from "../agent-acp/watchdog.js";

describe("AgentAcpWatchdog", () => {
  let app: AppContext;
  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });
  afterAll(async () => {
    await app?.shutdown();
    clearApp();
  });

  test("pre-first-update timeout finalizes with stop_reason=timeout", async () => {
    const session = app.sessions.create({ ticket: "T", summary: "x", repo: ".", branch: "main", compute_name: "local", agent: "gemini-acp", flow: "quick", workdir: "." });
    app.messages.upsertStreamingChunk(session.id, "t1", "assistant", "");
    const wd = new AgentAcpWatchdog(app, { preFirstUpdateMs: 50, inactivityMs: 500 });
    wd.armForTurn(session.id, "t1");
    await new Promise((r) => setTimeout(r, 100));
    const msgs = app.messages.list(session.id);
    expect((msgs[0] as any).streaming).toBe(0);
    expect((msgs[0] as any).stop_reason).toBe("timeout");
    expect((msgs[0] as any).partial).toBe(1);
    wd.dispose();
  });

  test("kick on each update resets timer", async () => {
    const session = app.sessions.create({ ticket: "T", summary: "y", repo: ".", branch: "main", compute_name: "local", agent: "gemini-acp", flow: "quick", workdir: "." });
    app.messages.upsertStreamingChunk(session.id, "t2", "assistant", "");
    const wd = new AgentAcpWatchdog(app, { preFirstUpdateMs: 50, inactivityMs: 100 });
    wd.armForTurn(session.id, "t2");
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 60));
      wd.kick(session.id, "t2"); // still running
    }
    expect((app.messages.list(session.id)[0] as any).streaming).toBe(1);
    wd.dispose();
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**

Run: `make test-file F=packages/core/__tests__/agent-acp-watchdog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement watchdog.**

```ts
// packages/core/agent-acp/watchdog.ts
import type { AppContext } from "../app.js";

interface TurnTimer {
  sessionId: string;
  turnId: string;
  firstUpdateSeen: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentAcpWatchdog {
  private timers = new Map<string, TurnTimer>(); // key: sessionId + "|" + turnId
  constructor(private app: AppContext, private opts: { preFirstUpdateMs: number; inactivityMs: number }) {}

  armForTurn(sessionId: string, turnId: string): void {
    const key = sessionId + "|" + turnId;
    if (this.timers.has(key)) return;
    const entry: TurnTimer = {
      sessionId, turnId, firstUpdateSeen: false,
      timer: setTimeout(() => this.fire(key, "pre_first_update"), this.opts.preFirstUpdateMs),
    };
    this.timers.set(key, entry);
  }

  kick(sessionId: string, turnId: string): void {
    const key = sessionId + "|" + turnId;
    const entry = this.timers.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.firstUpdateSeen = true;
    entry.timer = setTimeout(() => this.fire(key, "inactivity"), this.opts.inactivityMs);
  }

  clear(sessionId: string, turnId: string): void {
    const key = sessionId + "|" + turnId;
    const entry = this.timers.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.timers.delete(key);
  }

  dispose(): void {
    for (const [, entry] of this.timers) clearTimeout(entry.timer);
    this.timers.clear();
  }

  private fire(key: string, reason: "pre_first_update" | "inactivity"): void {
    const entry = this.timers.get(key);
    if (!entry) return;
    this.timers.delete(key);
    this.app.messages.finalizeTurn(entry.sessionId, entry.turnId, "timeout", true);
    this.app.events.log(entry.sessionId, "agent_acp_turn_completed", {
      actor: "system",
      data: { turn_id: entry.turnId, stop_reason: "timeout", partial: true, reason },
    });
    // Best-effort arkd cancel (fire-and-forget).
    // (arkd URL resolution identical to executor's resolveArkdEndpoint)
  }
}
```

- [ ] **Step 4: Wire the watchdog into the channel handler.**

In the handler modified in Task 20:

- Instantiate one `AgentAcpWatchdog` per `AppContext` (add to `AppContext.initialize` or similar).
- On `agent_acp_message_chunk | agent_acp_thought_chunk | agent_acp_plan | agent_acp_tool_call | agent_acp_tool_call_update`: call `watchdog.kick(sessionId, data.turn_id)`. Before first chunk, arm via `armForTurn` when the `send()` path fires -- patch `session-output.ts:send()` or the executor's `send()` to call `watchdog.armForTurn(sessionId, turnId)` when a turn starts. Pull the `turnId` generation up from the executor to a shared spot so the conductor can arm the watchdog at send time.
- On `agent_acp_turn_completed`: call `watchdog.clear(sessionId, data.turn_id)`.

Read timeouts from the runtime YAML (`cfg.inactivity_timeout_seconds ?? 900`, `cfg.pre_first_update_timeout_seconds ?? 60`).

- [ ] **Step 5: Run tests.**

Run: `make test-file F=packages/core/__tests__/agent-acp-watchdog.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit.**

```bash
make format
make lint
git add packages/core/agent-acp/watchdog.ts packages/core/__tests__/agent-acp-watchdog.test.ts packages/core/services/channel.ts
git commit -m "feat(agent-acp): inactivity + pre-first-update watchdogs"
```

---

### Task 22: Conductor crash recovery

**Files:**
- Modify: conductor boot path (search: `grep -rn "conductor.*boot\|conductorBoot\|startConductor" packages/core --include="*.ts"`). Typically `packages/core/services/conductor.ts` or similar.

- [ ] **Step 1: Add recovery function.**

Create `packages/core/agent-acp/recovery.ts`:

```ts
// packages/core/agent-acp/recovery.ts
import type { AppContext } from "../app.js";
import { createArkdAcpClient } from "./arkd-client.js";
import { resolveProvider } from "../provider-registry.js";

/**
 * On conductor boot, finalize any streaming messages that belong to
 * agent-acp sessions whose arkd-side subprocess is gone.
 */
export async function recoverAgentAcpStreamingMessages(app: AppContext): Promise<void> {
  const runningSessions = app.sessions.listRunning();
  for (const s of runningSessions) {
    const runtime = app.runtimes.get(s.agent);
    if (runtime?.type !== "agent-acp") continue;
    const streamingMsgs = app.messages.list(s.id).filter((m: any) => m.streaming === 1);
    if (streamingMsgs.length === 0) continue;
    try {
      const { compute } = resolveProvider(s);
      const baseUrl = (compute as any)?.arkd_url ?? "http://127.0.0.1:" + app.config.ports.arkd;
      const client = createArkdAcpClient({ baseUrl, token: process.env.ARK_ARKD_TOKEN });
      // If the arkd side has no session, close() is a no-op and we can finalize.
      await client.close(s.id).catch(() => {});
    } catch {
      // Unreachable arkd -- continue to finalize anyway.
    }
    for (const m of streamingMsgs) {
      app.messages.finalizeTurn(s.id, (m as any).turn_id, "interrupted", true);
    }
  }
}
```

- [ ] **Step 2: Invoke on conductor boot.**

In the conductor boot path, after DB init and before accepting HTTP:

```ts
await recoverAgentAcpStreamingMessages(app);
```

- [ ] **Step 3: Commit.**

```bash
make format
make lint
git add packages/core/agent-acp/recovery.ts packages/core/services/conductor.ts  # adjust path
git commit -m "feat(agent-acp): conductor boot recovery for dangling streaming messages"
```

---

## Phase 8 -- UI layer

### Task 23: Extend `useSessionStream` with streaming-chunk upsert

**Files:**
- Modify: `packages/web/src/hooks/useSessionStream.ts`

- [ ] **Step 1: Locate the SSE reducer.**

Open the file and find where incoming events update a React state / TanStack cache. Pattern is likely a `switch (event.type)` or an `onEvent(ev)` handler.

- [ ] **Step 2: Add handler.**

```ts
case "agent_acp_message_chunk":
case "agent_acp_thought_chunk": {
  const turnId = event.data?.turn_id;
  const text = extractText(event.data?.block);
  if (!turnId) break;
  setMessages((prev) => upsertStreaming(prev, turnId, event.type === "agent_acp_thought_chunk" ? "thought" : "assistant", text));
  break;
}
case "agent_acp_turn_completed": {
  const turnId = event.data?.turn_id;
  setMessages((prev) => prev.map((m) => (m.turn_id === turnId && m.streaming) ? { ...m, streaming: false, stop_reason: event.data.stop_reason, partial: !!event.data.partial } : m));
  break;
}

function extractText(block: any): string {
  if (!block) return "";
  if (block.type === "text") return block.text ?? "";
  return "";
}

function upsertStreaming(prev: any[], turnId: string, role: "assistant" | "thought", chunk: string): any[] {
  const existing = prev.find((m) => m.turn_id === turnId && m.role === role && m.streaming);
  if (existing) {
    return prev.map((m) => m === existing ? { ...m, content: (m.content ?? "") + chunk } : m);
  }
  return [...prev, { id: "streaming-" + turnId + "-" + role, turn_id: turnId, role, content: chunk, streaming: true, partial: false }];
}
```

- [ ] **Step 3: Commit.**

```bash
make format
make lint
git add packages/web/src/hooks/useSessionStream.ts
git commit -m "feat(agent-acp): streaming-chunk upsert in session stream hook"
```

---

### Task 24: Extend `event-builder.tsx` dispatch

**Files:**
- Modify: `packages/web/src/components/session/event-builder.tsx`

- [ ] **Step 1: Add branches to `buildRichTimelineEvent`.**

In the big if/else-if chain, before the `else` fallback, add:

```ts
} else if (evType === "agent_acp_ready") {
  label = <span>ACP agent ready{data.acp_session_id && <span className="text-[var(--fg-muted)]"> ({String(data.acp_session_id).slice(0, 8)})</span>}</span>;
  color = "blue";
} else if (evType === "agent_acp_message_chunk" || evType === "agent_acp_thought_chunk") {
  // Rendered inline in chat, not in timeline. Return a minimal entry.
  label = <span className="text-[var(--fg-muted)]">chunk</span>;
  color = "gray";
} else if (evType === "agent_acp_plan") {
  const n = Array.isArray(data.entries) ? data.entries.length : 0;
  label = <span>Plan updated ({n} {n === 1 ? "step" : "steps"})</span>;
  color = "blue";
} else if (evType === "agent_acp_tool_call" || evType === "agent_acp_tool_call_update") {
  const title = data.title ?? data.tool_call_id;
  const status = data.status ?? "updated";
  label = <span>Tool <strong>{title}</strong> -- {status}</span>;
  color = status === "failed" ? "red" : status === "completed" ? "green" : "blue";
} else if (evType === "agent_acp_permission_request") {
  label = <span>Permission requested: <strong>{data.tool_call?.title ?? ""}</strong></span>;
  color = "amber";
} else if (evType === "agent_acp_permission_resolved") {
  label = <span>Permission {data.outcome} ({data.actor})</span>;
  color = data.outcome === "granted" ? "green" : "red";
} else if (evType === "agent_acp_turn_completed") {
  label = <span>Turn completed: <strong>{data.stop_reason}</strong>{data.partial ? " (partial)" : ""}</span>;
  color = data.partial ? "amber" : "green";
} else if (evType === "agent_acp_agent_exited") {
  label = <span>ACP agent exited (code {data.exit_code ?? "?"}, signal {data.signal ?? "-"})</span>;
  color = "red";
} else if (evType === "agent_acp_resume_fallback") {
  label = <span>Resumed without prior context</span>;
  color = "amber";
} else if (evType === "agent_acp_protocol_violation") {
  label = <span>Protocol violation: {String(data.detail ?? "")}</span>;
  color = "red";
```

- [ ] **Step 2: Commit.**

```bash
make format
make lint
git add packages/web/src/components/session/event-builder.tsx
git commit -m "feat(agent-acp): event-builder dispatch for agent_acp_* events"
```

---

### Task 25: Upgrade `AgentMessage` with streaming/partial props

**Files:**
- Modify: `packages/web/src/components/session/AgentMessage.tsx` (locate via `grep -rn "export.*function.*AgentMessage\|AgentMessage =" packages/web/src --include="*.tsx"`)

- [ ] **Step 1: Extend the props.**

```ts
interface AgentMessageProps {
  content: string;
  streaming?: boolean;
  partial?: boolean;
  stopReason?: string;
  // existing props
}
```

- [ ] **Step 2: Render states.**

- `streaming && !partial`: show blinking caret, disable copy/edit.
- `!streaming && stopReason === "end_turn"`: no badge.
- `!streaming && stopReason === "refusal"`: neutral "agent declined" badge.
- `!streaming && stopReason === "max_tokens"`: amber "truncated -- token limit" badge + Continue button (calls `send("")`).
- `!streaming && stopReason === "max_turn_requests"`: amber "truncated -- turn step limit" badge.
- `!streaming && stopReason === "cancelled"`: gray "(cancelled)" marker, dim text.
- `!streaming && stopReason === "timeout"`: red "agent did not respond" banner + Retry button.
- `!streaming && stopReason === "interrupted"`: red "agent process exited" banner + Retry button.

Concrete render:

```tsx
export function AgentMessage(props: AgentMessageProps) {
  const { content, streaming, partial, stopReason } = props;
  const dim = stopReason === "cancelled";
  return (
    <div className={"agent-message" + (dim ? " opacity-60" : "")}>
      <MarkdownContent content={content} />
      {streaming && <span className="inline-block ml-1 w-[8px] h-[14px] bg-[var(--primary)] animate-pulse" aria-label="streaming" />}
      {!streaming && stopReason === "refusal" && <Badge kind="neutral">agent declined</Badge>}
      {!streaming && stopReason === "max_tokens" && <><Badge kind="amber">truncated -- token limit</Badge><ContinueButton /></>}
      {!streaming && stopReason === "max_turn_requests" && <Badge kind="amber">truncated -- turn step limit</Badge>}
      {!streaming && stopReason === "cancelled" && <span className="text-[var(--fg-muted)]"> (cancelled)</span>}
      {!streaming && stopReason === "timeout" && <><Banner kind="red">agent did not respond</Banner><RetryButton /></>}
      {!streaming && stopReason === "interrupted" && <><Banner kind="red">agent process exited</Banner><RetryButton /></>}
    </div>
  );
}
```

Use existing `Badge` / `Banner` components if they exist; otherwise inline the styles following the existing design-token pattern (`var(--waiting)`, `var(--failed)`, etc.).

- [ ] **Step 3: Write a React-testing-library test.**

```tsx
// packages/web/src/components/session/__tests__/AgentMessage.test.tsx
import { describe, test, expect } from "bun:test";
import { render } from "@testing-library/react";
import { AgentMessage } from "../AgentMessage.js";

describe("AgentMessage states", () => {
  test("streaming renders blinking caret", () => {
    const { container } = render(<AgentMessage content="hi" streaming />);
    expect(container.querySelector("[aria-label=streaming]")).not.toBeNull();
  });
  test("timeout shows red banner + retry", () => {
    const { getByText } = render(<AgentMessage content="" streaming={false} stopReason="timeout" />);
    expect(getByText(/agent did not respond/i)).toBeTruthy();
    expect(getByText(/retry/i)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run tests.**

Run: `make test-file F=packages/web/src/components/session/__tests__/AgentMessage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
make format
make lint
git add packages/web/src/components/session/AgentMessage.tsx packages/web/src/components/session/__tests__/AgentMessage.test.tsx
git commit -m "feat(agent-acp): AgentMessage streaming + partial states"
```

---

### Task 26: `AgentPlan` component

**Files:**
- Create: `packages/web/src/components/session/AgentPlan.tsx`

- [ ] **Step 1: Implement.**

```tsx
// packages/web/src/components/session/AgentPlan.tsx
interface PlanEntry { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed"; }

export function AgentPlan({ entries }: { entries: PlanEntry[] }) {
  if (!entries?.length) return null;
  const drawer = entries.length > 6;
  return (
    <div className={drawer ? "agent-plan-drawer" : "agent-plan-inline rounded border border-[var(--border)] p-2 my-2"}>
      <div className="font-medium mb-1">Plan</div>
      <ul className="list-none pl-0 m-0">
        {entries.map((e, i) => (
          <li key={i} className="flex items-center gap-2 text-[13px] py-0.5">
            <span aria-label={e.status}>{e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}</span>
            <span className={"text-[10px] uppercase px-1.5 py-0.5 rounded " + (e.priority === "high" ? "bg-[var(--failed)]/20" : e.priority === "low" ? "bg-[var(--fg-muted)]/10" : "bg-[var(--waiting)]/20")}>{e.priority}</span>
            <span className={e.status === "completed" ? "line-through opacity-70" : ""}>{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Hook into chat rendering.**

Wherever the chat body renders events by type, add a branch for `agent_acp_plan` that renders `<AgentPlan entries={...} />` using only the most recent plan event per session.

- [ ] **Step 3: Commit.**

```bash
make format
make lint
git add packages/web/src/components/session/AgentPlan.tsx
git commit -m "feat(agent-acp): AgentPlan component"
```

---

### Task 27: `PermissionPrompt` component + action

**Files:**
- Create: `packages/web/src/components/session/PermissionPrompt.tsx`
- Modify: the conductor-facing RPC client used by the web package (search for `sendRpc` / `arkClient`) to expose a `permissionReply(sessionId, requestId, outcome, selectedOptionId?)` method.

- [ ] **Step 1: Implement component.**

```tsx
// packages/web/src/components/session/PermissionPrompt.tsx
import { useState } from "react";

interface PermissionPromptProps {
  requestId: string;
  toolCall: { toolCallId: string; title: string; kind?: string };
  options: Array<{ optionId: string; label: string; kind?: string }>;
  resolved?: { outcome: "granted" | "denied" | "cancelled"; actor: string };
  onReply: (outcome: "granted" | "denied" | "cancelled", optionId?: string) => Promise<void>;
}

export function PermissionPrompt({ requestId, toolCall, options, resolved, onReply }: PermissionPromptProps) {
  const [busy, setBusy] = useState(false);
  const disabled = busy || !!resolved;
  async function click(outcome: "granted" | "denied" | "cancelled", optionId?: string) {
    if (disabled) return;
    setBusy(true);
    try { await onReply(outcome, optionId); } finally { setBusy(false); }
  }
  return (
    <div className="permission-prompt rounded border border-[var(--waiting)] p-2 my-2" role="group" aria-label="permission request">
      <div className="font-medium">Permission requested</div>
      <div className="text-[13px] text-[var(--fg-muted)]">{toolCall.title}</div>
      {resolved ? (
        <div className="mt-2 text-[13px]"><strong>{resolved.outcome}</strong> <span className="text-[var(--fg-muted)]">({resolved.actor})</span></div>
      ) : (
        <div className="mt-2 flex gap-2">
          {options.map((o) => (
            <button key={o.optionId} disabled={disabled} onClick={() => click(o.kind === "deny" ? "denied" : "granted", o.optionId)} className="px-3 py-1 rounded bg-[var(--primary)] text-white disabled:opacity-50">{o.label}</button>
          ))}
          <button disabled={disabled} onClick={() => click("denied")} className="px-3 py-1 rounded border border-[var(--border)] disabled:opacity-50">Deny</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire chat rendering.**

When an `agent_acp_permission_request` event arrives, render `<PermissionPrompt>` inline at that position in the chat. When an `agent_acp_permission_resolved` event with the same `request_id` arrives, re-render with the `resolved` prop. Action: `onReply` calls the conductor RPC `agentAcp.permissionReply(sessionId, requestId, outcome, optionId)`, which translates to an HTTP POST to arkd's `/agent-acp/permission-reply`.

- [ ] **Step 3: Commit.**

```bash
make format
make lint
git add packages/web/src/components/session/PermissionPrompt.tsx
git commit -m "feat(agent-acp): PermissionPrompt inline card"
```

---

### Task 28: `AgentThought`, `ToolCallRow` upgrade, `TerminalResultBlock`, `ModePill`, `AgentAcpFrameLog`

**Files:**
- Create: `packages/web/src/components/session/AgentThought.tsx`
- Create: `packages/web/src/components/session/TerminalResultBlock.tsx`
- Create: `packages/web/src/components/session/ModePill.tsx`
- Create: `packages/web/src/components/session/AgentAcpFrameLog.tsx`
- Modify: `packages/web/src/components/session/ToolCallRow.tsx` (find via grep)

**Implement each in turn, commit per component.**

- [ ] **Step 1: `AgentThought` (~30 LoC).**

```tsx
// AgentThought.tsx
import { useState } from "react";

export function AgentThought({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const preview = content.split("\n")[0].slice(0, 80);
  return (
    <div className="agent-thought text-[12px] text-[var(--fg-muted)] my-1">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="underline">
        {open ? "Hide thinking" : "Thinking: " + preview + (content.length > 80 ? "..." : "")}
      </button>
      {open && <pre className="whitespace-pre-wrap mt-1 p-2 rounded bg-[var(--bg-subtle)]">{content}</pre>}
    </div>
  );
}
```

Commit: `feat(agent-acp): AgentThought collapsible component`

- [ ] **Step 2: `TerminalResultBlock`.**

```tsx
// TerminalResultBlock.tsx
export function TerminalResultBlock({ output, exitCode, signal }: { output: string; exitCode?: number | null; signal?: string | null }) {
  return (
    <div className="terminal-result border rounded border-[var(--border)] my-2">
      <pre className="p-2 m-0 max-h-[15lh] overflow-auto text-[12px] font-[family-name:var(--font-mono)] bg-[var(--bg-terminal)] text-[var(--fg-terminal)]">{output}</pre>
      <div className="px-2 py-1 text-[11px] border-t border-[var(--border)] flex justify-between text-[var(--fg-muted)]">
        <span>terminal</span>
        <span>{exitCode !== null && exitCode !== undefined ? "exit " + exitCode : (signal ? "signal " + signal : "running")}</span>
      </div>
    </div>
  );
}
```

Commit: `feat(agent-acp): TerminalResultBlock`

- [ ] **Step 3: `ModePill`.**

```tsx
// ModePill.tsx
import { useState } from "react";
export function ModePill({ current, available, onChange }: { current: string; available: Array<{ id: string; label: string }>; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inline-block relative">
      <button onClick={() => setOpen(!open)} className="px-2 py-0.5 rounded-full bg-[var(--primary)]/10 text-[12px]">{current}</button>
      {open && (
        <ul className="absolute mt-1 z-10 bg-[var(--bg)] border border-[var(--border)] rounded shadow">
          {available.map((m) => (
            <li key={m.id}><button onClick={() => { onChange(m.id); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-[var(--bg-subtle)]">{m.label}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Commit: `feat(agent-acp): ModePill`

- [ ] **Step 4: `AgentAcpFrameLog`.**

```tsx
// AgentAcpFrameLog.tsx
interface Frame { direction: "in" | "out"; method?: string; id?: string | number; payload_preview: string; timestamp: string; }
export function AgentAcpFrameLog({ frames }: { frames: Frame[] }) {
  return (
    <div className="frame-log font-[family-name:var(--font-mono)] text-[11px]">
      {frames.map((f, i) => (
        <details key={i} className="border-b border-[var(--border)] py-1">
          <summary>
            <span className="mr-2">{f.direction === "in" ? "←" : "→"}</span>
            <span className="mr-2 text-[var(--fg-muted)]">{f.timestamp}</span>
            <span>{f.method ?? "(response)"}</span>
            {f.id !== undefined && <span className="ml-2 text-[var(--fg-muted)]">id={f.id}</span>}
          </summary>
          <pre className="whitespace-pre-wrap p-1">{f.payload_preview}</pre>
        </details>
      ))}
    </div>
  );
}
```

Wire fetch from conductor's read-only frame-log endpoint (add one: `GET /api/agent-acp/frames/:sessionId`) that returns the ring buffer from Task 28b below.

Commit: `feat(agent-acp): AgentAcpFrameLog debug viewer`

- [ ] **Step 5: Conductor frame-log buffer.**

Add a per-session ring buffer to the channel handler (Task 20 file). When event type is `agent_acp_frame`, append to the ring. Add `GET /api/agent-acp/frames/:sessionId` that returns the ring contents.

Commit: `feat(agent-acp): per-session frame-log ring buffer`

- [ ] **Step 6: `ToolCallRow` upgrade.**

Upgrade to an expandable card with status dot + content-block stack. Render each content block via type dispatch: `text` -> `MarkdownContent`; `diff` -> existing `DiffViewer`; `terminal` -> fetch terminal result via a dedicated arkd endpoint or inline from the tool_call_update payload; `resource_link` -> clickable file-path chip.

Commit: `feat(agent-acp): ToolCallRow expandable card with content-block stack`

---

### Task 29: `ChatInput` slash-command autocomplete

**Files:**
- Modify: `packages/web/src/components/session/ChatInput.tsx`

- [ ] **Step 1: Add state for `availableCommands` and an autocomplete popup.**

Subscribe to `agent_acp_mode_change` events that carry `available_commands`. When the user types `/` at the start of the input (or after whitespace), show a dropdown of commands filtered by the prefix after `/`. Tab or Enter selects; Escape dismisses.

```tsx
// inside ChatInput
const [availableCommands, setAvailableCommands] = useState<Array<{ name: string; description?: string }>>([]);
// subscribe via useSessionStream() -- set on agent_acp_mode_change events

// in render, detect "/" prefix in the input value, show filtered popup
```

- [ ] **Step 2: Commit.**

```bash
make format
make lint
git add packages/web/src/components/session/ChatInput.tsx
git commit -m "feat(agent-acp): ChatInput slash-command autocomplete"
```

---

### Task 30: Conditional tab layout for ACP sessions

**Files:**
- Modify: `packages/web/src/components/SessionDetail.tsx`

- [ ] **Step 1: Branch on runtime type.**

```tsx
const runtime = useRuntime(session.agent);
const isAcp = runtime?.type === "agent-acp";
// render tabs conditionally:
// non-ACP: Timeline | Terminal | Output | Cost ...
// ACP: Timeline | Frame Log | Cost ...  (Terminal tab hidden; Output tab retained but hidden)
```

- [ ] **Step 2: Commit.**

```bash
make format
make lint
git add packages/web/src/components/SessionDetail.tsx
git commit -m "feat(agent-acp): conditional tab layout for ACP sessions"
```

---

## Phase 9 -- End-to-end + docs

### Task 31: Full-stack e2e test with mock agent

**Files:**
- Create: `packages/core/__tests__/agent-acp-e2e.test.ts`

- [ ] **Step 1: Write e2e covering create session -> launch -> send -> stream chunks -> turn end -> close.**

```ts
// packages/core/__tests__/agent-acp-e2e.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "../agent-acp/__tests__/fixtures/mock-agent.ts");

describe("agent-acp e2e", () => {
  let app: AppContext;
  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });
  afterAll(async () => { await app?.shutdown(); clearApp(); });

  test("create -> launch -> send -> stream -> finalize", async () => {
    // Install mock-acp runtime into the store for this test.
    (app.runtimes as any).get = (n: string) => n === "mock-acp" ? {
      name: "mock-acp", type: "agent-acp",
      agent_acp: { command: ["bun", "run", FIXTURE], grant_all_permissions: true, host_capabilities: { fs: {}, terminal: false } },
      models: [{ id: "m", label: "m" }], default_model: "m",
    } : null;

    const session = app.sessions.create({ ticket: "T", summary: "e2e", repo: ".", branch: "main", compute_name: "local-arkd", agent: "mock-acp", flow: "quick", workdir: process.cwd() });
    await app.sessionService.start(session.id, { env: { MOCK_ACP_MODE: "well_behaved" } });

    await app.sessionService.send(session.id, "hello");
    await new Promise((r) => setTimeout(r, 800));

    const msgs = app.messages.list(session.id);
    const assistant = msgs.find((m: any) => m.role === "assistant" && m.turn_id);
    expect(assistant).toBeDefined();
    expect((assistant as any).streaming).toBe(0);
    expect((assistant as any).stop_reason).toBe("end_turn");
    expect(assistant!.content).toContain("hi");

    await app.sessionService.stop(session.id);
  });
});
```

- [ ] **Step 2: Run.**

Run: `make test-file F=packages/core/__tests__/agent-acp-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add packages/core/__tests__/agent-acp-e2e.test.ts
git commit -m "test(agent-acp): full-stack e2e with mock agent"
```

---

### Task 32: "Adding an ACP runtime" docs page

**Files:**
- Create: `docs/agent-acp-runtimes.md`

- [ ] **Step 1: Write the doc.**

```md
# Adding an ACP runtime

Ark supports agents that speak the Agent Client Protocol
(https://agentclientprotocol.com). Drop a YAML into `~/.ark/runtimes/` (or
this repo's `runtimes/` for built-ins) with `type: agent-acp` and the
subprocess command.

## Minimal example

```yaml
name: my-acp-agent
description: "My ACP agent"
type: agent-acp
agent_acp:
  command: ["my-acp-agent"]
  acp_flags: []
  model_delivery: cli_flag
  model_cli_flag: ["--model", "{model}"]
  grant_all_permissions: false
  host_capabilities:
    fs: { read_text_file: true, write_text_file: true }
    terminal: true
models:
  - { id: default, label: "Default" }
default_model: default
billing: { mode: api }
```

## `agent_acp` reference

(Copy the TS interface from `packages/types/agent.ts` and add prose
per field -- inactivity_timeout_seconds default 900, etc.)

## Permission flag safety

`grant_all_permissions: true` is honored only for runtimes from
`_source: builtin` or `_source: project`. User-installed (global)
runtimes always prompt.

## Session/load resume

If your ACP agent advertises `loadSession: true` in `initialize`, Ark
uses it to resume sessions after a close. Otherwise the user sees a
"resumed, prior context not preserved" divider.
```

- [ ] **Step 2: Commit.**

```bash
git add docs/agent-acp-runtimes.md
git commit -m "docs(agent-acp): author guide for adding an ACP runtime"
```

---

## Self-review checklist (plan author does this before handoff)

- [ ] Every spec §1 goal has a task.
- [ ] Every event name in spec §5 is produced somewhere in Tasks 11-14 or 20-22.
- [ ] Every UI component in spec §12.2 has a task in Phase 8.
- [ ] No `TBD`, `TODO`, `implement later` anywhere.
- [ ] Every task ends with a commit.
- [ ] Runtime YAML examples in Task 6 match the schema extension in Task 5.
- [ ] Schema deltas in Task 7 match spec §10.
- [ ] `model_delivery` plumbing lives in Task 5 (schema) and Task 18 (executor application).
- [ ] Watchdogs in Task 21 + Task 22 cover all four termination paths in spec §11.
