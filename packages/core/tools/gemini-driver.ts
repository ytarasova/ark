import type { ToolDriver } from "../tool-driver.js";
import { randomUUID } from "crypto";
import { shellQuoteArgs } from "../claude/claude.js";

const MODEL_MAP: Record<string, string> = {
  pro: "gemini-2.5-pro",
  flash: "gemini-2.5-flash",
};

export class GeminiDriver implements ToolDriver {
  name = "gemini";

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
    const args = ["gemini"];
    args.push("--model", this.resolveModel(opts.model));
    if (opts.systemPrompt) args.push("--system-instruction", opts.systemPrompt);
    if (opts.permissionMode === "bypassPermissions") {
      args.push("--yolo");
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
    const sessionId = opts.sessionId ?? randomUUID();
    const envLines = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n")
      : "";

    const cmd = shellQuoteArgs(opts.toolArgs);
    const resumeFlag = opts.prevSessionId ? ` --resume ${opts.prevSessionId}` : "";

    const script = `#!/usr/bin/env bash
set -e
cd ${JSON.stringify(opts.workdir)}
${envLines}
exec ${cmd}${resumeFlag}
`;
    return { script, sessionId };
  }
}
