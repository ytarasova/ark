import type { Command } from "commander";
import chalk from "chalk";
import { join } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import YAML from "yaml";
import * as core from "../../core/index.js";
import { getArkClient } from "./_shared.js";
import type { AppContext } from "../../core/app.js";

export function registerAgentCommands(program: Command, app: AppContext) {
  const agent = program.command("agent").description("Manage agent definitions");

  agent
    .command("list")
    .description("List agents")
    .option("--project <dir>", "Project root")
    .action(async (_opts) => {
      const ark = await getArkClient();
      const agents = await ark.agentList();
      for (const a of agents) {
        const src = (a._source === "project" ? "P" : a._source === "global" ? "G" : "B").padEnd(2);
        console.log(
          `  ${src} ${a.name.padEnd(16)} ${a.model.padEnd(8)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length} R:${a.memories.length}  ${a.description.slice(0, 40)}`,
        );
      }
    });

  agent
    .command("show")
    .description("Show agent details")
    .argument("<name>")
    .action(async (name) => {
      const ark = await getArkClient();
      try {
        const a = await ark.agentRead(name);
        console.log(chalk.bold(`\n${a.name}`) + chalk.dim(` (${a._source})`));
        console.log(`  Model:      ${a.model}`);
        console.log(`  Max turns:  ${a.max_turns}`);
        console.log(`  Tools:      ${a.tools.join(", ")}`);
        console.log(`  MCPs:       ${a.mcp_servers.length ? a.mcp_servers.join(", ") : "-"}`);
        console.log(`  Skills:     ${a.skills.length ? a.skills.join(", ") : "-"}`);
        console.log(`  Memories:   ${a.memories.length ? a.memories.join(", ") : "-"}`);
      } catch {
        console.log(chalk.red("Not found"));
      }
    });

  agent
    .command("create")
    .description("Create a new agent")
    .argument("<name>")
    .option("--global", "Save to ~/.ark/agents/ instead of project")
    .action(async (name, opts) => {
      const projectRoot = core.findProjectRoot(process.cwd());
      const scope: "project" | "global" = opts.global || !projectRoot ? "global" : "project";
      const dir = scope === "project" ? join(projectRoot!, ".ark", "agents") : join(app.config.arkDir, "agents");
      const filePath = join(dir, `${name}.yaml`);

      if (existsSync(filePath)) {
        console.log(chalk.red(`Agent '${name}' already exists at ${filePath}`));
        return;
      }

      mkdirSync(dir, { recursive: true });
      const scaffold = YAML.stringify({
        name,
        description: "",
        model: "sonnet",
        max_turns: 200,
        system_prompt: "",
        tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
        mcp_servers: [],
        skills: [],
        memories: [],
        context: [],
        permission_mode: "bypassPermissions",
        env: {},
      });
      writeFileSync(filePath, scaffold);
      console.log(chalk.green(`Created ${scope} agent: ${filePath}`));

      const editor = process.env.EDITOR || "vi";
      execFileSync(editor, [filePath], { stdio: "inherit" });
    });

  agent
    .command("edit")
    .description("Edit an agent definition")
    .argument("<name>")
    .action(async (name) => {
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
      const a = app.agents.get(name, projectRoot);
      if (!a) {
        console.log(chalk.red(`Agent '${name}' not found`));
        return;
      }

      if (a._source === "builtin") {
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) =>
          rl.question(`'${name}' is a builtin agent. Copy to [p]roject/[g]lobal first? [p/g/N] `, resolve),
        );
        rl.close();
        const choice = answer.trim().toLowerCase();
        if (choice === "p" && projectRoot) {
          app.agents.save(a.name, a, "project", projectRoot);
          const path = join(projectRoot, ".ark", "agents", `${name}.yaml`);
          execFileSync(process.env.EDITOR || "vi", [path], { stdio: "inherit" });
        } else if (choice === "g") {
          app.agents.save(a.name, a, "global");
          const path = join(app.config.arkDir, "agents", `${name}.yaml`);
          execFileSync(process.env.EDITOR || "vi", [path], { stdio: "inherit" });
        } else {
          console.log("Cancelled.");
        }
        return;
      }

      execFileSync(process.env.EDITOR || "vi", [a._path!], { stdio: "inherit" });
    });

  agent
    .command("delete")
    .description("Delete a custom agent")
    .argument("<name>")
    .action(async (name) => {
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
      const a = app.agents.get(name, projectRoot);
      if (!a) {
        console.log(chalk.red(`Agent '${name}' not found`));
        return;
      }

      if (a._source === "builtin") {
        console.log(chalk.red("Cannot delete builtin agents."));
        return;
      }

      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) =>
        rl.question(`Delete ${a._source} agent '${name}' at ${a._path}? [y/N] `, resolve),
      );
      rl.close();

      if (answer.trim().toLowerCase() === "y") {
        const scope = a._source as "project" | "global";
        app.agents.delete(name, scope, scope === "project" ? projectRoot : undefined);
        console.log(chalk.green(`Deleted '${name}'.`));
      } else {
        console.log("Cancelled.");
      }
    });

  agent
    .command("copy")
    .description("Copy an agent for customization")
    .argument("<name>")
    .argument("[new-name]")
    .option("--global", "Save to ~/.ark/agents/ instead of project")
    .action((name, newName, opts) => {
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
      const a = app.agents.get(name, projectRoot);
      if (!a) {
        console.log(chalk.red(`Agent '${name}' not found`));
        return;
      }

      const targetName = newName || name;
      const scope: "project" | "global" = opts.global || !projectRoot ? "global" : "project";
      const copy = { ...a, name: targetName };
      app.agents.save(copy.name, copy, scope, scope === "project" ? projectRoot : undefined);

      const dir = scope === "project" ? join(projectRoot!, ".ark", "agents") : join(app.config.arkDir, "agents");
      console.log(chalk.green(`Copied '${name}' → ${scope} '${targetName}' at ${join(dir, `${targetName}.yaml`)}`));
    });
}
