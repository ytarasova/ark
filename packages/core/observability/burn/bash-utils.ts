/**
 * Bash command extraction -- ported from codeburn (MIT).
 * Splits a shell command string into individual command names,
 * collapsing git/npm/npx subcommands and skipping builtins.
 */

import { basename } from "path";

const BUILTINS = new Set([
  "cd", "echo", "export", "source", "set", "unset",
  "true", "false", "alias", "declare", "local", "readonly",
  "shift", "eval", "trap", "return", "exit",
  "test", "[", "[[", "printf",
]);

const COLLAPSE_COMMANDS = new Set(["git", "npm", "npx"]);

function stripQuotedStrings(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, (match) => " ".repeat(match.length));
}

/**
 * Extract command names from a shell command string.
 * Splits on &&, ||, ;, and | separators.
 * Skips builtins (cd, echo, export, etc.).
 * Collapses git/npm/npx + subcommand (e.g. "git push", "npm run build").
 */
export function extractBashCommands(command: string): string[] {
  if (!command || !command.trim()) return [];

  const stripped = stripQuotedStrings(command);

  // Find separator positions in the stripped (quote-free) string
  const separatorRegex = /\s*(?:&&|\|\||;|\|)\s*/g;
  const separators: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = separatorRegex.exec(stripped)) !== null) {
    separators.push({ start: match.index, end: match.index + match[0].length });
  }

  // Build ranges between separators
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const sep of separators) {
    ranges.push([cursor, sep.start]);
    cursor = sep.end;
  }
  ranges.push([cursor, command.length]);

  const commands: string[] = [];
  for (const [start, end] of ranges) {
    const segment = command.slice(start, end).trim();
    if (!segment) continue;

    const tokens = segment.split(/\s+/);
    const firstToken = tokens[0];
    const base = basename(firstToken);

    if (BUILTINS.has(base)) continue;

    if (COLLAPSE_COMMANDS.has(base) && tokens.length > 1) {
      // For npm: collapse up to 2 extra tokens ("npm run build")
      // For git/npx: collapse 1 extra token ("git push", "npx vitest")
      if (base === "npm" && tokens[1] === "run" && tokens.length > 2) {
        commands.push(`${base} ${tokens[1]} ${tokens[2]}`);
      } else if (base === "npx" && tokens.length > 2) {
        commands.push(`${base} ${tokens[1]} ${tokens[2]}`);
      } else {
        commands.push(`${base} ${tokens[1]}`);
      }
    } else if (base) {
      commands.push(base);
    }
  }

  return commands;
}
