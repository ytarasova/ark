/**
 * StageAdvanceService -- stage advancement, completion, and agent handoff.
 *
 * Composes three internal classes over a shared `StageAdvanceDeps`
 * cradle-slice. No AppContext field. No getApp(). Every dependency is
 * either a narrow repository/store or a callback wired at DI time.
 *
 * Access via the DI container: `app.stageAdvance.X`. The old free-function
 * module (`services/stage-advance.ts`) has been retired; every caller now
 * uses the class through AppContext.
 */

import { StageAdvancer } from "./advance.js";
import { StageCompleter } from "./complete.js";
import { StageHandoffer } from "./handoff.js";
import { TranscriptParser } from "./transcript-parse.js";
import type { IdempotencyCapable, StageAdvanceDeps, StageOpResult } from "./types.js";

export type { StageAdvanceDeps, IdempotencyCapable, StageOpResult } from "./types.js";

export class StageAdvanceService {
  private readonly advancer: StageAdvancer;
  private readonly completer: StageCompleter;
  private readonly handoffer: StageHandoffer;
  private readonly transcriptParser: TranscriptParser;
  private readonly deps: StageAdvanceDeps;

  constructor(deps: StageAdvanceDeps) {
    this.deps = deps;
    this.transcriptParser = new TranscriptParser(deps);
    this.advancer = new StageAdvancer(deps);
    this.completer = new StageCompleter(deps, this.advancer, this.transcriptParser);
    this.handoffer = new StageHandoffer(deps);
  }

  advance(sessionId: string, force?: boolean, outcome?: string, opts?: IdempotencyCapable): Promise<StageOpResult> {
    return this.advancer.advance(sessionId, force, outcome, opts);
  }

  complete(sessionId: string, opts?: { force?: boolean } & IdempotencyCapable): Promise<StageOpResult> {
    return this.completer.complete(sessionId, opts);
  }

  handoff(
    sessionId: string,
    toAgent: string,
    instructions?: string,
    opts?: IdempotencyCapable,
  ): Promise<StageOpResult> {
    return this.handoffer.handoff(sessionId, toAgent, instructions, opts);
  }

  /**
   * Dispatch the named action for `sessionId`. Delegated to the action
   * registry via the wired `executeAction` callback so callers can reach
   * actions through `app.stageAdvance.executeAction(...)`.
   */
  executeAction(sessionId: string, action: string, opts?: IdempotencyCapable): Promise<StageOpResult> {
    return this.deps.executeAction(sessionId, action, opts);
  }
}
