/**
 * Central session action dispatcher. Every mutation goes through here:
 * async wrapper + refresh + error handling. No more forgetting refresh()
 * or wrapping in asyncState.run() manually.
 */

import * as core from "../../core/index.js";
import type { AsyncState } from "./useAsync.js";

interface SessionActionsOpts {
  asyncState: AsyncState;
  refresh: () => void;
}

export function useSessionActions({ asyncState, refresh }: SessionActionsOpts) {
  const run = (label: string, action: () => Promise<void> | void) => {
    asyncState.run(label, async () => {
      await action();
      refresh();
    });
  };

  return {
    dispatch: (id: string) => {
      run(`Dispatching ${id}`, () => core.dispatch(id));
    },

    restart: (id: string) => {
      run(`Restarting ${id}`, () => core.resume(id));
    },

    stop: (id: string) => {
      run(`Stopping ${id}`, () => { core.stop(id); });
    },

    complete: (id: string) => {
      run(`Completing ${id}`, () => { core.complete(id); });
    },

    delete: (id: string, tmuxName: string | null) => {
      run(`Deleting ${id}`, async () => {
        if (tmuxName) await core.killSessionAsync(tmuxName);
        core.deleteSession(id);
      });
    },

    clone: (sourceId: string, name: string, groupName?: string | null) => {
      run(`Cloning ${sourceId}`, async () => {
        const { ok, cloneId } = core.cloneSession(sourceId, name);
        if (!ok) return;
        if (groupName) core.updateSession(cloneId, { group_name: groupName });
        refresh(); // show clone in list before dispatch
        await core.dispatch(cloneId);
      });
    },

    move: (id: string, group: string | null) => {
      core.updateSession(id, { group_name: group });
      refresh();
    },

    stopGroup: (sessions: core.Session[]) => {
      run(`Stopping group`, () => {
        for (const s of sessions) {
          if (!["completed", "failed", "stopped"].includes(s.status)) core.stop(s.id);
        }
      });
    },

    resumeGroup: (sessions: core.Session[]) => {
      run(`Resuming group`, async () => {
        for (const s of sessions) {
          if (["blocked", "waiting", "failed", "stopped", "completed"].includes(s.status)) {
            await core.resume(s.id);
          }
        }
      });
    },

    deleteGroup: (sessions: core.Session[]) => {
      run(`Deleting group`, async () => {
        for (const s of sessions) {
          if (s.session_id) await core.killSessionAsync(s.session_id);
          core.deleteSession(s.id);
        }
      });
    },
  };
}
