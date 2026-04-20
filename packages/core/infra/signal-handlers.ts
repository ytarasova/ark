/**
 * SignalHandlers -- install SIGINT / SIGTERM listeners that trigger an
 * orderly shutdown. A second signal within the same process lifetime
 * force-exits, matching the previous behaviour in app.ts.
 */
import type { AppContext } from "../app.js";
import { logError } from "../observability/structured-log.js";

export class SignalHandlers {
  private handlers: { signal: string; handler: () => void }[] = [];
  private forceExitCount = 0;

  constructor(
    private readonly app: AppContext,
    private readonly opts: { skip?: boolean } = {},
  ) {}

  start(): void {
    if (this.opts.skip) return;
    this.makeHandler("SIGINT");
    this.makeHandler("SIGTERM");
  }

  stop(): void {
    for (const { signal, handler } of this.handlers) {
      process.removeListener(signal, handler);
    }
    this.handlers = [];
  }

  private makeHandler(signal: string): void {
    const handler = () => {
      this.forceExitCount++;
      if (this.forceExitCount >= 2) {
        process.exit(1);
      }
      this.app.shutdown().catch((err) => {
        logError("general", `Error during ${signal} shutdown: ${err}`);
        process.exit(1);
      });
    };
    this.handlers.push({ signal, handler });
    process.on(signal as NodeJS.Signals, handler);
  }
}
