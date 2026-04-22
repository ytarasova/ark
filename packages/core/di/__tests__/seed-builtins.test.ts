/**
 * Tests for the hosted-mode builtin seeder.
 *
 * We avoid standing up a full hosted AppContext (the hosted AppMode pins the
 * migration runner to postgres and we want this test to run against an
 * in-memory sqlite). Instead, we wire a minimal harness:
 *   - a sqlite-backed DatabaseAdapter with the `resource_definitions` table created
 *     directly via `initResourceDefinitionsTable()`,
 *   - a handful of real `DbResourceStore` instances (one per kind),
 *   - a thin object that quacks like AppContext to the seeder.
 * That's enough to drive the function end-to-end against real SQL.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";

import { BunSqliteAdapter } from "../../database/sqlite.js";
import { DbResourceStore, initResourceDefinitionsTable } from "../../stores/db-resource-store.js";
import type { AppContext } from "../../app.js";
import { resolveStoreBaseDir } from "../../install-paths.js";
import { seedBuiltinResources } from "../seed-builtins.js";

// ── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
  app: AppContext;
  db: BunSqliteAdapter;
  flows: DbResourceStore<any>;
  agents: DbResourceStore<any>;
  skills: DbResourceStore<any>;
  recipes: DbResourceStore<any>;
  runtimes: DbResourceStore<any>;
}

async function makeHarness(): Promise<Harness> {
  const raw = new Database(":memory:");
  const db = new BunSqliteAdapter(raw);
  await initResourceDefinitionsTable(db);

  const flows = new DbResourceStore<any>(db, "flow", { stages: [] });
  const agents = new DbResourceStore<any>(db, "agent", {
    description: "",
    model: "sonnet",
    max_turns: 200,
    system_prompt: "",
    tools: [],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "bypassPermissions",
    env: {},
  });
  const skills = new DbResourceStore<any>(db, "skill", { description: "", content: "" });
  const recipes = new DbResourceStore<any>(db, "recipe", { description: "", flow: "default" });
  const runtimes = new DbResourceStore<any>(db, "runtime", { description: "", type: "cli-agent", command: [] });

  const app = { flows, agents, skills, recipes, runtimes } as unknown as AppContext;
  return { app, db, flows, agents, skills, recipes, runtimes };
}

let harness: Harness | null = null;

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(() => {
  try {
    harness?.db.close();
  } catch {
    /* best effort */
  }
  harness = null;
});

function countBuiltins(): { flow: number; agent: number; skill: number; recipe: number; runtime: number } {
  const base = resolveStoreBaseDir();
  const count = (sub: string) => {
    const dir = join(base, sub);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).length;
  };
  return {
    flow: count(join("flows", "definitions")),
    agent: count("agents"),
    skill: count("skills"),
    recipe: count("recipes"),
    runtime: count("runtimes"),
  };
}

async function dbCount(h: Harness, kind: string): Promise<number> {
  const row = (await h.db
    .prepare("SELECT COUNT(*) AS c FROM resource_definitions WHERE kind = ? AND tenant_id = 'default'")
    .get(kind)) as { c: number };
  return row.c;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("seedBuiltinResources", () => {
  it("seeds rows for every kind with counts matching the on-disk files", async () => {
    const h = harness!;
    const expected = countBuiltins();

    await seedBuiltinResources(h.app);

    expect(await dbCount(h, "flow")).toBe(expected.flow);
    expect(await dbCount(h, "agent")).toBe(expected.agent);
    expect(await dbCount(h, "skill")).toBe(expected.skill);
    expect(await dbCount(h, "recipe")).toBe(expected.recipe);
    expect(await dbCount(h, "runtime")).toBe(expected.runtime);
  });

  it("is idempotent -- running again does not duplicate or throw", async () => {
    const h = harness!;
    await seedBuiltinResources(h.app);
    const before = {
      flow: await dbCount(h, "flow"),
      agent: await dbCount(h, "agent"),
      skill: await dbCount(h, "skill"),
      recipe: await dbCount(h, "recipe"),
      runtime: await dbCount(h, "runtime"),
    };

    await seedBuiltinResources(h.app);
    await seedBuiltinResources(h.app);

    expect(await dbCount(h, "flow")).toBe(before.flow);
    expect(await dbCount(h, "agent")).toBe(before.agent);
    expect(await dbCount(h, "skill")).toBe(before.skill);
    expect(await dbCount(h, "recipe")).toBe(before.recipe);
    expect(await dbCount(h, "runtime")).toBe(before.runtime);
  });

  it("does not overwrite a user-authored row for the same name", async () => {
    const h = harness!;

    // Plant a sentinel user row BEFORE seeding. The seeder must leave it alone.
    await h.flows.save("default", {
      name: "default",
      description: "USER OVERRIDE",
      stages: [{ name: "user-stage" }],
    });

    await seedBuiltinResources(h.app);

    const after = (await h.flows.get("default")) as any;
    expect(after.description).toBe("USER OVERRIDE");
    expect(after.stages?.[0]?.name).toBe("user-stage");

    // Other builtin flows should still have landed.
    const otherRow = (await h.db
      .prepare(
        "SELECT COUNT(*) AS c FROM resource_definitions WHERE kind='flow' AND tenant_id='default' AND name != 'default'",
      )
      .get()) as { c: number };
    expect(otherRow.c).toBeGreaterThan(0);
  });

  it("skips malformed YAML files without breaking the rest of the run", async () => {
    const h = harness!;

    // Plant a broken YAML in the real agents dir (source tree is writable in
    // dev mode). In a compiled-install checkout it may be read-only; in that
    // case we just assert the seeder still doesn't throw end-to-end.
    const base = resolveStoreBaseDir();
    const agentsDir = join(base, "agents");
    const bogus = join(agentsDir, "__seed_test_broken__.yaml");
    let plantedBroken = false;
    try {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(bogus, "this: is: not: valid: yaml: [{[\n");
      plantedBroken = true;
    } catch {
      /* read-only install prefix -- skip the inject portion */
    }

    try {
      await expect(seedBuiltinResources(h.app)).resolves.toBeUndefined();

      if (plantedBroken) {
        const row = (await h.db
          .prepare("SELECT name FROM resource_definitions WHERE kind='agent' AND tenant_id='default' AND name = ?")
          .get("__seed_test_broken__")) as { name: string } | undefined;
        expect(row).toBeUndefined();
      }

      // Valid builtin agents should still have landed.
      expect(await dbCount(h, "agent")).toBeGreaterThan(0);
    } finally {
      if (plantedBroken) {
        try {
          unlinkSync(bogus);
        } catch {
          /* best effort */
        }
      }
    }
  });
});
