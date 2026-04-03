/**
 * Session export/import for developer handoff.
 */

import { readFileSync, writeFileSync } from "fs";
import { getSession, createSession, updateSession, getEvents, type Session, type Event } from "./store.js";

export interface SessionExport {
  version: 1;
  exportedAt: string;
  session: Partial<Session>;
  events: Event[];
}

/** Export a session to a JSON file. */
export function exportSession(sessionId: string): SessionExport | null {
  const session = getSession(sessionId);
  if (!session) return null;

  const events = getEvents(sessionId);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      ticket: session.ticket,
      summary: session.summary,
      repo: session.repo,
      branch: session.branch,
      flow: session.flow,
      agent: session.agent,
      config: session.config,
      group_name: session.group_name,
    },
    events,
  };
}

/** Export session to a file path. */
export function exportSessionToFile(sessionId: string, filePath: string): boolean {
  const data = exportSession(sessionId);
  if (!data) return false;
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return true;
}

/** Import a session from a JSON file. */
export function importSessionFromFile(filePath: string): { ok: boolean; sessionId?: string; message: string } {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as SessionExport;

    if (data.version !== 1) return { ok: false, message: "Unsupported export version" };

    const session = createSession({
      ticket: data.session.ticket,
      summary: data.session.summary ? `[imported] ${data.session.summary}` : "[imported session]",
      repo: data.session.repo,
      flow: data.session.flow,
      config: data.session.config,
      group_name: data.session.group_name,
    });

    if (data.session.agent) {
      updateSession(session.id, { agent: data.session.agent });
    }

    return { ok: true, sessionId: session.id, message: `Imported as ${session.id}` };
  } catch (e: any) {
    return { ok: false, message: `Import failed: ${e?.message ?? e}` };
  }
}
