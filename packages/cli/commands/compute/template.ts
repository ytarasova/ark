import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import type { ComputeProviderName } from "../../../types/index.js";

export function registerTemplateCommands(computeCmd: Command) {
  const template = computeCmd.command("template").description("Manage compute templates");

  template
    .command("list")
    .description("List compute templates")
    .action(async () => {
      try {
        const app = await getInProcessApp();
        const templates = await app.computeTemplates.list();

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
        const app = await getInProcessApp();
        let tmpl: any = await app.computeTemplates.get(name);

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
    .description("Create a compute template (convenience alias for 'compute create --template')")
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
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.arch) config.arch = opts.arch;
        if (opts.region) config.region = opts.region;
        if (opts.profile) config.aws_profile = opts.profile;
        if (opts.image) config.image = opts.image;
        if (opts.namespace) config.namespace = opts.namespace;

        // Route through the unified RPC so templates and concrete targets
        // stay in lockstep (same tenant policies, same k8s validation).
        const ark = await getArkClient();
        const compute = await ark.computeCreate({
          name,
          provider: opts.provider,
          config,
          is_template: true,
        } as any);

        const ck = (compute as any).compute_kind ?? "-";
        const rk = (compute as any).runtime_kind ?? "-";
        console.log(chalk.green(`Created TEMPLATE '${name}' (${ck}/${rk})`));
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
        const app = await getInProcessApp();
        app.computeTemplates.delete(name);
        console.log(chalk.green(`Template '${name}' deleted`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });
}
