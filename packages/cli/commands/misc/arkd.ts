import type { Command } from "commander";

/** `ark arkd` -- start the arkd universal agent daemon as a standalone process. */
export function registerArkdCommand(program: Command): void {
  program
    .command("arkd")
    .description("Start the arkd agent daemon")
    .option("-p, --port <port>", "Port", "19300")
    .option("--hostname <host>", "Bind address (default: 0.0.0.0)", "0.0.0.0")
    .option("--conductor-url <url>", "Conductor URL for channel relay")
    .action(async (opts) => {
      const { startArkd } = await import("../../../arkd/server/index.js");
      const { DEFAULT_CONDUCTOR_URL } = await import("../../../core/constants.js");
      const conductorUrl = opts.conductorUrl || DEFAULT_CONDUCTOR_URL;
      startArkd(parseInt(opts.port), { conductorUrl, hostname: opts.hostname });
      // Keep alive
      setInterval(() => {}, 60_000);
    });
}
