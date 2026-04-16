# Channels + tmux Dual Communication Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code Channels as the programmatic communication layer between Ark conductor and agent sessions, while keeping tmux for human attach/detach/deep-dive.

**Architecture:** Two communication paths -- Channels (MCP over stdio) for structured agent↔conductor messaging, tmux for human observation and interaction. The ark-channel MCP server runs alongside each Claude session, receiving task assignments and reporting progress/completion back. The conductor sends tasks via channel notifications, agents reply via channel tools. Humans can still `tmux attach` at any time.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk`, `bun:sqlite`, tmux

---

## Communication Architecture

```
┌─────────────┐     MCP Channel (stdio)      ┌──────────────────┐
│  Conductor   │◄─────────────────────────────►│  Claude Session   │
│  (ark core)  │   structured events + tools   │  (agent working)  │
└──────┬───────┘                               └────────┬─────────┘
       │                                                │
       │  HTTP localhost                                │  tmux pane
       │  (status, events)                              │  (terminal I/O)
       │                                                │
┌──────┴───────┐                               ┌────────┴─────────┐
│  TUI / CLI   │                               │  Human (attach)   │
│  (blessed)   │                               │  (tmux attach)    │
└──────────────┘                               └──────────────────┘
```

**When to use which:**

| Need | Use | Why |
|------|-----|-----|
| Send task to agent | Channel notification | Structured, in Claude's context |
| Agent reports completion | Channel reply tool | Updates conductor DB, advances pipeline |
| Agent asks question | Channel reply tool | Conductor routes to human or auto-answers |
| Human watches agent work | tmux capture-pane | Visual, real-time terminal output |
| Human steers agent | tmux attach + type | Interactive, bidirectional |
| Agent-to-agent handoff | Channel notification | Structured context transfer |
| Pipeline advancement | Channel reply → conductor | Automatic, no polling |
| Fork coordination | Channel reply per child | Parent monitors all children |

---

## File Structure

```
packages/core/
├── channel.ts          # CREATE: ark-channel MCP server (the bridge)
├── channel-types.ts    # CREATE: shared types for channel messages
├── conductor.ts        # CREATE: conductor loop (replaces polling with channel events)
├── session.ts          # MODIFY: dispatch uses channel instead of tmux send-keys
├── tmux.ts             # KEEP: human attach/detach/capture (unchanged)
├── store.ts            # KEEP: SQLite (unchanged)
├── hooks.ts            # MODIFY: wire event bus to channel events
├── pipeline.ts         # KEEP: (unchanged)
├── agent.ts            # MODIFY: add channel MCP config to claude args
└── index.ts            # MODIFY: export new modules
```

---

### Task 1: Install MCP SDK and set up channel types

**Files:**
- Modify: `packages/core/package.json` (via bun add)
- Create: `packages/core/channel-types.ts`

- [ ] **Step 1: Install MCP SDK**

```bash
cd ~/Projects/ark && bun add @modelcontextprotocol/sdk
```

- [ ] **Step 2: Write channel message types**

Create `packages/core/channel-types.ts`:

```typescript
/**
 * Shared types for Ark channel messages.
 *
 * These define the structured events sent between conductor and agents.
 */

/** Conductor → Agent: task assignment */
export interface TaskAssignment {
  type: "task";
  sessionId: string;
  stage: string;
  agent: string;
  task: string;
  handoff?: {
    previousStages: { stage: string; agent: string; summary?: string }[];
    planMd?: string;
    recentCommits?: string;
  };
}

/** Conductor → Agent: steering message (redirect, clarify) */
export interface SteerMessage {
  type: "steer";
  sessionId: string;
  message: string;
  from: string; // "conductor" | "human" | session-id
}

/** Conductor → Agent: stop/abort */
export interface AbortMessage {
  type: "abort";
  sessionId: string;
  reason: string;
}

/** Agent → Conductor: progress update */
export interface ProgressReport {
  type: "progress";
  sessionId: string;
  stage: string;
  message: string;
  toolCalls?: number;
  filesChanged?: string[];
}

/** Agent → Conductor: stage completed */
export interface CompletionReport {
  type: "completed";
  sessionId: string;
  stage: string;
  summary: string;
  filesChanged: string[];
  commits: string[];
  cost?: number;
  turns?: number;
}

/** Agent → Conductor: question for human */
export interface QuestionReport {
  type: "question";
  sessionId: string;
  stage: string;
  question: string;
  options?: string[];
}

/** Agent → Conductor: error */
export interface ErrorReport {
  type: "error";
  sessionId: string;
  stage: string;
  error: string;
}

export type InboundMessage = TaskAssignment | SteerMessage | AbortMessage;
export type OutboundMessage = ProgressReport | CompletionReport | QuestionReport | ErrorReport;
export type ChannelMessage = InboundMessage | OutboundMessage;
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/channel-types.ts
git commit -m "feat: add channel message types for conductor↔agent communication"
```

---

### Task 2: Build ark-channel MCP server

**Files:**
- Create: `packages/core/channel.ts`
- Test: manual test with `claude --dangerously-load-development-channels`

The channel server is an MCP server that:
1. Registers as a Claude channel (`experimental: { 'claude/channel': {} }`)
2. Exposes a `report` tool Claude can call to send structured messages back
3. Listens on a local HTTP port for inbound messages from the conductor
4. Pushes inbound messages to Claude via `mcp.notification()`

- [ ] **Step 1: Write the channel server**

Create `packages/core/channel.ts`:

```typescript
#!/usr/bin/env bun
/**
 * ark-channel: MCP server bridging Ark conductor ↔ Claude sessions.
 *
 * Inbound (conductor → Claude): task assignments, steering, context
 * Outbound (Claude → conductor): progress, completion, questions, errors
 *
 * Usage: started automatically by ark session dispatch.
 * Claude receives messages as <channel source="ark" ...> tags.
 * Claude reports back via the `report` tool.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { OutboundMessage } from "./channel-types.js";

// Session ID passed via env
const SESSION_ID = process.env.ARK_SESSION_ID ?? "unknown";
const CONDUCTOR_PORT = parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100");
const HTTP_PORT = parseInt(process.env.ARK_CHANNEL_PORT ?? "0");

// ── MCP Server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "ark", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "You are an Ark agent session. Messages from the Ark conductor arrive as <channel source=\"ark\"> tags.",
      "When you complete a stage, report via the `report` tool with type='completed'.",
      "When you have a question for the human, report via `report` with type='question'.",
      "When you encounter an error, report via `report` with type='error'.",
      "Periodically report progress via `report` with type='progress'.",
    ].join("\n"),
  }
);

// ── Report tool (Claude → Conductor) ────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "report",
      description:
        "Report progress, completion, questions, or errors back to the Ark conductor. " +
        "Use type='progress' for updates, 'completed' when stage is done, " +
        "'question' to ask the human, 'error' for failures.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["progress", "completed", "question", "error"],
            description: "Type of report",
          },
          message: {
            type: "string",
            description: "Report content -- summary, question text, or error message",
          },
          filesChanged: {
            type: "array",
            items: { type: "string" },
            description: "Files modified (for completed reports)",
          },
          commits: {
            type: "array",
            items: { type: "string" },
            description: "Commit hashes (for completed reports)",
          },
        },
        required: ["type", "message"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "report") {
    const args = req.params.arguments as Record<string, unknown>;
    const report: OutboundMessage = {
      type: args.type as any,
      sessionId: SESSION_ID,
      stage: process.env.ARK_STAGE ?? "",
      ...({
        message: args.message as string,
        summary: args.message as string,
        question: args.message as string,
        error: args.message as string,
        filesChanged: (args.filesChanged as string[]) ?? [],
        commits: (args.commits as string[]) ?? [],
      }),
    };

    // POST to conductor
    try {
      await fetch(`http://localhost:${CONDUCTOR_PORT}/api/channel/${SESSION_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
    } catch {
      // Conductor not running -- log locally
      console.error(`[ark-channel] Conductor unreachable: ${JSON.stringify(report)}`);
    }

    return { content: [{ type: "text", text: `Reported: ${args.type}` }] };
  }
  return { content: [{ type: "text", text: "Unknown tool" }] };
});

// ── HTTP server for inbound messages (Conductor → Claude) ───────────────────

if (HTTP_PORT > 0) {
  Bun.serve({
    port: HTTP_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "POST") {
        const body = await req.json();
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: body.message ?? body.task ?? JSON.stringify(body),
            meta: {
              type: body.type,
              session_id: body.sessionId ?? SESSION_ID,
              stage: body.stage,
              from: body.from ?? "conductor",
            },
          },
        });
        return new Response("ok");
      }
      return new Response("ark-channel", { status: 200 });
    },
  });
}

// ── Connect ─────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());
```

- [ ] **Step 2: Test channel server manually**

```bash
# Register as a development channel
cd ~/Projects/ark
echo '{"mcpServers":{"ark":{"command":"bun","args":["packages/core/channel.ts"],"env":{"ARK_SESSION_ID":"test","ARK_STAGE":"plan"}}}}' > /tmp/ark-mcp.json

# Start Claude with the channel
claude --mcp-config /tmp/ark-mcp.json --dangerously-load-development-channels server:ark
```

Verify: Claude starts, shows ark channel loaded. Type "report progress" -- Claude should call the `report` tool.

- [ ] **Step 3: Commit**

```bash
git add packages/core/channel.ts
git commit -m "feat: ark-channel MCP server for conductor↔agent communication"
```

---

### Task 3: Wire channel into session dispatch

**Files:**
- Modify: `packages/core/session.ts` (launchAgentTmux)
- Modify: `packages/core/agent.ts` (buildClaudeArgs)

Instead of `tmux.waitAndSend()` to inject the task, the channel server pushes the task as a notification. Claude receives it as `<channel source="ark" type="task">`.

- [ ] **Step 1: Add channel MCP config to agent launch**

Modify `packages/core/agent.ts` -- add function to generate channel MCP config:

```typescript
export function channelMcpConfig(sessionId: string, stage: string, channelPort: number): Record<string, unknown> {
  return {
    command: "bun",
    args: [join(__dirname, "..", "..", "packages", "core", "channel.ts")],
    env: {
      ARK_SESSION_ID: sessionId,
      ARK_STAGE: stage,
      ARK_CHANNEL_PORT: String(channelPort),
    },
  };
}
```

- [ ] **Step 2: Modify launchAgentTmux to include channel**

In `packages/core/session.ts`, update `launchAgentTmux`:

```typescript
// Allocate a port for this session's channel
const channelPort = 19200 + parseInt(session.id.replace("s-", ""), 16) % 1000;

// Add channel MCP to claude args
const mcpConfig = { ark: agentRegistry.channelMcpConfig(session.id, stage, channelPort) };
const mcpConfigPath = join(store.TRACKS_DIR, session.id, "mcp.json");
writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mcpConfig }));

// Add to launcher
launchContent = `#!/bin/bash
cd ${JSON.stringify(effectiveWorkdir)}
${claudeCmd} --session-id ${claudeSessionId} --dangerously-skip-permissions \\
  --mcp-config ${mcpConfigPath} \\
  --dangerously-load-development-channels server:ark
exec bash
`;
```

- [ ] **Step 3: Send task via channel HTTP instead of tmux send-keys**

Replace `tmux.waitAndSend()` with:

```typescript
// Send task via channel HTTP (structured, no tmux send-keys needed)
const channelUrl = `http://localhost:${channelPort}`;
spawn("bash", ["-c", [
  `while ! curl -sf ${channelUrl} > /dev/null 2>&1; do read -t 1 < /dev/null; done;`,
  `curl -sf -X POST ${channelUrl} -H 'Content-Type: application/json' \\`,
  `  -d '${JSON.stringify({ type: "task", task, sessionId: session.id, stage })}'`,
].join(" ")], { stdio: "ignore", detached: true }).unref();
```

- [ ] **Step 4: Test dispatch with channel**

```bash
rm -f ~/.ark/ark.db
ark session start T-1 -r /Users/paytmlabs/Projects/foundry-test-repo -s "Test channels" -p bare --dispatch
ark session attach <session-id>
# Should see: <channel source="ark" type="task"> with the task
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/session.ts packages/core/agent.ts
git commit -m "feat: dispatch agents via channel instead of tmux send-keys"
```

---

### Task 4: Build conductor HTTP server for channel replies

**Files:**
- Create: `packages/core/conductor.ts`
- Modify: `packages/core/hooks.ts` (wire channel events to event bus)

When agents call the `report` tool, the channel POSTs to the conductor. The conductor updates the DB, advances the pipeline, and broadcasts to the TUI.

- [ ] **Step 1: Write conductor HTTP server**

Create `packages/core/conductor.ts`:

```typescript
/**
 * Conductor: HTTP server that receives channel reports from agents.
 *
 * Routes:
 *   POST /api/channel/:sessionId -- receive agent report (progress/completed/question/error)
 *   GET  /api/sessions            -- list sessions (for TUI/web)
 *   GET  /api/sessions/:id        -- get session detail
 *   GET  /api/events/:id          -- get events
 *   GET  /health                  -- health check
 */

import * as store from "./store.js";
import * as session from "./session.js";
import { eventBus } from "./hooks.js";
import type { OutboundMessage } from "./channel-types.js";

const DEFAULT_PORT = 19100;

export function startConductor(port = DEFAULT_PORT): void {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Agent channel reports
      if (req.method === "POST" && path.startsWith("/api/channel/")) {
        const sessionId = path.split("/")[3]!;
        const report = await req.json() as OutboundMessage;
        handleReport(sessionId, report);
        return Response.json({ status: "ok" });
      }

      // REST API for TUI/web
      if (path === "/api/sessions") {
        return Response.json(store.listSessions());
      }
      if (path.startsWith("/api/sessions/")) {
        const id = path.split("/")[3]!;
        return Response.json(store.getSession(id));
      }
      if (path.startsWith("/api/events/")) {
        const id = path.split("/")[3]!;
        return Response.json(store.getEvents(id));
      }
      if (path === "/health") {
        return Response.json({ status: "ok", sessions: store.listSessions().length });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`Ark conductor listening on localhost:${port}`);
}

function handleReport(sessionId: string, report: OutboundMessage): void {
  store.logEvent(sessionId, `agent_${report.type}`, {
    stage: report.stage,
    actor: "agent",
    data: report as unknown as Record<string, unknown>,
  });

  // Emit to event bus (TUI subscribes)
  eventBus.emit(`agent_${report.type}`, sessionId, {
    stage: report.stage,
    data: report as unknown as Record<string, unknown>,
  });

  switch (report.type) {
    case "completed":
      store.updateSession(sessionId, { status: "ready", session_id: null });
      session.advance(sessionId);
      break;
    case "question":
      store.updateSession(sessionId, {
        status: "waiting",
        breakpoint_reason: (report as any).question,
      });
      break;
    case "error":
      store.updateSession(sessionId, {
        status: "failed",
        error: (report as any).error,
      });
      break;
    case "progress":
      // Just log, no state change
      break;
  }
}
```

- [ ] **Step 2: Wire conductor start into CLI**

Add to `packages/cli/index.ts`:

```typescript
program.command("conductor")
  .description("Start the conductor server")
  .option("-p, --port <port>", "Port", "19100")
  .action((opts) => {
    const { startConductor } = require("../core/conductor.js");
    startConductor(parseInt(opts.port));
    console.log("Conductor running. Press Ctrl+C to stop.");
    // Keep alive
    setInterval(() => {}, 1000 * 60);
  });
```

- [ ] **Step 3: Test conductor receives reports**

```bash
# Terminal 1: start conductor
ark conductor

# Terminal 2: send a fake report
curl -X POST localhost:19100/api/channel/s-test123 \
  -H 'Content-Type: application/json' \
  -d '{"type":"completed","sessionId":"s-test123","stage":"plan","summary":"Created PLAN.md"}'

# Terminal 1: should log the event
# Check DB:
ark session events s-test123
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/conductor.ts packages/cli/index.ts
git commit -m "feat: conductor HTTP server receives channel reports, advances pipeline"
```

---

### Task 5: Agent-to-agent communication via channels

**Files:**
- Modify: `packages/core/channel.ts` (add agent-to-agent relay)
- Modify: `packages/core/conductor.ts` (route messages between sessions)

When agent A needs to communicate with agent B (fork coordination, handoff), the message goes: A's channel → conductor → B's channel.

- [ ] **Step 1: Add `send_to_agent` tool to channel server**

In `packages/core/channel.ts`, add a second tool:

```typescript
{
  name: "send_to_agent",
  description: "Send a message to another Ark agent session (for coordination, handoff, or delegation)",
  inputSchema: {
    type: "object",
    properties: {
      target_session: { type: "string", description: "Target session ID (e.g., s-abc123)" },
      message: { type: "string", description: "Message to send" },
    },
    required: ["target_session", "message"],
  },
}
```

Handler: POST to conductor's `/api/relay` endpoint.

- [ ] **Step 2: Add relay endpoint to conductor**

```typescript
// POST /api/relay -- route message from one agent to another
if (req.method === "POST" && path === "/api/relay") {
  const { from, target, message } = await req.json();
  // Find target's channel port
  const targetSession = store.getSession(target);
  if (targetSession) {
    const channelPort = 19200 + parseInt(target.replace("s-", ""), 16) % 1000;
    await fetch(`http://localhost:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "steer", message, from, sessionId: target }),
    });
  }
  return Response.json({ status: "relayed" });
}
```

- [ ] **Step 3: Test agent-to-agent message**

```bash
# Fork two agents from a parent
ark session start T-1 -r /Users/paytmlabs/Projects/foundry-test-repo -s "Parent" -p bare --dispatch
ark session fork s-<parent> "Child task"

# Child agent can now call send_to_agent to communicate with parent
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/channel.ts packages/core/conductor.ts
git commit -m "feat: agent-to-agent communication via channel relay"
```

---

### Task 6: Auto-pipeline advancement via channel completion reports

**Files:**
- Modify: `packages/core/conductor.ts` (handleReport → auto-dispatch next stage)
- Modify: `packages/core/session.ts` (advance auto-dispatches)

When an agent reports `type: "completed"`, the conductor advances the pipeline and auto-dispatches the next agent stage -- fully automated for auto-gate stages.

- [ ] **Step 1: Enhance handleReport for auto-advancement**

In `packages/core/conductor.ts`:

```typescript
case "completed":
  store.updateSession(sessionId, { status: "ready", session_id: null });
  const advResult = session.advance(sessionId);
  if (advResult.ok) {
    // Check if next stage is an agent -- auto-dispatch
    const updated = store.getSession(sessionId);
    if (updated && updated.status === "ready") {
      const nextAction = pipeline.getStageAction(updated.pipeline, updated.stage!);
      if (nextAction.type === "agent" || nextAction.type === "fork") {
        session.dispatch(sessionId);
      }
    }
  }
  break;
```

- [ ] **Step 2: Test full pipeline flow**

```bash
# Start conductor
ark conductor &

# Create session with default pipeline (plan → implement → ... → close)
ark session start FLOW-1 -r /Users/paytmlabs/Projects/foundry-test-repo \
  -s "Full pipeline test" -p default --dispatch

# When planner reports completed (via channel), conductor:
# 1. Logs stage_completed event
# 2. Evaluates gate (plan has manual gate → blocks)
# 3. Manual: ark session advance s-xxx --force
# 4. Dispatches implementer automatically
# 5. When implementer reports completed → auto-advances to pr
# ... continues through pipeline
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/conductor.ts
git commit -m "feat: auto-pipeline advancement on channel completion reports"
```

---

### Task 7: Update TUI to show channel status

**Files:**
- Modify: `packages/tui/index.ts` (show channel connection status, live reports)

- [ ] **Step 1: Add channel status indicator**

In the detail pane, show whether the channel is connected:

```typescript
// Check channel health
const channelPort = 19200 + parseInt(s.id.replace("s-", ""), 16) % 1000;
try {
  const resp = await fetch(`http://localhost:${channelPort}`);
  lines.push(` {green-fg}⚡ Channel: connected (port ${channelPort}){/green-fg}`);
} catch {
  lines.push(` {gray-fg}⚡ Channel: not connected{/gray-fg}`);
}
```

- [ ] **Step 2: Show latest agent report in detail pane**

```typescript
// Show latest progress/question from events
const latestReport = events
  .filter(e => e.type.startsWith("agent_"))
  .pop();
if (latestReport) {
  const d = latestReport.data ?? {};
  lines.push("", `{bold}{inverse} Latest Report {/inverse}{/bold}`);
  lines.push(` Type: ${latestReport.type.replace("agent_", "")}`);
  lines.push(` ${d.message ?? d.summary ?? d.question ?? d.error ?? ""}`);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/tui/index.ts
git commit -m "feat: TUI shows channel connection status and agent reports"
```

---

## Summary: What uses what

| Operation | Before (tmux only) | After (channel + tmux) |
|---|---|---|
| **Send task to agent** | `tmux.waitAndSend()` (poll for prompt, paste text) | Channel notification (structured, instant) |
| **Agent reports completion** | Never (manual `c` key in TUI) | `report` tool → conductor auto-advances |
| **Agent asks question** | Never (stays at `❯` prompt) | `report` tool → session status = "waiting" |
| **Pipeline advancement** | Manual (`c` key or conductor polling) | Automatic via channel completion |
| **Agent-to-agent** | Not possible | `send_to_agent` tool via conductor relay |
| **Human watches** | `tmux capture-pane` | Same -- tmux capture (unchanged) |
| **Human steers** | `tmux attach` + type | Same -- tmux attach (unchanged) |
| **Human answers question** | `ark session send` (tmux send-keys) | Channel notification via conductor |

**tmux stays for:** human attach/detach, visual monitoring, interactive steering, debugging.
**Channels replace:** task injection, completion detection, question routing, agent coordination.
