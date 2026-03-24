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
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { OutboundMessage } from "./channel-types.js";

const SESSION_ID = process.env.ARK_SESSION_ID ?? "unknown";
const CONDUCTOR_PORT = parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100");
const HTTP_PORT = parseInt(process.env.ARK_CHANNEL_PORT ?? "0");

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
      "When you complete a stage, call the `report` tool with type='completed' and a summary.",
      "When you have a question for the human, call `report` with type='question'.",
      "When you encounter an error, call `report` with type='error'.",
      "Periodically call `report` with type='progress' to update on your work.",
    ].join("\n"),
  },
);

// ── Tools (Claude → Ark) ────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "report",
      description:
        "Report progress, completion, questions, or errors back to the Ark conductor.",
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
            description: "Report content — summary, question text, or error message",
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
        },
        required: ["type", "message"],
      },
    },
    {
      name: "send_to_agent",
      description:
        "Send a message to another Ark agent session (for coordination or handoff)",
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
    const message = args.message as string;

    const report: OutboundMessage = (() => {
      const base = { sessionId: SESSION_ID, stage: process.env.ARK_STAGE ?? "" };
      switch (reportType) {
        case "completed":
          return { ...base, type: "completed" as const, summary: message,
            filesChanged: (args.filesChanged as string[]) ?? [], commits: (args.commits as string[]) ?? [] };
        case "question":
          return { ...base, type: "question" as const, question: message };
        case "error":
          return { ...base, type: "error" as const, error: message };
        default:
          return { ...base, type: "progress" as const, message,
            filesChanged: (args.filesChanged as string[]) ?? [] };
      }
    })();

    try {
      await fetch(`http://localhost:${CONDUCTOR_PORT}/api/channel/${SESSION_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
    } catch {}

    return { content: [{ type: "text", text: `Reported: ${reportType}` }] };
  }

  if (req.params.name === "send_to_agent") {
    try {
      await fetch(`http://localhost:${CONDUCTOR_PORT}/api/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: SESSION_ID,
          target: args.target_session as string,
          message: args.message as string,
        }),
      });
    } catch {}
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
