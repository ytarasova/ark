/**
 * TranscriptParser interface + registry.
 *
 * Each agent runtime (claude, codex, gemini, ...) provides a TranscriptParser
 * implementation next to its other runtime code. Parsers are registered into
 * a registry at app boot and resolved via AppContext at dispatch/completion time.
 *
 * To add a new runtime parser:
 *   1. Create packages/core/runtimes/<name>/parser.ts
 *   2. Export a class/instance implementing TranscriptParser
 *   3. Register it in app.ts boot sequence: registry.register(new MyParser())
 *   4. Set billing.transcript_parser: <name> in the runtime YAML
 */

import type { TokenUsage } from "../observability/pricing.js";

export interface ParseResult {
  usage: TokenUsage;
  model?: string;
  transcript_path?: string;
}

export interface FindOpts {
  /** Workdir/cwd the Ark session ran in. Used to disambiguate concurrent runs. */
  workdir: string;
  /** Only consider transcripts created at or after this time. */
  startTime?: Date;
}

export interface TranscriptParser {
  /** Kind identifier that matches runtime.billing.transcript_parser (e.g. 'claude'). */
  readonly kind: string;
  /** Parse a transcript file and extract token usage. Never throws. */
  parse(transcriptPath: string): ParseResult;
  /**
   * Find the transcript file for a specific Ark session.
   * Matches by workdir (cwd the tool ran in) + start time. Handles
   * concurrent sessions and cross-contamination from manual tool runs.
   * Returns null when no match found.
   */
  findForSession(opts: FindOpts): string | null;
}

/**
 * Registry of transcript parsers keyed by kind.
 * Populated at app boot from the runtime implementations.
 */
export class TranscriptParserRegistry {
  private parsers = new Map<string, TranscriptParser>();

  register(parser: TranscriptParser): void {
    this.parsers.set(parser.kind, parser);
  }

  get(kind: string): TranscriptParser | undefined {
    return this.parsers.get(kind);
  }

  list(): TranscriptParser[] {
    return Array.from(this.parsers.values());
  }

  has(kind: string): boolean {
    return this.parsers.has(kind);
  }
}
