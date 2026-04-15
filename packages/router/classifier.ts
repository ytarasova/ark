/**
 * LLM Router -- request complexity classifier.
 *
 * Rule-based v1 classifier. Analyzes the request to estimate complexity
 * along multiple dimensions: message length, turn count, tool presence,
 * code indicators, and reasoning keywords.
 *
 * Returns a ClassificationResult with a 0-1 score, task type, difficulty,
 * and a list of signals that contributed to the score.
 */

import type { ChatCompletionRequest, Difficulty } from "./types.js";

// ── Classification result ────────────────────────────────────────────────────

export interface ClassificationResult {
  score: number; // 0-1 complexity score
  task_type: string; // "code", "reasoning", "extraction", "generation", "chat"
  difficulty: Difficulty;
  has_tools: boolean;
  context_length: number; // estimated token count
  turn_count: number; // number of messages
  signals: string[]; // e.g. ["long_context", "multi_tool", "code_generation"]
}

// ── Signal patterns ──────────────────────────────────────────────────────────

const CODE_PATTERNS = [
  /```[\s\S]*?```/, // fenced code blocks
  /\bfunction\s+\w+/, // function declarations
  /\bclass\s+\w+/, // class declarations
  /\bimport\s+[\{*]/, // import statements
  /\bconst\s+\w+\s*=/, // const assignments
  /\b(async|await)\b/, // async/await
  /\.(ts|js|py|go|rs|java|cpp)\b/, // file extensions
  /\b(npm|pip|cargo|maven|gradle)\b/, // package managers
  /\b(git|docker|kubectl)\b/, // devops tools
  /\bdef\s+\w+\(/, // Python function defs
];

const REASONING_PATTERNS = [
  /\b(explain|analyze|compare|contrast|evaluate|assess)\b/i,
  /\b(prove|derive|deduce|infer|reason)\b/i,
  /\b(why|how come|what causes|what is the relationship)\b/i,
  /\b(trade-?offs?|pros?\s+and\s+cons?|advantages?\s+and\s+disadvantages?)\b/i,
  /\b(step[\s-]by[\s-]step|think through|break down)\b/i,
  /\b(implications?|consequences?|ramifications?)\b/i,
  /\b(architecture|design pattern|system design)\b/i,
];

const EXTRACTION_PATTERNS = [
  /\b(extract|parse|summarize|list|enumerate)\b/i,
  /\b(find all|identify|locate|search for)\b/i,
  /\b(convert|transform|translate|format)\b/i,
  /\b(json|csv|xml|yaml|markdown)\b/i,
];

const SIMPLE_CHAT_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|sure|yes|no|bye|good)\b/i,
  /^(what is|who is|when was|where is)\s/i,
  /\?$/, // simple questions
];

// ── Public API ───────────────────────────────────────────────────────────────

export function classify(request: ChatCompletionRequest): ClassificationResult {
  const _t0 = performance.now();
  const signals: string[] = [];
  let score = 0;

  const messages = request.messages || [];
  const turnCount = messages.length;
  const hasTools = !!(request.tools && request.tools.length > 0);
  const toolCount = request.tools?.length ?? 0;

  // Get full text content for analysis
  const fullText = messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
  const lastUserMsg = getLastUserMessage(messages);

  // Estimate token count (rough: ~4 chars per token)
  const contextLength = Math.ceil(fullText.length / 4);

  // ── Signal: context length ─────────────────────────────────────────────

  if (contextLength > 50000) {
    signals.push("very_long_context");
    score += 0.25;
  } else if (contextLength > 10000) {
    signals.push("long_context");
    score += 0.15;
  } else if (contextLength > 2000) {
    signals.push("medium_context");
    score += 0.05;
  }

  // ── Signal: turn count ─────────────────────────────────────────────────

  if (turnCount > 20) {
    signals.push("many_turns");
    score += 0.15;
  } else if (turnCount > 10) {
    signals.push("multi_turn");
    score += 0.1;
  } else if (turnCount > 4) {
    signals.push("few_turns");
    score += 0.05;
  }

  // ── Signal: tool presence ──────────────────────────────────────────────

  if (hasTools) {
    if (toolCount > 5) {
      signals.push("multi_tool");
      score += 0.2;
    } else {
      signals.push("has_tools");
      score += 0.1;
    }
  }

  if (request.tool_choice && request.tool_choice !== "none") {
    signals.push("forced_tool_use");
    score += 0.05;
  }

  // ── Signal: code indicators ────────────────────────────────────────────

  let codeHits = 0;
  for (const pat of CODE_PATTERNS) {
    if (pat.test(fullText)) codeHits++;
  }

  if (codeHits >= 4) {
    signals.push("heavy_code");
    score += 0.2;
  } else if (codeHits >= 2) {
    signals.push("code_generation");
    score += 0.12;
  } else if (codeHits >= 1) {
    signals.push("code_mention");
    score += 0.05;
  }

  // ── Signal: reasoning indicators ───────────────────────────────────────

  let reasoningHits = 0;
  for (const pat of REASONING_PATTERNS) {
    if (pat.test(lastUserMsg)) reasoningHits++;
  }

  if (reasoningHits >= 3) {
    signals.push("deep_reasoning");
    score += 0.2;
  } else if (reasoningHits >= 1) {
    signals.push("reasoning");
    score += 0.1;
  }

  // ── Signal: extraction / simple tasks ──────────────────────────────────

  let extractionHits = 0;
  for (const pat of EXTRACTION_PATTERNS) {
    if (pat.test(lastUserMsg)) extractionHits++;
  }

  if (extractionHits >= 2) {
    signals.push("extraction_task");
    // Extraction is moderate complexity -- can be done by standard models
    score += 0.05;
  }

  // ── Signal: simple chat ────────────────────────────────────────────────

  if (turnCount <= 2 && lastUserMsg.length < 100) {
    let simpleChatHits = 0;
    for (const pat of SIMPLE_CHAT_PATTERNS) {
      if (pat.test(lastUserMsg)) simpleChatHits++;
    }
    if (simpleChatHits >= 1) {
      signals.push("simple_chat");
      score -= 0.15;
    }
  }

  // ── Signal: system prompt complexity ───────────────────────────────────

  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg) {
    const sysText = typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content ?? "");
    const sysTokens = Math.ceil(sysText.length / 4);
    if (sysTokens > 2000) {
      signals.push("complex_system_prompt");
      score += 0.1;
    } else if (sysTokens > 500) {
      signals.push("detailed_system_prompt");
      score += 0.05;
    }
  }

  // ── Clamp score ────────────────────────────────────────────────────────

  score = Math.max(0, Math.min(1, score));

  // ── Determine task type ────────────────────────────────────────────────

  const taskType = detectTaskType(signals);
  const difficulty = scoreToDifficulty(score);

  return {
    score,
    task_type: taskType,
    difficulty,
    has_tools: hasTools,
    context_length: contextLength,
    turn_count: turnCount,
    signals,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLastUserMessage(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const c = messages[i].content;
      return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }
  }
  return "";
}

function detectTaskType(signals: string[]): string {
  if (signals.includes("heavy_code") || signals.includes("code_generation")) return "code";
  if (signals.includes("deep_reasoning") || signals.includes("reasoning")) return "reasoning";
  if (signals.includes("extraction_task")) return "extraction";
  if (signals.includes("simple_chat")) return "chat";
  return "generation";
}

function scoreToDifficulty(score: number): Difficulty {
  if (score < 0.15) return "trivial";
  if (score < 0.3) return "simple";
  if (score < 0.55) return "moderate";
  if (score < 0.75) return "complex";
  return "expert";
}
