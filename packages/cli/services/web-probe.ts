/**
 * Service helpers for `ark web`:
 *   - probeDaemonHealth: reusable HTTP probe ("is something alive on :port?")
 *   - startParentDeathWatchdog: exits the process when its original parent dies
 *   - startAuxiliaryDaemons: boot conductor + arkd in-process when required
 *
 * Extracted from the old misc.ts so the CLI `web` action stays a thin shell
 * around these building blocks.
 */

import chalk from "chalk";
import { logDebug } from "../../core/observability/structured-log.js";
import type { AppContext } from "../../core/app.js";
import type { LogComponent } from "../../core/observability/structured-log.js";

/**
 * Probe an HTTP `/health` endpoint. Returns true if the endpoint responds
 * with 2xx within `timeoutMs`; logs a debug-level message when the probe
 * errors out so boot-time troubleshooting has a breadcrumb trail.
 */
export async function probeDaemonHealth(
  port: number,
  component: LogComponent,
  label: string,
  timeoutMs = 500,
): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err) => {
      logDebug(component, `${label}: health probe failed (will start new instance)`, {
        port,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    return Boolean(resp?.ok);
  } catch (err) {
    logDebug(component, `${label}: health probe threw`, {
      port,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Install a parent-death watchdog. When `ARK_WATCH_PARENT=1`, polls the
 * pid captured at startup every 2s using `kill(pid, 0)` and exits when it
 * disappears.
 *
 * Why not rely on `process.ppid`? On macOS libuv captures it at startup and
 * never refreshes after the process reparents to launchd -- so the value
 * remains the dead parent's pid forever. `kill(pid, 0)` does an actual
 * ESRCH check via the kernel and detects reparenting on both macOS + Linux.
 *
 * Unset by default: a bare `ark web` should keep running after the user's
 * shell closes, but the e2e fixture and desktop shell opt in so they don't
 * leak zombie processes holding the port open.
 */
export function startParentDeathWatchdog(): void {
  if (process.env.ARK_WATCH_PARENT !== "1") return;
  const startingPpid = process.ppid;
  let logged = false;
  setInterval(() => {
    let parentAlive = true;
    try {
      // Signal 0 = existence probe, no signal delivered. Throws ESRCH
      // if the pid is gone.
      process.kill(startingPpid, 0);
    } catch {
      parentAlive = false;
    }
    if (!parentAlive) {
      if (!logged) {
        logged = true;
        console.log(chalk.yellow(`ark web: parent process ${startingPpid} died, exiting`));
      }
      process.exit(0);
    }
  }, 2000).unref();
}

export interface AuxiliaryDaemons {
  handles: { stop: () => void }[];
}

/**
 * Boot conductor + arkd in-process so `ark web --with-daemon` can serve a
 * fully working instance (desktop app / standalone use). When the ports are
 * already claimed by external daemons the start calls are skipped; the
 * web dashboard probes localhost:19100 / 19300 and finds them online.
 */
export async function startAuxiliaryDaemons(app: AppContext): Promise<AuxiliaryDaemons> {
  const auxiliary: { stop: () => void }[] = [];

  const { startConductor } = await import("../../core/conductor/server/conductor.js");
  const { startArkd } = await import("../../arkd/index.js");
  const { DEFAULT_CONDUCTOR_PORT, DEFAULT_ARKD_PORT } = await import("../../core/constants.js");

  // Conductor: start unless something already listens on the port
  try {
    if (await probeDaemonHealth(DEFAULT_CONDUCTOR_PORT, "conductor", "cli/web: conductor")) {
      console.log(chalk.dim(`Conductor already running on :${DEFAULT_CONDUCTOR_PORT} -- reusing`));
    } else {
      const conductor = startConductor(app, DEFAULT_CONDUCTOR_PORT, { quiet: true });
      auxiliary.push(conductor);
      console.log(chalk.dim(`Started conductor on :${DEFAULT_CONDUCTOR_PORT}`));
    }
  } catch (e: any) {
    console.log(chalk.yellow(`Could not start conductor: ${e?.message ?? e}`));
  }

  // ArkD: start unless something already listens on the port
  try {
    if (await probeDaemonHealth(DEFAULT_ARKD_PORT, "general", "cli/web: arkd")) {
      console.log(chalk.dim(`ArkD already running on :${DEFAULT_ARKD_PORT} -- reusing`));
    } else {
      const arkd = startArkd(DEFAULT_ARKD_PORT, {
        conductorUrl: `http://localhost:${DEFAULT_CONDUCTOR_PORT}`,
        quiet: true,
      });
      auxiliary.push(arkd);
      console.log(chalk.dim(`Started arkd on :${DEFAULT_ARKD_PORT}`));
    }
  } catch (e: any) {
    console.log(chalk.yellow(`Could not start arkd: ${e?.message ?? e}`));
  }

  return { handles: auxiliary };
}
