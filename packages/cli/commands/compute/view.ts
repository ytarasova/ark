import type { Command } from "commander";
import chalk from "chalk";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { getProvider } from "../../../compute/index.js";
import { getArkClient } from "../../app-client.js";
import { logDebug } from "../../../core/observability/structured-log.js";

export function registerViewCommands(computeCmd: Command) {
  computeCmd
    .command("list")
    .description("List compute targets and templates")
    .option("--templates-only", "Only list templates (reusable config blueprints)")
    .option("--concrete-only", "Only list concrete compute targets")
    .action(async (opts) => {
      const ark = await getArkClient();
      const include = opts.templatesOnly ? "template" : opts.concreteOnly ? "concrete" : "all";
      const computes = (await ark.computeList({ include })) as Array<Record<string, any>>;
      if (!computes.length) {
        console.log(chalk.dim("No compute. Create one: ark compute create <name> --compute local --runtime direct"));
        return;
      }
      console.log(
        `  ${"NAME".padEnd(20)} ${"KIND".padEnd(9)} ${"COMPUTE".padEnd(12)} ${"RUNTIME".padEnd(12)} ${"PROVIDER".padEnd(10)} ${"STATUS".padEnd(14)} IP`,
      );
      for (const h of computes) {
        const ip = (h.config as { ip?: string })?.ip ?? "-";
        const ck = String(h.compute_kind ?? "-").padEnd(12);
        const rk = String(h.runtime_kind ?? "-").padEnd(12);
        const kind = (h.is_template ? "template" : "compute").padEnd(9);
        console.log(
          `  ${String(h.name).padEnd(20)} ${kind} ${ck} ${rk} ${String(h.provider).padEnd(10)} ${String(h.status).padEnd(14)} ${ip}`,
        );
      }
    });

  computeCmd
    .command("status")
    .description("Show compute details")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const compute = await ark.computeRead(name);
        console.log(JSON.stringify(compute, null, 2));
        if (compute.status === "running") {
          try {
            const snap = await ark.metricsSnapshot(name);
            console.log(chalk.bold("\nMetrics:"));
            console.log(`  CPU:  ${snap.metrics.cpu.toFixed(1)}%`);
            console.log(
              `  MEM:  ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`,
            );
            console.log(`  DISK: ${snap.metrics.diskPct.toFixed(1)}%`);
          } catch (e: any) {
            console.log(chalk.dim(`(metrics unavailable: ${e.message})`));
          }
        }
      } catch {
        console.log(chalk.red(`Compute '${name}' not found`));
      }
    });

  computeCmd
    .command("sync")
    .description("Sync environment to/from compute")
    .argument("<name>", "Compute name")
    .option("--direction <dir>", "Sync direction (push|pull)", "push")
    .action(async (name, opts) => {
      const ark = await getArkClient();
      let compute: any;
      try {
        compute = await ark.computeRead(name);
      } catch {
        console.log(chalk.red(`Compute '${name}' not found`));
        return;
      }
      const provider = getProvider(compute.provider);
      if (!provider) {
        console.log(chalk.red(`Provider '${compute.provider}' not found`));
        return;
      }
      try {
        console.log(chalk.dim(`Syncing (${opts.direction}) to '${name}'...`));
        await provider.syncEnvironment(compute, { direction: opts.direction });
        console.log(chalk.green(`Sync complete (${opts.direction})`));
      } catch (e: any) {
        console.log(chalk.red(`Sync failed: ${e.message}`));
      }
    });

  computeCmd
    .command("metrics")
    .description("Show compute metrics")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const snap = await ark.metricsSnapshot(name);
        if (!snap) {
          console.log(chalk.red(`No metrics for '${name}'`));
          return;
        }
        console.log(chalk.bold(`\nCompute: ${name}`));
        console.log(`  CPU:       ${snap.metrics.cpu.toFixed(1)}%`);
        console.log(
          `  MEM:       ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`,
        );
        console.log(`  DISK:      ${snap.metrics.diskPct.toFixed(1)}%`);
        console.log(`  NET:       rx=${snap.metrics.netRxMb.toFixed(1)} MB  tx=${snap.metrics.netTxMb.toFixed(1)} MB`);
        console.log(`  Uptime:    ${snap.metrics.uptime}`);
        console.log(`  Sessions:  ${snap.sessions.length}`);
        console.log(`  Processes: ${snap.processes.length}`);
      } catch (e: any) {
        console.log(chalk.red(`Metrics failed: ${e.message}`));
      }
    });

  computeCmd
    .command("default")
    .description("Set default compute")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        await ark.computeRead(name);
      } catch {
        console.log(chalk.red(`Compute '${name}' not found`));
        return;
      }
      const envPath = join(homedir(), ".ark", ".env");
      mkdirSync(dirname(envPath), { recursive: true });
      // Read existing, update or append
      let content = "";
      try {
        content = readFileSync(envPath, "utf-8");
      } catch {
        logDebug("general", "new file");
      }
      if (content.includes("ARK_DEFAULT_COMPUTE=")) {
        content = content.replace(/ARK_DEFAULT_COMPUTE=.*/g, `ARK_DEFAULT_COMPUTE=${name}`);
      } else {
        content += `\nARK_DEFAULT_COMPUTE=${name}\n`;
      }
      writeFileSync(envPath, content.trimStart());
      process.env.ARK_DEFAULT_COMPUTE = name;
      console.log(chalk.green(`Default compute set to '${name}'`));
    });

  computeCmd
    .command("ssh")
    .description("SSH into a compute")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      let compute: any;
      try {
        compute = await ark.computeRead(name);
      } catch {
        console.log(chalk.red(`Compute '${name}' not found`));
        return;
      }
      const sshCfg = compute.config as { ip?: string; key_path?: string; ssh_user?: string };
      const ip = sshCfg.ip;
      const keyPath = sshCfg.key_path;
      const user = sshCfg.ssh_user ?? "ubuntu";
      if (!ip) {
        console.log(chalk.red(`Compute '${name}' has no IP address`));
        return;
      }
      const sshArgs = [`${user}@${ip}`];
      if (keyPath) sshArgs.unshift("-i", keyPath);
      console.log(chalk.dim(`$ ssh ${sshArgs.join(" ")}`));
      try {
        execFileSync("ssh", sshArgs, { stdio: "inherit" });
      } catch (e: any) {
        console.log(chalk.red(`SSH failed: ${e.message}`));
      }
    });
}
