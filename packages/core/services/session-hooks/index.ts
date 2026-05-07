/**
 * SessionHooks -- inbound event processing (hook status, channel reports,
 * stage handoffs, failure retries). Composes three internal appliers over a
 * shared `SessionHooksDeps` cradle-slice.
 */

import type { Session } from "../../../types/index.js";
import type { OutboundMessage } from "../channel/channel-types.js";
import { HookStatusApplier } from "./hook-status.js";
import { ReportApplier } from "./report.js";
import { HandoffMediator } from "./handoff.js";
import type { HookStatusResult, ReportResult, StageHandoffResult, SessionHooksDeps } from "./types.js";

export type { HookStatusResult, ReportResult, StageHandoffResult, SessionHooksDeps } from "./types.js";
export { parseOnFailure } from "./types.js";

export class SessionHooks {
  private readonly hookStatus: HookStatusApplier;
  private readonly report: ReportApplier;
  private readonly handoff: HandoffMediator;

  constructor(deps: SessionHooksDeps) {
    this.hookStatus = new HookStatusApplier(deps);
    this.report = new ReportApplier(deps);
    this.handoff = new HandoffMediator(deps);
  }

  /** Process a hook status event; returns updates + events + flags for the caller to apply. */
  applyHookStatus(session: Session, hookEvent: string, payload: Record<string, unknown>): Promise<HookStatusResult> {
    return this.hookStatus.apply(session, hookEvent, payload);
  }

  /** Process an agent channel report; returns updates + messages + flags. */
  applyReport(sessionId: string, report: OutboundMessage): Promise<ReportResult> {
    return this.report.apply(sessionId, report);
  }

  /**
   * Verify -> advance -> optional dispatch. Single entry point for stage
   * transitions after an agent completes.
   */
  mediateStageHandoff(
    sessionId: string,
    opts?: { autoDispatch?: boolean; source?: string; outcome?: string },
  ): Promise<StageHandoffResult> {
    return this.handoff.mediate(sessionId, opts);
  }

  /** Reset a failed session to `ready` for re-dispatch, gated on max retries. */
  retryWithContext(sessionId: string, opts?: { maxRetries?: number }): Promise<{ ok: boolean; message: string }> {
    return this.handoff.retryWithContext(sessionId, opts);
  }
}
