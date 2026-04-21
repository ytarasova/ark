/**
 * Seed builtin resources into the hosted DB on first boot.
 *
 * Local mode uses file-backed stores that read YAMLs from `resolveStoreBaseDir()`
 * on every list/get. Hosted mode swaps in `DbResourceStore`, which reads from the
 * `resource_definitions` table -- a table that starts empty on a fresh install.
 *
 * Without this seeder the hosted control plane boots with zero agents / flows /
 * skills / recipes / runtimes, and `agent/list` + friends all return []. That
 * makes it impossible to dispatch a session because the picker has nothing to
 * choose from.
 *
 * This function is idempotent: it only inserts a builtin resource if there is
 * no existing row for that name + kind under the `default` tenant. Ops can
 * therefore override a builtin by writing their own row -- restarts will not
 * stomp the override.
 *
 * Callers (`app.ts:boot`) guard this behind `isHosted` themselves; this module
 * assumes it has been called with a hosted-mode AppContext.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { AppContext } from "../app.js";
import { resolveStoreBaseDir } from "../install-paths.js";
import { logInfo, logWarn } from "../observability/structured-log.js";

type Kind = "flow" | "agent" | "skill" | "recipe" | "runtime";

interface KindSpec {
  kind: Kind;
  /** Subdirectory under `resolveStoreBaseDir()` holding the YAMLs. */
  subdir: string;
  /** Accessor on AppContext that returns the store (DB-backed in hosted mode). */
  pick: (app: AppContext) => { get: (name: string) => unknown; save: (name: string, data: any) => unknown };
}

const SPECS: KindSpec[] = [
  { kind: "flow", subdir: join("flows", "definitions"), pick: (a) => a.flows as any },
  { kind: "agent", subdir: "agents", pick: (a) => a.agents as any },
  { kind: "skill", subdir: "skills", pick: (a) => a.skills as any },
  { kind: "recipe", subdir: "recipes", pick: (a) => a.recipes as any },
  { kind: "runtime", subdir: "runtimes", pick: (a) => a.runtimes as any },
];

/**
 * Seed every kind of builtin resource into the DB. Idempotent.
 *
 * Returns void; a summary line is logged at info level.
 */
export async function seedBuiltinResources(app: AppContext): Promise<void> {
  const base = resolveStoreBaseDir();
  const counts: Record<Kind, number> = { flow: 0, agent: 0, skill: 0, recipe: 0, runtime: 0 };
  let total = 0;

  for (const spec of SPECS) {
    const dir = join(base, spec.subdir);
    if (!existsSync(dir)) {
      logWarn("general", `seedBuiltins: ${spec.kind} dir missing`, { dir });
      continue;
    }

    const store = spec.pick(app);
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of files) {
      const path = join(dir, file);
      let parsed: Record<string, unknown> | null = null;
      try {
        const raw = readFileSync(path, "utf-8");
        parsed = YAML.parse(raw) as Record<string, unknown> | null;
      } catch (err) {
        logWarn("general", `seedBuiltins: skipped (YAML parse error)`, {
          kind: spec.kind,
          file,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!parsed || typeof parsed !== "object") {
        logWarn("general", `seedBuiltins: skipped (empty or non-object YAML)`, { kind: spec.kind, file });
        continue;
      }

      const name = (parsed.name as string) ?? file.replace(/\.ya?ml$/, "");
      if (!name) {
        logWarn("general", `seedBuiltins: skipped (no name)`, { kind: spec.kind, file });
        continue;
      }

      // Idempotency guard: leave user-authored rows alone.
      const existing = await store.get(name);
      if (existing) continue;

      await store.save(name, { ...parsed, name });
      counts[spec.kind]++;
      total++;
    }
  }

  logInfo(
    "general",
    `seeded ${total} builtin resources: flows=${counts.flow}, agents=${counts.agent}, skills=${counts.skill}, recipes=${counts.recipe}, runtimes=${counts.runtime}`,
  );
}
