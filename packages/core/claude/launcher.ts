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
  /**
   * When true, the launcher prepends a small jq-based merge that updates
   * the LAUNCH HOST's `~/.claude.json` so claude skips its first-run UX
   * gates: `hasCompletedOnboarding: true` (theme picker) and
   * `projects[<workdir>].hasTrustDialogAccepted: true` (workspace trust
   * prompt). Local dispatch already does both via `trustDirectory()` /
   * the existing onboarding state on the conductor's filesystem. Remote
   * dispatch needs the writes to land on the EC2/k8s host instead, hence
   * embedding the merge in the launcher script.
   */
  preAcceptClaudeUx?: boolean;
}

/** Generate launcher bash script content. */
export function buildLauncher(opts: LauncherOpts): { content: string; claudeSessionId: string } {
  const claudeSessionId = opts.claudeSessionId ?? randomUUID();
  const claudeCmd = shellQuoteArgs(opts.claudeArgs);
  // Channel config is in .mcp.json (project level), Claude reads it automatically.
  // --remote-control was dropped: it wrote session metadata into the host
  // workspace and nothing on the Ark side consumed it.
  //
  // `--dangerously-load-development-channels=server:ark-channel` is the
  // sole flag that loads `ark-channel` non-interactively in Claude Code
  // 2.1.x. It both whitelists the server AND satisfies the dev-channel
  // ack that `.mcp.json`-defined channels require -- using `--channels`
  // alone leaves Claude printing `entries need --dangerously-load-
  // development-channels` and the channel never registers (verified
  // against 2.1.126).
  //
  // The `=value` syntax matters: the dev-channels flag is greedy and
  // would consume positional arguments otherwise -- it would swallow
  // the prompt we append below. Using `=` binds the value tightly so
  // the prompt arg can stay positional.
  const extraFlags = `--dangerously-load-development-channels=server:ark-channel`;

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
  // `--`: belt-and-braces with the `=value` form above so any future flag
  // change (rename, additional channel arg, etc.) can't silently consume
  // the prompt as another channel entry.
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

  // Auto-ack first-run interactive prompts that Claude Code shows even when
  // the corresponding `~/.claude.json` field is set to true. Specifically
  // 2.1.126 added a "I am using this for local development / Exit" dialog
  // that fires unconditionally on a fresh per-host install -- the
  // `bypassPermissionsModeAccepted: true` we write in `preAcceptBlock` is
  // necessary but not sufficient. The dialog accepts on Enter (option 1 is
  // pre-selected). We schedule two Enter-presses on the surrounding tmux
  // session: one at +6s (covers the bypass dialog), one at +12s (covers a
  // second-stage prompt some installs see). Both are harmless if the
  // prompt is already gone -- the keystrokes land on the running claude
  // input which ignores stray Enters at the bash prompt or in input mode.
  // Skipped when not running inside tmux (e.g. local --print invocations).
  const autoAckBlock = `# Pre-empt Claude Code 2.1.x first-run interactive prompts.
if command -v tmux >/dev/null 2>&1 && [ -n "\${TMUX:-}" ]; then
  _ARK_TMUX_SESSION="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
  if [ -n "\$_ARK_TMUX_SESSION" ]; then
    (sleep 6 && tmux send-keys -t "\$_ARK_TMUX_SESSION" Enter 2>/dev/null
     sleep 6 && tmux send-keys -t "\$_ARK_TMUX_SESSION" Enter 2>/dev/null) &
  fi
  unset _ARK_TMUX_SESSION
fi
`;
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

  // Pre-accept Claude Code's first-run UX gates on the launch host so the
  // agent never blocks on an interactive prompt. Five gates, each mapped
  // to a single field in ~/.claude.json:
  //
  //   .hasCompletedOnboarding = true                              (theme picker)
  //   .bypassPermissionsModeAccepted = true                       (--dangerously-skip-permissions disclaimer)
  //   .projects[<wd>].hasTrustDialogAccepted = true               (workspace trust)
  //   .projects[<wd>].enableAllProjectMcpServers = true           (mcp approval)
  //   .customApiKeyResponses.approved += [<key.slice(-20)>]       (api-key prompt)
  //
  // The api-key gate only fires when ANTHROPIC_API_KEY is in the env. The
  // "hash" Claude stores is literally `key.slice(-20)` -- we read that from
  // the env var inside the launcher so the raw key never appears in the
  // script. jq merges everything in place to preserve pre-existing fields
  // (oauthAccount, firstStartTime, migration markers, etc.).
  const preAcceptBlock = (() => {
    if (!opts.preAcceptClaudeUx) return "";
    const wd = shellQuote(opts.workdir);
    const merge = `'.hasCompletedOnboarding = true
      | .bypassPermissionsModeAccepted = true
      | .projects = ((.projects // {}) | .[$dir] = ((.[$dir] // {}) | .hasTrustDialogAccepted = true | .enableAllProjectMcpServers = true))
      | (if $keyHash == "" then . else
          .customApiKeyResponses = ((.customApiKeyResponses // {approved:[], rejected:[]})
            | .approved = (((.approved // []) - [$keyHash]) + [$keyHash])
            | .rejected = ((.rejected // []) - [$keyHash]))
        end)'`;
    return [
      `# Pre-accept Claude first-run UX (theme + workspace trust + MCP + API key)`,
      `# Claude hashes the env API key as key.slice(-20); compute that here so`,
      `# the raw key never appears in the launcher script.`,
      `_ARK_CLAUDE_KEY_HASH=""`,
      `if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then`,
      `  _ARK_CLAUDE_KEY_HASH="\${ANTHROPIC_API_KEY: -20}"`,
      `fi`,
      `if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ]; then`,
      `  jq --arg dir ${wd} --arg keyHash "$_ARK_CLAUDE_KEY_HASH" ${merge} "$HOME/.claude.json" > "$HOME/.claude.json.tmp" && mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"`,
      `elif command -v jq >/dev/null 2>&1; then`,
      `  echo '{}' | jq --arg dir ${wd} --arg keyHash "$_ARK_CLAUDE_KEY_HASH" ${merge} > "$HOME/.claude.json"`,
      `fi`,
      `unset _ARK_CLAUDE_KEY_HASH`,
      ``,
    ].join("\n");
  })();

  // Order matters: envBlock exports ANTHROPIC_API_KEY which preAcceptBlock
  // reads to compute the key-approval hash. Put envBlock first so $key is
  // populated by the time the jq merge runs.
  const content = `#!/bin/bash
${pathSetup}cd ${shellQuote(opts.workdir)}
${embedBlock}${envBlock}${preAcceptBlock}${autoAckBlock}${body}
exec bash
`;

  return { content, claudeSessionId };
}
