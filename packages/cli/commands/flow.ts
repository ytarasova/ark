import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import YAML from "yaml";
import { getArkClient, runAction } from "./_shared.js";

export function registerFlowCommands(program: Command) {
  const pipe = program.command("flow").description("Manage flows");

  pipe
    .command("list")
    .description("List flows")
    .action(async () => {
      const ark = await getArkClient();
      const flows = await ark.flowList();
      for (const p of flows) {
        console.log(`  ${p.name.padEnd(16)} ${p.stages.join(" > ")}  ${chalk.dim(p.description.slice(0, 40))}`);
      }
    });

  pipe
    .command("show")
    .description("Show flow")
    .argument("<name>")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const p = await ark.flowRead(name);
        console.log(chalk.bold(`\n${p.name}`));
        if (p.description) console.log(chalk.dim(`  ${p.description}`));
        for (const [i, s] of p.stages.entries()) {
          const type = s.type ?? (s.action ? "action" : "agent");
          const detail = s.agent ?? s.action ?? "";
          console.log(
            `  ${i + 1}. ${s.name.padEnd(14)} [${type}:${detail}] gate=${s.gate}${s.optional ? " (optional)" : ""}`,
          );
        }
      } catch {
        console.log(chalk.red("Not found"));
      }
    });

  pipe
    .command("create")
    .description("Create a flow from a YAML file")
    .argument("<name>", "Flow name")
    .option("--from <file>", "YAML file containing the stages array")
    .option("--description <text>", "Flow description")
    .option("--scope <scope>", "global or project", "global")
    .action(async (name: string, opts: { from?: string; description?: string; scope?: string }) => {
      let stages: unknown[] = [];
      let description = opts.description ?? "";
      if (opts.from) {
        const file = resolve(opts.from);
        if (!existsSync(file)) {
          console.error(chalk.red(`File not found: ${file}`));
          process.exit(1);
        }
        const parsed = YAML.parse(readFileSync(file, "utf-8")) as { stages?: unknown[]; description?: string };
        stages = parsed?.stages ?? [];
        if (!description && parsed?.description) description = parsed.description;
      }
      if (!Array.isArray(stages) || stages.length === 0) {
        console.error(chalk.red("No stages provided. Pass --from <file.yaml> with a 'stages:' array."));
        process.exit(1);
      }
      await runAction("flow create", async () => {
        const ark = await getArkClient();
        const result = await ark.flowCreate({
          name,
          description,
          stages: stages as never,
          scope: (opts.scope as "global" | "project") ?? "global",
        });
        console.log(chalk.green(`Created flow '${result.name}'`));
      });
    });

  pipe
    .command("delete")
    .description("Delete a flow (global or project only -- builtins are protected)")
    .argument("<name>", "Flow name")
    .option("--scope <scope>", "global or project", "global")
    .action(async (name: string, opts: { scope?: string }) => {
      await runAction("flow delete", async () => {
        const ark = await getArkClient();
        const result = await ark.flowDelete(name, (opts.scope as "global" | "project") ?? "global");
        if (result.ok) console.log(chalk.green(`Deleted flow '${name}'`));
        else console.log(chalk.red(`Flow '${name}' not found`));
      });
    });

  pipe
    .command("validate")
    .description(
      "Dry-run validate a flow payload. Accepts a registered flow name OR a path to a YAML file. Runs the same structural + DAG + requires_repo + declared-inputs checks that session/start would, without creating a session.",
    )
    .argument("<name-or-path>", "Flow name OR a path to an inline flow YAML")
    .option("--repo <path>", "Optional repo path. When unset, flows declaring requires_repo: true report a problem.")
    .option(
      "--param <k=value>",
      "Declared input to validate against the flow contract (repeatable).",
      (value: string, prev: Record<string, unknown> = {}) => {
        const eq = value.indexOf("=");
        if (eq < 0) throw new Error(`--param expects k=value, got: ${value}`);
        const k = value.slice(0, eq).trim();
        const raw = value.slice(eq + 1);
        if (!k) throw new Error(`--param expects k=value, got: ${value}`);
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* keep as string */
        }
        return { ...prev, [k]: parsed };
      },
      {} as Record<string, unknown>,
    )
    .action(async (target: string, opts: { repo?: string; param?: Record<string, unknown> }) => {
      await runAction("flow validate", async () => {
        const ark = await getArkClient();
        // Path-looking arg that exists on disk -> parse + send as inline.
        let flowArg: string | Record<string, unknown> = target;
        if (/\.(yaml|yml)$/i.test(target)) {
          const file = resolve(target);
          if (!existsSync(file)) {
            console.error(chalk.red(`File not found: ${file}`));
            process.exit(1);
          }
          try {
            flowArg = YAML.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
          } catch (e: any) {
            console.error(chalk.red(`Failed to parse ${file}: ${e?.message ?? e}`));
            process.exit(1);
          }
        }
        const inputs = opts.param && Object.keys(opts.param).length ? opts.param : undefined;
        const result = await ark.flowValidate({ flow: flowArg as never, inputs, repo: opts.repo });
        if (result.ok) {
          const label = result.flow?.name ?? (typeof flowArg === "string" ? flowArg : "(inline)");
          const stageList = result.flow?.stages?.join(" > ") ?? "";
          console.log(chalk.green(`Flow '${label}' is valid`));
          if (stageList) console.log(chalk.dim(`  stages: ${stageList}`));
        } else {
          console.error(chalk.red(`Flow validation failed (${result.problems.length} problem(s)):`));
          for (const p of result.problems) console.error(chalk.red(`  - ${p}`));
          process.exit(1);
        }
      });
    });
}
