/**
 * Shared utilities for CLI command modules.
 *
 * Re-exports getArkClient so command files can import from a single location.
 */

import chalk from "chalk";

export { getArkClient } from "../client.js";

/**
 * Wraps a CLI action body in a uniform try/catch.
 *
 * On failure it prints `<label>: <message>` in red to stderr and sets
 * process.exitCode = 1 so the CLI exits non-zero. Returns the action's
 * resolved value on success, or undefined on failure (so callers can
 * early-return without further handling).
 *
 * Replaces the scattered `try { ... } catch (e) { console.log(chalk.red("Failed: ...")) }`
 * boilerplate with a single consistent shape.
 */
export async function runAction<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(chalk.red(`${label}: ${msg}`));
    process.exitCode = 1;
    return undefined;
  }
}
