/**
 * Gemini burn parser.
 *
 * Parses Gemini CLI JSONL transcripts into ClassifiedTurns for the burn dashboard.
 *
 * Key Gemini transcript patterns:
 *   - First line: {sessionId, projectHash, startTime, kind:"chat"} -- metadata
 *   - {type:"user", content:"...", timestamp:"..."} -- user message
 *   - {type:"gemini", content:"...", model:"gemini-2.5-pro", tokens:{input, output, cached, thoughts, tool, total}} -- assistant
 *
 * Gemini transcripts have NO tool data available. Classification is keyword-only
 * from user message text. All tool/bash/mcp arrays are empty.
 * has_edits=false, retries=0, is_one_shot=false for all turns.
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { PricingRegistry } from "../../pricing.js";
import { buildSessionSummary } from "../parser.js";
import type { BurnTranscriptParser } from "../burn-parser.js";
import type { ClassifiedTurn, ParsedApiCall, ParsedTurn, TokenUsageBurn, TaskCategory } from "../types.js";

const pricing = new PricingRegistry();

// -- Keyword patterns for classification (no tool data, keyword-only) --
const DEBUG_KEYWORDS =
  /\b(fix|bug|error|broken|failing|crash|issue|debug|traceback|exception|not\s+working|wrong|unexpected)\b/i;
const FEATURE_KEYWORDS =
  /\b(add|create|implement|new|build|feature|introduce|set\s*up|scaffold|generate|make\s+(?:a|me|the)|write\s+(?:a|me|the))\b/i;
const REFACTOR_KEYWORDS =
  /\b(refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|move|migrate|split)\b/i;
const BRAINSTORM_KEYWORDS =
  /\b(brainstorm|idea|what\s+if|explore|think\s+about|approach|strategy|design|consider|how\s+should|what\s+would|opinion|suggest|recommend)\b/i;
const RESEARCH_KEYWORDS =
  /\b(research|investigate|look\s+into|find\s+out|check|search|analyze|review|understand|explain|how\s+does|what\s+is|show\s+me|list|compare)\b/i;
const TEST_KEYWORDS =
  /\b(test|pytest|vitest|jest|spec|coverage|npm\s+test)\b/i;
const GIT_KEYWORDS =
  /\b(git\s+(push|pull|commit|merge|rebase|checkout|branch|stash|log|diff|status|add|reset))\b/i;
const BUILD_KEYWORDS =
  /\b(npm\s+run\s+build|npm\s+publish|pip\s+install|docker|deploy|make\s+build|cargo\s+build)\b/i;
const CODING_KEYWORDS =
  /\.(py|js|ts|tsx|jsx|json|yaml|yml|toml|sql|sh|go|rs|java|rb|php|css|html)\b/i;

function classifyByKeywords(userMessage: string): TaskCategory {
  if (BRAINSTORM_KEYWORDS.test(userMessage)) return "brainstorming";
  if (TEST_KEYWORDS.test(userMessage)) return "testing";
  if (GIT_KEYWORDS.test(userMessage)) return "git";
  if (BUILD_KEYWORDS.test(userMessage)) return "build/deploy";
  if (DEBUG_KEYWORDS.test(userMessage)) return "debugging";
  if (REFACTOR_KEYWORDS.test(userMessage)) return "refactoring";
  if (FEATURE_KEYWORDS.test(userMessage)) return "feature";
  if (RESEARCH_KEYWORDS.test(userMessage)) return "exploration";
  if (CODING_KEYWORDS.test(userMessage)) return "coding";
  return "conversation";
}

// ---------------------------------------------------------------------------
// Transcript line types
// ---------------------------------------------------------------------------

interface GeminiLine {
  type?: string;
  content?: string;
  model?: string;
  timestamp?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
  };
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class GeminiBurnParser implements BurnTranscriptParser {
  readonly kind = "gemini";

  parseTranscript(transcriptPath: string, project: string) {
    let content: string;
    try {
      content = readFileSync(transcriptPath, "utf-8");
    } catch {
      return {
        turns: [] as ClassifiedTurn[],
        summary: buildSessionSummary(basename(transcriptPath, ".jsonl"), project, []),
      };
    }

    const lines = content.split("\n").filter((l) => l.trim());
    const entries: GeminiLine[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }

    const parsedTurns = this.groupIntoTurns(entries);
    // Gemini has no tool data, so we use keyword-only classification
    const classifiedTurns: ClassifiedTurn[] = parsedTurns.map((turn) => ({
      ...turn,
      category: classifyByKeywords(turn.userMessage),
      retries: 0,
      hasEdits: false,
      isOneShot: false,
    }));

    const sessionId = basename(transcriptPath, ".jsonl");
    const summary = buildSessionSummary(sessionId, project, classifiedTurns);

    return { turns: classifiedTurns, summary };
  }

  private groupIntoTurns(entries: GeminiLine[]): ParsedTurn[] {
    const turns: ParsedTurn[] = [];
    let currentUserMessage = "";
    let currentTimestamp = "";
    let currentCalls: ParsedApiCall[] = [];

    for (const entry of entries) {
      // Skip metadata line (first line with sessionId/projectHash)
      if (entry.sessionId && entry.projectHash && !entry.type) continue;
      // Skip $set and $rewindTo records
      if ((entry as any).$set || (entry as any).$rewindTo) continue;

      if (entry.type === "user") {
        // Flush previous turn if it has calls
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: "",
          });
        }
        currentUserMessage = entry.content ?? "";
        currentTimestamp = entry.timestamp ?? "";
        currentCalls = [];
        continue;
      }

      if (entry.type === "gemini") {
        const tokens = entry.tokens ?? {};
        const inputTokens = tokens.input ?? 0;
        const outputTokens = (tokens.output ?? 0) + (tokens.thoughts ?? 0) + (tokens.tool ?? 0);
        const cachedTokens = tokens.cached ?? 0;

        const usage: TokenUsageBurn = {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: cachedTokens,
          cachedInputTokens: cachedTokens,
          reasoningTokens: tokens.thoughts ?? 0,
          webSearchRequests: 0,
        };

        const model = entry.model ?? "gemini-2.5-pro";
        const costUSD = pricing.calculateCost(
          model,
          {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_tokens: cachedTokens,
            cache_write_tokens: 0,
          },
        );

        currentCalls.push({
          provider: "google",
          model,
          usage,
          costUSD,
          tools: [],
          mcpTools: [],
          hasAgentSpawn: false,
          hasPlanMode: false,
          speed: "standard",
          timestamp: entry.timestamp ?? currentTimestamp,
          bashCommands: [],
          deduplicationKey: `gemini:${entry.timestamp ?? currentTimestamp}:${Math.random()}`,
        });
        continue;
      }

      // Skip info, error, warning message types
    }

    // Flush the last turn
    if (currentCalls.length > 0) {
      turns.push({
        userMessage: currentUserMessage,
        assistantCalls: currentCalls,
        timestamp: currentTimestamp,
        sessionId: "",
      });
    }

    return turns;
  }
}
