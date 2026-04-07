/**
 * Agent Client Protocol (ACP) — JSON-RPC for headless session management.
 * Enables CI/CD integration and programmatic agent control.
 */

import { startSession, dispatch, stop, resume, deleteSessionAsync, getOutput, send } from "./services/session-orchestration.js";
import { getApp } from "./app.js";
import { getSession as storeGetSession, listSessions as storeListSessions } from "./store.js";

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
export async function handleAcpRequest(req: AcpRequest): Promise<AcpResponse> {
  const id = req.id;
  try {
    switch (req.method) {
      case "session/create": {
        const p = req.params ?? {};
        const session = startSession({
          summary: p.summary as string,
          repo: p.repo as string,
          flow: p.flow as string,
          workdir: p.workdir as string,
        });
        return { jsonrpc: "2.0", result: { sessionId: session.id, status: session.status }, id };
      }

      case "session/dispatch": {
        const sessionId = req.params?.sessionId as string;
        await dispatch(sessionId);
        return { jsonrpc: "2.0", result: { ok: true }, id };
      }

      case "session/stop": {
        const sessionId = req.params?.sessionId as string;
        await stop(sessionId);
        return { jsonrpc: "2.0", result: { ok: true }, id };
      }

      case "session/restart": {
        const sessionId = req.params?.sessionId as string;
        await resume(sessionId);
        return { jsonrpc: "2.0", result: { ok: true }, id };
      }

      case "session/delete": {
        const sessionId = req.params?.sessionId as string;
        const result = await deleteSessionAsync(sessionId);
        return { jsonrpc: "2.0", result, id };
      }

      case "session/get": {
        const sessionId = req.params?.sessionId as string;
        let session;
        try { session = getApp().sessions.get(sessionId); }
        catch { session = storeGetSession(sessionId); }
        return { jsonrpc: "2.0", result: session, id };
      }

      case "session/list": {
        let sessions;
        try { sessions = getApp().sessions.list({ limit: req.params?.limit as number ?? 100 }); }
        catch { sessions = storeListSessions({ limit: req.params?.limit as number ?? 100 }); }
        return { jsonrpc: "2.0", result: sessions, id };
      }

      case "session/output": {
        const sessionId = req.params?.sessionId as string;
        const output = await getOutput(sessionId, { lines: req.params?.lines as number });
        return { jsonrpc: "2.0", result: { output }, id };
      }

      case "session/send": {
        const sessionId = req.params?.sessionId as string;
        const message = req.params?.message as string;
        const result = await send(sessionId, message);
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
export function runAcpServer(): void {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    try {
      const req = JSON.parse(line) as AcpRequest;
      const resp = await handleAcpRequest(req);
      process.stdout.write(JSON.stringify(resp) + "\n");
    } catch (e: any) {
      const resp: AcpResponse = {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: 0,
      };
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  });
}
