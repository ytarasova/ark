/**
 * StageCompleter -- runs `complete()`: verification + transcript parse +
 * cascade into advance. Cascade calls `advancer.advanceImpl` directly so it
 * does NOT re-key on the caller's idempotency key.
 */

import { loadRepoConfig } from "../../repo-config.js";
import { withIdempotency } from "../idempotency.js";
import type { StageAdvancer } from "./advance.js";
import type { TranscriptParser } from "./transcript-parse.js";
import type { IdempotencyCapable, StageAdvanceDeps, StageOpResult } from "./types.js";

export class StageCompleter {
  constructor(
    private readonly deps: StageAdvanceDeps,
    private readonly advancer: StageAdvancer,
    private readonly transcriptParser: TranscriptParser,
  ) {}

  complete(sessionId: string, opts?: { force?: boolean } & IdempotencyCapable): Promise<StageOpResult> {
    return withIdempotency(
      this.deps.db,
      { sessionId, stage: null, opKind: "complete", idempotencyKey: opts?.idempotencyKey },
      () => this.completeImpl(sessionId, opts),
    );
  }

  private async completeImpl(
    sessionId: string,
    opts: ({ force?: boolean } & IdempotencyCapable) | undefined,
  ): Promise<StageOpResult> {
    const { deps } = this;
    const session = await deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    // Run verification unless --force.
    // Quick sync check: only invoke async runVerification if there are todos or verify scripts.
    if (!opts?.force) {
      const hasTodos = (await deps.todos.list(sessionId)).length > 0;
      const stageVerify =
        session.stage && session.flow ? deps.getStage(session.flow, session.stage)?.verify : undefined;
      const repoVerify = session.workdir ? loadRepoConfig(session.workdir).verify : undefined;
      const hasScripts = (stageVerify ?? repoVerify ?? []).length > 0;

      if (hasTodos || hasScripts) {
        const verify = await deps.runVerification(sessionId);
        if (!verify.ok) {
          return { ok: false, message: `Verification failed:\n${verify.message}` };
        }
      }
    }

    await deps.events.log(sessionId, "stage_completed", {
      stage: session.stage,
      actor: "user",
      data: { note: "Manually completed" },
    });
    await deps.messages.markRead(sessionId);

    // Parse agent transcript for token usage (non-Claude agents).
    // Claude usage is captured via hooks in applyHookStatus(); this handles codex/gemini.
    this.transcriptParser.parseNonClaude(session);

    await deps.sessions.update(sessionId, { status: "ready", session_id: null });
    // Internal cascade -- the outer complete() already keyed on idempotencyKey,
    // so we MUST NOT re-key advance() here or we'd collide with a caller that
    // later replays advance() on its own. Run the body directly.
    return this.advancer.advanceImpl(sessionId, true, undefined);
  }
}
