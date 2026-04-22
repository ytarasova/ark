/**
 * StageAdvanceService -- thin class wrapper over the legacy free-function
 * `advance()`. Exists so callers can write `app.stageAdvance.advance(id)`
 * without worrying about whether the class-based refactor has landed.
 */

import type { AppContext } from "../../app.js";
import { advance, handoff } from "../stage-advance.js";
import { executeAction as executeActionFree } from "../actions/index.js";

export { advance, handoff } from "../stage-advance.js";

export class StageAdvanceService {
  constructor(private readonly app: AppContext) {}
  advance(sessionId: string, force?: boolean, outcome?: string): Promise<{ ok: boolean; message: string }> {
    return advance(this.app, sessionId, force, outcome);
  }
  handoff(sessionId: string, toAgent: string, instructions?: string): Promise<{ ok: boolean; message: string }> {
    return handoff(this.app, sessionId, toAgent, instructions);
  }
  executeAction(sessionId: string, action: string): Promise<{ ok: boolean; message: string }> {
    return executeActionFree(this.app, sessionId, action);
  }
}
