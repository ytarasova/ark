/**
 * `ark tenant config` -- admin CLI for the per-tenant compute-config YAML blob.
 *
 *   ark tenant config set-compute <tenantId> --file clusters.yaml
 *   ark tenant config get-compute <tenantId>
 *   ark tenant config clear-compute <tenantId>
 *
 * Kept in a separate file from `./tenant.ts` (agent F territory) so the two
 * agents can ship in parallel without merge collisions. Registered via
 * `registerTenantConfigCommands` from the CLI entry point.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync } from "fs";
import { getArkClient } from "../app-client.js";

export function registerTenantConfigCommands(program: Command): void {
  // If `ark tenant` already exists (registered by ./tenant.ts), reuse it;
  // otherwise create the parent group. Commander doesn't expose a `find`
  // helper for sub-commands, so we scan manually.
  const existing = program.commands.find((c) => c.name() === "tenant");
  const tenant = existing ?? program.command("tenant").description("Manage tenant settings");
  const config = tenant.command("config").description("Manage per-tenant configuration blobs");

  config
    .command("set-compute")
    .description("Write the compute-config YAML blob for a tenant (cluster overrides)")
    .argument("<tenantId>", "Tenant ID")
    .option("-f, --file <path>", "Path to YAML file with cluster overrides")
    .action(async (tenantId: string, opts: { file?: string }) => {
      try {
        if (!opts.file) {
          console.log(chalk.red("--file <path> is required"));
          process.exitCode = 2;
          return;
        }
        if (!existsSync(opts.file)) {
          console.log(chalk.red(`File not found: ${opts.file}`));
          process.exitCode = 2;
          return;
        }
        const yaml = readFileSync(opts.file, "utf-8");
        if (yaml.length === 0) {
          console.log(chalk.red("YAML file is empty"));
          process.exitCode = 2;
          return;
        }
        const ark = await getArkClient();
        await ark.tenantComputeConfigSet(tenantId, yaml);
        console.log(chalk.green(`Compute config stored for tenant '${tenantId}'.`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e?.message ?? e}`));
        process.exitCode = 1;
      }
    });

  config
    .command("get-compute")
    .description("Fetch the compute-config YAML blob for a tenant")
    .argument("<tenantId>", "Tenant ID")
    .action(async (tenantId: string) => {
      try {
        const ark = await getArkClient();
        const yaml = await ark.tenantComputeConfigGet(tenantId);
        if (yaml == null) {
          console.log(chalk.dim("(no compute config set for this tenant)"));
          return;
        }
        process.stdout.write(yaml);
        if (process.stdout.isTTY && !yaml.endsWith("\n")) process.stdout.write("\n");
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e?.message ?? e}`));
        process.exitCode = 1;
      }
    });

  config
    .command("clear-compute")
    .description("Clear the compute-config YAML blob for a tenant")
    .argument("<tenantId>", "Tenant ID")
    .action(async (tenantId: string) => {
      try {
        const ark = await getArkClient();
        const removed = await ark.tenantComputeConfigClear(tenantId);
        if (removed) console.log(chalk.green(`Cleared compute config for tenant '${tenantId}'.`));
        else console.log(chalk.yellow(`No compute config to clear for tenant '${tenantId}'.`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e?.message ?? e}`));
        process.exitCode = 1;
      }
    });
}
