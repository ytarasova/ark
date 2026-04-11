import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { findProjectRoot } from "../../core/agent/agent.js";
import { instantiateRecipe } from "../../core/agent/recipe.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type {
  AgentReadParams,
  FlowReadParams,
  SkillReadParams,
  RecipeReadParams,
  RecipeUseParams,
  RuntimeReadParams,
  ComputeNameParams,
  ComputeUpdateParams,
  GroupCreateParams,
  GroupDeleteParams,
} from "../../types/index.js";

/** Kill tmux sessions for zombie ark sessions (no DB record or terminal status). */
async function cleanZombieSessions(app: AppContext): Promise<number> {
  const { listArkSessionsAsync, killSessionAsync } = await import("../../core/infra/tmux.js");
  const tmuxSessions = await listArkSessionsAsync();
  let cleaned = 0;
  for (const ts of tmuxSessions) {
    const sessionId = ts.name.replace("ark-", "");
    const dbSession = app.sessions.get(sessionId);
    if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
      await killSessionAsync(ts.name);
      if (dbSession) app.sessions.update(dbSession.id, { session_id: null });
      cleaned++;
    }
  }
  return cleaned;
}

export function registerResourceHandlers(router: Router, app: AppContext): void {
  router.handle("agent/list", async () => ({ agents: app.agents.list() }));
  router.handle("agent/read", async (p) => {
    const { name } = extract<AgentReadParams>(p, ["name"]);
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const agent = app.agents.get(name, projectRoot);
    if (!agent) throw new Error(`Agent '${name}' not found`);
    return { agent };
  });
  router.handle("flow/list", async () => ({ flows: app.flows.list() }));
  router.handle("flow/read", async (p) => {
    const { name } = extract<FlowReadParams>(p, ["name"]);
    const flow = app.flows.get(name);
    if (!flow) throw new Error(`Flow '${name}' not found`);
    return { flow };
  });
  router.handle("skill/list", async () => ({ skills: app.skills.list() }));
  router.handle("skill/read", async (p) => {
    const { name } = extract<SkillReadParams>(p, ["name"]);
    return { skill: app.skills.get(name) };
  });
  router.handle("runtime/list", async () => ({ runtimes: app.runtimes.list() }));
  router.handle("runtime/read", async (p) => {
    const { name } = extract<RuntimeReadParams>(p, ["name"]);
    const runtime = app.runtimes.get(name);
    if (!runtime) throw new Error(`Runtime '${name}' not found`);
    return { runtime };
  });
  router.handle("recipe/list", async () => ({ recipes: app.recipes.list() }));
  router.handle("recipe/read", async (p) => {
    const { name } = extract<RecipeReadParams>(p, ["name"]);
    const recipe = app.recipes.get(name);
    if (!recipe) throw new Error(`Recipe '${name}' not found`);
    return { recipe };
  });

  router.handle("recipe/use", async (p) => {
    const { name, variables } = extract<RecipeUseParams>(p, ["name"]);
    const recipe = app.recipes.get(name);
    if (!recipe) throw new Error(`Recipe '${name}' not found`);
    const instance = instantiateRecipe(recipe, (variables ?? {}) as Record<string, string>);
    const session = app.sessionService.start(instance);
    return { session };
  });
  router.handle("compute/list", async () => ({ targets: app.computes.list() }));
  router.handle("compute/create", async (p) => {
    const { name, provider, config } = extract<{ name: string; provider?: import("../../types/index.js").ComputeProviderName; config?: Partial<import("../../types/index.js").ComputeConfig> }>(p, ["name"]);
    const compute = app.computes.create({ name, provider, config });
    return { compute };
  });
  router.handle("compute/delete", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    app.computes.delete(name);
    return { ok: true };
  });
  router.handle("compute/update", async (p) => {
    const { name, fields } = extract<ComputeUpdateParams>(p, ["name", "fields"]);
    app.computes.update(name, fields as Record<string, unknown>);
    return { ok: true };
  });
  router.handle("compute/read", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new RpcError("Compute not found", ErrorCodes.SESSION_NOT_FOUND);
    return { compute };
  });
  router.handle("compute/provision", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    app.computes.update(compute.name, { status: "provisioning" });
    await provider.provision(compute);
    app.computes.update(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/stop-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    try {
      await provider.stop(compute);
      app.computes.update(compute.name, { status: "stopped" });
    } catch (e: any) {
      if (provider.checkStatus) {
        const real = await provider.checkStatus(compute).catch(() => null);
        if (real === "destroyed" || real === "terminated") {
          app.computes.update(compute.name, { status: "destroyed" });
          app.computes.mergeConfig(compute.name, { ip: null });
          return { ok: true, status: "destroyed" };
        }
      }
      throw e;
    }
    return { ok: true };
  });
  router.handle("compute/start-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await provider.start(compute);
    app.computes.update(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/destroy", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await provider.destroy(compute);
    app.computes.update(compute.name, { status: "destroyed" });
    return { ok: true };
  });
  router.handle("compute/clean", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const cleaned = await cleanZombieSessions(app);
    return { ok: true, cleaned };
  });
  router.handle("compute/reboot", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider?.reboot) throw new Error("Provider does not support reboot");
    await provider.reboot(compute);
    return { ok: true };
  });
  router.handle("compute/ping", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const cfg = compute.config as Record<string, unknown>;
    const ip = cfg?.ip as string | undefined;
    if (!ip) return { reachable: false, message: "No IP configured" };
    try {
      const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
      const { exitCode, stdout } = await sshExecAsync(sshKeyPath(compute.name), ip, "echo ok && uptime", { timeout: 10_000 });
      if (exitCode === 0) {
        return { reachable: true, message: stdout.trim() };
      }
      // Check AWS status if SSH fails
      const { getProvider } = await import("../../compute/index.js");
      const provider = getProvider(compute.provider);
      if (provider?.checkStatus) {
        const real = await provider.checkStatus(compute).catch(() => null);
        if (real && real !== compute.status) {
          app.computes.update(compute.name, { status: real });
        }
        return { reachable: false, message: `Unreachable — AWS status: ${real ?? "unknown"}` };
      }
      return { reachable: false, message: "Unreachable — SSH connection failed" };
    } catch {
      return { reachable: false, message: "Unreachable — SSH connection failed" };
    }
  });
  router.handle("compute/clean-zombies", async () => {
    const cleaned = await cleanZombieSessions(app);
    return { cleaned };
  });
  // ── Compute templates ──────────────────────────────────────────────────
  router.handle("compute/template/list", async () => {
    const dbTemplates = app.computeTemplates.list();
    const configTemplates = app.config.computeTemplates ?? [];
    const dbNames = new Set(dbTemplates.map(t => t.name));
    const merged = [
      ...dbTemplates,
      ...configTemplates.filter(t => !dbNames.has(t.name)).map(t => ({
        name: t.name,
        description: t.description,
        provider: t.provider,
        config: t.config,
      })),
    ];
    return { templates: merged };
  });
  router.handle("compute/template/get", async (p) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    let tmpl = app.computeTemplates.get(name);
    if (!tmpl) {
      const cfgTmpl = (app.config.computeTemplates ?? []).find(t => t.name === name);
      if (cfgTmpl) {
        tmpl = { name: cfgTmpl.name, description: cfgTmpl.description, provider: cfgTmpl.provider as any, config: cfgTmpl.config };
      }
    }
    return tmpl ?? null;
  });
  router.handle("compute/template/create", async (p) => {
    const { name, provider, config, description } = extract<{ name: string; provider: string; config?: Record<string, unknown>; description?: string }>(p, ["name", "provider"]);
    app.computeTemplates.create({ name, description, provider: provider as any, config: config ?? {} });
    return { ok: true };
  });
  router.handle("compute/template/delete", async (p) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    app.computeTemplates.delete(name);
    return { ok: true };
  });

  router.handle("group/list", async () => ({ groups: app.sessions.getGroups() }));
  router.handle("group/create", async (p) => {
    const { name } = extract<GroupCreateParams>(p, ["name"]);
    app.sessions.createGroup(name);
    return { group: { name } };
  });
  router.handle("group/delete", async (p) => {
    const { name } = extract<GroupDeleteParams>(p, ["name"]);
    app.sessions.deleteGroup(name);
    return { ok: true };
  });
}
