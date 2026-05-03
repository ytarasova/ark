import type { Command } from "commander";

/**
 * `ark run-agent-sdk` -- launch the claude-agent runtime child process.
 *
 * Invoked by the claude-agent executor in compiled-binary mode; dev mode spawns
 * `launch.ts` directly. All context is read from `ARK_*` env vars.
 *
 * Subcommand name kept as `run-agent-sdk` (not `run-claude-agent`) for
 * backward-compat with previously compiled binaries -- the launch spec in
 * install-paths.ts still emits this verb.
 */
export function registerRunAgentSdkCommand(program: Command): void {
  program
    .command("run-agent-sdk")
    .description("Run the claude-agent launch script (internal -- used by claude-agent executor)")
    .action(async () => {
      const { runAgentSdkLaunch } = await import("../../../core/runtimes/claude-agent/launch.js");

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

      // Hook endpoint resolution: prefer ARK_ARKD_URL (remote dispatch -- the
      // local arkd buffers hooks; the conductor pulls them via /events/stream),
      // fall back to ARK_CONDUCTOR_URL (local dispatch -- the agent runs on the
      // conductor host and can post directly).
      const arkdUrl = process.env.ARK_ARKD_URL;
      const conductorUrl = process.env.ARK_CONDUCTOR_URL;
      const hookEndpoint = arkdUrl
        ? `${arkdUrl}/hooks/forward`
        : conductorUrl
          ? `${conductorUrl}/hooks/status`
          : undefined;
      if (!hookEndpoint) {
        console.warn(
          "[agent-sdk launch] neither ARK_ARKD_URL nor ARK_CONDUCTOR_URL is set -- hook forwarding disabled",
        );
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
        hookEndpoint,
        authToken: process.env.ARK_API_TOKEN,
      });

      process.exit(result.exitCode);
    });
}
