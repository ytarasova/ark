/**
 * Central session action dispatcher. Every mutation goes through
 * asyncState.run() which automatically calls refresh() on completion
 * (configured via useAsync's onComplete callback).
 */

import { useRef } from "react";
import { useArkClient } from "./useArkClient.js";
import type { AsyncState } from "./useAsync.js";

interface SessionLike {
  id: string;
  status: string;
}

export function useSessionActions(asyncState: AsyncState) {
  const ark = useArkClient();
  const run = asyncState.run;
  const lastDeletedRef = useRef<string | null>(null);

  return {
    dispatch: (id: string) => {
      run(`Dispatching ${id}`, async () => {
        await ark.sessionDispatch(id);
      });
    },

    restart: (id: string) => {
      run(`Restarting ${id}`, async () => {
        await ark.sessionDispatch(id);
      });
    },

    stop: (id: string) => {
      run(`Stopping ${id}`, async () => { await ark.sessionStop(id); });
    },

    complete: (id: string) => {
      run(`Completing ${id}`, async () => { await ark.sessionComplete(id); });
    },

    delete: (id: string) => {
      run(`Deleting ${id}`, async () => {
        await ark.sessionDelete(id);
        lastDeletedRef.current = id;
      });
    },

    undoDelete: () => {
      const id = lastDeletedRef.current;
      if (!id) return false;
      run("Restoring session", async () => {
        const result = await ark.sessionUndelete(id);
        if (result?.ok) lastDeletedRef.current = null;
      });
      return true;
    },

    fork: (sourceId: string, name: string, groupName?: string | null) => {
      run(`Forking → ${name}`, async () => {
        const session = await ark.sessionClone(sourceId, name);
        if (!session) return;
        if (groupName) await ark.sessionUpdate(session.id, { group_name: groupName });
        await ark.sessionDispatch(session.id);
      });
    },

    move: (id: string, group: string | null) => {
      run("Moving session", async () => { await ark.sessionUpdate(id, { group_name: group }); });
    },

    stopGroup: (sessions: SessionLike[]) => {
      run("Stopping group", async () => {
        for (const s of sessions) {
          if (!["completed", "failed", "stopped"].includes(s.status)) await ark.sessionStop(s.id);
        }
      });
    },

    resumeGroup: (sessions: SessionLike[]) => {
      run("Resuming group", async () => {
        for (const s of sessions) {
          if (["blocked", "waiting", "failed", "stopped", "completed"].includes(s.status)) {
            await ark.sessionDispatch(s.id);
          }
        }
      });
    },

    deleteGroup: (sessions: SessionLike[]) => {
      run("Deleting group", async () => {
        for (const s of sessions) {
          await ark.sessionDelete(s.id);
        }
        if (sessions.length > 0) lastDeletedRef.current = sessions[sessions.length - 1].id;
      });
    },
  };
}
