import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import YAML from "yaml";
import * as core from "../../core/index.js";
import { getArkClient } from "./_shared.js";
import type { AppContext } from "../../core/app.js";

export function registerRecipeCommands(program: Command, app: AppContext) {
  const recipeCmd = program.command("recipe").description("Manage recipes");

  recipeCmd
    .command("list")
    .description("List available recipes")
    .action(async () => {
      const ark = await getArkClient();
      const recipes = await ark.recipeList();
      if (!recipes.length) {
        console.log(chalk.dim("No recipes found."));
        return;
      }
      for (const r of recipes) {
        console.log(`  ${(r._source ?? "").padEnd(8)} ${r.name.padEnd(20)} ${r.description}`);
      }
    });

  recipeCmd
    .command("show")
    .description("Show recipe details")
    .argument("<name>", "Recipe name")
    .action(async (name: string) => {
      const ark = await getArkClient();
      try {
        const recipe = await ark.recipeRead(name);
        if (!recipe) {
          console.log(chalk.red(`Recipe not found: ${name}`));
          return;
        }
        console.log(chalk.bold(`\n${recipe.name}`) + chalk.dim(` (${recipe._source})`));
        console.log(`  Description: ${recipe.description}`);
        console.log(`  Flow:        ${recipe.flow}`);
        if (recipe.agent) console.log(`  Agent:       ${recipe.agent}`);
        if (recipe.variables?.length) {
          console.log(chalk.bold(`\n  Variables:`));
          for (const v of recipe.variables) {
            console.log(
              `    ${v.name}${v.required ? " *" : ""}  ${v.description}${v.default ? ` (default: ${v.default})` : ""}`,
            );
          }
        }
      } catch {
        console.log(chalk.red(`Recipe not found: ${name}`));
      }
    });

  recipeCmd
    .command("create")
    .description("Create a new recipe")
    .option("--from <file>", "Create from YAML file")
    .option("--from-session <id>", "Create from existing session")
    .option("-n, --name <name>", "Recipe name (required with --from-session)")
    .option("-s, --scope <scope>", "Scope: global or project", "global")
    .action(async (opts: any) => {
      const scope = opts.scope as "global" | "project";
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

      if (opts.fromSession) {
        if (!opts.name) {
          console.error(chalk.red("--name required with --from-session"));
          process.exit(1);
        }
        const ark = await getArkClient();
        const { session } = await ark.sessionRead(opts.fromSession);
        if (!session) {
          console.error(chalk.red(`Session not found: ${opts.fromSession}`));
          process.exit(1);
        }
        const recipe = core.sessionToRecipe(session, opts.name);
        app.recipes.save(recipe.name, recipe, scope, projectRoot);
        console.log(chalk.green(`Created recipe: ${opts.name} from session ${opts.fromSession} (${scope})`));
        return;
      }

      if (opts.from) {
        let content: string;
        try {
          content = readFileSync(opts.from, "utf-8");
        } catch {
          console.error(chalk.red(`Cannot read file: ${opts.from}`));
          process.exit(1);
        }
        const recipe = YAML.parse(content);
        if (!recipe.name) {
          console.error(chalk.red("YAML must have a 'name' field"));
          process.exit(1);
        }
        app.recipes.save(recipe.name, recipe, scope, projectRoot);
        console.log(chalk.green(`Created recipe: ${recipe.name} (${scope})`));
        return;
      }

      console.error(chalk.red("Must specify --from <file> or --from-session <id>"));
      process.exit(1);
    });

  recipeCmd
    .command("delete")
    .description("Delete a recipe (global or project only)")
    .argument("<name>", "Recipe name")
    .option("-s, --scope <scope>", "Scope: global or project", "global")
    .action((name: string, opts: any) => {
      const scope = opts.scope as "global" | "project";
      const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

      const recipe = app.recipes.get(name, projectRoot);
      if (recipe && recipe._source === "builtin") {
        console.error(chalk.red(`Cannot delete builtin recipe: ${name}`));
        process.exit(1);
      }
      if (!recipe) {
        console.error(chalk.red(`Recipe not found: ${name}`));
        process.exit(1);
      }

      app.recipes.delete(name, scope, projectRoot);
      console.log(chalk.green(`Deleted recipe: ${name}`));
    });
}
