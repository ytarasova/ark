/**
 * Claude CLI argument assembly + shell quoting helpers.
 *
 * Kept free of fs / tmux / conductor deps so pure argument building can be
 * unit-tested without an AppContext.
 */

import { resolveModel } from "./model.js";

export interface ClaudeArgsOpts {
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  tools?: string[];
  mcpServers?: (string | Record<string, unknown>)[];
  task?: string;
  sessionId?: string;
  headless?: boolean;
  autonomy?: string;
}

export function buildArgs(opts: ClaudeArgsOpts): string[] {
  const args = ["claude"];
  const skipPerms = !opts.autonomy || opts.autonomy === "full" || opts.autonomy === "execute";

  if (opts.headless && opts.task) {
    args.push("-p", opts.task, "--verbose", "--output-format", "stream-json");
    if (skipPerms) {
      args.push("--dangerously-skip-permissions");
    }
  }

  if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  }

  const model = opts.model ? resolveModel(opts.model) : null;
  if (model) args.push("--model", model);

  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

  if (!opts.headless) {
    if (skipPerms) {
      args.push("--dangerously-skip-permissions");
    }
  }

  for (const mcp of opts.mcpServers ?? []) {
    if (typeof mcp === "object") {
      args.push("--mcp-config", JSON.stringify(mcp));
    } else {
      args.push("--mcp-config", mcp);
    }
  }

  return args;
}

// ── Shell quoting ────────────────────────────────────────────────────────────

/** Single-quote a string for bash, escaping embedded single quotes. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** Quote CLI args for bash, preserving --flags unquoted. */
export function shellQuoteArgs(claudeArgs: string[]): string {
  return claudeArgs
    .map((arg, i) => {
      if (arg.startsWith("--")) return arg;
      const prev = claudeArgs[i - 1];
      if (prev && prev.startsWith("--")) return shellQuote(arg);
      return arg;
    })
    .join(" ");
}
