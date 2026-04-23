import type { Command } from "commander";

/**
 * `ark run-agent-sdk` -- launch the agent-sdk child process.
 *
 * Invoked by the agent-sdk executor in compiled-binary mode; dev mode spawns
 * `launch.ts` directly. All context is read from `ARK_*` env vars.
 */
export function registerRunAgentSdkCommand(program: Command): void {
  program
    .command("run-agent-sdk")
    .description("Run the agent-sdk launch script (internal -- used by agent-sdk executor)")
    .action(async () => {
      const { runAgentSdkLaunch } = await import("../../../core/runtimes/agent-sdk/launch.js");

      function need(name: string): string {
        const v = process.env[name];
        if (!v) {
          console.error(`[agent-sdk launch] missing required env var: ${name}`);
          process.exit(2);
        }
        return v;
      }

      function optionalNumber(name: string): number | undefined {
        const raw = process.env[name];
        if (raw === undefined || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          console.error(`[agent-sdk launch] invalid ${name}=${raw}, ignoring`);
          return undefined;
        }
        return n;
      }

      const sessionId = need("ARK_SESSION_ID");
      const sessionDir = need("ARK_SESSION_DIR");
      const worktree = need("ARK_WORKTREE");
      const promptFile = need("ARK_PROMPT_FILE");

      if (!process.env.ANTHROPIC_API_KEY) {
        console.error(
          "[agent-sdk launch] ANTHROPIC_API_KEY is required. Set it in the environment or via StageSecretResolver.",
        );
        process.exit(2);
      }

      const conductorUrl = process.env.ARK_CONDUCTOR_URL;
      if (!conductorUrl) {
        console.warn("[agent-sdk launch] ARK_CONDUCTOR_URL is not set -- conductor hook forwarding disabled");
      }

      const result = await runAgentSdkLaunch({
        sessionId,
        sessionDir,
        worktree,
        promptFile,
        model: process.env.ARK_MODEL,
        maxTurns: optionalNumber("ARK_MAX_TURNS"),
        maxBudgetUsd: optionalNumber("ARK_MAX_BUDGET_USD"),
        systemAppend: process.env.ARK_SYSTEM_PROMPT_APPEND,
        conductorUrl,
        authToken: process.env.ARK_API_TOKEN,
      });

      process.exit(result.exitCode);
    });
}
