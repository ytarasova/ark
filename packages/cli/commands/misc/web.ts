import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../../core/index.js";
import { getInProcessApp } from "../../app-client.js";
import { logDebug } from "../../../core/observability/structured-log.js";
import { startAuxiliaryDaemons, startParentDeathWatchdog } from "../../services/web-probe.js";

/**
 * Encapsulates `ark web` -- both proxy mode (remote control plane) and
 * in-process mode (optionally boots conductor + arkd alongside the web
 * server). Probe + watchdog logic lives in `services/web-probe.ts`.
 */
export class WebCommand {
  constructor(private readonly program: Command) {}

  register(): void {
    this.program
      .command("web")
      .description("Start web dashboard")
      .option("--port <port>", "Listen port", "8420")
      .option("--read-only", "Read-only mode")
      .option("--token <token>", "Bearer token for auth")
      .option("--api-only", "API only, skip static file serving (for dev with Vite)")
      .option("--with-daemon", "Also start conductor + arkd in-process (for desktop app / standalone use)")
      .action((opts) => this.run(opts));
  }

  private async run(opts: Record<string, any>): Promise<void> {
    startParentDeathWatchdog();

    const globalOpts = this.program.opts();
    const remoteUrl = globalOpts.server || process.env.ARK_SERVER;
    const remoteAuthToken = globalOpts.token || process.env.ARK_TOKEN;

    if (remoteUrl) {
      await this.runProxyMode({
        port: Number(opts.port),
        remoteUrl,
        token: remoteAuthToken,
        readOnly: opts.readOnly,
        apiOnly: opts.apiOnly,
        localToken: opts.token,
      });
      return;
    }

    await this.runLocalMode({
      port: Number(opts.port),
      readOnly: opts.readOnly,
      token: opts.token,
      apiOnly: opts.apiOnly,
      withDaemon: Boolean(opts.withDaemon),
    });
  }

  private async runProxyMode(opts: {
    port: number;
    remoteUrl: string;
    token: string | undefined;
    readOnly: boolean | undefined;
    apiOnly: boolean | undefined;
    localToken: string | undefined;
  }): Promise<void> {
    const { startWebProxy } = await import("../../../core/hosted/web-proxy.js");
    const proxy = startWebProxy({
      port: opts.port,
      remoteUrl: opts.remoteUrl,
      token: opts.token,
      readOnly: opts.readOnly,
      apiOnly: opts.apiOnly,
      localToken: opts.localToken,
    });
    console.log(chalk.green(`Ark web dashboard (proxying to ${opts.remoteUrl}): ${proxy.url}`));
    console.log(chalk.dim("Press Ctrl+C to stop"));
    process.on("SIGINT", () => {
      proxy.stop();
      process.exit(0);
    });
    await new Promise(() => {});
  }

  private async runLocalMode(opts: {
    port: number;
    readOnly: boolean | undefined;
    token: string | undefined;
    apiOnly: boolean | undefined;
    withDaemon: boolean;
  }): Promise<void> {
    let auxiliary: { stop: () => void }[] = [];
    if (opts.withDaemon) {
      const arkApp = await getInProcessApp();
      const aux = await startAuxiliaryDaemons(arkApp);
      auxiliary = aux.handles;
    }

    const serverApp = await getInProcessApp();
    const server = core.startWebServer(serverApp, {
      port: opts.port,
      readOnly: opts.readOnly,
      token: opts.token,
      apiOnly: opts.apiOnly,
    });
    console.log(chalk.green(`Ark web dashboard: ${server.url}`));
    console.log(chalk.dim("Press Ctrl+C to stop"));
    const shutdown = () => {
      server.stop();
      for (const aux of auxiliary) {
        try {
          aux.stop();
        } catch {
          logDebug("general", "ignore");
        }
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  }
}

export function registerWebCommand(program: Command): void {
  new WebCommand(program).register();
}
