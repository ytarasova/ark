import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerResourceHandlers(router: Router): void {
  router.handle("agent/list", async () => ({ agents: core.listAgents() }));
  router.handle("flow/list", async () => ({ flows: core.listFlows() }));
  router.handle("skill/list", async () => ({ skills: core.listSkills() }));
  router.handle("skill/read", async (p) => ({ skill: core.loadSkill(p.name as string) }));
  router.handle("recipe/list", async () => ({ recipes: core.listRecipes() }));
  router.handle("recipe/use", async (p) => {
    const recipe = core.loadRecipe(p.name as string);
    if (!recipe) throw new Error(`Recipe '${p.name}' not found`);
    const instance = core.instantiateRecipe(recipe, (p.variables ?? {}) as Record<string, string>);
    const session = core.startSession(instance);
    return { session };
  });
  router.handle("compute/list", async () => ({ targets: core.listCompute() }));
  router.handle("compute/create", async (p) => {
    const compute = core.createCompute(p as any);
    return { compute };
  });
  router.handle("compute/delete", async (p) => {
    core.deleteCompute(p.name as string);
    return { ok: true };
  });
  router.handle("group/list", async () => ({ groups: core.getGroups() }));
  router.handle("group/create", async (p) => {
    const group = core.createGroup(p.name as string);
    return { group };
  });
  router.handle("group/delete", async (p) => {
    core.deleteGroup(p.name as string);
    return { ok: true };
  });
}
