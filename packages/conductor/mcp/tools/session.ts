/**
 * Session tools. Thin pass-throughs to the AppContext services and
 * repositories that the JSON-RPC handlers in `packages/conductor/handlers/`
 * already use. No business logic here; auth/tenant scoping is handled
 * upstream by the /mcp route.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";
import type { SessionStatus, Session } from "../../../types/session.js";

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

const sessionStartInput = z.object({
  compute: z.string().optional(),
  flow: z.string(),
  agent: z.string().optional(),
  summary: z.string(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  prompt: z.string().optional(),
  parent: z.string().optional(),
});

const sessionStart: ToolDef = {
  name: "session_start",
  description: "Create and dispatch a new session.",
  inputSchema: sessionStartInput,
  handler: async (input, { app }) => {
    const parsed = input as z.infer<typeof sessionStartInput>;

    // Flow-level requires_repo gate (#416). Reject before any session row
    // is written if the flow declares it requires a repo and the caller
    // didn't pass one. Same logic as the JSON-RPC session/start handler.
    if (parsed.flow && !parsed.repo) {
      const flow = app.flows.get(parsed.flow);
      if (flow?.requires_repo) {
        throw new Error(`Flow '${parsed.flow}' requires a repo. Pass repo: <git-url-or-local-path>.`);
      }
    }

    // Mirror packages/conductor/handlers/session.ts session/start: delegate to
    // sessionLifecycle.start with the onCreated callback so the default
    // dispatcher listener kicks the background launcher synchronously.
    const session = await app.sessionLifecycle.start(
      {
        compute_name: parsed.compute,
        flow: parsed.flow,
        agent: parsed.agent,
        summary: parsed.summary,
        repo: parsed.repo,
        branch: parsed.branch,
        // `prompt` and `parent` ride on the session config blob -- the JSON-RPC
        // start handler accepts the same shape via SessionStartParams.
        config: {
          ...(parsed.prompt !== undefined ? { prompt: parsed.prompt } : {}),
          ...(parsed.parent !== undefined ? { parent_id: parsed.parent } : {}),
        },
      },
      { onCreated: (id) => app.sessionService.emitSessionCreated(id) },
    );
    return { sessionId: session.id };
  },
};

const sessionSteerInput = z.object({ sessionId: z.string(), message: z.string() });

const sessionSteer: ToolDef = {
  name: "session_steer",
  description: "Send a steer message to a session. Queued; the agent picks it up on its next loop.",
  inputSchema: sessionSteerInput,
  handler: async (input, { app }) => {
    const parsed = input as z.infer<typeof sessionSteerInput>;
    return app.sessionService.send(parsed.sessionId, parsed.message);
  },
};

const sessionKillInput = z.object({ sessionId: z.string() });

const sessionKill: ToolDef = {
  name: "session_kill",
  description: "Hard terminate a session and release its compute slot.",
  inputSchema: sessionKillInput,
  handler: async (input, { app }) => {
    const parsed = input as z.infer<typeof sessionKillInput>;
    // Mirror packages/conductor/handlers/session.ts session/kill: there is no
    // single sessionService.kill primitive; the handler inlines executor
    // terminate + status update + cleanupSession. We replay the same calls
    // so the MCP surface and JSON-RPC surface end up in identical states.
    const s = await app.sessions.get(parsed.sessionId);
    if (!s) throw new Error(`Session not found: ${parsed.sessionId}`);

    const terminalStatuses = ["completed", "failed", "archived", "stopped"];
    if (terminalStatuses.includes(s.status)) {
      return { ok: false, message: `session already terminal (status=${s.status})` };
    }

    const handle = s.session_id;
    if (handle) {
      const { getExecutor } = await import("../../../core/executor.js");
      const executorName = (s.config as Record<string, unknown> | null)?.launch_executor as string | undefined;
      const executor = executorName ? getExecutor(executorName) : undefined;
      if (executor) {
        if (executor.terminate) await executor.terminate(handle);
        else await executor.kill(handle);
      }
    }

    await app.sessions.update(parsed.sessionId, {
      status: "failed",
      error: "killed",
      session_id: null,
    } as Partial<Session>);

    await app.events.log(parsed.sessionId, "session_killed", {
      actor: "user",
      data: { handle: handle ?? null },
    });

    const updated = await app.sessions.get(parsed.sessionId);
    if (updated) {
      const { cleanupSession } = await import("../../../core/services/session/cleanup.js");
      await cleanupSession(app, updated);
    }

    return { ok: true, terminated_at: Date.now(), cleaned_up: true };
  },
};

sharedRegistry.register(sessionList);
sharedRegistry.register(sessionShow);
sharedRegistry.register(sessionEvents);
sharedRegistry.register(sessionStart);
sharedRegistry.register(sessionSteer);
sharedRegistry.register(sessionKill);
