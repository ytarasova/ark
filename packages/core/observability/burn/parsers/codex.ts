/**
 * Codex burn parser.
 *
 * Parses Codex JSONL transcripts into ClassifiedTurns for the burn dashboard.
 *
 * Key Codex transcript patterns:
 *   - {type:"session_meta", payload:{cwd:"..."}} -- session start
 *   - {type:"event_msg", payload:{type:"user_message", message:"..."}} -- user input
 *   - {type:"turn_context", payload:{model:"gpt-5.1-codex-max",...}} -- new turn boundary
 *   - {type:"response_item", payload:{type:"function_call", name:"shell", arguments:"{...}"}} -- tool use
 *   - {type:"response_item", payload:{type:"function_call_output", call_id:"...", output:"..."}} -- result
 *   - {type:"event_msg", payload:{type:"token_count", info:{last_token_usage:{...}}}} -- per-turn tokens
 *
 * Tool normalization: Codex only has `shell`. We map shell commands to
 * Claude-equivalent tool names for consistent classification:
 *   apply_patch -> Edit, cat/head/tail -> Read, ls/find -> Glob,
 *   grep/rg -> Grep, everything else -> Bash
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { PricingRegistry } from "../../pricing.js";
import { classifyTurn } from "../classifier.js";
import { buildSessionSummary } from "../parser.js";
import type { BurnTranscriptParser } from "../burn-parser.js";
import type { ClassifiedTurn, ParsedApiCall, ParsedTurn, TokenUsageBurn } from "../types.js";

const pricing = new PricingRegistry();

// ---------------------------------------------------------------------------
// Tool normalization -- map shell commands to Claude-equivalent tool names
// ---------------------------------------------------------------------------

/** Extract the base command from a Codex shell command array or string. */
function extractBaseCommand(command: unknown): string {
  if (Array.isArray(command)) {
    const first = command[0];
    return typeof first === "string" ? first : "";
  }
  if (typeof command === "string") {
    return command.split(/\s+/)[0] ?? "";
  }
  return "";
}

/** Check if a shell command contains apply_patch. */
function isApplyPatch(command: unknown): boolean {
  if (Array.isArray(command)) {
    return command.some((c) => typeof c === "string" && c.includes("apply_patch"));
  }
  if (typeof command === "string") {
    return command.includes("apply_patch");
  }
  return false;
}

const READ_COMMANDS = new Set(["cat", "head", "tail"]);
const GLOB_COMMANDS = new Set(["ls", "find"]);
const GREP_COMMANDS = new Set(["grep", "rg"]);

/** Map a shell command to a Claude-equivalent tool name. */
function normalizeShellTool(command: unknown): string {
  if (isApplyPatch(command)) return "Edit";
  const base = basename(extractBaseCommand(command));
  if (READ_COMMANDS.has(base)) return "Read";
  if (GLOB_COMMANDS.has(base)) return "Glob";
  if (GREP_COMMANDS.has(base)) return "Grep";
  return "Bash";
}

/** Extract a readable bash command from a Codex shell command. */
function extractBashCommand(command: unknown): string {
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string") return command;
  return "";
}

// ---------------------------------------------------------------------------
// Transcript line types
// ---------------------------------------------------------------------------

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: any;
}

interface PendingTurn {
  userMessage: string;
  timestamp: string;
  model: string;
  tools: string[];
  bashCommands: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  functionCalls: Array<{ normalizedTool: string; isApplyPatch: boolean }>;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class CodexBurnParser implements BurnTranscriptParser {
  readonly kind = "codex";

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
    const entries: CodexLine[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }

    const parsedTurns = this.groupIntoTurns(entries);
    const classifiedTurns = parsedTurns.map(classifyTurn);
    const sessionId = basename(transcriptPath, ".jsonl");
    const summary = buildSessionSummary(sessionId, project, classifiedTurns);

    return { turns: classifiedTurns, summary };
  }

  private groupIntoTurns(entries: CodexLine[]): ParsedTurn[] {
    const turns: ParsedTurn[] = [];
    let currentUserMessage = "";
    let currentTimestamp = "";
    let currentModel = "";
    let turnCalls: ParsedApiCall[] = [];
    let pendingFunctionCalls: Array<{ normalizedTool: string; command: unknown }> = [];
    let turnStarted = false;

    // Token tracking -- last_token_usage gives per-turn deltas
    let lastTokens: { input: number; output: number; cached: number; reasoning: number } | null = null;

    for (const entry of entries) {
      // User message
      if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
        // Flush previous turn if it has calls
        if (turnStarted && turnCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: turnCalls,
            timestamp: currentTimestamp,
            sessionId: "",
          });
        }
        currentUserMessage = entry.payload.message ?? "";
        turnCalls = [];
        pendingFunctionCalls = [];
        turnStarted = false;
        continue;
      }

      // Turn boundary -- marks a new assistant turn
      if (entry.type === "turn_context") {
        // If we already have accumulated calls (from a previous turn_context
        // within the same user message), flush them
        if (turnStarted && turnCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: turnCalls,
            timestamp: currentTimestamp,
            sessionId: "",
          });
          turnCalls = [];
          pendingFunctionCalls = [];
        }
        currentTimestamp = entry.timestamp ?? currentTimestamp;
        currentModel = entry.payload?.model ?? currentModel;
        turnStarted = true;
        lastTokens = null;
        continue;
      }

      // Function call (tool use)
      if (entry.type === "response_item" && entry.payload?.type === "function_call" && entry.payload?.name === "shell") {
        let command: unknown;
        try {
          const args = JSON.parse(entry.payload.arguments ?? "{}");
          command = args.command;
        } catch {
          command = entry.payload.arguments;
        }
        const normalizedTool = normalizeShellTool(command);
        pendingFunctionCalls.push({ normalizedTool, command });
        continue;
      }

      // Token count -- per-turn usage
      if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
        const info = entry.payload.info;
        if (info?.last_token_usage) {
          lastTokens = {
            input: info.last_token_usage.input_tokens ?? 0,
            output: info.last_token_usage.output_tokens ?? 0,
            cached: info.last_token_usage.cached_input_tokens ?? 0,
            reasoning: info.last_token_usage.reasoning_output_tokens ?? 0,
          };

          if (turnStarted && pendingFunctionCalls.length > 0) {
            // Emit each function call as a separate ParsedApiCall so the
            // classifier's Edit -> Bash -> Edit retry detector can see them
            // individually. Split tokens evenly across calls.
            const n = pendingFunctionCalls.length;
            const perCallInput = Math.floor(lastTokens.input / n);
            const perCallOutput = Math.floor((lastTokens.output + lastTokens.reasoning) / n);
            const perCallCached = Math.floor(lastTokens.cached / n);
            const perCallReasoning = Math.floor(lastTokens.reasoning / n);

            for (let i = 0; i < n; i++) {
              const fc = pendingFunctionCalls[i];
              const usage: TokenUsageBurn = {
                inputTokens: perCallInput,
                outputTokens: perCallOutput,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: perCallCached,
                cachedInputTokens: perCallCached,
                reasoningTokens: perCallReasoning,
                webSearchRequests: 0,
              };

              const costUSD = pricing.calculateCost(
                currentModel,
                {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  cache_read_tokens: usage.cacheReadInputTokens,
                  cache_write_tokens: usage.cacheCreationInputTokens,
                },
              );

              const bashCmd = extractBashCommand(fc.command);
              turnCalls.push({
                provider: "openai",
                model: currentModel,
                usage,
                costUSD,
                tools: [fc.normalizedTool],
                mcpTools: [],
                hasAgentSpawn: false,
                hasPlanMode: false,
                speed: "standard",
                timestamp: entry.timestamp ?? currentTimestamp,
                bashCommands: bashCmd ? [bashCmd] : [],
                deduplicationKey: `codex:${entry.timestamp ?? currentTimestamp}:${i}`,
              });
            }
            pendingFunctionCalls = [];
          } else if (turnStarted && pendingFunctionCalls.length === 0) {
            // Token count without function calls -- assistant text only
            const usage: TokenUsageBurn = {
              inputTokens: lastTokens.input,
              outputTokens: lastTokens.output + lastTokens.reasoning,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: lastTokens.cached,
              cachedInputTokens: lastTokens.cached,
              reasoningTokens: lastTokens.reasoning,
              webSearchRequests: 0,
            };

            const costUSD = pricing.calculateCost(
              currentModel,
              {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cache_read_tokens: usage.cacheReadInputTokens,
                cache_write_tokens: usage.cacheCreationInputTokens,
              },
            );

            turnCalls.push({
              provider: "openai",
              model: currentModel,
              usage,
              costUSD,
              tools: [],
              mcpTools: [],
              hasAgentSpawn: false,
              hasPlanMode: false,
              speed: "standard",
              timestamp: entry.timestamp ?? currentTimestamp,
              bashCommands: [],
              deduplicationKey: `codex:${entry.timestamp ?? currentTimestamp}:text`,
            });
          }
        }
        continue;
      }
    }

    // Flush the last turn
    if (turnStarted && turnCalls.length > 0) {
      turns.push({
        userMessage: currentUserMessage,
        assistantCalls: turnCalls,
        timestamp: currentTimestamp,
        sessionId: "",
      });
    }

    return turns;
  }
}
