import type { Command } from "commander";
import chalk from "chalk";
import { registerServerDaemonCommands } from "./server-daemon.js";

/**
 * `ark server start` -- start the JSON-RPC server in either local
 * stdio/WebSocket mode or as a hosted multi-tenant control plane.
 * Extracted from misc.ts so each cluster of CLI commands lives in its
 * own file.
 */
export function registerServerCommands(program: Command) {
  const serverCmd = program.command("server").description("JSON-RPC server");

  registerServerDaemonCommands(serverCmd);

  serverCmd
    .command("start")
    .description("Start the Ark server")
    .option("--stdio", "Use stdio transport (JSONL)")
    .option("--ws", "Use WebSocket transport")
    .option("--hosted", "Start as hosted multi-tenant control plane")
    .option("-p, --port <port>", "WebSocket port", "19400")
    .action(async (opts) => {
      // Hosted mode: full control plane (worker registry + scheduler + tenant policies)
      if (opts.hosted) {
        const { loadConfig } = await import("../../core/config.js");
        const { startHostedServer } = await import("../../core/hosted/index.js");

        const config = loadConfig();
        const webPort = parseInt(opts.port) || 8420;
        (config as { port?: number }).port = webPort;

        console.log(chalk.cyan("Starting Ark hosted control plane..."));
        const { stop } = await startHostedServer(config);

        console.log(chalk.green("Ark control plane running"));
        console.log(chalk.dim(`  Web UI:     http://localhost:${webPort}`));
        console.log(chalk.dim(`  Conductor:  http://localhost:${config.ports.conductor}`));
        if (config.redisUrl) console.log(chalk.dim(`  Redis:      ${config.redisUrl}`));
        if (config.database.url) console.log(chalk.dim(`  Database:   ${config.database.url}`));
        console.log(chalk.dim("Press Ctrl+C to stop"));

        process.on("SIGINT", async () => {
          await stop();
          process.exit(0);
        });
        await new Promise(() => {});
        return;
      }

      // Local stdio / WebSocket transport
      const { AppContext, loadConfig } = await import("../../core/index.js");
      const { ArkServer } = await import("../../server/index.js");
      const { registerAllHandlers } = await import("../../server/register.js");

      const serverApp = new AppContext(loadConfig());
      await serverApp.boot();

      const server = new ArkServer();
      registerAllHandlers(server.router, serverApp);
      server.attachLifecycle(serverApp);
      server.attachAuth(serverApp);
      server.attachApp(serverApp);

      if (opts.stdio) {
        server.startStdio();
        process.on("SIGINT", () => {
          serverApp.shutdown();
          process.exit(0);
        });
        await new Promise(() => {});
      } else {
        const port = parseInt(opts.port);
        const ws = server.startWebSocket(port, { app: serverApp });
        console.log(`Ark server listening on ws://localhost:${port}`);
        process.on("SIGINT", () => {
          ws.stop();
          serverApp.shutdown();
          process.exit(0);
        });
        await new Promise(() => {});
      }
    });
}
