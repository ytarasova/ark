import type { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import YAML from "yaml";
import { getArkClient } from "../app-client.js";

/**
 * Scaffold a fresh agent YAML string. Kept client-side so the CLI can preview
 * and edit it in `$EDITOR` before sending it to the daemon. The daemon fills
 * missing fields with the same defaults when it receives a partial YAML, so
 * this scaffold is just a UX convenience.
 */
function agentScaffold(name: string): string {
  return YAML.stringify({
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
}

/**
 * Open `$EDITOR` on a scratch file pre-populated with `initial`, return the
 * post-edit contents. The file lives in an ephemeral tmp directory so
 * exits-without-save don't clutter the user's cwd.
 */
function editInEditor(filename: string, initial: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "ark-agent-"));
  const path = join(dir, filename);
  writeFileSync(path, initial);
  try {
    execFileSync(process.env.EDITOR || "vi", [path], { stdio: "inherit" });
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } finally {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best effort
    }
  }
}

async function confirm(question: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

export function registerAgentCommands(program: Command) {
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
    .option("--global", "Save at global scope instead of project scope")
    .option("--from <file>", "Seed YAML from a file instead of scaffolding fresh")
    .option("--no-editor", "Skip the $EDITOR step (use the scaffold / --from content as-is)")
    .action(async (name: string, opts: { global?: boolean; from?: string; editor?: boolean }) => {
      const scope: "global" | "project" = opts.global ? "global" : "project";

      let seed: string;
      if (opts.from) {
        try {
          seed = readFileSync(opts.from, "utf-8");
        } catch {
          console.error(chalk.red(`Cannot read file: ${opts.from}`));
          process.exit(1);
        }
      } else {
        seed = agentScaffold(name);
      }

      let yaml: string | null = seed;
      if (opts.editor !== false) {
        yaml = editInEditor(`${name}.yaml`, seed);
        if (yaml === null) {
          console.log(chalk.red("Editor discarded file; aborting."));
          return;
        }
      }

      const ark = await getArkClient();
      try {
        const res = await ark.agentCreate({ name, yaml, scope });
        console.log(chalk.green(`Created ${res.scope} agent '${res.name}'.`));
      } catch (e: any) {
        console.error(chalk.red(`agent/create failed: ${e?.message ?? e}`));
        process.exit(1);
      }
    });

  agent
    .command("edit")
    .description("Edit an agent definition")
    .argument("<name>")
    .option("--global", "Write back at global scope (default follows the existing agent's scope)")
    .action(async (name: string, opts: { global?: boolean }) => {
      const ark = await getArkClient();
      let current;
      try {
        current = await ark.agentRead(name);
      } catch {
        console.log(chalk.red(`Agent '${name}' not found`));
        return;
      }

      if (current._source === "builtin") {
        const yes = await confirm(`'${name}' is a builtin agent. Copy it to global scope first? [y/N] `);
        if (!yes) {
          console.log("Cancelled.");
          return;
        }
        // Copy, then edit the copy at the requested scope.
        try {
          await ark.agentCopy({ from: name, to: name, scope: "global" });
        } catch (e: any) {
          console.error(chalk.red(`agent/copy failed: ${e?.message ?? e}`));
          process.exit(1);
        }
        current = await ark.agentRead(name);
      }

      // Strip metadata fields before handing YAML back to the user -- the
      // daemon will re-derive `_source` / `_path` on the next read.
      const { _source, _path, ...visible } = current;
      const seed = YAML.stringify(visible);
      const edited = editInEditor(`${name}.yaml`, seed);
      if (edited === null) {
        console.log(chalk.red("Editor discarded file; aborting."));
        return;
      }
      if (edited.trim() === seed.trim()) {
        console.log(chalk.dim("No changes."));
        return;
      }

      const scope: "global" | "project" | undefined = opts.global
        ? "global"
        : current._source === "project"
          ? "project"
          : "global";
      try {
        const res = await ark.agentEdit({ name, yaml: edited, scope });
        console.log(chalk.green(`Updated ${res.scope} agent '${res.name}'.`));
      } catch (e: any) {
        console.error(chalk.red(`agent/edit failed: ${e?.message ?? e}`));
        process.exit(1);
      }
    });

  agent
    .command("delete")
    .description("Delete a custom agent")
    .argument("<name>")
    .option("-y, --yes", "Skip confirmation")
    .action(async (name: string, opts: { yes?: boolean }) => {
      const ark = await getArkClient();
      let current;
      try {
        current = await ark.agentRead(name);
      } catch {
        console.log(chalk.red(`Agent '${name}' not found`));
        return;
      }

      if (current._source === "builtin") {
        console.log(chalk.red("Cannot delete builtin agents."));
        return;
      }

      if (!opts.yes) {
        const yes = await confirm(`Delete ${current._source} agent '${name}'? [y/N] `);
        if (!yes) {
          console.log("Cancelled.");
          return;
        }
      }

      try {
        await ark.agentDelete(name, current._source as "global" | "project");
        console.log(chalk.green(`Deleted '${name}'.`));
      } catch (e: any) {
        console.error(chalk.red(`agent/delete failed: ${e?.message ?? e}`));
        process.exit(1);
      }
    });

  agent
    .command("copy")
    .description("Copy an agent for customization")
    .argument("<name>")
    .argument("[new-name]")
    .option("--global", "Save at global scope instead of project scope")
    .action(async (name: string, newName: string | undefined, opts: { global?: boolean }) => {
      const target = newName || name;
      const scope: "global" | "project" = opts.global ? "global" : "project";

      const ark = await getArkClient();
      try {
        const res = await ark.agentCopy({ from: name, to: target, scope });
        console.log(chalk.green(`Copied '${name}' -> ${res.scope} '${res.name}'.`));
      } catch (e: any) {
        console.error(chalk.red(`agent/copy failed: ${e?.message ?? e}`));
        process.exit(1);
      }
    });
}
