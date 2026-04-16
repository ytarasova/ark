/**
 * Claude burn parser -- wraps the existing parseClaudeTranscript() function
 * as a BurnTranscriptParser implementation.
 */

import { parseClaudeTranscript } from "../parser.js";
import type { BurnTranscriptParser } from "../burn-parser.js";

export class ClaudeBurnParser implements BurnTranscriptParser {
  readonly kind = "claude";

  parseTranscript(transcriptPath: string, project: string) {
    return parseClaudeTranscript(transcriptPath, project);
  }
}
