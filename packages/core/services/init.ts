/**
 * Side-effect module: wires cross-module runtime deps that used to live in
 * the old `session-orchestration.ts` barrel.
 *
 * `worktree.finishWorktree` needs `deleteSessionAsync`, `stop`, and
 * `runVerification` from `session-lifecycle.ts`, but importing them directly
 * would create a cycle (session-lifecycle already imports
 * `removeSessionWorktree`). The legacy barrel ran the injection on first
 * load; now this module owns it. Import it once (e.g. from `services/index.ts`)
 * to guarantee the deps are wired before `finishWorktree` can be called.
 */

import { injectWorktreeDeps } from "./worktree/index.js";
import { deleteSessionAsync, stop, runVerification } from "./session-lifecycle.js";

injectWorktreeDeps({ deleteSessionAsync, stop, runVerification });
