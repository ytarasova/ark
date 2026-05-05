/**
 * Channel-report processing pipeline.
 *
 * The `/api/channel/:sessionId` route and the `/hooks/status` non-hook
 * passthrough both feed reports through `handleReport`. This module owns
 * that pipeline: log events, persist messages, emit bus events, apply
 * store updates, run stage handoff, and trigger completion side-effects
 * (notifications, artifact tracking, knowledge indexing, auto-PR).
 */

import type { AppContext } from "../app.js";
import { createWorktreePR } from "../services/worktree/index.js";
import { eventBus } from "../hooks.js";
import type { OutboundMessage } from "./channel-types.js";
import { safeAsync } from "../safe.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { sendOSNotification } from "../notify.js";
import { markDispatchFailedShared } from "../services/session-dispatch-listeners.js";

export async function handleReport(app: AppContext, sessionId: string, report: OutboundMessage): Promise<void> {
  const result = await app.sessionHooks.applyReport(sessionId, report);

  for (const evt of result.logEvents ?? []) {
    await app.events.log(sessionId, evt.type, evt.opts);
  }

  if (result.message) {
    await app.messages.send(sessionId, result.message.role, result.message.content, result.message.type);
  }

  for (const evt of result.busEvents ?? []) {
    eventBus.emit(evt.type, evt.sessionId, evt.data);
  }

  if (Object.keys(result.updates).length > 0) {
    await app.sessions.update(sessionId, result.updates);
  }

  if (result.shouldAdvance) {
    try {
      const handoff = await app.sessionHooks.mediateStageHandoff(sessionId, {
        autoDispatch: result.shouldAutoDispatch,
        source: "channel_report",
        outcome: result.outcome,
      });
      if (!handoff.ok && !handoff.blockedByVerification) {
        logWarn("conductor", `stage handoff failed for ${sessionId}: ${handoff.message}`);
      }
      if (handoff.blockedByVerification) {
        const s = await app.sessions.get(sessionId);
        await sendOSNotification(
          "Ark: Verification failed",
          `${s?.summary ?? sessionId} - ${handoff.message.slice(0, 100)}`,
        );
        return;
      }
    } catch (handoffErr: any) {
      logError("conductor", `mediateStageHandoff failed for ${sessionId}: ${handoffErr?.message ?? handoffErr}`);
    }
  }

  if (result.shouldRetry) {
    const retryResult = await app.sessionHooks.retryWithContext(sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry triggered for ${sessionId}: ${retryResult.message}`);
      // Inspect the resolved DispatchResult so non-throwing failures
      // (`{ok:false}`) are surfaced too. Pre-fix only `.catch` ran, and
      // `{ok:false}` was silently dropped -- the on_failure retry would
      // appear "scheduled" but the session never made progress. Now both
      // throw and ok:false flip the session to failed.
      app.dispatchService
        .dispatch(sessionId)
        .then(async (r) => {
          if (r && r.ok === false) {
            const reason = r.message ?? "on_failure retry returned ok:false";
            logWarn("conductor", `on_failure retry dispatch returned ok:false for ${sessionId}: ${reason}`);
            await markDispatchFailedShared(app.sessions, app.events, sessionId, reason);
          }
        })
        .catch(async (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          logError("conductor", `on_failure retry dispatch failed for ${sessionId}: ${reason}`);
          await markDispatchFailedShared(app.sessions, app.events, sessionId, reason);
        });
      return;
    }
    logWarn("conductor", `on_failure retry exhausted for ${sessionId}: ${retryResult.message}`);
  }

  const finalSession = await app.sessions.get(sessionId);
  if (finalSession && (report.type === "completed" || report.type === "error")) {
    const notifyTitle = report.type === "completed" ? "Stage completed" : "Session failed";
    const notifyBody = `${finalSession.summary ?? sessionId} - ${finalSession.stage ?? ""}`;
    await sendOSNotification(`Ark: ${notifyTitle}`, notifyBody);
  }

  if (result.prUrl) {
    await app.events.log(sessionId, "pr_detected", {
      actor: "agent",
      data: { pr_url: result.prUrl },
    });
  }

  try {
    const r = report as unknown as Record<string, unknown>;
    if (result.prUrl) {
      await app.artifacts.add(sessionId, "pr", [result.prUrl]);
    }
    if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
      await app.artifacts.add(sessionId, "file", r.filesChanged as string[]);
    }
    if (Array.isArray(r.commits) && r.commits.length > 0) {
      await app.artifacts.add(sessionId, "commit", r.commits as string[]);
    }
    const s = await app.sessions.get(sessionId);
    if (s?.branch && report.type === "completed") {
      await app.artifacts.add(sessionId, "branch", [s.branch]);
    }
  } catch {
    logDebug("conductor", "best-effort artifact tracking");
  }

  if (report.type === "completed" && app.knowledge) {
    try {
      const { indexSessionCompletion } = await import("../knowledge/indexer.js");
      const s = await app.sessions.get(sessionId);
      const changedFiles = ((report as unknown as Record<string, unknown>).filesChanged as string[] | undefined) ?? [];
      await indexSessionCompletion(app.knowledge, sessionId, s?.summary ?? "", "completed", changedFiles);
    } catch {
      logDebug("conductor", "best-effort knowledge indexing");
    }
  }

  if (report.type === "completed" && !result.prUrl) {
    const s = await app.sessions.get(sessionId);
    if (s && !s.pr_url && s.config?.github_url && s.branch) {
      const { loadRepoConfig } = await import("../repo-config.js");
      const repoConfig = s.workdir ? loadRepoConfig(s.workdir) : {};
      const autoPR = repoConfig.auto_pr !== false;

      if (autoPR) {
        await safeAsync(`auto-pr: ${sessionId}`, async () => {
          const prResult = await createWorktreePR(app, sessionId, {
            title: s.summary ?? undefined,
          });
          if (prResult.ok && prResult.pr_url) {
            logInfo("conductor", `auto-PR created for ${sessionId}: ${prResult.pr_url}`);
          }
        });
      }
    }
  }
}
