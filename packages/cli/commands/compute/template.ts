import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import { runAction } from "../_shared.js";

/**
 * Display-only helper -- compose a `${compute_kind}+${isolation_kind}` label
 * back into the legacy provider-name string the wire format used to carry.
 */
function legacyLabel(c: { compute?: string; isolation?: string }): string {
  const ck = c.compute ?? "local";
  const ik = c.isolation ?? "direct";
  if (ck === "local") {
    if (ik === "direct") return "local";
    if (ik === "docker") return "docker";
    if (ik === "devcontainer") return "devcontainer";
  }
  if (ck === "ec2") {
    if (ik === "direct") return "ec2";
    if (ik === "docker") return "ec2-docker";
    if (ik === "devcontainer") return "ec2-devcontainer";
  }
  if (ck === "firecracker") return "firecracker";
  if (ck === "k8s") return "k8s";
  if (ck === "k8s-kata") return "k8s-kata";
  return ck;
}

export function registerTemplateCommands(computeCmd: Command) {
  const template = computeCmd.command("template").description("Manage compute templates");

  template
    .command("list")
    .description("List compute templates")
    .action(async () => {
      await runAction("compute template list", async () => {
        const app = await getInProcessApp();
        const templates = await app.computeTemplates.list();

        // Also show config-defined templates
        const configTemplates = app.config.computeTemplates ?? [];
        const dbNames = new Set(templates.map((t) => t.name));
        type TemplateRow = { name: string; description?: string; provider: string };
        const dbRows: TemplateRow[] = templates.map((t) => ({
          name: t.name,
          description: t.description,
          provider: legacyLabel({ compute: t.compute, isolation: t.isolation }),
        }));
        const cfgRows: TemplateRow[] = configTemplates
          .filter((t) => !dbNames.has(t.name))
          .map((t) => ({
            name: t.name,
            description: t.description,
            provider: t.provider,
          }));
        const allTemplates: TemplateRow[] = [...dbRows, ...cfgRows];

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
      });
    });

  template
    .command("show")
    .description("Show a compute template")
    .argument("<name>", "Template name")
    .action(async (name) => {
      await runAction("compute template show", async () => {
        const app = await getInProcessApp();
        let tmpl: any = await app.computeTemplates.get(name);
        let providerLabel: string | undefined = tmpl
          ? legacyLabel({ compute: tmpl.compute, isolation: tmpl.isolation })
          : undefined;

        // Fall back to config
        if (!tmpl) {
          const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === name);
          if (cfgTmpl) {
            tmpl = {
              name: cfgTmpl.name,
              description: cfgTmpl.description,
              config: cfgTmpl.config,
            };
            providerLabel = cfgTmpl.provider;
          }
        }

        if (!tmpl) {
          console.log(chalk.red(`Template '${name}' not found.`));
          return;
        }

        console.log(chalk.bold(tmpl.name));
        if (tmpl.description) console.log(`  Description: ${tmpl.description}`);
        console.log(`  Provider:    ${providerLabel ?? "-"}`);
        console.log(`  Config:`);
        for (const [k, v] of Object.entries(tmpl.config)) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      });
    });

  template
    .command("create")
    .description("Create a compute template (convenience alias for 'compute create --template')")
    .argument("<name>", "Template name")
    .option("--provider <type>", "Provider type", "ec2")
    .option("--description <desc>", "Description")
    .option("--size <size>", "Instance size (ec2)")
    .option("--arch <arch>", "Architecture (ec2)")
    .option("--aws-region <region>", "AWS region (ec2)")
    .option("--aws-profile <profile>", "AWS profile (ec2)")
    .option("--image <image>", "Docker image (docker)")
    .option("--namespace <ns>", "K8s namespace (k8s)")
    .action(async (name, opts) => {
      await runAction("compute template create", async () => {
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.arch) config.arch = opts.arch;
        if (opts.awsRegion) config.region = opts.awsRegion;
        if (opts.awsProfile) config.aws_profile = opts.awsProfile;
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
        const ik = (compute as any).isolation_kind ?? "-";
        console.log(chalk.green(`Created TEMPLATE '${name}' (${ck}/${ik})`));
        console.log(`  Provider: ${opts.provider}`);
        for (const [k, v] of Object.entries(config)) {
          console.log(`  ${k}: ${v}`);
        }
      });
    });

  template
    .command("delete")
    .description("Delete a compute template")
    .argument("<name>", "Template name")
    .action(async (name) => {
      await runAction("compute template delete", async () => {
        const app = await getInProcessApp();
        app.computeTemplates.delete(name);
        console.log(chalk.green(`Template '${name}' deleted`));
      });
    });
}
