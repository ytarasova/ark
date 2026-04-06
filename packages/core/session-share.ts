/**
 * Session export/import for developer handoff.
 */

import { readFileSync, writeFileSync } from "fs";
import type { Session, Event } from "../types/index.js";
import { getApp } from "./app.js";
import { getSession as storeGetSession, getEvents as storeGetEvents, createSession as storeCreateSession, updateSession as storeUpdateSession } from "./store.js";

export interface SessionExport {
  version: 1;
  exportedAt: string;
  session: Partial<Session>;
  events: Event[];
}

/** Export a session to a JSON file. */
export function exportSession(sessionId: string): SessionExport | null {
  let session, events;
  try { session = getApp().sessions.get(sessionId); events = getApp().events.list(sessionId); }
  catch { session = storeGetSession(sessionId); events = storeGetEvents(sessionId) as Event[]; }
  if (!session) return null;

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

    let session;
    const createOpts = {
      ticket: data.session.ticket,
      summary: data.session.summary ? `[imported] ${data.session.summary}` : "[imported session]",
      repo: data.session.repo,
      flow: data.session.flow,
      config: data.session.config,
      group_name: data.session.group_name,
    };
    try { session = getApp().sessions.create(createOpts); }
    catch { session = storeCreateSession(createOpts); }

    if (data.session.agent) {
      try { getApp().sessions.update(session.id, { agent: data.session.agent }); }
      catch { storeUpdateSession(session.id, { agent: data.session.agent }); }
    }

    return { ok: true, sessionId: session.id, message: `Imported as ${session.id}` };
  } catch (e: any) {
    return { ok: false, message: `Import failed: ${e?.message ?? e}` };
  }
}
