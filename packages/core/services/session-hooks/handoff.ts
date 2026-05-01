/**
 * Stage handoff + retry orchestration.
 *
 * `mediateStageHandoff` is the single entry point for advancing a session
 * from one stage to the next after an agent completes. It consolidates the
 * verify -> advance -> dispatch chain. `retryWithContext` resets a failed
 * session for re-dispatch, subject to max-retries.
 */

import { logWarn } from "../../observability/structured-log.js";
import { loadRepoConfig } from "../../repo-config.js";
import type { DispatchResult } from "../dispatch/types.js";
import { markDispatchFailedShared } from "../session-dispatch-listeners.js";
import type { StageHandoffResult, SessionHooksDeps } from "./types.js";

export class HandoffMediator {
  constructor(private readonly deps: SessionHooksDeps) {}

  async mediate(
    sessionId: string,
    opts?: { autoDispatch?: boolean; source?: string; outcome?: string },
  ): Promise<StageHandoffResult> {
    const {
      sessions,
      events,
      messages,
      todos,
      getStage,
      getStageAction,
      advance,
      dispatch,
      executeAction,
      runVerification,
    } = this.deps;

    const autoDispatch = opts?.autoDispatch ?? true;
    const source = opts?.source ?? "unknown";

    const session = await sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `Session ${sessionId} not found` };
    }

    const fromStage = session.stage;

    // Step 1: Pre-advance verification (verify scripts + unresolved todos)
    if (fromStage && session.flow) {
      const stageDef = getStage(session.flow, fromStage);
      const hasTodos = (await todos.list(sessionId)).some((t) => !t.done);
      const repoVerify = session.workdir ? loadRepoConfig(session.workdir).verify : undefined;
      if (stageDef?.verify?.length || repoVerify?.length || hasTodos) {
        const verify = await runVerification(sessionId);
        if (!verify.ok) {
          logWarn("handoff", `stage handoff blocked by verification for ${sessionId}/${fromStage}: ${verify.message}`);
          await sessions.update(sessionId, {
            status: "blocked",
            breakpoint_reason: `Verification failed before advancing: ${verify.message.slice(0, 200)}`,
          });
          await messages.send(
            sessionId,
            "system",
            `Advance blocked: verification failed for stage '${fromStage}'. ${verify.message}`,
            "error",
          );
          await events.log(sessionId, "stage_handoff_blocked", {
            actor: "system",
            stage: fromStage,
            data: { reason: "verification_failed", source, message: verify.message.slice(0, 500) },
          });
          return {
            ok: false,
            message: `Verification failed: ${verify.message}`,
            fromStage,
            blockedByVerification: true,
          };
        }
      }
    }

    // Step 2: Advance to the next stage (or complete the flow)
    const advResult = await advance(sessionId, false, opts?.outcome);
    if (!advResult.ok) {
      return { ok: false, message: advResult.message, fromStage };
    }

    const updated = await sessions.get(sessionId);

    // Check if the flow completed (no more stages)
    if (updated?.status === "completed") {
      await events.log(sessionId, "stage_handoff", {
        actor: "system",
        stage: fromStage ?? undefined,
        data: { from_stage: fromStage, to_stage: null, flow_completed: true, source },
      });
      return {
        ok: true,
        message: "Flow completed",
        fromStage,
        toStage: null,
        flowCompleted: true,
      };
    }

    const toStage = updated?.stage ?? null;

    // Step 3: Auto-dispatch the next stage if requested
    let dispatched = false;
    if (autoDispatch && updated?.status === "ready" && toStage) {
      const nextAction = getStageAction(updated.flow, toStage);
      if (nextAction.type === "agent" || nextAction.type === "fork") {
        // Inspect the DispatchResult: a `{ok:false}` return is just as much a
        // dispatch failure as a thrown error. Mirror SessionDispatchListeners
        // behaviour (dispatch_failed event + flip-to-failed lenient guard) so
        // mediator-driven auto-dispatch (planner -> implement -> verify ...)
        // surfaces failures the same way kickDispatch does.
        let dispatchResult: DispatchResult | null = null;
        let dispatchError: Error | null = null;
        try {
          dispatchResult = await dispatch(sessionId);
        } catch (err: any) {
          dispatchError = err instanceof Error ? err : new Error(String(err));
        }

        if (dispatchError || (dispatchResult && dispatchResult.ok === false)) {
          const reason = dispatchError
            ? dispatchError.message
            : (dispatchResult!.message ?? "dispatch returned ok: false");
          logWarn("handoff", `auto-dispatch failed for ${sessionId}/${toStage}: ${reason}`);
          await markDispatchFailedShared(sessions, events, sessionId, reason);
          dispatched = false;
        } else {
          dispatched = true;
        }
      } else if (nextAction.type === "action") {
        // Verification + executeAction. A `{ok:false}` from executeAction is
        // a dispatch-equivalent failure for the action stage; surface it via
        // the same shared helper so the failure shape matches the agent path.
        const verify = await runVerification(sessionId);
        if (!verify.ok) {
          logWarn("handoff", `action stage blocked by verification for ${sessionId}/${toStage}: ${verify.message}`);
          await sessions.update(sessionId, {
            status: "blocked",
            breakpoint_reason: `Verification failed: ${verify.message.slice(0, 200)}`,
          });
          dispatched = false;
        } else {
          let actionResult: { ok: boolean; message: string } | null = null;
          let actionError: Error | null = null;
          try {
            actionResult = await executeAction(sessionId, nextAction.action ?? "");
          } catch (err: any) {
            actionError = err instanceof Error ? err : new Error(String(err));
          }

          if (actionError || (actionResult && actionResult.ok === false)) {
            const rawReason = actionError
              ? actionError.message
              : (actionResult!.message ?? "action returned ok: false");
            const reason = `Action '${nextAction.action}' failed: ${rawReason.slice(0, 200)}`;
            logWarn("handoff", `action '${nextAction.action}' failed for ${sessionId}: ${rawReason}`);
            await markDispatchFailedShared(sessions, events, sessionId, reason);
            dispatched = false;
          } else {
            // Action succeeded -- chain into next stage unless the action
            // set a non-ready status (e.g. auto_merge sets "waiting").
            const postAction = await sessions.get(sessionId);
            if (postAction?.status === "ready") {
              await this.mediate(sessionId, {
                autoDispatch: true,
                source: "action_chain",
              });
            }
            dispatched = true;
          }
        }
      }
    }

    // Step 4: Emit handoff event for observability
    await events.log(sessionId, "stage_handoff", {
      actor: "system",
      stage: toStage ?? undefined,
      data: {
        from_stage: fromStage,
        to_stage: toStage,
        dispatched,
        source,
      },
    });

    return {
      ok: true,
      message: dispatched
        ? `Handed off from '${fromStage}' to '${toStage}' (dispatched)`
        : `Advanced from '${fromStage}' to '${toStage}'`,
      fromStage,
      toStage,
      dispatched,
    };
  }

  async retryWithContext(sessionId: string, opts?: { maxRetries?: number }): Promise<{ ok: boolean; message: string }> {
    const { sessions, events } = this.deps;
    const s = await sessions.get(sessionId);
    if (!s) return { ok: false, message: "Session not found" };
    if (s.status !== "failed") return { ok: false, message: "Session is not in failed state" };

    const maxRetries = opts?.maxRetries ?? 3;
    const priorRetries = (await events.list(sessionId)).filter((e) => e.type === "retry_with_context").length;
    if (priorRetries >= maxRetries) {
      return { ok: false, message: `Max retries (${maxRetries}) reached` };
    }

    await events.log(sessionId, "retry_with_context", {
      actor: "system",
      data: {
        attempt: priorRetries + 1,
        error: s.error,
        stage: s.stage,
      },
    });

    await sessions.update(sessionId, { status: "ready", error: null });

    return { ok: true, message: `Retry ${priorRetries + 1}/${maxRetries} queued` };
  }
}
