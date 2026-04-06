import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import { ErrorCodes } from "../../protocol/types.js";
import type {
  AgentReadParams,
  FlowReadParams,
  SkillReadParams,
  RecipeReadParams,
  RecipeUseParams,
  ComputeNameParams,
  ComputeUpdateParams,
  GroupCreateParams,
  GroupDeleteParams,
} from "../../types/index.js";

export function registerResourceHandlers(router: Router, app: AppContext): void {
  router.handle("agent/list", async () => ({ agents: core.listAgents() }));
  router.handle("agent/read", async (p) => {
    const { name } = extract<AgentReadParams>(p, ["name"]);
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
    const agent = core.loadAgent(name, projectRoot);
    if (!agent) throw new Error(`Agent '${name}' not found`);
    return { agent };
  });
  router.handle("flow/list", async () => ({ flows: core.listFlows() }));
  router.handle("flow/read", async (p) => {
    const { name } = extract<FlowReadParams>(p, ["name"]);
    const flow = core.loadFlow(name);
    if (!flow) throw new Error(`Flow '${name}' not found`);
    return { flow };
  });
  router.handle("skill/list", async () => ({ skills: core.listSkills() }));
  router.handle("skill/read", async (p) => {
    const { name } = extract<SkillReadParams>(p, ["name"]);
    return { skill: core.loadSkill(name) };
  });
  router.handle("recipe/list", async () => ({ recipes: core.listRecipes() }));
  router.handle("recipe/read", async (p) => {
    const { name } = extract<RecipeReadParams>(p, ["name"]);
    const recipe = core.loadRecipe(name);
    if (!recipe) throw new Error(`Recipe '${name}' not found`);
    return { recipe };
  });

  router.handle("recipe/use", async (p) => {
    const { name, variables } = extract<RecipeUseParams>(p, ["name"]);
    const recipe = core.loadRecipe(name);
    if (!recipe) throw new Error(`Recipe '${name}' not found`);
    const instance = core.instantiateRecipe(recipe, (variables ?? {}) as Record<string, string>);
    const session = core.startSession(instance);
    return { session };
  });
  router.handle("compute/list", async () => ({ targets: core.listCompute() }));
  router.handle("compute/create", async (p) => {
    const compute = core.createCompute(p as any);
    return { compute };
  });
  router.handle("compute/delete", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    core.deleteCompute(name);
    return { ok: true };
  });
  router.handle("compute/update", async (p) => {
    const { name, fields } = extract<ComputeUpdateParams>(p, ["name", "fields"]);
    core.updateCompute(name, fields as Record<string, unknown>);
    return { ok: true };
  });
  router.handle("compute/read", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw Object.assign(new Error("Compute not found"), { code: ErrorCodes.SESSION_NOT_FOUND });
    return { compute };
  });
  router.handle("compute/provision", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    core.updateCompute(compute.name, { status: "provisioning" });
    await provider.provision(compute);
    core.updateCompute(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/stop-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    try {
      await provider.stop(compute);
      core.updateCompute(compute.name, { status: "stopped" });
    } catch (e: any) {
      if (provider.checkStatus) {
        const real = await provider.checkStatus(compute).catch(() => null);
        if (real === "destroyed" || real === "terminated") {
          core.updateCompute(compute.name, { status: "destroyed" });
          core.mergeComputeConfig(compute.name, { ip: null });
          return { ok: true, status: "destroyed" };
        }
      }
      throw e;
    }
    return { ok: true };
  });
  router.handle("compute/start-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await provider.start(compute);
    core.updateCompute(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/destroy", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await provider.destroy(compute);
    core.updateCompute(compute.name, { status: "destroyed" });
    return { ok: true };
  });
  router.handle("compute/clean", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const { listArkSessionsAsync, killSessionAsync } = await import("../../core/tmux.js");
    const tmuxSessions = await listArkSessionsAsync();
    let cleaned = 0;
    for (const ts of tmuxSessions) {
      const sessionId = ts.name.replace("ark-", "");
      const dbSession = core.getSession(sessionId);
      if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
        await killSessionAsync(ts.name);
        if (dbSession) core.updateSession(dbSession.id, { session_id: null });
        cleaned++;
      }
    }
    return { ok: true, cleaned };
  });
  router.handle("compute/reboot", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider?.reboot) throw new Error("Provider does not support reboot");
    await provider.reboot(compute);
    return { ok: true };
  });
  router.handle("compute/ping", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = core.getCompute(name);
    if (!compute) throw new Error("Compute not found");
    const cfg = compute.config as any;
    const ip = cfg?.ip;
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
          core.updateCompute(compute.name, { status: real });
        }
        return { reachable: false, message: `Unreachable — AWS status: ${real ?? "unknown"}` };
      }
      return { reachable: false, message: "Unreachable — SSH connection failed" };
    } catch {
      return { reachable: false, message: "Unreachable — SSH connection failed" };
    }
  });
  router.handle("compute/clean-zombies", async () => {
    const { listArkSessionsAsync, killSessionAsync } = await import("../../core/tmux.js");
    const tmuxSessions = await listArkSessionsAsync();
    let cleaned = 0;
    for (const ts of tmuxSessions) {
      const sessionId = ts.name.replace("ark-", "");
      const dbSession = core.getSession(sessionId);
      if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
        await killSessionAsync(ts.name);
        if (dbSession) core.updateSession(dbSession.id, { session_id: null });
        cleaned++;
      }
    }
    return { cleaned };
  });
  router.handle("group/list", async () => ({ groups: core.getGroups() }));
  router.handle("group/create", async (p) => {
    const { name } = extract<GroupCreateParams>(p, ["name"]);
    const group = core.createGroup(name);
    return { group };
  });
  router.handle("group/delete", async (p) => {
    const { name } = extract<GroupDeleteParams>(p, ["name"]);
    core.deleteGroup(name);
    return { ok: true };
  });
}
