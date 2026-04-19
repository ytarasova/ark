import type { Command } from "commander";
import chalk from "chalk";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { getProvider, allFlagSpecs, getFlagSpec } from "../../compute/index.js";
import type { ProviderFlagOption } from "../../compute/index.js";
import { getArkClient } from "./_shared.js";
import { ComputePoolManager } from "../../core/compute/pool.js";
import type { ComputeProviderName } from "../../types/index.js";

/**
 * Apply every registered provider's Commander options to `create`, de-duped
 * by flag header (docker `--image` and k8s `--image` are the same flag and
 * must only be registered once). Repeatable list-style flags get an
 * accumulator; everything else is a plain option (possibly with a default).
 */
function registerProviderFlags(cmd: Command): Command {
  const seen = new Set<string>();
  const appendToList = (val: string, acc: string[] = []) => {
    acc.push(val);
    return acc;
  };

  for (const spec of allFlagSpecs()) {
    for (const opt of spec.options) {
      const header = flagHeader(opt.flag);
      if (seen.has(header)) continue;
      seen.add(header);

      if (isRepeatableListOption(opt)) {
        cmd.option(opt.flag, opt.description, appendToList, [] as string[]);
      } else if (opt.default !== undefined) {
        cmd.option(opt.flag, opt.description, opt.default);
      } else {
        cmd.option(opt.flag, opt.description);
      }
    }
  }
  return cmd;
}

/** Extract the canonical long-flag header (eg `"--image"` from `"--image <image>"`). */
function flagHeader(flag: string): string {
  const parts = flag.trim().split(/\s+/);
  return parts[0] ?? flag;
}

/** Heuristic: repeatable flags say so in their description. Cheaper than a 2nd field. */
function isRepeatableListOption(opt: ProviderFlagOption): boolean {
  return /\(repeatable\)/i.test(opt.description);
}

export function registerComputeCommands(program: Command) {
  const computeCmd = program.command("compute").description("Manage compute resources");

  const createCmd = computeCmd
    .command("create")
    .description("Create a new compute resource")
    .argument("<name>", "Compute name")
    // Two-axis flags:
    .option("--compute <kind>", "Compute kind (local, firecracker, ec2, k8s, k8s-kata)")
    .option("--runtime <kind>", "Runtime kind (direct, docker, compose, devcontainer, firecracker-in-container)")
    // Legacy single-axis flag, kept for one release:
    .option(
      "--provider <type>",
      "[deprecated] Provider type (local, docker, ec2, k8s, k8s-kata). Use --compute + --runtime.",
    );

  // Per-provider flags come from the flag-spec registry; each provider owns
  // its own knobs via `packages/compute/flag-specs/*.ts`. Adding a new
  // provider means shipping a new flag spec -- this command does not change.
  registerProviderFlags(createCmd);

  createCmd.option("--from-template <name>", "Use a compute template as defaults").action(async (name, opts) => {
    // Resolve either --compute + --runtime (new) or --provider (legacy).
    // We mutate `opts.provider` to a concrete value before handing off to
    // the per-provider flag spec so the spec sees the real provider key.
    const { providerToPair, pairToProvider } = await import("../../compute/adapters/provider-map.js");

    const newCompute: string | undefined = opts.compute;
    const newRuntime: string | undefined = opts.runtime;

    if (opts.provider) {
      const pair = providerToPair(opts.provider);
      console.log(
        chalk.yellow(
          `--provider is deprecated; pass --compute + --runtime instead. ` +
            `Auto-mapping '${opts.provider}' -> --compute ${pair.compute} --runtime ${pair.runtime}.`,
        ),
      );
    }

    // Default when nothing is specified: local + direct (local auto-created).
    if (!opts.provider && !newCompute && !newRuntime) {
      opts.provider = "local";
    }

    // Derive legacy provider name for the downstream spec lookup + display.
    if (!opts.provider && newCompute && newRuntime) {
      opts.provider = pairToProvider({ compute: newCompute as any, runtime: newRuntime as any }) ?? newCompute;
    }

    if (opts.provider === "local" && !opts.fromTemplate && !newCompute) {
      console.log(chalk.red("Local compute is auto-created. Use 'ec2' or 'docker' provider, or --from-template."));
      return;
    }
    try {
      const ark = await getArkClient();

      // Apply template defaults if specified
      if (opts.fromTemplate) {
        const tmpl = await ark.computeTemplateGet(opts.fromTemplate);
        if (!tmpl) {
          console.log(chalk.red(`Template '${opts.fromTemplate}' not found.`));
          return;
        }
        // Template sets provider unless user overrides
        if (!opts.provider || opts.provider === "local") {
          opts.provider = tmpl.provider;
        }
      }

      // Delegate config construction to the provider's flag spec. Unknown
      // providers fall through to an empty config with a warning -- every
      // provider that ships today has a spec, so this branch is a safety net.
      const spec = getFlagSpec(opts.provider);
      if (!spec) {
        console.log(chalk.yellow(`Unknown provider '${opts.provider}'; creating with empty config.`));
      }
      let config: Record<string, unknown> = spec ? spec.configFromFlags(opts) : {};

      // Merge template config as base, user options override
      if (opts.fromTemplate) {
        const tmpl = await ark.computeTemplateGet(opts.fromTemplate);
        if (tmpl?.config) {
          config = { ...tmpl.config, ...config };
        }
      }

      const compute = await ark.computeCreate({
        name,
        provider: opts.provider,
        ...(newCompute ? { compute: newCompute } : {}),
        ...(newRuntime ? { runtime: newRuntime } : {}),
        config,
      } as any);

      console.log(chalk.green(`Compute '${compute.name}' created`));
      console.log(`  Provider: ${compute.provider}`);
      if ((compute as any).compute_kind || (compute as any).runtime_kind) {
        console.log(`  Compute:  ${(compute as any).compute_kind ?? "-"}`);
        console.log(`  Runtime:  ${(compute as any).runtime_kind ?? "-"}`);
      }
      console.log(`  Status:   ${compute.status}`);

      if (spec) {
        for (const line of spec.displaySummary(config, opts)) {
          console.log(line);
        }
      }
    } catch (e: any) {
      console.log(chalk.red(`Failed to create compute: ${e.message}`));
    }
  });

  computeCmd
    .command("provision")
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
        try {
          await ark.computeUpdate(name, { status: "stopped" });
        } catch {
          /* ignore */
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
    .option("--region <region>", "AWS region")
    .option("--profile <profile>", "AWS profile")
    .option("--subnet-id <id>", "Subnet ID")
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
        if (opts.region) config.region = opts.region;
        if (opts.profile) config.aws_profile = opts.profile;
        if (opts.subnetId) config.subnet_id = opts.subnetId;
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

  computeCmd
    .command("list")
    .description("List all compute")
    .action(async () => {
      const ark = await getArkClient();
      const computes = await ark.computeList();
      if (!computes.length) {
        console.log(chalk.dim("No compute. Create one: ark compute create <name> --compute local --runtime direct"));
        return;
      }
      console.log(
        `  ${"NAME".padEnd(20)} ${"COMPUTE".padEnd(12)} ${"RUNTIME".padEnd(12)} ${"PROVIDER".padEnd(10)} ${"STATUS".padEnd(14)} IP`,
      );
      for (const h of computes) {
        const ip = (h.config as { ip?: string }).ip ?? "-";
        const ck = String((h as any).compute_kind ?? "-").padEnd(12);
        const rk = String((h as any).runtime_kind ?? "-").padEnd(12);
        console.log(`  ${h.name.padEnd(20)} ${ck} ${rk} ${h.provider.padEnd(10)} ${h.status.padEnd(14)} ${ip}`);
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
        /* new file */
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

  // ── Compute Pools ─────────────────────────────────────────────────────────

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
        const app = core.getApp();
        const manager = new ComputePoolManager(app);
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.region) config.region = opts.region;
        if (opts.image) config.image = opts.image;
        const pool = manager.createPool({
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
        const app = core.getApp();
        const manager = new ComputePoolManager(app);
        const pools = manager.listPools();
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
        const app = core.getApp();
        const manager = new ComputePoolManager(app);
        const deleted = manager.deletePool(name);
        if (deleted) {
          console.log(chalk.green(`Pool '${name}' deleted`));
        } else {
          console.log(chalk.red(`Pool '${name}' not found`));
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  // ── Template subcommands ──────────────────────────────────────────────

  const template = computeCmd.command("template").description("Manage compute templates");

  template
    .command("list")
    .description("List compute templates")
    .action(async () => {
      try {
        const app = core.getApp();
        const templates = app.computeTemplates.list();

        // Also show config-defined templates
        const configTemplates = app.config.computeTemplates ?? [];
        const dbNames = new Set(templates.map((t) => t.name));
        const allTemplates = [
          ...templates,
          ...configTemplates
            .filter((t) => !dbNames.has(t.name))
            .map((t) => ({
              name: t.name,
              description: t.description,
              provider: t.provider as ComputeProviderName,
              config: t.config,
            })),
        ];

        if (!allTemplates.length) {
          console.log(chalk.dim("No templates. Add to ~/.ark/config.yaml:"));
          console.log(chalk.dim("  compute_templates:"));
          console.log(chalk.dim("    gpu-large:"));
          console.log(chalk.dim("      provider: ec2"));
          console.log(chalk.dim("      size: l"));
          console.log(chalk.dim("      region: us-east-1"));
          return;
        }

        console.log(`  ${"NAME".padEnd(20)} ${"PROVIDER".padEnd(12)} DESCRIPTION`);
        for (const t of allTemplates) {
          console.log(`  ${t.name.padEnd(20)} ${t.provider.padEnd(12)} ${t.description ?? ""}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  template
    .command("show")
    .description("Show a compute template")
    .argument("<name>", "Template name")
    .action(async (name) => {
      try {
        const app = core.getApp();
        let tmpl = app.computeTemplates.get(name);

        // Fall back to config
        if (!tmpl) {
          const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === name);
          if (cfgTmpl) {
            tmpl = {
              name: cfgTmpl.name,
              description: cfgTmpl.description,
              provider: cfgTmpl.provider as ComputeProviderName,
              config: cfgTmpl.config,
            };
          }
        }

        if (!tmpl) {
          console.log(chalk.red(`Template '${name}' not found.`));
          return;
        }

        console.log(chalk.bold(tmpl.name));
        if (tmpl.description) console.log(`  Description: ${tmpl.description}`);
        console.log(`  Provider:    ${tmpl.provider}`);
        console.log(`  Config:`);
        for (const [k, v] of Object.entries(tmpl.config)) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  template
    .command("create")
    .description("Create a compute template")
    .argument("<name>", "Template name")
    .option("--provider <type>", "Provider type", "ec2")
    .option("--description <desc>", "Description")
    .option("--size <size>", "Instance size (ec2)")
    .option("--arch <arch>", "Architecture (ec2)")
    .option("--region <region>", "Region (ec2)")
    .option("--profile <profile>", "AWS profile (ec2)")
    .option("--image <image>", "Docker image (docker)")
    .option("--namespace <ns>", "K8s namespace (k8s)")
    .action(async (name, opts) => {
      try {
        const app = core.getApp();
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.arch) config.arch = opts.arch;
        if (opts.region) config.region = opts.region;
        if (opts.profile) config.aws_profile = opts.profile;
        if (opts.image) config.image = opts.image;
        if (opts.namespace) config.namespace = opts.namespace;

        app.computeTemplates.create({
          name,
          description: opts.description,
          provider: opts.provider,
          config,
        });

        console.log(chalk.green(`Template '${name}' created`));
        console.log(`  Provider: ${opts.provider}`);
        for (const [k, v] of Object.entries(config)) {
          console.log(`  ${k}: ${v}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  template
    .command("delete")
    .description("Delete a compute template")
    .argument("<name>", "Template name")
    .action(async (name) => {
      try {
        const app = core.getApp();
        app.computeTemplates.delete(name);
        console.log(chalk.green(`Template '${name}' deleted`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });
}
