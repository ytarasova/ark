import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import YAML from "yaml";
import * as core from "../../core/index.js";
import { getApp } from "../../core/app.js";
import { getArkClient } from "./_shared.js";

export function registerSkillCommands(program: Command) {
  const skillCmd = program.command("skill").description("Manage skills");

  skillCmd.command("list")
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

  skillCmd.command("show")
    .description("Show skill details")
    .argument("<name>", "Skill name")
    .action(async (name: string) => {
      const ark = await getArkClient();
      const skill = await ark.skillRead(name);
      if (!skill) { console.log(chalk.red(`Skill not found: ${name}`)); return; }
      console.log(chalk.bold(`\n${skill.name}`) + chalk.dim(` (${skill._source})`));
      console.log(`  Description: ${skill.description}`);
      if (skill.tags?.length) console.log(`  Tags:        ${skill.tags.join(", ")}`);
      if (skill.prompt) {
        console.log(`\n${chalk.bold("Prompt:")}`);
        console.log(skill.prompt);
      }
    });

  skillCmd.command("create")
    .description("Create a new skill")
    .argument("[name]", "Skill name (required unless --from)")
    .option("--from <file>", "Create from YAML file")
    .option("-d, --description <desc>", "Skill description")
    .option("-p, --prompt <prompt>", "Skill prompt")
    .option("-s, --scope <scope>", "Scope: global or project", "global")
    .option("--tags <tags>", "Comma-separated tags")
    .action((name: string | undefined, opts: any) => {
      const scope = opts.scope as "global" | "project";
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

      if (opts.from) {
        let content: string;
        try { content = readFileSync(opts.from, "utf-8"); }
        catch { console.error(chalk.red(`Cannot read file: ${opts.from}`)); process.exit(1); }
        const skill = YAML.parse(content);
        if (!skill.name) { console.error(chalk.red("YAML must have a 'name' field")); process.exit(1); }
        getApp().skills.save(skill.name, skill, scope, projectRoot);
        console.log(chalk.green(`Created skill: ${skill.name} (${scope})`));
        return;
      }

      if (!name) { console.error(chalk.red("Name required (or use --from)")); process.exit(1); }
      if (!opts.prompt) { console.error(chalk.red("--prompt required")); process.exit(1); }

      getApp().skills.save(name, {
        name,
        description: opts.description ?? "",
        prompt: opts.prompt,
        tags: opts.tags?.split(",").map((t: string) => t.trim()) ?? [],
      }, scope, projectRoot);
      console.log(chalk.green(`Created skill: ${name} (${scope})`));
    });

  skillCmd.command("delete")
    .description("Delete a skill (global or project only)")
    .argument("<name>", "Skill name")
    .option("-s, --scope <scope>", "Scope: global or project", "global")
    .action((name: string, opts: any) => {
      const scope = opts.scope as "global" | "project";
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

      const skill = getApp().skills.get(name, projectRoot);
      if (skill && skill._source === "builtin") {
        console.error(chalk.red(`Cannot delete builtin skill: ${name}`));
        process.exit(1);
      }
      if (!skill) {
        console.error(chalk.red(`Skill not found: ${name}`));
        process.exit(1);
      }

      getApp().skills.delete(name, scope, projectRoot);
      console.log(chalk.green(`Deleted skill: ${name}`));
    });
}
