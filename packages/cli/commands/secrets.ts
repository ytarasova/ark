/**
 * CLI commands for tenant-scoped secrets management.
 *
 *   ark secrets list
 *   ark secrets set <NAME>              # reads value from stdin if piped,
 *                                       # otherwise prompts with masked input
 *   ark secrets delete <NAME> [--yes]   # --yes skips the confirm prompt
 *   ark secrets get <NAME> [--print]    # refuses to print to a TTY without --print
 *
 * All subcommands dispatch via ArkClient against secret/*. Tenant resolution
 * lives server-side: the `--tenant` flag is still accepted for explicit
 * override, but defaulting falls back to the server's auth context.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getArkClient } from "../app-client.js";
import { runAction } from "./_shared.js";

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
        if (ch === "") {
          // Ctrl-C -- bail with a non-zero exit so shell scripts notice.
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
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

export function registerSecretsCommands(program: Command): void {
  const group = program.command("secrets").description("Manage tenant-scoped secrets (env vars for sessions)");

  group
    .command("list")
    .description("List secret names (values are never returned)")
    .action(async () => {
      await runAction("secrets list", async () => {
        const ark = await getArkClient();
        const refs = await ark.secretList();
        if (refs.length === 0) {
          console.log(chalk.dim("No secrets configured."));
          return;
        }
        console.log(`  ${"NAME".padEnd(32)} ${"UPDATED".padEnd(22)} DESCRIPTION`);
        for (const r of refs) {
          const desc = r.description ?? "";
          console.log(`  ${r.name.padEnd(32)} ${(r.updated_at ?? "").padEnd(22)} ${desc}`);
        }
      });
    });

  group
    .command("set")
    .description("Create or replace a secret. Reads value from stdin if piped, otherwise prompts.")
    .argument("<name>", "Secret name (ASCII [A-Z0-9_]+)")
    .option("-d, --description <text>", "Human-readable description")
    .action(async (name: string, opts) => {
      await runAction("secrets set", async () => {
        const ark = await getArkClient();
        let value: string;
        if (!process.stdin.isTTY) {
          value = (await readStdin()).replace(/\r?\n$/, "");
        } else {
          value = await promptMasked(`Value for ${name}: `);
        }
        if (value.length === 0) {
          console.error(chalk.red("Refusing to store an empty secret value."));
          process.exitCode = 2;
          return;
        }
        await ark.secretSet(name, value, opts.description);
        console.log(chalk.green(`Secret '${name}' stored.`));
      });
    });

  group
    .command("delete")
    .description("Delete a secret.")
    .argument("<name>", "Secret name")
    .option("-y, --yes", "Skip the confirm prompt")
    .action(async (name: string, opts) => {
      await runAction("secrets delete", async () => {
        if (!opts.yes) {
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Delete secret '${name}'? [y/N] `, (a) => {
              rl.close();
              resolve(a.trim().toLowerCase());
            });
          });
          if (answer !== "y" && answer !== "yes") {
            console.log("Aborted.");
            return;
          }
        }
        const ark = await getArkClient();
        const removed = await ark.secretDelete(name);
        if (removed) {
          console.log(chalk.green(`Deleted secret '${name}'.`));
        } else {
          console.log(chalk.yellow(`No secret '${name}' (idempotent).`));
        }
      });
    });

  // ── Blob (multi-file) subcommands ────────────────────────────────────
  //
  // A blob is a named bag of files, uploaded from a directory on disk.
  // Used today for claude subscription credentials (`~/.claude/`) where
  // the "secret" is really a small directory, not a single string.

  const blob = group.command("blob").description("Manage multi-file secret blobs (directory-shaped secrets)");

  blob
    .command("list")
    .description("List blob names (contents are never returned)")
    .action(async () => {
      await runAction("secrets blob list", async () => {
        const ark = await getArkClient();
        const names = await ark.secretBlobList();
        if (names.length === 0) {
          console.log(chalk.dim("No blob secrets configured."));
          return;
        }
        for (const n of names) console.log(`  ${n}`);
      });
    });

  blob
    .command("upload")
    .description("Upload a directory as a named blob. Reads every file in <dir> (non-recursive).")
    .argument("<name>", "Blob name (lowercase kebab-case, <=63 chars)")
    .argument("<dir>", "Directory to upload")
    .action(async (name: string, dir: string) => {
      await runAction("secrets blob upload", async () => {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          console.error(chalk.red(`'${dir}' is not a directory`));
          process.exitCode = 2;
          return;
        }
        const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
        if (entries.length === 0) {
          console.error(chalk.red(`Directory '${dir}' has no files`));
          process.exitCode = 2;
          return;
        }
        const files: Record<string, string> = {};
        for (const entry of entries) {
          const buf = readFileSync(join(dir, entry.name));
          files[entry.name] = buf.toString("base64");
        }
        const ark = await getArkClient();
        await ark.secretBlobSet(name, files, { encoding: "base64" });
        console.log(chalk.green(`Blob '${name}' uploaded (${entries.length} file${entries.length === 1 ? "" : "s"}).`));
      });
    });

  blob
    .command("download")
    .description("Download a blob into a directory. Creates the directory if missing.")
    .argument("<name>", "Blob name")
    .argument("<dir>", "Target directory")
    .action(async (name: string, dir: string) => {
      await runAction("secrets blob download", async () => {
        const ark = await getArkClient();
        const blobData = await ark.secretBlobGet(name);
        if (!blobData) {
          console.error(chalk.red(`Blob '${name}' not found`));
          process.exitCode = 1;
          return;
        }
        mkdirSync(dir, { recursive: true });
        const files = Object.keys(blobData.files);
        for (const filename of files) {
          const bytes = Buffer.from(blobData.files[filename], "base64");
          writeFileSync(join(dir, filename), bytes, { mode: 0o600 });
        }
        console.log(
          chalk.green(`Blob '${name}' written to ${dir} (${files.length} file${files.length === 1 ? "" : "s"}).`),
        );
      });
    });

  blob
    .command("delete")
    .description("Delete a blob.")
    .argument("<name>", "Blob name")
    .option("-y, --yes", "Skip the confirm prompt")
    .action(async (name: string, opts) => {
      await runAction("secrets blob delete", async () => {
        if (!opts.yes) {
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Delete blob '${name}'? [y/N] `, (a) => {
              rl.close();
              resolve(a.trim().toLowerCase());
            });
          });
          if (answer !== "y" && answer !== "yes") {
            console.log("Aborted.");
            return;
          }
        }
        const ark = await getArkClient();
        const removed = await ark.secretBlobDelete(name);
        if (removed) console.log(chalk.green(`Deleted blob '${name}'.`));
        else console.log(chalk.yellow(`No blob '${name}' (idempotent).`));
      });
    });

  group
    .command("get")
    .description("Print a secret value to stdout. Refuses TTY stdout without --print.")
    .argument("<name>", "Secret name")
    .option("--print", "Allow printing to a TTY (default: refuse to prevent shoulder surfing)")
    .action(async (name: string, opts) => {
      await runAction("secrets get", async () => {
        if (process.stdout.isTTY && !opts.print) {
          console.error(
            chalk.red(
              "Refusing to print a secret to a TTY. Re-run with --print, or pipe the output (e.g. `ark secrets get FOO | pbcopy`).",
            ),
          );
          process.exitCode = 2;
          return;
        }
        const ark = await getArkClient();
        const value = await ark.secretGet(name);
        if (value === null) {
          console.error(chalk.red(`Secret '${name}' not found.`));
          process.exitCode = 1;
          return;
        }
        // Use process.stdout.write so there's no trailing newline that would
        // pollute a shell-substitution consumer ($(ark secrets get FOO)).
        process.stdout.write(value);
        if (process.stdout.isTTY) process.stdout.write("\n");
      });
    });
}
