/**
 * Central group action dispatcher. Mutations go through asyncState.run()
 * which automatically refreshes via onComplete. Follows the same pattern
 * as useSessionActions and useComputeActions.
 */

import * as core from "../../core/index.js";
import type { AsyncState } from "./useAsync.js";

export function useGroupActions(asyncState: AsyncState) {
  const run = asyncState.run;

  return {
    createGroup: (name: string, onDone?: () => void) => {
      run("Creating group...", () => {
        core.createGroup(name);
        onDone?.();
      });
    },

    deleteGroup: (name: string, sessions: core.Session[], onDone?: (count: number) => void) => {
      run("Deleting group...", async () => {
        // Kill and delete all sessions in the group
        const groupSessions = sessions.filter(s => s.group_name === name);
        for (const s of groupSessions) {
          if (s.session_id) {
            try { await core.killSessionAsync(s.session_id); } catch {}
          }
          core.deleteSession(s.id);
        }
        // Delete the group itself
        core.deleteGroup(name);
        onDone?.(groupSessions.length);
      });
    },
  };
}
