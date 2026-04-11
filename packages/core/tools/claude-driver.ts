import type { ToolDriver } from "../tool-driver.js";
import * as claude from "../claude/claude.js";

const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export class ClaudeDriver implements ToolDriver {
  name = "claude";

  resolveModel(shortName: string): string {
    return MODEL_MAP[shortName] ?? shortName;
  }

  buildArgs(opts: {
    model: string;
    maxTurns?: number;
    systemPrompt?: string;
    mcpConfigPath?: string;
    permissionMode?: string;
    extraArgs?: string[];
  }): string[] {
    const args = ["claude"];
    args.push("--model", this.resolveModel(opts.model));
    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
    if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
    if (opts.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }
    if (opts.extraArgs) args.push(...opts.extraArgs);
    return args;
  }

  buildLauncher(opts: {
    toolArgs: string[];
    workdir: string;
    sessionId?: string;
    prevSessionId?: string;
    channelName?: string;
    env?: Record<string, string>;
  }): { script: string; sessionId: string } {
    const result = claude.buildLauncher({
      claudeArgs: opts.toolArgs,
      workdir: opts.workdir,
      mcpConfigPath: "",
      claudeSessionId: opts.sessionId,
      prevClaudeSessionId: opts.prevSessionId,
      sessionName: opts.channelName,
      env: opts.env,
    });
    return { script: result.content, sessionId: result.claudeSessionId };
  }
}
