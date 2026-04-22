/**
 * DispatchService -- resolve compute + launch the agent for the current stage.
 *
 * Class-based composition over narrow repository/service deps. The body
 * never holds an AppContext reference; every AppContext-requiring helper
 * (`buildTaskWithHandoff`, `indexRepoForDispatch`, ...) is wrapped as a
 * `DispatchDeps` callback at the DI-registration layer. Follows the
 * `SessionHooks` / `SessionLifecycle` idiom.
 *
 * Split:
 *   types.ts            -- DispatchDeps interface + callback shapes
 *   compute-resolve.ts  -- per-stage compute resolution + template cloning
 *   secrets-resolve.ts  -- stage + runtime secret merge
 *   dispatch-hosted.ts  -- hosted-mode scheduler delegation
 *   dispatch-fanout.ts  -- fork / fan-out split
 *   dispatch-core.ts    -- main dispatch + resume body
 *   index.ts            -- public DispatchService facade (this file)
 */

import { CoreDispatcher } from "./dispatch-core.js";
import type { DispatchDeps, DispatchResult } from "./types.js";
import type { StageDefinition } from "../../state/flow.js";

export type { DispatchDeps, DispatchResult } from "./types.js";

export class DispatchService {
  private readonly core: CoreDispatcher;

  constructor(deps: DispatchDeps) {
    this.core = new CoreDispatcher(deps);
  }

  dispatch(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<DispatchResult> {
    return this.core.dispatch(sessionId, opts);
  }

  resume(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<DispatchResult> {
    return this.core.resume(sessionId, opts);
  }

  /**
   * Per-stage compute template resolution. Exposed publicly so stage-planning
   * code (and the legacy `resolveComputeForStage` test suite) can check
   * resolution without triggering a full launch.
   */
  resolveComputeForStage(
    stageDef: StageDefinition | null,
    sessionId: string,
    log: (msg: string) => void = () => {},
  ): Promise<string | null> {
    return this.core.resolveComputeForStage(stageDef, sessionId, log);
  }
}
