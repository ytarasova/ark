/**
 * Allowlist of commands the /exec endpoint will spawn.
 *
 * Server-only. Clients should NOT second-guess the allowlist; if a
 * legitimate command is blocked, add it here rather than working around
 * it client-side.
 */

export const EXEC_ALLOWED_COMMANDS = new Set([
  "git",
  "bun",
  "make",
  "npm",
  "npx",
  "node",
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "diff",
  "echo",
  "pwd",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "touch",
  "chmod",
  "sh",
  "bash",
  "zsh",
  "tmux",
  "df",
  "ps",
  "pgrep",
  "top",
  "uptime",
  "sysctl",
  "vm_stat",
  "lsof",
  "ss",
  "docker",
  "devcontainer",
  "claude",
  "codex",
  "gemini",
  "goose",
  "codegraph",
]);
