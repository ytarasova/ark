import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getArkClient } from "./_shared.js";

export function registerTriggerCommands(program: Command) {
  const trigger = program.command("trigger").description("Manage trigger configurations (webhook / schedule / poll)");

  trigger
    .command("list")
    .description("List configured triggers")
    .option("--tenant <name>", "Tenant scope (default: 'default')")
    .action(async (opts) => {
      const ark = await getArkClient();
      const { triggers } = await ark.triggerList(opts.tenant);
      if (!triggers || triggers.length === 0) {
        console.log(chalk.yellow("No triggers configured."));
        console.log(chalk.dim("Add YAML files under triggers/ in the repo or ~/.ark/triggers/"));
        return;
      }
      for (const t of triggers) {
        const status = t.enabled === false ? chalk.dim("o") : chalk.green("*");
        const kind = (t.kind ?? "webhook").padEnd(8);
        const source = t.source.padEnd(12);
        const flow = t.flow.padEnd(18);
        const event = (t.event ?? "*").padEnd(20);
        console.log(`  ${status} ${chalk.dim(t.name.padEnd(30))} ${kind} ${source} ${event} -> ${flow}`);
      }
    });

  trigger
    .command("get")
    .description("Show a trigger config")
    .argument("<name>", "Trigger name")
    .option("--tenant <name>", "Tenant scope")
    .action(async (name, opts) => {
      const ark = await getArkClient();
      try {
        const { trigger: t } = await ark.triggerGet(name, opts.tenant);
        console.log(chalk.bold(`\n${t.name}`));
        console.log(`  source: ${t.source}`);
        console.log(`  event:  ${t.event ?? chalk.dim("(any)")}`);
        console.log(`  flow:   ${t.flow}`);
        console.log(`  kind:   ${t.kind ?? "webhook"}`);
        console.log(`  enabled:${t.enabled === false ? chalk.red(" no") : chalk.green(" yes")}`);
        if (t.match) console.log(`  match:  ${JSON.stringify(t.match)}`);
        if (t.inputs) console.log(`  inputs: ${JSON.stringify(t.inputs)}`);
        if (t.params) console.log(`  params: ${JSON.stringify(t.params)}`);
        if (t.cron) console.log(`  cron:   ${t.cron}`);
        if (t.tenant) console.log(`  tenant: ${t.tenant}`);
      } catch (e: any) {
        console.log(chalk.red(e.message ?? "Trigger not found"));
        process.exit(1);
      }
    });

  trigger
    .command("enable")
    .description("Enable a trigger (in-memory; edit the YAML to persist)")
    .argument("<name>", "Trigger name")
    .option("--tenant <name>", "Tenant scope")
    .action(async (name, opts) => {
      const ark = await getArkClient();
      try {
        await ark.triggerEnable(name, opts.tenant);
        console.log(chalk.green(`Enabled ${name}`));
        console.log(chalk.dim("Note: change is in-memory. Edit the YAML file to make it permanent."));
      } catch (e: any) {
        console.log(chalk.red(e.message ?? "Trigger not found"));
        process.exit(1);
      }
    });

  trigger
    .command("disable")
    .description("Disable a trigger (in-memory; restart resets)")
    .argument("<name>", "Trigger name")
    .option("--tenant <name>", "Tenant scope")
    .action(async (name, opts) => {
      const ark = await getArkClient();
      try {
        await ark.triggerDisable(name, opts.tenant);
        console.log(chalk.yellow(`Disabled ${name}`));
        console.log(chalk.dim("Note: change is in-memory. Edit the YAML file to make it permanent."));
      } catch (e: any) {
        console.log(chalk.red(e.message ?? "Trigger not found"));
        process.exit(1);
      }
    });

  trigger
    .command("reload")
    .description("Re-read trigger YAML files from disk")
    .action(async () => {
      const ark = await getArkClient();
      await ark.triggerReload();
      console.log(chalk.green("Triggers reloaded."));
    });

  trigger
    .command("sources")
    .description("List registered source connectors and their status")
    .action(async () => {
      const ark = await getArkClient();
      const { sources } = await ark.triggerSources();
      for (const s of sources) {
        const colored = s.status === "full" ? chalk.green : s.status === "scaffolded" ? chalk.yellow : chalk.dim;
        console.log(
          `  ${colored(s.status.padEnd(11))} ${chalk.bold(s.name.padEnd(14))} ${s.label.padEnd(32)} ${chalk.dim(`secret env: ${s.secretEnvVar}`)}`,
        );
      }
    });

  trigger
    .command("test")
    .description("Replay a sample payload against a trigger (dry-run by default)")
    .argument("<name>", "Trigger name")
    .requiredOption("--payload <file>", "JSON file with the synthetic payload")
    .option("--tenant <name>", "Tenant scope")
    .option("--fire", "Actually invoke the flow (default: dry-run)")
    .action(async (name, opts) => {
      const path = resolve(opts.payload);
      if (!existsSync(path)) {
        console.log(chalk.red(`Payload file not found: ${path}`));
        process.exit(1);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(readFileSync(path, "utf-8"));
      } catch (e: any) {
        console.log(chalk.red(`Invalid JSON in ${path}: ${e.message}`));
        process.exit(1);
      }
      const ark = await getArkClient();
      const result = await ark.triggerTest({
        name,
        payload,
        tenant: opts.tenant,
        dryRun: !opts.fire,
      });
      if (result.fired) {
        console.log(chalk.green(`Trigger ${name} fired against synthetic event.`));
        if (result.sessionId) console.log(chalk.dim(`Session: ${result.sessionId}`));
        else if (result.dryRun) console.log(chalk.dim("(dry-run -- no session created)"));
      } else {
        console.log(chalk.yellow(`Trigger ${name} did NOT fire (match filter rejected the payload).`));
      }
      if (result.message) console.log(chalk.red(result.message));
    });
}
