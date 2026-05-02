/**
 * Session read tools (list, show, events). These are thin pass-throughs to
 * the AppContext repositories -- the same code paths the JSON-RPC handlers
 * in `packages/server/handlers/session.ts` already use. No business logic
 * here; auth/tenant scoping is handled upstream by the /mcp route.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";
import type { SessionStatus } from "../../../types/session.js";

const sessionListInput = z.object({
  status: z.string().optional(),
  flow: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const sessionList: ToolDef = {
  name: "session_list",
  description: "List sessions visible to the caller's tenant. Optional filters: status, flow, limit.",
  inputSchema: sessionListInput,
  handler: async (input, { app }) => {
    const parsed = input as z.infer<typeof sessionListInput>;
    return app.sessions.list({
      status: parsed.status as SessionStatus | undefined,
      flow: parsed.flow,
      limit: parsed.limit ?? 100,
    });
  },
};

const sessionShowInput = z.object({ sessionId: z.string() });

const sessionShow: ToolDef = {
  name: "session_show",
  description: "Get a single session by id.",
  inputSchema: sessionShowInput,
  handler: async (input, { app }) => {
    const parsed = input as z.infer<typeof sessionShowInput>;
    const session = await app.sessions.get(parsed.sessionId);
    if (!session) throw new Error(`Session not found: ${parsed.sessionId}`);
    return session;
  },
};

const sessionEventsInput = z.object({
  sessionId: z.string(),
  type: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const sessionEvents: ToolDef = {
  name: "session_events",
  description: "Read events for a session. Optional filters: type, limit (defaults to 200).",
  inputSchema: sessionEventsInput,
  handler: async (input, { app }) => {
    const parsed = input as z.infer<typeof sessionEventsInput>;
    return app.events.list(parsed.sessionId, {
      type: parsed.type,
      limit: parsed.limit ?? 200,
    });
  },
};

sharedRegistry.register(sessionList);
sharedRegistry.register(sessionShow);
sharedRegistry.register(sessionEvents);
