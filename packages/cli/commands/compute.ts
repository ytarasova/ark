import type { Command } from "commander";
import chalk from "chalk";
import { join, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { getArkClient } from "./_shared.js";

export function registerComputeCommands(program: Command) {
  const computeCmd = program.command("compute").description("Manage compute resources");

  computeCmd.command("create")
    .description("Create a new compute resource")
    .argument("<name>", "Compute name")
    .option("--provider <type>", "Provider type", "local")
    // EC2-specific options
    .option("--size <size>", "Instance size: xs (2vCPU/8GB), s (4/16), m (8/32), l (16/64), xl (32/128), xxl (48/192), xxxl (64/256)", "m")
    .option("--arch <arch>", "Architecture: x64, arm", "x64")
    .option("--region <region>", "Region", "us-east-1")
    .option("--profile <profile>", "AWS profile")
    .option("--subnet-id <id>", "Subnet ID")
    .option("--tag <key=value>", "Tag (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    // Docker-specific options
    .option("--image <image>", "Docker image (default: ubuntu:22.04)")
    .option("--devcontainer", "Use devcontainer.json from project")
    .option("--volume <mount>", "Extra volume mount (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    .action(async (name, opts) => {
      if (opts.provider === "local") {
        console.log(chalk.red("Local compute is auto-created. Use 'ec2' or 'docker' provider."));
        return;
      }
      try {
        const ark = await getArkClient();
        let config: Record<string, unknown>;

        if (opts.provider === "docker") {
          config = {
            image: opts.image ?? "ubuntu:22.04",
            ...(opts.devcontainer ? { devcontainer: true } : {}),
            ...(opts.volume?.length ? { volumes: opts.volume } : {}),
          };
        } else if (opts.provider === "ec2") {
          const tags: Record<string, string> = {};
          for (const t of opts.tag) {
            const [k, ...rest] = t.split("=");
            if (k && rest.length) tags[k] = rest.join("=");
          }
          config = {
            size: opts.size,
            arch: opts.arch,
            region: opts.region,
            ...(opts.profile ? { aws_profile: opts.profile } : {}),
            ...(opts.subnetId ? { subnet_id: opts.subnetId } : {}),
            ...(Object.keys(tags).length ? { tags } : {}),
          };
        } else {
          config = {};
        }

        const compute = await ark.computeCreate({
          name,
          provider: opts.provider,
          config,
        });

        console.log(chalk.green(`Compute '${compute.name}' created`));
        console.log(`  Provider: ${compute.provider}`);
        console.log(`  Status:   ${compute.status}`);

        if (opts.provider === "docker") {
          console.log(`  Image:    ${(config.image as string) ?? "ubuntu:22.04"}`);
          if (config.devcontainer) console.log(`  Devcontainer: yes`);
          if ((config.volumes as string[] | undefined)?.length) {
            console.log(`  Volumes:  ${(config.volumes as string[]).join(", ")}`);
          }
        } else if (opts.provider === "ec2") {
          let sizeLabel = opts.size;
          try {
            const { INSTANCE_SIZES } = await import("../../compute/providers/ec2/provision.js");
            const tier = INSTANCE_SIZES[opts.size];
            if (tier) sizeLabel = tier.label;
          } catch { /* not ec2 provider */ }
          console.log(`  Size:     ${sizeLabel}`);
          console.log(`  Arch:     ${opts.arch}`);
          console.log(`  Region:   ${opts.region}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed to create compute: ${e.message}`));
      }
    });

  computeCmd.command("provision")
    .description("Provision a compute resource (create infrastructure)")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const compute = await ark.computeRead(name);
        console.log(chalk.dim(`Provisioning '${name}' via ${compute.provider}...`));
        await ark.computeProvision(name);
        console.log(chalk.green(`Compute '${name}' provisioned and running`));
      } catch (e: any) {
        try { await ark.computeUpdate(name, { status: "stopped" }); } catch { /* ignore */ }
        console.log(chalk.red(`Provision failed: ${e.message}`));
      }
    });

  computeCmd.command("start")
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

  computeCmd.command("stop")
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

  computeCmd.command("destroy")
    .description("Destroy a compute resource (remove infrastructure)")
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

  computeCmd.command("delete")
    .description("Delete a compute record from the database")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const compute = await ark.computeRead(name);
        if (compute.status === "running") {
          console.log(chalk.red("Compute is running. Stop or destroy it first."));
          return;
        }
        await ark.computeDelete(name);
        console.log(chalk.green(`Compute '${name}' deleted`));
      } catch (e: any) {
        console.log(chalk.red(`Compute '${name}' not found`));
      }
    });

  computeCmd.command("update")
    .description("Update compute configuration")
    .argument("<name>", "Compute name")
    .option("--size <size>", "Instance size")
    .option("--arch <arch>", "Architecture: x64, arm")
    .option("--region <region>", "AWS region")
    .option("--profile <profile>", "AWS profile")
    .option("--subnet-id <id>", "Subnet ID")
    .option("--ingress <cidrs>", "SSH ingress CIDRs (comma-separated, or 'open' for 0.0.0.0/0)")
    .option("--idle-minutes <min>", "Idle shutdown timeout in minutes")
    .option("--set <key=value>", "Set arbitrary config key", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    .action(async (name, opts) => {
      const ark = await getArkClient();
      try {
        const compute = await ark.computeRead(name);

        const config: Record<string, unknown> = { ...compute.config };
        if (opts.size) config.size = opts.size;
        if (opts.arch) config.arch = opts.arch;
        if (opts.region) config.region = opts.region;
        if (opts.profile) config.aws_profile = opts.profile;
        if (opts.subnetId) config.subnet_id = opts.subnetId;
        if (opts.ingress) {
          config.ingress_cidrs = opts.ingress === "open"
            ? ["0.0.0.0/0"]
            : opts.ingress.split(",").map((s: string) => s.trim());
        }
        if (opts.idleMinutes) config.idle_minutes = parseInt(opts.idleMinutes);
        for (const kv of opts.set) {
          const [k, ...rest] = kv.split("=");
          if (k && rest.length) config[k] = rest.join("=");
        }

        await ark.computeUpdate(name, { config });
        console.log(chalk.green(`Compute '${name}' updated`));
        console.log(JSON.stringify(config, null, 2));
      } catch (e: any) {
        console.log(chalk.red(`Compute '${name}' not found`));
      }
    });

  computeCmd.command("list")
    .description("List all compute")
    .action(async () => {
      const ark = await getArkClient();
      const computes = await ark.computeList();
      if (!computes.length) {
        console.log(chalk.dim("No compute. Create one: ark compute create <name> --provider local"));
        return;
      }
      console.log(`  ${"NAME".padEnd(20)} ${"PROVIDER".padEnd(10)} ${"STATUS".padEnd(14)} IP`);
      for (const h of computes) {
        const ip = (h.config as { ip?: string }).ip ?? "-";
        console.log(`  ${h.name.padEnd(20)} ${h.provider.padEnd(10)} ${h.status.padEnd(14)} ${ip}`);
      }
    });

  computeCmd.command("status")
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
            console.log(`  MEM:  ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`);
            console.log(`  DISK: ${snap.metrics.diskPct.toFixed(1)}%`);
          } catch (e: any) {
            console.log(chalk.dim(`(metrics unavailable: ${e.message})`));
          }
        }
      } catch (e: any) {
        console.log(chalk.red(`Compute '${name}' not found`));
      }
    });

  computeCmd.command("sync")
    .description("Sync environment to/from compute")
    .argument("<name>", "Compute name")
    .option("--direction <dir>", "Sync direction (push|pull)", "push")
    .action(async (name, opts) => {
      const ark = await getArkClient();
      let compute: any;
      try { compute = await ark.computeRead(name); } catch { console.log(chalk.red(`Compute '${name}' not found`)); return; }
      const provider = getProvider(compute.provider);
      if (!provider) { console.log(chalk.red(`Provider '${compute.provider}' not found`)); return; }
      try {
        console.log(chalk.dim(`Syncing (${opts.direction}) to '${name}'...`));
        await provider.syncEnvironment(compute, { direction: opts.direction });
        console.log(chalk.green(`Sync complete (${opts.direction})`));
      } catch (e: any) {
        console.log(chalk.red(`Sync failed: ${e.message}`));
      }
    });

  computeCmd.command("metrics")
    .description("Show compute metrics")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const snap = await ark.metricsSnapshot(name);
        if (!snap) { console.log(chalk.red(`No metrics for '${name}'`)); return; }
        console.log(chalk.bold(`\nCompute: ${name}`));
        console.log(`  CPU:       ${snap.metrics.cpu.toFixed(1)}%`);
        console.log(`  MEM:       ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`);
        console.log(`  DISK:      ${snap.metrics.diskPct.toFixed(1)}%`);
        console.log(`  NET:       rx=${snap.metrics.netRxMb.toFixed(1)} MB  tx=${snap.metrics.netTxMb.toFixed(1)} MB`);
        console.log(`  Uptime:    ${snap.metrics.uptime}`);
        console.log(`  Sessions:  ${snap.sessions.length}`);
        console.log(`  Processes: ${snap.processes.length}`);
      } catch (e: any) {
        console.log(chalk.red(`Metrics failed: ${e.message}`));
      }
    });

  computeCmd.command("default")
    .description("Set default compute")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      try { await ark.computeRead(name); } catch { console.log(chalk.red(`Compute '${name}' not found`)); return; }
      const envPath = join(homedir(), ".ark", ".env");
      mkdirSync(dirname(envPath), { recursive: true });
      // Read existing, update or append
      let content = "";
      try { content = readFileSync(envPath, "utf-8"); } catch { /* new file */ }
      if (content.includes("ARK_DEFAULT_COMPUTE=")) {
        content = content.replace(/ARK_DEFAULT_COMPUTE=.*/g, `ARK_DEFAULT_COMPUTE=${name}`);
      } else {
        content += `\nARK_DEFAULT_COMPUTE=${name}\n`;
      }
      writeFileSync(envPath, content.trimStart());
      process.env.ARK_DEFAULT_COMPUTE = name;
      console.log(chalk.green(`Default compute set to '${name}'`));
    });

  computeCmd.command("ssh")
    .description("SSH into a compute")
    .argument("<name>", "Compute name")
    .action(async (name) => {
      const ark = await getArkClient();
      let compute: any;
      try { compute = await ark.computeRead(name); } catch { console.log(chalk.red(`Compute '${name}' not found`)); return; }
      const sshCfg = compute.config as { ip?: string; key_path?: string; ssh_user?: string };
      const ip = sshCfg.ip;
      const keyPath = sshCfg.key_path;
      const user = sshCfg.ssh_user ?? "ubuntu";
      if (!ip) { console.log(chalk.red(`Compute '${name}' has no IP address`)); return; }
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
