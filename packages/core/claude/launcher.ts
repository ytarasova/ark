/**
 * Launcher bash script generation for `claude` inside tmux.
 *
 * Produces a shell script that exports the right env, cd's into the
 * worktree, invokes `claude` with resume/session-id fallback, and writes
 * an exit-code sentinel so the status poller can detect hard failures.
 */

import { randomUUID } from "crypto";

import { shellQuote, shellQuoteArgs } from "./args.js";

export interface LauncherOpts {
  workdir: string;
  claudeArgs: string[];
  mcpConfigPath: string;
  claudeSessionId?: string;
  prevClaudeSessionId?: string | null;
  /** Environment variables to export before launching Claude */
  env?: Record<string, string>;
  /** Initial prompt passed as positional arg -- triggers immediate processing */
  initialPrompt?: string;
  /**
   * Files to materialise on the host the launcher runs on, before claude
   * starts. Each entry is `{ relPath, content }`; `relPath` is interpreted
   * relative to `workdir`. Used by remote dispatch to ship .mcp.json and
   * .claude/settings.local.json into the workdir freshly cloned on the
   * remote host -- the conductor builds the JSON locally, embeds it as a
   * heredoc, and the launcher script writes it on first run. No rsync.
   */
  embedFiles?: Array<{ relPath: string; content: string }>;
}

/** Generate launcher bash script content. */
export function buildLauncher(opts: LauncherOpts): { content: string; claudeSessionId: string } {
  const claudeSessionId = opts.claudeSessionId ?? randomUUID();
  const claudeCmd = shellQuoteArgs(opts.claudeArgs);
  // Channel config is in .mcp.json (project level), Claude reads it automatically.
  // --remote-control was dropped: it wrote session metadata into the host
  // workspace and nothing on the Ark side consumed it.
  const extraFlags = `--dangerously-load-development-channels server:ark-channel`;

  const envExports = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");
  const envBlock = envExports ? envExports + "\n" : "";

  // Ensure tools are in PATH (claude, bun, nvm live in ~/.local/bin etc)
  // Can't source .bashrc -- it exits early for non-interactive shells
  const pathSetup = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/*/bin:$PATH"\n`;

  // PTY geometry is deferred: claude launches at tmux's default pane size.
  // When the web terminal attaches, the first client resize triggers
  // `tmux resize-window` which sends SIGWINCH to the running claude process,
  // prompting it to reflow. CLI-only dispatches stay at the tmux default.
  //
  // When initialPrompt is provided, append it as the last positional arg
  // to trigger immediate processing. Separate it from option values with
  // `--`: `--dangerously-load-development-channels` is greedy and would
  // otherwise consume the prompt as another channel entry. The `--` tells
  // Claude's arg parser "everything after this is a positional".
  const promptArg = opts.initialPrompt ? ` \\\n  -- ${shellQuote(opts.initialPrompt)}` : "";

  // Wrap the claude invocation so a non-zero exit is surfaced back to Ark.
  // `exec bash` below keeps the tmux pane alive (so the user can read the
  // error + debug), but without this sentinel, Ark's status poller sees the
  // tmux session as still "alive" and never flips the Ark session to
  // `failed`. The poller watches $ARK_SESSION_DIR/exit-code to detect this
  // case. See session-orchestration docs + status-poller.ts.
  //
  // `ARK_SESSION_DIR` is exported into the launch env by the executor
  // (see executors/claude-code.ts). If it is not set (defensive default),
  // we fall back to writing under /tmp so the file write never breaks the
  // launcher -- the poller just won't find the sentinel and the session
  // stays "running", which matches the pre-bug-3 behaviour.
  const sentinelDir = `"\${ARK_SESSION_DIR:-/tmp/ark-session-unknown}"`;
  const primary = opts.prevClaudeSessionId
    ? `${claudeCmd} --resume ${shellQuote(opts.prevClaudeSessionId)} \\
  ${extraFlags}${promptArg}`
    : `${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}${promptArg}`;
  const fallback = opts.prevClaudeSessionId
    ? `${claudeCmd} --session-id ${shellQuote(claudeSessionId)} \\
  ${extraFlags}${promptArg}`
    : null;

  const body = fallback
    ? `if ${primary}; then
  :
elif ${fallback}; then
  :
else
  code=$?
  mkdir -p ${sentinelDir} 2>/dev/null || true
  echo "$code" > ${sentinelDir}/exit-code
  echo "Claude exited with code $code. Session marked failed." >&2
fi`
    : `if ${primary}; then
  :
else
  code=$?
  mkdir -p ${sentinelDir} 2>/dev/null || true
  echo "$code" > ${sentinelDir}/exit-code
  echo "Claude exited with code $code. Session marked failed." >&2
fi`;

  // Optional file heredocs: write embedded files into the workdir on the host
  // the launcher runs on. We use a quoted heredoc tag (`'ARK_EOF_<n>'`) so
  // $-interpolation in the content is suppressed -- the JSON we embed must
  // land verbatim on disk. A unique tag per entry guards against literal
  // collisions in the content.
  const embedBlock = (() => {
    if (!opts.embedFiles?.length) return "";
    const lines: string[] = [];
    opts.embedFiles.forEach((file, idx) => {
      // Resolve `<workdir>/<relPath>` into a single shell-quoted absolute path
      // so the launcher script is invariant to the cwd it runs in.
      const absolute = file.relPath.startsWith("/") ? file.relPath : `${opts.workdir}/${file.relPath}`;
      const targetPath = shellQuote(absolute);
      const tag = `ARK_EOF_${idx}`;
      lines.push(`mkdir -p "$(dirname ${targetPath})"`);
      lines.push(`cat > ${targetPath} <<'${tag}'`);
      lines.push(file.content);
      lines.push(tag);
    });
    return lines.join("\n") + "\n";
  })();

  const content = `#!/bin/bash
${pathSetup}cd ${shellQuote(opts.workdir)}
${embedBlock}${envBlock}${body}
exec bash
`;

  return { content, claudeSessionId };
}
