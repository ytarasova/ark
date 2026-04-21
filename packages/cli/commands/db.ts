/**
 * `ark db` -- global Ark schema migrations.
 *
 *   db migrate [--to N]   apply pending migrations (or up to version N)
 *   db status             print current schema version + applied/pending
 *   db down --to N        rollback to version N (Phase 1 stub: throws)
 *
 * DB commands are local-only: they reach directly into the schema to run
 * migrations, so `--server` remote mode isn't meaningful here. When a
 * caller is in remote mode, `getInProcessApp()` throws with a friendly
 * message.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getInProcessApp } from "../app-client.js";

export function registerDbCommands(program: Command) {
  const cmd = program.command("db").description("Schema migrations + status");

  cmd
    .command("migrate")
    .description("Apply any pending Ark migrations")
    .option("--to <version>", "Target version (default: latest)")
    .action(async (opts) => {
      const app = await getInProcessApp();
      const targetVersion = opts.to ? Number(opts.to) : undefined;
      await app.mode.migrations.apply(app.db, { targetVersion });
      const status = await app.mode.migrations.status(app.db);
      console.log(
        chalk.green(`Applied. Current version: ${status.currentVersion} (dialect: ${app.mode.migrations.dialect})`),
      );
    });

  cmd
    .command("status")
    .description("Print current schema version + pending migrations")
    .action(async () => {
      const app = await getInProcessApp();
      const status = await app.mode.migrations.status(app.db);
      console.log(`Dialect:         ${chalk.cyan(app.mode.migrations.dialect)}`);
      console.log(`Current version: ${chalk.cyan(status.currentVersion)}`);
      if (status.applied.length > 0) {
        console.log(chalk.dim(`${status.applied.length} applied:`));
        for (const a of status.applied) {
          console.log(`  ${chalk.green(String(a.version).padStart(3, "0"))}: ${a.name}  ${chalk.dim(a.applied_at)}`);
        }
      }
      if (status.pending.length === 0) {
        console.log(chalk.green("No pending migrations."));
      } else {
        console.log(chalk.yellow(`${status.pending.length} pending:`));
        for (const m of status.pending) console.log(`  ${chalk.yellow(String(m.version).padStart(3, "0"))}: ${m.name}`);
      }
    });

  cmd
    .command("down")
    .description("Roll back to a target version (Phase 1: not implemented)")
    .requiredOption("--to <version>", "Target version")
    .action(async (opts) => {
      try {
        const app = await getInProcessApp();
        await app.mode.migrations.down(app.db, { targetVersion: Number(opts.to) });
      } catch (err: any) {
        console.error(chalk.red(err.message ?? String(err)));
        process.exitCode = 1;
      }
    });
}
