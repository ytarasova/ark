/**
 * ask_user MCP server for the agent-sdk runtime.
 *
 * The claude runtime has a first-class `report(question)` tool exposed via the
 * conductor-channel MCP (`packages/core/conductor/channel.ts`). The agent-sdk
 * runtime does not mount that MCP, so agents had no way to ask a mid-run
 * question as a structured conductor event. This module fills that gap by
 * exposing a single tool `ask_user(question, context?)` that fires the same
 * `type: "question"` hook to the conductor, reusing the existing UI render
 * path. The tool is non-blocking: the agent continues working and the user's
 * reply arrives via the existing intervention tail as the next user message.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface AskUserMcpOpts {
  sessionId: string;
  /**
   * Conductor base URL (e.g. "http://localhost:19100"). When undefined, the
   * tool still loads but becomes a no-op that tells the agent the conductor
   * is not reachable. Callers should avoid mounting the server in that case.
   */
  conductorUrl?: string;
  /** Optional bearer token for the conductor's Authorization header. */
  authToken?: string;
  /** Stage label to include in the payload (mirrors claude report path). */
  stage?: string;
  /** Fetch implementation. Defaults to the global fetch. Injected in tests. */
  fetchFn?: typeof fetch;
}

/** The shape the SDK's `tool()` handler returns. */
export interface AskUserResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Pure handler. Exported for unit tests so they can exercise the POST shape
 * and error paths without reaching into the SDK server internals.
 */
export async function askUserHandler(
  args: { question: string; context?: string },
  opts: AskUserMcpOpts,
): Promise<AskUserResult> {
  const { sessionId, conductorUrl, authToken, stage, fetchFn } = opts;
  const doFetch = fetchFn ?? fetch;

  if (!conductorUrl) {
    return {
      content: [
        {
          type: "text",
          text: "Conductor unreachable (ARK_CONDUCTOR_URL not set); question was not dispatched.",
        },
      ],
    };
  }

  const payload: Record<string, unknown> = {
    type: "question",
    sessionId,
    stage: stage ?? "",
    message: args.question,
    context: args.context ?? null,
    source: "agent-sdk-ask-user",
    timestamp: new Date().toISOString(),
  };

  try {
    await doFetch(`${conductorUrl}/hooks/status?session=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return {
      content: [
        {
          type: "text",
          text: `Failed to dispatch question to conductor: ${msg}. Continue without the reply.`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: "Question sent to user. Wait for their reply; it will arrive as your next user message via the intervention channel.",
      },
    ],
  };
}

/**
 * Build the `ask_user` MCP server. The returned object is compatible with the
 * SDK's `mcpServers` option (`McpSdkServerConfigWithInstance`).
 */
export function createAskUserMcpServer(opts: AskUserMcpOpts): McpSdkServerConfigWithInstance {
  const askUser = tool(
    "ask_user",
    [
      "Ask the user a mid-run question. Fires a conductor event so the UI",
      "surfaces the prompt as a first-class question. Non-blocking: the agent",
      "continues working, and the user's reply arrives as a normal user",
      "message via the intervention channel. Do not stop and wait after",
      "calling this tool.",
    ].join(" "),
    {
      question: z.string().describe("The question text to show the user."),
      context: z
        .string()
        .optional()
        .describe("Optional additional context to help the user understand why you're asking."),
    },
    (args) => askUserHandler(args, opts),
  );

  return createSdkMcpServer({
    name: "ark-ask-user",
    version: "0.1.0",
    tools: [askUser],
  });
}
