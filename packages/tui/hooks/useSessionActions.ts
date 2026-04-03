/**
 * Central session action dispatcher. Every mutation goes through
 * asyncState.run() which automatically calls refresh() on completion
 * (configured via useAsync's onComplete callback).
 */

import { useRef } from "react";
import * as core from "../../core/index.js";
import type { AsyncState } from "./useAsync.js";

export function useSessionActions(asyncState: AsyncState) {
  const run = asyncState.run;
  const lastDeletedRef = useRef<string | null>(null);

  return {
    dispatch: (id: string) => {
      run(`Dispatching ${id}`, async (updateLabel) => {
        await core.dispatch(id, {
          onLog: (msg) => {
            updateLabel(msg);
            core.logEvent(id, "dispatch_progress", { actor: "system", data: { message: msg } });
          },
        });
      });
    },

    restart: (id: string) => {
      run(`Restarting ${id}`, async (updateLabel) => {
        await core.resume(id, { onLog: (msg) => updateLabel(msg) });
      });
    },

    stop: (id: string) => {
      run(`Stopping ${id}`, async () => { await core.stop(id); });
    },

    complete: (id: string) => {
      run(`Completing ${id}`, () => { core.complete(id); });
    },

    delete: (id: string) => {
      run(`Deleting ${id}`, async () => {
        await core.deleteSessionAsync(id);
        lastDeletedRef.current = id;
      });
    },

    undoDelete: () => {
      const id = lastDeletedRef.current;
      if (!id) return false;
      run("Restoring session", async () => {
        const result = await core.undeleteSessionAsync(id);
        if (result.ok) lastDeletedRef.current = null;
      });
      return true;
    },

    fork: (sourceId: string, name: string, groupName?: string | null) => {
      run(`Forking → ${name}`, async (updateLabel) => {
        const result = core.cloneSession(sourceId, name);
        if (!result.ok) return;
        if (groupName) core.updateSession(result.sessionId, { group_name: groupName });
        await core.dispatch(result.sessionId, { onLog: (msg) => updateLabel(msg) });
      });
    },

    move: (id: string, group: string | null) => {
      run("Moving session", () => { core.updateSession(id, { group_name: group }); });
    },

    stopGroup: (sessions: core.Session[]) => {
      run("Stopping group", () => {
        for (const s of sessions) {
          if (!["completed", "failed", "stopped"].includes(s.status)) core.stop(s.id);
        }
      });
    },

    resumeGroup: (sessions: core.Session[]) => {
      run("Resuming group", async () => {
        for (const s of sessions) {
          if (["blocked", "waiting", "failed", "stopped", "completed"].includes(s.status)) {
            await core.resume(s.id);
          }
        }
      });
    },

    deleteGroup: (sessions: core.Session[]) => {
      run("Deleting group", async () => {
        for (const s of sessions) {
          await core.deleteSessionAsync(s.id);
        }
        if (sessions.length > 0) lastDeletedRef.current = sessions[sessions.length - 1].id;
      });
    },
  };
}
