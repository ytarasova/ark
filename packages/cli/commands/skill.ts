import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import YAML from "yaml";
import { getArkClient } from "../app-client.js";

export function registerSkillCommands(program: Command) {
  const skillCmd = program.command("skill").description("Manage skills");

  skillCmd
    .command("list")
    .description("List available skills")
    .action(async () => {
      const ark = await getArkClient();
      const skills = await ark.skillList();
      if (!skills.length) {
        console.log(chalk.dim("No skills found."));
        return;
      }
      for (const s of skills) {
        console.log(`  ${(s._source ?? "").padEnd(8)} ${s.name.padEnd(20)} ${s.description}`);
      }
    });

  skillCmd
    .command("show")
    .description("Show skill details")
    .argument("<name>", "Skill name")
    .action(async (name: string) => {
      const ark = await getArkClient();
      const skill = await ark.skillRead(name);
      if (!skill) {
        console.log(chalk.red(`Skill not found: ${name}`));
        return;
      }
      console.log(chalk.bold(`\n${skill.name}`) + chalk.dim(` (${skill._source})`));
      console.log(`  Description: ${skill.description}`);
      if (skill.tags?.length) console.log(`  Tags:        ${skill.tags.join(", ")}`);
      if (skill.prompt) {
        console.log(`\n${chalk.bold("Prompt:")}`);
        console.log(skill.prompt);
      }
    });

  skillCmd
    .command("create")
    .description("Create a new skill")
    .argument("[name]", "Skill name (required unless --from)")
    .option("--from <file>", "Create from YAML file")
    .option("-d, --description <desc>", "Skill description")
    .option("-p, --prompt <prompt>", "Skill prompt")
    .option("-s, --scope <scope>", "Scope: global or project", "global")
    .option("--tags <tags>", "Comma-separated tags")
    .action(async (name: string | undefined, opts: any) => {
      const scope = opts.scope as "global" | "project";
      const ark = await getArkClient();

      // Two input paths: --from <file> OR inline flags. Both get serialized
      // to YAML client-side and posted as a single `yaml` blob so the daemon
      // can persist identical content against local or remote control planes.
      let yaml: string;
      let resolvedName: string;
      if (opts.from) {
        let content: string;
        try {
          content = readFileSync(opts.from, "utf-8");
        } catch {
          console.error(chalk.red(`Cannot read file: ${opts.from}`));
          process.exit(1);
        }
        let parsed: any;
        try {
          parsed = YAML.parse(content);
        } catch (e: any) {
          console.error(chalk.red(`Malformed YAML: ${e?.message ?? e}`));
          process.exit(1);
        }
        if (!parsed || typeof parsed !== "object" || !parsed.name) {
          console.error(chalk.red("YAML must be an object with a 'name' field"));
          process.exit(1);
        }
        resolvedName = String(parsed.name);
        yaml = content;
      } else {
        if (!name) {
          console.error(chalk.red("Name required (or use --from)"));
          process.exit(1);
        }
        if (!opts.prompt) {
          console.error(chalk.red("--prompt required"));
          process.exit(1);
        }
        resolvedName = name;
        yaml = YAML.stringify({
          name,
          description: opts.description ?? "",
          prompt: opts.prompt,
          tags: opts.tags?.split(",").map((t: string) => t.trim()) ?? [],
        });
      }

      try {
        const res = await ark.skillCreate({ name: resolvedName, yaml, scope });
        console.log(chalk.green(`Created skill: ${res.name} (${res.scope})`));
      } catch (e: any) {
        console.error(chalk.red(`skill/create failed: ${e?.message ?? e}`));
        process.exit(1);
      }
    });

  skillCmd
    .command("delete")
    .description("Delete a skill (global or project only)")
    .argument("<name>", "Skill name")
    .option("-s, --scope <scope>", "Scope: global or project", "global")
    .action(async (name: string, opts: any) => {
      const scope = opts.scope as "global" | "project";
      const ark = await getArkClient();
      try {
        await ark.skillDelete(name, scope);
        console.log(chalk.green(`Deleted skill: ${name}`));
      } catch (e: any) {
        console.error(chalk.red(`skill/delete failed: ${e?.message ?? e}`));
        process.exit(1);
      }
    });
}
