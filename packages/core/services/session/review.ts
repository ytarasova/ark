/**
 * SessionReviewer -- runVerification, approve/reject review gate, renderReworkPrompt.
 * Extracted from the old session-lifecycle.ts.
 */

import { execFile } from "child_process";
import { promisify } from "util";

import type { SessionLifecycleDeps, VerificationResult, VerifyScriptRunner } from "./types.js";
import * as flow from "../flow.js";
import { loadRepoConfig } from "../../repo-config.js";
import { substituteVars, buildSessionVars } from "../../template.js";

const execFileAsync = promisify(execFile);

const defaultVerifyScriptRunner: VerifyScriptRunner = async (script, opts) => {
  const { stdout, stderr } = await execFileAsync("bash", ["-c", script], {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
};

/** Default rework prompt when the flow stage doesn't declare one. */
const DEFAULT_REWORK_PROMPT = "Rework required. Reviewer said: {{rejection_reason}}";

/**
 * Render the rework prompt template. Uses the standard Nunjucks template
 * engine; `{{rejection_reason}}` is injected alongside the session vars.
 */
export function renderReworkPrompt(template: string, reason: string, sessionVars: Record<string, string>): string {
  const merged: Record<string, string> = { ...sessionVars, rejection_reason: reason };
  return substituteVars(template, merged);
}

export class SessionReviewer {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  /**
   * Run verification for a session: check todos are resolved and verify scripts
   * pass. Returns structured results for display and enforcement.
   */
  async runVerification(
    sessionId: string,
    opts?: { runScript?: VerifyScriptRunner; timeoutMs?: number },
  ): Promise<VerificationResult> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session)
      return { ok: false, todosResolved: true, pendingTodos: [], scriptResults: [], message: "Session not found" };

    const todos = await d.todos.list(sessionId);
    const pending = todos.filter((t) => !t.done);
    const todosResolved = pending.length === 0;

    const flowShim = { flows: d.flows } as unknown as Parameters<typeof flow.getStage>[0];
    const stageVerify =
      session.stage && session.flow ? flow.getStage(flowShim, session.flow, session.stage)?.verify : undefined;
    const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
    const scripts: string[] = stageVerify ?? repoConfig.verify ?? [];

    const workdir = session.workdir ?? session.repo;
    const scriptResults: Array<{ script: string; passed: boolean; output: string }> = [];
    const runScript = opts?.runScript ?? defaultVerifyScriptRunner;
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    for (const script of scripts) {
      try {
        const { stdout, stderr } = await runScript(script, { cwd: workdir ?? undefined, timeoutMs });
        scriptResults.push({ script, passed: true, output: (stdout + stderr).slice(0, 5000) });
      } catch (e: any) {
        const output = ((e?.stderr ?? "") + (e?.stdout ?? "") + (e?.message ?? "")).slice(0, 5000);
        scriptResults.push({ script, passed: false, output });
      }
    }

    const allScriptsPassed = scriptResults.every((r) => r.passed);
    const ok = todosResolved && allScriptsPassed;

    const parts: string[] = [];
    if (!todosResolved) parts.push(`${pending.length} unresolved todo(s): ${pending.map((t) => t.content).join(", ")}`);
    for (const r of scriptResults) {
      if (!r.passed) parts.push(`verify failed: ${r.script}\n${r.output}`);
    }

    return {
      ok,
      todosResolved,
      pendingTodos: pending.map((t) => t.content),
      scriptResults,
      message: ok ? "Verification passed" : parts.join("\n"),
    };
  }

  /** Open a review gate -- called when PR is approved via webhook. */
  async approve(
    sessionId: string,
    advanceOverride?: (id: string, force?: boolean) => Promise<{ ok: boolean; message: string }>,
  ): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const s = await d.sessions.get(sessionId);
    if (!s) return { ok: false, message: "Session not found" };

    await d.events.log(sessionId, "review_approved", {
      stage: s.stage ?? undefined,
      actor: "github",
    });

    const advanceFn = advanceOverride ?? d.advance;
    return await advanceFn(sessionId, true);
  }

  /**
   * Reject a review gate: render the rework prompt, persist it, bump the rework
   * counter, clear the runtime session id so the next dispatch starts fresh,
   * log a `review_rejected` event, and re-dispatch the same stage. When
   * `on_reject.max_rejections` is exceeded, the session is marked `failed`
   * instead of re-dispatched.
   *
   * Accepts an optional `dispatchOverride` so tests (and the back-compat
   * shim) can inject a stub; defaults to the DI-wired dispatch callback.
   */
  async reject(
    sessionId: string,
    reason: string,
    dispatchOverride?: (id: string) => Promise<{ ok: boolean; message: string }>,
  ): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: "Session not found" };

    const stageName = session.stage;
    if (!stageName) return { ok: false, message: "Session has no current stage" };

    const flowShim = { flows: d.flows } as unknown as Parameters<typeof flow.getStage>[0];
    const stageDef = flow.getStage(flowShim, session.flow, stageName);
    if (!stageDef) return { ok: false, message: `Stage '${stageName}' not found in flow '${session.flow}'` };

    if (stageDef.gate !== "review" && stageDef.gate !== "manual") {
      return {
        ok: false,
        message: `Stage '${stageName}' gate is '${stageDef.gate}', expected 'review' or 'manual'`,
      };
    }

    const onReject = stageDef.on_reject;
    const max = onReject?.max_rejections;
    const currentCount = session.rejection_count ?? 0;

    if (typeof max === "number" && max >= 0 && currentCount >= max) {
      await d.sessions.update(sessionId, { status: "failed", error: "max_rejections exceeded" });
      await d.events.log(sessionId, "review_rejected", {
        stage: stageName,
        actor: "user",
        data: { reason, rejection_count: currentCount, max_rejections: max, capped: true },
      });
      await d.events.log(sessionId, "session_failed", {
        stage: stageName,
        actor: "system",
        data: { reason: "max_rejections exceeded", rejection_count: currentCount, max_rejections: max },
      });
      return { ok: false, message: "max_rejections exceeded" };
    }

    const vars = buildSessionVars(session as unknown as Record<string, unknown>);
    const template = onReject?.prompt && onReject.prompt.trim() ? onReject.prompt : DEFAULT_REWORK_PROMPT;
    const rendered = renderReworkPrompt(template, reason, vars);

    const nextCount = currentCount + 1;
    await d.sessions.update(sessionId, {
      rework_prompt: rendered,
      rejection_count: nextCount,
      rejected_at: new Date().toISOString(),
      rejected_reason: reason,
      claude_session_id: null,
      session_id: null,
      status: "ready",
      error: null,
    });

    await d.events.log(sessionId, "review_rejected", {
      stage: stageName,
      actor: "user",
      data: { reason, rejection_count: nextCount, max_rejections: max ?? null },
    });

    const dispatchFn = dispatchOverride ?? d.dispatch;
    return await dispatchFn(sessionId);
  }
}
