import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { findProjectRoot } from "../../core/agent/agent.js";
import { instantiateRecipe } from "../../core/agent/recipe.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type {
  AgentDefinition,
  AgentReadParams,
  FlowDefinition,
  FlowReadParams,
  SkillDefinition,
  SkillReadParams,
  RecipeReadParams,
  RecipeUseParams,
  RuntimeReadParams,
  ComputeNameParams,
  ComputeUpdateParams,
  GroupCreateParams,
  GroupDeleteParams,
  ComputeProviderName,
} from "../../types/index.js";

// FlowDefinition from `types/flow.ts` is the protocol shape; we only use it
// for the request body type below. The runtime FlowDefinition expected by
// app.flows.save() lives in core/state/flow.ts -- we cast across the boundary
// in flow/create where the two definitions meet.

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

  /**
   * Create or update an agent definition. Used by Web (`Create Agent` /
   * `Edit Agent` forms) and remote CLI clients. The handler intentionally
   * accepts a partial body and fills in safe defaults so callers don't have
   * to spell out every required field.
   */
  router.handle("agent/create", async (p) => {
    const params = extract<Partial<AgentDefinition> & { name: string; scope?: "global" | "project" }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const existing = app.agents.get(params.name, projectRoot);
    if (existing && existing._source !== "builtin") {
      throw new Error(`Agent '${params.name}' already exists. Use agent/update to modify it.`);
    }
    const agent: AgentDefinition = {
      name: params.name,
      description: rest.description ?? "",
      model: rest.model ?? "sonnet",
      max_turns: rest.max_turns ?? 200,
      system_prompt: rest.system_prompt ?? "",
      tools: rest.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      mcp_servers: rest.mcp_servers ?? [],
      skills: rest.skills ?? [],
      memories: rest.memories ?? [],
      context: rest.context ?? [],
      permission_mode: rest.permission_mode ?? "bypassPermissions",
      env: rest.env ?? {},
      ...(rest.runtime ? { runtime: rest.runtime } : {}),
      ...(rest.command ? { command: rest.command } : {}),
      ...(rest.task_delivery ? { task_delivery: rest.task_delivery } : {}),
    };
    const resolvedScope: "global" | "project" = scope === "project" && projectRoot ? "project" : "global";
    app.agents.save(agent.name, agent, resolvedScope, resolvedScope === "project" ? projectRoot : undefined);
    return { ok: true, name: agent.name, scope: resolvedScope };
  });

  router.handle("agent/update", async (p) => {
    const params = extract<Partial<AgentDefinition> & { name: string; scope?: "global" | "project" }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const existing = app.agents.get(params.name, projectRoot);
    if (!existing) throw new Error(`Agent '${params.name}' not found`);
    if (existing._source === "builtin") {
      throw new Error(`Agent '${params.name}' is builtin -- copy it to global/project before editing.`);
    }
    const merged: AgentDefinition = { ...existing, ...rest, name: params.name };
    const resolvedScope: "global" | "project" = scope ?? (existing._source === "project" ? "project" : "global");
    app.agents.save(merged.name, merged, resolvedScope, resolvedScope === "project" ? projectRoot : undefined);
    return { ok: true, name: merged.name, scope: resolvedScope };
  });

  router.handle("agent/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: "global" | "project" }>(p, ["name"]);
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const existing = app.agents.get(name, projectRoot);
    if (!existing) throw new Error(`Agent '${name}' not found`);
    if (existing._source === "builtin") {
      throw new Error(`Cannot delete builtin agent '${name}'.`);
    }
    const resolvedScope: "global" | "project" = scope ?? (existing._source === "project" ? "project" : "global");
    const ok = app.agents.delete(name, resolvedScope, resolvedScope === "project" ? projectRoot : undefined);
    return { ok };
  });

  router.handle("flow/list", async () => ({ flows: app.flows.list() }));
  router.handle("flow/read", async (p) => {
    const { name } = extract<FlowReadParams>(p, ["name"]);
    const flow = app.flows.get(name);
    if (!flow) throw new Error(`Flow '${name}' not found`);
    return { flow };
  });

  /**
   * Create a flow from a stages array. The Web `New Flow` form has been
   * sending this RPC for a while -- it just wasn't registered, so every
   * `Create Flow` click silently 404'd at the JSON-RPC layer.
   *
   * Note: `app.flows.get()` returns the raw YAML object so it doesn't carry
   * a source tag. We use `app.flows.list()` (which does tag source) to know
   * whether an existing flow with this name is builtin or user/project.
   */
  router.handle("flow/create", async (p) => {
    const params = extract<{
      name: string;
      description?: string;
      stages: FlowDefinition["stages"];
      scope?: "global" | "project";
    }>(p, ["name", "stages"]);
    if (!Array.isArray(params.stages) || params.stages.length === 0) {
      throw new Error("flow/create requires at least one stage");
    }
    const summary = app.flows.list().find((f) => f.name === params.name);
    if (summary && summary.source !== "builtin") {
      throw new Error(`Flow '${params.name}' already exists.`);
    }
    // The runtime FlowDefinition (core/state/flow.ts) is the right shape for
    // app.flows.save(); we cast through unknown because the protocol type
    // (types/flow.ts) is structurally compatible but not the same identity.
    const flow = {
      name: params.name,
      description: params.description,
      stages: params.stages,
    } as unknown as Parameters<typeof app.flows.save>[1];
    app.flows.save(params.name, flow, params.scope ?? "global");
    return { ok: true, name: params.name };
  });

  router.handle("flow/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: "global" | "project" }>(p, ["name"]);
    const summary = app.flows.list().find((f) => f.name === name);
    if (!summary) throw new Error(`Flow '${name}' not found`);
    if (summary.source === "builtin") {
      throw new Error(`Cannot delete builtin flow '${name}'.`);
    }
    const ok = app.flows.delete(name, scope ?? "global");
    return { ok };
  });

  router.handle("skill/list", async () => ({ skills: app.skills.list() }));
  router.handle("skill/read", async (p) => {
    const { name } = extract<SkillReadParams>(p, ["name"]);
    return { skill: app.skills.get(name) };
  });

  /**
   * Create or update a skill. Web `New Skill` form already calls this --
   * registering the handler unblocks the broken form.
   */
  router.handle("skill/save", async (p) => {
    const params = extract<Partial<SkillDefinition> & { name: string; scope?: "global" | "project" }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const skill: SkillDefinition = {
      name: params.name,
      description: rest.description ?? "",
      prompt: rest.prompt ?? "",
      tags: rest.tags ?? [],
    };
    const resolvedScope: "global" | "project" = scope === "project" && projectRoot ? "project" : "global";
    app.skills.save(skill.name, skill, resolvedScope, resolvedScope === "project" ? projectRoot : undefined);
    return { ok: true, name: skill.name, scope: resolvedScope };
  });

  router.handle("skill/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: "global" | "project" }>(p, ["name"]);
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const existing = app.skills.get(name, projectRoot);
    if (!existing) throw new Error(`Skill '${name}' not found`);
    if (existing._source === "builtin") {
      throw new Error(`Cannot delete builtin skill '${name}'.`);
    }
    const resolvedScope: "global" | "project" = scope ?? (existing._source === "project" ? "project" : "global");
    const ok = app.skills.delete(name, resolvedScope, resolvedScope === "project" ? projectRoot : undefined);
    return { ok };
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

  router.handle("recipe/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: "global" | "project" }>(p, ["name"]);
    const projectRoot = findProjectRoot(process.cwd()) ?? undefined;
    const existing = app.recipes.get(name, projectRoot);
    if (!existing) throw new Error(`Recipe '${name}' not found`);
    if (existing._source === "builtin") {
      throw new Error(`Cannot delete builtin recipe '${name}'.`);
    }
    const resolvedScope: "global" | "project" = scope ?? (existing._source === "project" ? "project" : "global");
    const ok = app.recipes.delete(name, resolvedScope, resolvedScope === "project" ? projectRoot : undefined);
    return { ok };
  });
  router.handle("compute/list", async () => ({ targets: app.computes.list() }));
  router.handle("compute/create", async (p) => {
    const { name, provider, config } = extract<{
      name: string;
      provider?: import("../../types/index.js").ComputeProviderName;
      config?: Partial<import("../../types/index.js").ComputeConfig>;
    }>(p, ["name"]);
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
      const { exitCode, stdout } = await sshExecAsync(sshKeyPath(compute.name), ip, "echo ok && uptime", {
        timeout: 10_000,
      });
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
        return { reachable: false, message: `Unreachable -- AWS status: ${real ?? "unknown"}` };
      }
      return { reachable: false, message: "Unreachable -- SSH connection failed" };
    } catch {
      return { reachable: false, message: "Unreachable -- SSH connection failed" };
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
    const dbNames = new Set(dbTemplates.map((t) => t.name));
    const merged = [
      ...dbTemplates,
      ...configTemplates
        .filter((t) => !dbNames.has(t.name))
        .map((t) => ({
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
      const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === name);
      if (cfgTmpl) {
        tmpl = {
          name: cfgTmpl.name,
          description: cfgTmpl.description,
          provider: cfgTmpl.provider as ComputeProviderName,
          config: cfgTmpl.config,
        };
      }
    }
    return tmpl ?? null;
  });
  router.handle("compute/template/create", async (p) => {
    const { name, provider, config, description } = extract<{
      name: string;
      provider: string;
      config?: Record<string, unknown>;
      description?: string;
    }>(p, ["name", "provider"]);
    app.computeTemplates.create({ name, description, provider: provider as ComputeProviderName, config: config ?? {} });
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
