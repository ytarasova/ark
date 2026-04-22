import type { Command } from "commander";
import chalk from "chalk";
import { getInProcessApp } from "../../app-client.js";
import { ComputePoolManager } from "../../../core/compute/pool.js";

export function registerPoolCommands(computeCmd: Command) {
  const pool = computeCmd.command("pool").description("Manage compute pools");

  pool
    .command("create")
    .description("Create a compute pool")
    .argument("<name>", "Pool name")
    .option("--provider <type>", "Provider type (ec2, docker, k8s)", "ec2")
    .option("--min <n>", "Minimum warm instances", "0")
    .option("--max <n>", "Maximum instances", "10")
    .option("--size <size>", "Instance size (provider-specific)", "m")
    .option("--region <region>", "Region (provider-specific)")
    .option("--image <image>", "Container image (provider-specific)")
    .action(async (name, opts) => {
      try {
        const app = await getInProcessApp();
        const manager = new ComputePoolManager(app);
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.region) config.region = opts.region;
        if (opts.image) config.image = opts.image;
        const pool = await manager.createPool({
          name,
          provider: opts.provider,
          min: parseInt(opts.min, 10),
          max: parseInt(opts.max, 10),
          config,
        });
        console.log(chalk.green(`Pool '${pool.name}' created`));
        console.log(`  Provider: ${pool.provider}`);
        console.log(`  Min:      ${pool.min}`);
        console.log(`  Max:      ${pool.max}`);
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  pool
    .command("list")
    .description("List compute pools")
    .action(async () => {
      try {
        const app = await getInProcessApp();
        const manager = new ComputePoolManager(app);
        const pools = await manager.listPools();
        if (!pools.length) {
          console.log(chalk.dim("No pools. Create one: ark compute pool create <name> --provider ec2"));
          return;
        }
        console.log(
          `  ${"NAME".padEnd(20)} ${"PROVIDER".padEnd(10)} ${"MIN".padEnd(5)} ${"MAX".padEnd(5)} ${"ACTIVE".padEnd(8)} AVAIL`,
        );
        for (const p of pools) {
          console.log(
            `  ${p.name.padEnd(20)} ${p.provider.padEnd(10)} ${String(p.min).padEnd(5)} ${String(p.max).padEnd(5)} ${String(p.active).padEnd(8)} ${p.available}`,
          );
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  pool
    .command("delete")
    .description("Delete a compute pool")
    .argument("<name>", "Pool name")
    .action(async (name) => {
      try {
        const app = await getInProcessApp();
        const manager = new ComputePoolManager(app);
        const deleted = await manager.deletePool(name);
        if (deleted) {
          console.log(chalk.green(`Pool '${name}' deleted`));
        } else {
          console.log(chalk.red(`Pool '${name}' not found`));
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });
}
