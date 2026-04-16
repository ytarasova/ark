/**
 * Burn module -- codeburn-inspired cost observability.
 *
 * Re-exports all public symbols from submodules.
 */

// Types and constants
export {
  type TokenUsageBurn,
  type ToolUseBlock,
  type ContentBlock,
  type ApiUsage,
  type AssistantMessageContent,
  type JournalEntry,
  type ParsedApiCall,
  type ParsedTurn,
  type TaskCategory,
  CATEGORY_LABELS,
  type ClassifiedTurn,
  type SessionSummary,
  type ProjectSummary,
  type DateRange,
  type BurnPeriod,
  type BurnSummaryResponse,
} from "./types.js";

export { extractBashCommands } from "./bash-utils.js";
export { classifyTurn, countRetries } from "./classifier.js";
export { parseClaudeTranscript } from "./parser.js";
export { syncBurn, type SyncResult } from "./sync.js";
export { type BurnTranscriptParser, BurnParserRegistry } from "./burn-parser.js";
export { recordBurnTurns } from "./record.js";
