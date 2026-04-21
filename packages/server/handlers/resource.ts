import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { instantiateRecipe } from "../../core/agent/recipe.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { guardBuiltin, projectArg, resolveProjectRoot, resolveScope, type Scope } from "./scope-helpers.js";
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
    const dbSession = await app.sessions.get(sessionId);
    if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
      await killSessionAsync(ts.name);
      if (dbSession) await app.sessions.update(dbSession.id, { session_id: null });
      cleaned++;
    }
  }
  return cleaned;
}

export function registerResourceHandlers(router: Router, app: AppContext): void {
  router.handle("agent/list", async () => {
    return { agents: app.agents.list(resolveProjectRoot()) };
  });
  router.handle("agent/read", async (p) => {
    const { name } = extract<AgentReadParams>(p, ["name"]);
    const agent = app.agents.get(name, resolveProjectRoot());
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
    const params = extract<Partial<AgentDefinition> & { name: string; scope?: Scope }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = resolveProjectRoot();
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
    const resolvedScope = resolveScope(scope, null, projectRoot);
    app.agents.save(agent.name, agent, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok: true, name: agent.name, scope: resolvedScope };
  });

  router.handle("agent/update", async (p) => {
    const params = extract<Partial<AgentDefinition> & { name: string; scope?: Scope }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = resolveProjectRoot();
    const existing = app.agents.get(params.name, projectRoot);
    if (!existing) throw new Error(`Agent '${params.name}' not found`);
    guardBuiltin(existing, "Agent", params.name, "edit");
    const merged: AgentDefinition = { ...existing, ...rest, name: params.name };
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    app.agents.save(merged.name, merged, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok: true, name: merged.name, scope: resolvedScope };
  });

  router.handle("agent/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const projectRoot = resolveProjectRoot();
    const existing = app.agents.get(name, projectRoot);
    if (!existing) throw new Error(`Agent '${name}' not found`);
    guardBuiltin(existing, "Agent", name, "delete");
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    const ok = app.agents.delete(name, resolvedScope, projectArg(resolvedScope, projectRoot));
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
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const summary = app.flows.list().find((f) => f.name === name);
    if (!summary) throw new Error(`Flow '${name}' not found`);
    // Flow summaries use `source` (not `_source`); adapt to the shared guard.
    guardBuiltin({ _source: summary.source }, "Flow", name, "delete");
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
    const params = extract<Partial<SkillDefinition> & { name: string; scope?: Scope }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = resolveProjectRoot();
    const skill: SkillDefinition = {
      name: params.name,
      description: rest.description ?? "",
      prompt: rest.prompt ?? "",
      tags: rest.tags ?? [],
    };
    const resolvedScope = resolveScope(scope, null, projectRoot);
    app.skills.save(skill.name, skill, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok: true, name: skill.name, scope: resolvedScope };
  });

  router.handle("skill/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const projectRoot = resolveProjectRoot();
    const existing = app.skills.get(name, projectRoot);
    if (!existing) throw new Error(`Skill '${name}' not found`);
    guardBuiltin(existing, "Skill", name, "delete");
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    const ok = app.skills.delete(name, resolvedScope, projectArg(resolvedScope, projectRoot));
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
    const session = await app.sessionService.start(instance);
    return { session };
  });

  router.handle("recipe/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const projectRoot = resolveProjectRoot();
    const existing = app.recipes.get(name, projectRoot);
    if (!existing) throw new Error(`Recipe '${name}' not found`);
    guardBuiltin(existing, "Recipe", name, "delete");
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    const ok = app.recipes.delete(name, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok };
  });
  router.handle("compute/list", async () => ({ targets: await app.computes.list() }));
  router.handle("compute/create", async (p) => {
    // Accept either legacy `{provider}` or new `{compute, runtime}`.
    // When only `provider` is given the repo derives the pair via
    // providerToPair. When only the new axes are given we reverse-map to the
    // best-matching legacy provider name so back-compat reads keep working.
    const {
      name,
      provider,
      compute: computeKind,
      runtime: runtimeKind,
      config,
    } = extract<{
      name: string;
      provider?: import("../../types/index.js").ComputeProviderName;
      compute?: import("../../types/index.js").ComputeKindName;
      runtime?: import("../../types/index.js").RuntimeKindName;
      config?: Partial<import("../../types/index.js").ComputeConfig>;
    }>(p, ["name"]);

    let effectiveProvider = provider;
    if (!effectiveProvider && computeKind && runtimeKind) {
      const { pairToProvider } = await import("../../compute/adapters/provider-map.js");
      effectiveProvider = (pairToProvider({ compute: computeKind, runtime: runtimeKind }) ??
        "local") as import("../../types/index.js").ComputeProviderName;
    }

    const compute = await app.computes.create({
      name,
      provider: effectiveProvider,
      compute: computeKind,
      runtime: runtimeKind,
      config,
    });
    return { compute };
  });
  // Surface registered Compute / Runtime kinds so the web UI can populate
  // dropdowns without duplicating our enum.
  router.handle("compute/kinds", async () => ({ kinds: app.listComputes() }));
  router.handle("runtime/kinds", async () => ({ kinds: app.listRuntimes() }));
  router.handle("compute/update", async (p) => {
    const { name, fields } = extract<ComputeUpdateParams>(p, ["name", "fields"]);
    await app.computes.update(name, fields as Record<string, unknown>);
    return { ok: true };
  });
  router.handle("compute/read", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError("Compute not found", ErrorCodes.SESSION_NOT_FOUND);
    return { compute };
  });
  router.handle("compute/provision", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await app.computes.update(compute.name, { status: "provisioning" });
    await provider.provision(compute);
    await app.computes.update(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/stop-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    try {
      await provider.stop(compute);
      await app.computes.update(compute.name, { status: "stopped" });
    } catch (e: any) {
      if (provider.checkStatus) {
        const real = await provider.checkStatus(compute).catch(() => null);
        if (real === "destroyed" || real === "terminated") {
          await app.computes.update(compute.name, { status: "destroyed" });
          await app.computes.mergeConfig(compute.name, { ip: null });
          return { ok: true, status: "destroyed" };
        }
      }
      throw e;
    }
    return { ok: true };
  });
  router.handle("compute/start-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await provider.start(compute);
    await app.computes.update(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/destroy", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider) throw new Error(`Provider '${compute.provider}' not found`);
    await provider.destroy(compute);
    // destroy cascades to the DB row. There is no "destroyed but still
    // listed" state -- if a user asks for destroy, they want it gone.
    await app.computes.delete(compute.name);
    return { ok: true };
  });
  router.handle("compute/clean", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const cleaned = await cleanZombieSessions(app);
    return { ok: true, cleaned };
  });
  router.handle("compute/reboot", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new Error("Compute not found");
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute.provider);
    if (!provider?.reboot) throw new Error("Provider does not support reboot");
    await provider.reboot(compute);
    return { ok: true };
  });
  router.handle("compute/ping", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
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
          await app.computes.update(compute.name, { status: real });
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
    const dbTemplates = await app.computeTemplates.list();
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
    let tmpl: any = await app.computeTemplates.get(name);
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
    await app.computeTemplates.create({
      name,
      description: description ?? null,
      provider: provider as ComputeProviderName,
      config: JSON.stringify(config ?? {}),
      tenant_id: "default",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);
    return { ok: true };
  });
  router.handle("compute/template/delete", async (p) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    await app.computeTemplates.delete(name);
    return { ok: true };
  });

  router.handle("group/list", async () => ({ groups: await app.sessions.getGroups() }));
  router.handle("group/create", async (p) => {
    const { name } = extract<GroupCreateParams>(p, ["name"]);
    await app.sessions.createGroup(name);
    return { group: { name } };
  });
  router.handle("group/delete", async (p) => {
    const { name } = extract<GroupDeleteParams>(p, ["name"]);
    await app.sessions.deleteGroup(name);
    return { ok: true };
  });
}
