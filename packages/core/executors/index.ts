/**
 * Executor barrel + discovery.
 *
 * Single source of truth for which executors ship with Ark. Adding a new
 * built-in executor means: (1) write the module, (2) import it here, (3) add
 * it to `builtinExecutors`. App boot loops this array -- no N-way hardcoded
 * imports scattered through app.ts.
 *
 * External plugins: a user can drop a compiled JS module at
 * `~/.ark/plugins/executors/<name>.js` that default-exports an Executor.
 * `loadPluginExecutors()` discovers them at boot via dynamic import.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";

import type { Executor } from "../executor.js";

import { claudeCodeExecutor } from "./claude-code.js";
import { subprocessExecutor } from "./subprocess.js";
import { cliAgentExecutor } from "./cli-agent.js";
import { gooseExecutor } from "./goose.js";

export { claudeCodeExecutor, subprocessExecutor, cliAgentExecutor, gooseExecutor };

/** Built-in executors shipped with every Ark bundle. */
export const builtinExecutors: Executor[] = [
  claudeCodeExecutor,
  subprocessExecutor,
  cliAgentExecutor,
  gooseExecutor,
];

/**
 * Discover and load user-provided executor plugins from
 * `<arkDir>/plugins/executors/*.js`. Each plugin module must default-export
 * (or export a named `executor`) an object conforming to the `Executor`
 * interface. Returns the loaded executors; logs and skips any that fail.
 *
 * Plugin loading is best-effort: an error in one plugin never blocks boot.
 */
export async function loadPluginExecutors(
  arkDir: string,
  onLog?: (msg: string) => void,
): Promise<Executor[]> {
  const log = onLog ?? (() => {});
  const pluginDir = join(arkDir, "plugins", "executors");
  if (!existsSync(pluginDir)) return [];

  const loaded: Executor[] = [];
  for (const file of readdirSync(pluginDir)) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const path = join(pluginDir, file);
    try {
      const mod = await import(path);
      const exec = (mod.default ?? mod.executor) as Executor | undefined;
      if (!exec || typeof exec.launch !== "function") {
        log(`plugin ${file}: default export is not an Executor, skipping`);
        continue;
      }
      loaded.push(exec);
      log(`plugin ${file}: loaded executor '${exec.name}'`);
    } catch (e: any) {
      log(`plugin ${file}: failed to load (${e?.message ?? e})`);
    }
  }
  return loaded;
}
