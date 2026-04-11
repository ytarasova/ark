/**
 * Tool driver interface -- abstracts across AI coding tools.
 * Each tool (Claude, Gemini, etc.) implements this interface.
 */

export interface ToolDriver {
  /** Tool name identifier */
  name: string;

  /** Resolve short model name to full model ID */
  resolveModel(shortName: string): string;

  /** Build CLI arguments for the tool */
  buildArgs(opts: {
    model: string;
    maxTurns?: number;
    systemPrompt?: string;
    mcpConfigPath?: string;
    permissionMode?: string;
    extraArgs?: string[];
  }): string[];

  /** Build launcher bash script content */
  buildLauncher(opts: {
    toolArgs: string[];
    workdir: string;
    sessionId?: string;
    prevSessionId?: string;
    channelName?: string;
    env?: Record<string, string>;
  }): { script: string; sessionId: string };
}
