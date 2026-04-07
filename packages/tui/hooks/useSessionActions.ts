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

export function useSessionActions(asyncState: AsyncState, onSuccess?: (msg: string) => void) {
  const ark = useArkClient();
  const run = asyncState.run;
  const lastDeletedRef = useRef<string | null>(null);

  return {
    dispatch: (id: string) => {
      run(`Dispatching ${id}`, async () => {
        await ark.sessionDispatch(id);
        onSuccess?.(`Dispatched ${id}`);
      });
    },

    restart: (id: string) => {
      run(`Restarting ${id}`, async () => {
        await ark.sessionDispatch(id);
        onSuccess?.(`Restarted ${id}`);
      });
    },

    stop: (id: string) => {
      run(`Stopping ${id}`, async () => {
        await ark.sessionStop(id);
        onSuccess?.(`Stopped ${id}`);
      });
    },

    complete: (id: string) => {
      run(`Completing ${id}`, async () => {
        await ark.sessionComplete(id);
        onSuccess?.(`Completed ${id}`);
      });
    },

    delete: (id: string) => {
      run(`Deleting ${id}`, async () => {
        await ark.sessionDelete(id);
        lastDeletedRef.current = id;
        onSuccess?.(`Deleted ${id}. Ctrl+Z to undo (90s)`);
      });
    },

    undoDelete: () => {
      const id = lastDeletedRef.current;
      if (!id) return false;
      run("Restoring session", async () => {
        const result = await ark.sessionUndelete(id);
        if (result?.ok) {
          lastDeletedRef.current = null;
          onSuccess?.("Session restored");
        }
      });
      return true;
    },

    fork: (sourceId: string, name: string, groupName?: string | null) => {
      run(`Forking → ${name}`, async () => {
        const session = await ark.sessionClone(sourceId, name);
        if (!session) return;
        if (groupName) await ark.sessionUpdate(session.id, { group_name: groupName });
        await ark.sessionDispatch(session.id);
        onSuccess?.(`Forked and dispatched ${session.id}`);
      });
    },

    move: (id: string, group: string | null) => {
      run("Moving session", async () => {
        await ark.sessionUpdate(id, { group_name: group });
        onSuccess?.(group ? `Moved to '${group}'` : "Removed from group");
      });
    },

    stopGroup: (sessions: SessionLike[]) => {
      run("Stopping group", async () => {
        for (const s of sessions) {
          if (!["completed", "failed", "stopped"].includes(s.status)) await ark.sessionStop(s.id);
        }
        onSuccess?.(`Stopped ${sessions.length} sessions`);
      });
    },

    resumeGroup: (sessions: SessionLike[]) => {
      run("Resuming group", async () => {
        for (const s of sessions) {
          if (["blocked", "waiting", "failed", "stopped", "completed"].includes(s.status)) {
            await ark.sessionDispatch(s.id);
          }
        }
        onSuccess?.(`Resumed ${sessions.length} sessions`);
      });
    },

    deleteGroup: (sessions: SessionLike[]) => {
      run("Deleting group", async () => {
        for (const s of sessions) {
          await ark.sessionDelete(s.id);
        }
        if (sessions.length > 0) lastDeletedRef.current = sessions[sessions.length - 1].id;
        onSuccess?.(`Deleted ${sessions.length} sessions`);
      });
    },

    interrupt: (id: string) => {
      run(`Interrupting ${id}`, async () => {
        await ark.sessionInterrupt(id);
        onSuccess?.(`Interrupted ${id}`);
      });
    },

    archive: (id: string) => {
      run(`Archiving ${id}`, async () => {
        await ark.sessionArchive(id);
        onSuccess?.(`Archived ${id}`);
      });
    },

    restore: (id: string) => {
      run(`Restoring ${id}`, async () => {
        await ark.sessionRestore(id);
        onSuccess?.(`Restored ${id}`);
      });
    },

    createPR: (id: string, title?: string) => {
      run(`Creating PR for ${id}`, async () => {
        await ark.worktreeCreatePR(id, { title });
        onSuccess?.(`PR created for ${id}`);
      });
    },
  };
}
