/**
 * StageHandoffer -- clone-and-dispatch to a different agent.
 *
 * Idempotency-keyed so a Temporal retry doesn't double-clone the session.
 */

import { withIdempotency } from "../idempotency.js";
import type { IdempotencyCapable, StageAdvanceDeps, StageOpResult } from "./types.js";

export class StageHandoffer {
  constructor(private readonly deps: StageAdvanceDeps) {}

  handoff(
    sessionId: string,
    toAgent: string,
    instructions?: string,
    opts?: IdempotencyCapable,
  ): Promise<StageOpResult> {
    const { deps } = this;
    return withIdempotency(
      deps.db,
      { sessionId, stage: null, opKind: "handoff", idempotencyKey: opts?.idempotencyKey },
      async () => {
        const result = await deps.sessionClone(sessionId, instructions);
        if (!result.ok) return { ok: false, message: (result as { ok: false; message: string }).message };

        await deps.events.log(result.sessionId, "session_handoff", {
          actor: "user",
          data: { from_session: sessionId, to_agent: toAgent, instructions },
        });

        return deps.dispatch(result.sessionId);
      },
    );
  }
}
