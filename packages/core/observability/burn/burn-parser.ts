/**
 * BurnTranscriptParser interface + registry.
 *
 * Each agent runtime (claude, codex, gemini, ...) provides a BurnTranscriptParser
 * that extracts classified turns and session summaries from transcript files.
 * Unlike the TranscriptParser (which extracts token usage for cost tracking),
 * the BurnTranscriptParser produces fine-grained per-turn classification data
 * for the burn dashboard.
 *
 * To add a new runtime burn parser:
 *   1. Create packages/core/observability/burn/parsers/<name>.ts
 *   2. Export a class implementing BurnTranscriptParser
 *   3. Register it in app.ts: app.burnParsers.register(new MyBurnParser())
 */

import type { ClassifiedTurn, SessionSummary } from "./types.js";

export interface BurnTranscriptParser {
  /** Kind identifier matching runtime.billing.transcript_parser (e.g. 'claude'). */
  readonly kind: string;

  /**
   * Parse a transcript file, classify each turn, and build a session summary.
   * Returns empty arrays/summary on read errors (never throws).
   */
  parseTranscript(
    transcriptPath: string,
    project: string,
  ): { turns: ClassifiedTurn[]; summary: SessionSummary };
}

/**
 * Registry of burn transcript parsers keyed by kind.
 * Populated at app boot from the runtime burn parser implementations.
 */
export class BurnParserRegistry {
  private parsers = new Map<string, BurnTranscriptParser>();

  register(parser: BurnTranscriptParser): void {
    this.parsers.set(parser.kind, parser);
  }

  get(kind: string): BurnTranscriptParser | undefined {
    return this.parsers.get(kind);
  }

  has(kind: string): boolean {
    return this.parsers.has(kind);
  }

  list(): BurnTranscriptParser[] {
    return Array.from(this.parsers.values());
  }
}
