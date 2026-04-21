/**
 * CLI commands for tenant-scoped secrets management.
 *
 *   ark secrets list
 *   ark secrets set <NAME>              # reads value from stdin if piped,
 *                                       # otherwise prompts with masked input
 *   ark secrets delete <NAME> [--yes]   # --yes skips the confirm prompt
 *   ark secrets get <NAME> [--print]    # refuses to print to a TTY without --print
 *
 * Tenant resolution matches the rest of Ark: `--tenant` if set, else
 * `ARK_DEFAULT_TENANT`, else "default".
 */

import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import type { AppContext } from "../../core/app.js";
import { assertValidSecretName } from "../../core/secrets/types.js";

function resolveTenant(app: AppContext, opts: { tenant?: string }): string {
  return opts.tenant ?? process.env.ARK_DEFAULT_TENANT ?? app.config.authSection?.defaultTenant ?? "default";
}

/** Read the entire stdin to a string. Used when the caller pipes a value in. */
async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

/**
 * Prompt the user for a secret value. Masks each keystroke with "*" on a
 * TTY. Falls back to plain readline when stdin isn't a TTY (shouldn't
 * happen -- the caller is supposed to pipe in that case -- but we cover it).
 */
async function promptMasked(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    return await new Promise<string>((resolve) =>
      rl.question(prompt, (ans) => {
        rl.close();
        resolve(ans);
      }),
    );
  }
  stdout.write(prompt);
  return await new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "") {
          // Ctrl-C -- bail with a non-zero exit so shell scripts notice.
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        buf += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

export function registerSecretsCommands(program: Command, app: AppContext): void {
  const group = program.command("secrets").description("Manage tenant-scoped secrets (env vars for sessions)");

  group
    .command("list")
    .description("List secret names (values are never returned)")
    .option("--tenant <id>", "Override the tenant id (default: ARK_DEFAULT_TENANT or 'default')")
    .action(async (opts) => {
      try {
        const tenantId = resolveTenant(app, opts);
        const refs = await app.secrets.list(tenantId);
        if (refs.length === 0) {
          console.log(chalk.dim(`No secrets configured for tenant '${tenantId}'.`));
          return;
        }
        console.log(`  ${"NAME".padEnd(32)} ${"UPDATED".padEnd(22)} DESCRIPTION`);
        for (const r of refs) {
          const desc = r.description ?? "";
          console.log(`  ${r.name.padEnd(32)} ${(r.updated_at ?? "").padEnd(22)} ${desc}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });

  group
    .command("set")
    .description("Create or replace a secret. Reads value from stdin if piped, otherwise prompts.")
    .argument("<name>", "Secret name (ASCII [A-Z0-9_]+)")
    .option("-d, --description <text>", "Human-readable description")
    .option("--tenant <id>", "Override the tenant id")
    .action(async (name: string, opts) => {
      try {
        assertValidSecretName(name);
        const tenantId = resolveTenant(app, opts);
        let value: string;
        if (!process.stdin.isTTY) {
          value = (await readStdin()).replace(/\r?\n$/, "");
        } else {
          value = await promptMasked(`Value for ${name}: `);
        }
        if (value.length === 0) {
          console.log(chalk.red("Refusing to store an empty secret value."));
          process.exitCode = 2;
          return;
        }
        await app.secrets.set(tenantId, name, value, { description: opts.description });
        console.log(chalk.green(`Secret '${name}' stored for tenant '${tenantId}'.`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });

  group
    .command("delete")
    .description("Delete a secret.")
    .argument("<name>", "Secret name")
    .option("-y, --yes", "Skip the confirm prompt")
    .option("--tenant <id>", "Override the tenant id")
    .action(async (name: string, opts) => {
      try {
        assertValidSecretName(name);
        const tenantId = resolveTenant(app, opts);
        if (!opts.yes) {
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Delete secret '${name}' for tenant '${tenantId}'? [y/N] `, (a) => {
              rl.close();
              resolve(a.trim().toLowerCase());
            });
          });
          if (answer !== "y" && answer !== "yes") {
            console.log("Aborted.");
            return;
          }
        }
        const removed = await app.secrets.delete(tenantId, name);
        if (removed) {
          console.log(chalk.green(`Deleted secret '${name}'.`));
        } else {
          console.log(chalk.yellow(`No secret '${name}' for tenant '${tenantId}' (idempotent).`));
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });

  group
    .command("get")
    .description("Print a secret value to stdout. Refuses TTY stdout without --print.")
    .argument("<name>", "Secret name")
    .option("--print", "Allow printing to a TTY (default: refuse to prevent shoulder surfing)")
    .option("--tenant <id>", "Override the tenant id")
    .action(async (name: string, opts) => {
      try {
        assertValidSecretName(name);
        if (process.stdout.isTTY && !opts.print) {
          console.log(
            chalk.red(
              "Refusing to print a secret to a TTY. Re-run with --print, or pipe the output (e.g. `ark secrets get FOO | pbcopy`).",
            ),
          );
          process.exitCode = 2;
          return;
        }
        const tenantId = resolveTenant(app, opts);
        const value = await app.secrets.get(tenantId, name);
        if (value === null) {
          console.log(chalk.red(`Secret '${name}' not found for tenant '${tenantId}'.`));
          process.exitCode = 1;
          return;
        }
        // Use process.stdout.write so there's no trailing newline that would
        // pollute a shell-substitution consumer ($(ark secrets get FOO)).
        process.stdout.write(value);
        if (process.stdout.isTTY) process.stdout.write("\n");
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });
}
