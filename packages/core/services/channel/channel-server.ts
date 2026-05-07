#!/usr/bin/env bun
/**
 * ark-channel: Claude Code channel server for Ark sessions.
 *
 * Uses the official Claude Code channel protocol:
 * - Declares `claude/channel` capability so Claude registers a listener
 * - Pushes tasks/steering via `notifications/claude/channel` events
 * - Exposes `report` and `send_to_agent` tools for bidirectional communication
 * - Accepts inbound HTTP on ARK_CHANNEL_PORT for conductor → Claude delivery
 *
 * Started automatically by ark session dispatch via --mcp-config.
 * Claude receives inbound messages as <channel source="ark" ...> tags.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OutboundMessage } from "./channel-types.js";
import { DEFAULT_ARKD_URL } from "../../constants.js";
import { logDebug } from "../../observability/structured-log.js";

const SESSION_ID = process.env.ARK_SESSION_ID ?? "unknown";
const ARKD_URL = DEFAULT_ARKD_URL;
// Fallback: if no arkd available, try conductor directly
const HTTP_PORT = parseInt(process.env.ARK_CHANNEL_PORT ?? "0");
const TENANT_ID = process.env.ARK_TENANT_ID;

/** Build outbound headers, including tenant id when known. */
function outboundHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TENANT_ID) headers["X-Ark-Tenant-Id"] = TENANT_ID;
  return headers;
}

// ── MCP Server with channel capability ──────────────────────────────────────

const mcp = new Server(
  { name: "ark-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "You are an Ark agent session. Tasks and messages from the Ark conductor arrive as <channel> tags.",
      "When you first receive your initial task, immediately call `report` with type='progress' to announce you are online and ready for work.",
      "When you complete a stage, call the `report` tool with type='completed' and a summary.",
      "When you have a question for the human, call `report` with type='question'.",
      "When you encounter an error, call `report` with type='error'.",
      "Periodically call `report` with type='progress' to update on your work.",
      "When you receive a steer message from a user, always call `report` with type='progress' to acknowledge and respond -- this is how your replies appear in the chat UI.",
    ].join("\n"),
  },
);

// ── Tools (Claude → Ark) ────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "report",
      description: "Report progress, completion, questions, or errors back to the Ark conductor.",
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
            description: "Files modified (for completed/progress reports)",
          },
          commits: {
            type: "array",
            items: { type: "string" },
            description: "Commit hashes (for completed reports)",
          },
          pr_url: {
            type: "string",
            description: "GitHub PR URL - include when you create a pull request",
          },
          outcome: {
            type: "string",
            description:
              "Stage outcome label for flow routing (e.g., 'approved', 'rejected'). Used with on_outcome in flow definitions.",
          },
        },
        required: ["type", "message"],
      },
    },
    {
      name: "send_to_agent",
      description: "Send a message to another Ark agent session (for coordination or handoff)",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_session: {
            type: "string",
            description: "Target session ID (e.g., s-abc123)",
          },
          message: {
            type: "string",
            description: "Message to send",
          },
        },
        required: ["target_session", "message"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, unknown>;

  if (req.params.name === "report") {
    const reportType = args.type as string;
    // Agents sometimes pass "summary" instead of "message" -- accept both
    const message = (args.message ?? args.summary ?? args.question ?? args.error ?? "") as string;

    const report: OutboundMessage = (() => {
      const base = { sessionId: SESSION_ID, stage: process.env.ARK_STAGE ?? "" };
      const prUrl = args.pr_url as string | undefined;
      const outcomeVal = args.outcome as string | undefined;
      switch (reportType) {
        case "completed":
          return {
            ...base,
            type: "completed" as const,
            summary: message,
            filesChanged: (args.filesChanged as string[]) ?? [],
            commits: (args.commits as string[]) ?? [],
            ...(prUrl ? { pr_url: prUrl } : {}),
            ...(outcomeVal ? { outcome: outcomeVal } : {}),
          };
        case "question":
          return { ...base, type: "question" as const, question: message };
        case "error":
          return { ...base, type: "error" as const, error: message };
        default:
          return {
            ...base,
            type: "progress" as const,
            message,
            filesChanged: (args.filesChanged as string[]) ?? [],
            ...(prUrl ? { pr_url: prUrl } : {}),
          };
      }
    })();

    // Report through arkd -- the single path for agent-to-conductor communication.
    // Arkd forwards to the conductor. No fallback: if arkd is down, the report is lost.
    try {
      await fetch(`${ARKD_URL}/channel/${SESSION_ID}`, {
        method: "POST",
        headers: outboundHeaders(),
        body: JSON.stringify(report),
      });
    } catch {
      logDebug("conductor", "arkd not reachable");
    }

    return { content: [{ type: "text", text: `Reported: ${reportType}` }] };
  }

  if (req.params.name === "send_to_agent") {
    const relayPayload = {
      from: SESSION_ID,
      target: args.target_session as string,
      message: args.message as string,
    };
    // Relay through arkd -- the single path for agent-to-agent communication.
    try {
      await fetch(`${ARKD_URL}/channel/relay`, {
        method: "POST",
        headers: outboundHeaders(),
        body: JSON.stringify(relayPayload),
      });
    } catch {
      logDebug("conductor", "arkd not reachable");
    }
    return { content: [{ type: "text", text: `Sent to ${args.target_session}` }] };
  }

  return { content: [{ type: "text", text: "Unknown tool" }] };
});

// ── Connect stdio transport ─────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());

// ── HTTP inbound (Conductor → Claude via channel notifications) ─────────────

if (HTTP_PORT > 0) {
  Bun.serve({
    port: HTTP_PORT,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      if (req.method === "GET") {
        return new Response("ark-channel", { status: 200 });
      }

      if (req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const content = (body.task ?? body.message ?? JSON.stringify(body)) as string;

        // Push to Claude via the official channel notification protocol
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              type: (body.type as string) ?? "task",
              session_id: (body.sessionId as string) ?? SESSION_ID,
              stage: (body.stage as string) ?? "",
            },
          },
        });

        return new Response("ok");
      }

      return new Response("method not allowed", { status: 405 });
    },
  });
}
