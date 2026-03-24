/**
 * Central session action dispatcher. Every mutation goes through
 * asyncState.run() which automatically calls refresh() on completion
 * (configured via useAsync's onComplete callback).
 */

import * as core from "../../core/index.js";
import type { AsyncState } from "./useAsync.js";

export function useSessionActions(asyncState: AsyncState) {
  const run = asyncState.run;

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

    delete: (id: string) => {
      run(`Deleting ${id}`, () => core.deleteSessionAsync(id));
    },

    clone: (sourceId: string, name: string, groupName?: string | null) => {
      run(`Cloning → ${name}`, async () => {
        const { ok, cloneId } = core.cloneSession(sourceId, name);
        if (!ok) return;
        if (groupName) core.updateSession(cloneId, { group_name: groupName });
        await core.dispatch(cloneId);
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
      });
    },
  };
}
