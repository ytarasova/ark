/**
 * TranscriptParser -- extracts token usage from non-Claude agent transcripts
 * (codex, gemini) after a session reaches a terminal state. Claude usage is
 * captured via hooks in applyHookStatus(); this handles everyone else.
 */

import type { Session } from "../../../types/index.js";
import { logError } from "../../observability/structured-log.js";
import type { StageAdvanceDeps } from "./types.js";

export class TranscriptParser {
  constructor(private readonly deps: StageAdvanceDeps) {}

  parseNonClaude(session: Session): void {
    const { deps } = this;
    try {
      const runtimeName = (session.config?.runtime as string | undefined) ?? session.agent;
      if (!runtimeName) return;
      const runtime = deps.runtimes.get(runtimeName);
      const parserKind = runtime?.billing?.transcript_parser;
      // Only handle non-Claude kinds here; Claude is handled via hooks in applyHookStatus.
      if (!parserKind || parserKind === "claude") return;

      const parser = deps.transcriptParsers.get(parserKind);
      if (!parser) {
        logError("session", "no transcript parser registered", { sessionId: session.id, kind: parserKind });
        return;
      }

      const workdir = session.workdir;
      if (!workdir) return;

      const transcriptPath = parser.findForSession({
        workdir,
        startTime: session.created_at ? new Date(session.created_at) : undefined,
      });
      if (!transcriptPath) return;

      const result = parser.parse(transcriptPath);
      if (result.usage.input_tokens > 0 || result.usage.output_tokens > 0) {
        const provider = parserKind === "codex" ? "openai" : parserKind === "gemini" ? "google" : parserKind;
        deps.recordSessionUsage(session, result.usage, provider, "transcript");
      }
    } catch (e: any) {
      logError("session", "non-Claude transcript parsing failed", {
        sessionId: session.id,
        error: String(e?.message ?? e),
      });
    }
  }
}
