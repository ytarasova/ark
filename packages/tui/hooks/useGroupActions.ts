/**
 * Central group action dispatcher. Mutations go through asyncState.run()
 * which automatically refreshes via onComplete. Follows the same pattern
 * as useSessionActions and useComputeActions.
 */

import { useArkClient } from "./useArkClient.js";
import type { AsyncState } from "./useAsync.js";

interface SessionLike {
  id: string;
  session_id: string | null;
  group_name: string | null;
}

export function useGroupActions(asyncState: AsyncState) {
  const ark = useArkClient();
  const run = asyncState.run;

  return {
    createGroup: (name: string, onDone?: () => void) => {
      run("Creating group...", async () => {
        await ark.groupCreate(name);
        onDone?.();
      });
    },

    deleteGroup: (name: string, sessions: SessionLike[], onDone?: (count: number) => void) => {
      run("Deleting group...", async () => {
        // Stop and delete all sessions in the group
        const groupSessions = sessions.filter(s => s.group_name === name);
        for (const s of groupSessions) {
          if (s.session_id) {
            try { await ark.sessionStop(s.id); } catch { /* session may already be stopped */ }
          }
          await ark.sessionDelete(s.id);
        }
        // Delete the group itself
        await ark.groupDelete(name);
        onDone?.(groupSessions.length);
      });
    },
  };
}
