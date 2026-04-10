/**
 * Agent Client Protocol (ACP) — JSON-RPC for headless session management.
 * Enables CI/CD integration and programmatic agent control.
 */

import readline from "readline";
import { startSession, dispatch, stop, resume, deleteSessionAsync, getOutput, send } from "./services/session-orchestration.js";
import type { AppContext } from "./app.js";

export interface AcpRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

export interface AcpResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string };
  id: string | number;
}

/** Handle a single ACP request. */
export async function handleAcpRequest(app: AppContext, req: AcpRequest): Promise<AcpResponse> {
  const id = req.id;
  try {
    switch (req.method) {
      case "session/create": {
        const p = req.params ?? {};
        const session = startSession(app, {
          summary: p.summary as string,
          repo: p.repo as string,
          flow: p.flow as string,
          workdir: p.workdir as string,
        });
        return { jsonrpc: "2.0", result: { sessionId: session.id, status: session.status }, id };
      }

      case "session/dispatch": {
        const sessionId = req.params?.sessionId as string;
        await dispatch(app, sessionId);
        return { jsonrpc: "2.0", result: { ok: true }, id };
      }

      case "session/stop": {
        const sessionId = req.params?.sessionId as string;
        await stop(app, sessionId);
        return { jsonrpc: "2.0", result: { ok: true }, id };
      }

      case "session/restart": {
        const sessionId = req.params?.sessionId as string;
        await resume(app, sessionId);
        return { jsonrpc: "2.0", result: { ok: true }, id };
      }

      case "session/delete": {
        const sessionId = req.params?.sessionId as string;
        const result = await deleteSessionAsync(app, sessionId);
        return { jsonrpc: "2.0", result, id };
      }

      case "session/get": {
        const sessionId = req.params?.sessionId as string;
        const session = app.sessions.get(sessionId);
        return { jsonrpc: "2.0", result: session, id };
      }

      case "session/list": {
        const sessions = app.sessions.list({ limit: req.params?.limit as number ?? 100 });
        return { jsonrpc: "2.0", result: sessions, id };
      }

      case "session/output": {
        const sessionId = req.params?.sessionId as string;
        const output = await getOutput(app, sessionId, { lines: req.params?.lines as number });
        return { jsonrpc: "2.0", result: { output }, id };
      }

      case "session/send": {
        const sessionId = req.params?.sessionId as string;
        const message = req.params?.message as string;
        const result = await send(app, sessionId, message);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        return { jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${req.method}` }, id };
    }
  } catch (e: any) {
    return { jsonrpc: "2.0", error: { code: -32000, message: e.message ?? String(e) }, id };
  }
}

/** Run ACP server on stdin/stdout (for headless CLI mode). */
export function runAcpServer(app: AppContext): void {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    try {
      const req = JSON.parse(line) as AcpRequest;
      const resp = await handleAcpRequest(app, req);
      process.stdout.write(JSON.stringify(resp) + "\n");
    } catch {
      const resp: AcpResponse = {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: 0,
      };
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  });
}
