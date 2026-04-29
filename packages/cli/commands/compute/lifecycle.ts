import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../../app-client.js";
import { logDebug } from "../../../core/observability/structured-log.js";
import { providerOf } from "../../../compute/adapters/provider-map.js";

export function registerLifecycleCommands(computeCmd: Command) {
  computeCmd
    .command("provision")
    .description("Provision a compute resource (create infrastructure)")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const compute = await ark.computeRead(name);
        console.log(chalk.dim(`Provisioning '${name}' via ${providerOf(compute)}...`));
        await ark.computeProvision(name);
        console.log(chalk.green(`Compute '${name}' provisioned and running`));
      } catch (e: any) {
        try {
          await ark.computeUpdate(name, { status: "stopped" });
        } catch {
          logDebug("general", "ignore");
        }
        console.log(chalk.red(`Provision failed: ${e.message}`));
      }
    });

  computeCmd
    .command("start")
    .description("Start a compute resource")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        await ark.computeStartInstance(name);
        console.log(chalk.green(`Compute '${name}' started`));
      } catch (e: any) {
        console.log(chalk.red(`Start failed: ${e.message}`));
      }
    });

  computeCmd
    .command("stop")
    .description("Stop a compute resource")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        await ark.computeStopInstance(name);
        console.log(chalk.yellow(`Compute '${name}' stopped`));
      } catch (e: any) {
        console.log(chalk.red(`Stop failed: ${e.message}`));
      }
    });

  computeCmd
    .command("destroy")
    .description("Destroy a compute resource (removes infrastructure and DB record)")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        await ark.computeDestroy(name);
        console.log(chalk.green(`Compute '${name}' destroyed`));
      } catch (e: any) {
        console.log(chalk.red(`Destroy failed: ${e.message}`));
      }
    });

  computeCmd
    .command("update")
    .description("Update compute configuration")
    .argument("<name>", "Compute name")
    .option("--size <size>", "Instance size")
    .option("--arch <arch>", "Architecture: x64, arm")
    .option("--aws-region <region>", "AWS region")
    .option("--aws-profile <profile>", "AWS profile")
    .option("--aws-subnet-id <id>", "AWS subnet ID")
    .option("--ingress <cidrs>", "SSH ingress CIDRs (comma-separated, or 'open' for 0.0.0.0/0)")
    .option("--idle-minutes <min>", "Idle shutdown timeout in minutes")
    .option(
      "--set <key=value>",
      "Set arbitrary config key",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .action(async (name, opts) => {
      const ark = await getArkClient();
      try {
        const compute = await ark.computeRead(name);

        const config: Record<string, unknown> = { ...compute.config };
        if (opts.size) config.size = opts.size;
        if (opts.arch) config.arch = opts.arch;
        if (opts.awsRegion) config.region = opts.awsRegion;
        if (opts.awsProfile) config.aws_profile = opts.awsProfile;
        if (opts.awsSubnetId) config.subnet_id = opts.awsSubnetId;
        if (opts.ingress) {
          config.ingress_cidrs =
            opts.ingress === "open" ? ["0.0.0.0/0"] : opts.ingress.split(",").map((s: string) => s.trim());
        }
        if (opts.idleMinutes) config.idle_minutes = parseInt(opts.idleMinutes);
        for (const kv of opts.set) {
          const [k, ...rest] = kv.split("=");
          if (k && rest.length) config[k] = rest.join("=");
        }

        await ark.computeUpdate(name, { config });
        console.log(chalk.green(`Compute '${name}' updated`));
        console.log(JSON.stringify(config, null, 2));
      } catch {
        console.log(chalk.red(`Compute '${name}' not found`));
      }
    });
}
