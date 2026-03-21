#!/usr/bin/env bun
/**
 * ark-channel: MCP server bridging Ark conductor <-> Claude sessions.
 *
 * Inbound (conductor -> Claude): task assignments, steering, context
 * Outbound (Claude -> conductor): progress, completion, questions, errors
 *
 * Started automatically by ark session dispatch.
 * Claude receives inbound messages as logging notifications with logger="ark-channel".
 * Claude reports back via the `report` tool.
 */

// Bun global type declaration (avoids requiring @types/bun as a dependency)
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch(req: Request): Promise<Response> | Response;
  }): { stop(): void };
};

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

const mcp = new Server(
  { name: "ark", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: [
      'You are an Ark agent session. Messages from the Ark conductor arrive as logging notifications with logger="ark-channel".',
      "When you complete a stage, report via the `report` tool with type='completed'.",
      "When you have a question for the human, report via `report` with type='question'.",
      "When you encounter an error, report via `report` with type='error'.",
      "Periodically report progress via `report` with type='progress'.",
    ].join("\n"),
  }
);

// -- Tools ---------------------------------------------------------------

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
    {
      name: "send_to_agent",
      description:
        "Send a message to another Ark agent session (for coordination, handoff, or delegation)",
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

    // Build the outbound message matching the channel-types union
    const report: OutboundMessage = (() => {
      const base = {
        sessionId: SESSION_ID,
        stage: process.env.ARK_STAGE ?? "",
      };
      switch (reportType) {
        case "completed":
          return {
            ...base,
            type: "completed" as const,
            summary: message,
            filesChanged: (args.filesChanged as string[]) ?? [],
            commits: (args.commits as string[]) ?? [],
          };
        case "question":
          return {
            ...base,
            type: "question" as const,
            question: message,
          };
        case "error":
          return {
            ...base,
            type: "error" as const,
            error: message,
          };
        default:
          return {
            ...base,
            type: "progress" as const,
            message,
            filesChanged: (args.filesChanged as string[]) ?? [],
          };
      }
    })();

    try {
      await fetch(
        `http://localhost:${CONDUCTOR_PORT}/api/channel/${SESSION_ID}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
        }
      );
    } catch {
      console.error(`[ark-channel] Conductor unreachable at port ${CONDUCTOR_PORT}`);
    }

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
    } catch {
      console.error(`[ark-channel] Conductor unreachable for relay`);
    }

    return {
      content: [{ type: "text", text: `Sent to ${args.target_session}` }],
    };
  }

  return { content: [{ type: "text", text: "Unknown tool" }] };
});

// -- HTTP inbound server (Conductor -> Claude) ----------------------------

if (HTTP_PORT > 0) {
  Bun.serve({
    port: HTTP_PORT,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      if (req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;

        // Deliver inbound message to Claude via logging notification.
        // We use level="info" and logger="ark-channel" so Claude can
        // distinguish conductor messages from other log output.
        const content =
          (body.message ?? body.task ?? JSON.stringify(body)) as string;
        const meta = {
          type: body.type as string,
          session_id: (body.sessionId ?? SESSION_ID) as string,
          stage: body.stage as string | undefined,
          from: (body.from ?? "conductor") as string,
        };

        await mcp.sendLoggingMessage({
          level: "info",
          logger: "ark-channel",
          data: { content, meta },
        });

        return new Response("ok");
      }
      return new Response("ark-channel", { status: 200 });
    },
  });
}

// -- Connect -------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
