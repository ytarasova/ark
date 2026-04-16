/**
 * Claude transcript parser -- ported from AgentSeal/codeburn (MIT).
 * Reads a Claude Code JSONL transcript file, groups entries into turns,
 * deduplicates by message id, classifies each turn, and builds a SessionSummary.
 *
 * Adapted for Ark: uses PricingRegistry for cost calculation instead of
 * codeburn's inline model pricing.
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { PricingRegistry } from "../pricing.js";
import { classifyTurn } from "./classifier.js";
import { BASH_TOOLS } from "./classifier.js";
import { extractBashCommands } from "./bash-utils.js";
import type {
  AssistantMessageContent,
  ClassifiedTurn,
  ContentBlock,
  JournalEntry,
  ParsedApiCall,
  ParsedTurn,
  SessionSummary,
  TokenUsageBurn,
  ToolUseBlock,
} from "./types.js";

// Shared PricingRegistry instance for cost calculation
const pricing = new PricingRegistry();

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

export function parseJsonlLine(line: string): JournalEntry | null {
  try {
    return JSON.parse(line) as JournalEntry;
  } catch {
    return null;
  }
}

export function extractToolNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => b.name);
}

export function extractMcpTools(tools: string[]): string[] {
  return tools.filter((t) => t.startsWith("mcp__"));
}

function extractCoreTools(tools: string[]): string[] {
  return tools.filter((t) => !t.startsWith("mcp__"));
}

export function extractBashCommandsFromContent(content: ContentBlock[]): string[] {
  return content
    .filter(
      (b): b is ToolUseBlock =>
        b.type === "tool_use" && BASH_TOOLS.has((b as ToolUseBlock).name),
    )
    .flatMap((b) => {
      const command = (b.input as Record<string, unknown>)?.command;
      return typeof command === "string" ? extractBashCommands(command) : [];
    });
}

export function getUserMessageText(entry: JournalEntry): string {
  if (!entry.message || entry.message.role !== "user") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

export function getMessageId(entry: JournalEntry): string | null {
  if (entry.type !== "assistant") return null;
  const msg = entry.message as AssistantMessageContent | undefined;
  return msg?.id ?? null;
}

// ---------------------------------------------------------------------------
// API call parsing
// ---------------------------------------------------------------------------

export function parseApiCall(entry: JournalEntry): ParsedApiCall | null {
  if (entry.type !== "assistant") return null;
  const msg = entry.message as AssistantMessageContent | undefined;
  if (!msg?.usage || !msg?.model) return null;

  const usage = msg.usage;
  const tokens: TokenUsageBurn = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  };

  // Use Ark's PricingRegistry for cost calculation
  const costUSD = pricing.calculateCost(
    msg.model,
    {
      input_tokens: tokens.inputTokens,
      output_tokens: tokens.outputTokens,
      cache_read_tokens: tokens.cacheReadInputTokens,
      cache_write_tokens: tokens.cacheCreationInputTokens,
    },
    {
      speed: usage.speed ?? "standard",
      webSearchRequests: tokens.webSearchRequests,
    },
  );

  const tools = extractToolNames(msg.content ?? []);
  const bashCmds = extractBashCommandsFromContent(msg.content ?? []);

  return {
    provider: "claude",
    model: msg.model,
    usage: tokens,
    costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes("Agent"),
    hasPlanMode: tools.includes("EnterPlanMode"),
    speed: usage.speed ?? "standard",
    timestamp: entry.timestamp ?? "",
    bashCommands: bashCmds,
    deduplicationKey: msg.id ?? `claude:${entry.timestamp}`,
  };
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

export function groupIntoTurns(
  entries: JournalEntry[],
  seenMsgIds: Set<string>,
): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let currentUserMessage = "";
  let currentCalls: ParsedApiCall[] = [];
  let currentTimestamp = "";
  let currentSessionId = "";

  for (const entry of entries) {
    if (entry.type === "user") {
      const text = getUserMessageText(entry);
      if (text.trim()) {
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: currentSessionId,
          });
        }
        currentUserMessage = text;
        currentCalls = [];
        currentTimestamp = entry.timestamp ?? "";
        currentSessionId = entry.sessionId ?? "";
      }
    } else if (entry.type === "assistant") {
      const msgId = getMessageId(entry);
      if (msgId && seenMsgIds.has(msgId)) continue;
      if (msgId) seenMsgIds.add(msgId);
      const call = parseApiCall(entry);
      if (call) currentCalls.push(call);
    }
  }

  // Flush the last turn
  if (currentCalls.length > 0) {
    turns.push({
      userMessage: currentUserMessage,
      assistantCalls: currentCalls,
      timestamp: currentTimestamp,
      sessionId: currentSessionId,
    });
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Session summary builder
// ---------------------------------------------------------------------------

export function buildSessionSummary(
  sessionId: string,
  project: string,
  turns: ClassifiedTurn[],
): SessionSummary {
  const modelBreakdown: SessionSummary["modelBreakdown"] = {};
  const toolBreakdown: SessionSummary["toolBreakdown"] = {};
  const mcpBreakdown: SessionSummary["mcpBreakdown"] = {};
  const bashBreakdown: SessionSummary["bashBreakdown"] = {};
  const categoryBreakdown: SessionSummary["categoryBreakdown"] =
    {} as SessionSummary["categoryBreakdown"];

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let apiCalls = 0;
  let firstTs = "";
  let lastTs = "";

  for (const turn of turns) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0);

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = {
        turns: 0,
        costUSD: 0,
        retries: 0,
        editTurns: 0,
        oneShotTurns: 0,
      };
    }
    categoryBreakdown[turn.category].turns++;
    categoryBreakdown[turn.category].costUSD += turnCost;
    if (turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++;
      categoryBreakdown[turn.category].retries += turn.retries;
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++;
    }

    for (const call of turn.assistantCalls) {
      totalCost += call.costUSD;
      totalInput += call.usage.inputTokens;
      totalOutput += call.usage.outputTokens;
      totalCacheRead += call.usage.cacheReadInputTokens;
      totalCacheWrite += call.usage.cacheCreationInputTokens;
      apiCalls++;

      const modelKey = call.model;
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          tokens: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
          },
        };
      }
      modelBreakdown[modelKey].calls++;
      modelBreakdown[modelKey].costUSD += call.costUSD;
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens;
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens;
      modelBreakdown[modelKey].tokens.cacheReadInputTokens +=
        call.usage.cacheReadInputTokens;
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens +=
        call.usage.cacheCreationInputTokens;

      for (const tool of extractCoreTools(call.tools)) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 };
        toolBreakdown[tool].calls++;
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split("__")[1] ?? mcp;
        mcpBreakdown[server] = mcpBreakdown[server] ?? { calls: 0 };
        mcpBreakdown[server].calls++;
      }
      for (const cmd of call.bashCommands) {
        bashBreakdown[cmd] = bashBreakdown[cmd] ?? { calls: 0 };
        bashBreakdown[cmd].calls++;
      }

      if (!firstTs || call.timestamp < firstTs) firstTs = call.timestamp;
      if (!lastTs || call.timestamp > lastTs) lastTs = call.timestamp;
    }
  }

  return {
    sessionId,
    project,
    firstTimestamp: firstTs || turns[0]?.timestamp || "",
    lastTimestamp: lastTs || turns[turns.length - 1]?.timestamp || "",
    totalCostUSD: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    apiCalls,
    turns,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Claude Code JSONL transcript file, classify turns, and build a
 * SessionSummary. This is the main entry point for the burn pipeline.
 */
export function parseClaudeTranscript(
  transcriptPath: string,
  project: string,
): { turns: ClassifiedTurn[]; summary: SessionSummary } {
  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return {
      turns: [],
      summary: buildSessionSummary(
        basename(transcriptPath, ".jsonl"),
        project,
        [],
      ),
    };
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const entries: JournalEntry[] = [];

  for (const line of lines) {
    const entry = parseJsonlLine(line);
    if (entry) entries.push(entry);
  }

  const seenMsgIds = new Set<string>();
  const parsedTurns = groupIntoTurns(entries, seenMsgIds);
  const classifiedTurns = parsedTurns.map(classifyTurn);
  const sessionId = basename(transcriptPath, ".jsonl");
  const summary = buildSessionSummary(sessionId, project, classifiedTurns);

  return { turns: classifiedTurns, summary };
}
