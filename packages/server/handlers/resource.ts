import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { guardBuiltin, projectArg, resolveProjectRoot, resolveScope, type Scope } from "./scope-helpers.js";
import { registerComputeHandlers } from "./resource-compute.js";
import type {
  AgentDefinition,
  AgentReadParams,
  FlowDefinition,
  FlowReadParams,
  SkillDefinition,
  SkillReadParams,
  RuntimeReadParams,
  GroupCreateParams,
  GroupDeleteParams,
} from "../../types/index.js";

// FlowDefinition from `types/flow.ts` is the protocol shape; we only use it
// for the request body type below. The runtime FlowDefinition expected by
// app.flows.save() lives in core/services/flow.ts -- we cast across the boundary
// in flow/create where the two definitions meet.

export function registerResourceHandlers(router: Router, app: AppContext): void {
  router.handle("agent/list", async () => {
    return { agents: await app.agents.list(resolveProjectRoot()) };
  });
  router.handle("agent/read", async (p) => {
    const { name } = extract<AgentReadParams>(p, ["name"]);
    const agent = await app.agents.get(name, resolveProjectRoot());
    if (!agent) throw new RpcError(`Agent '${name}' not found`, ErrorCodes.NOT_FOUND);
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
    const existing = await app.agents.get(params.name, projectRoot);
    if (existing && existing._source !== "builtin") {
      throw new RpcError(
        `Agent '${params.name}' already exists. Use agent/update to modify it.`,
        ErrorCodes.INVALID_PARAMS,
      );
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
    await app.agents.save(agent.name, agent, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok: true, name: agent.name, scope: resolvedScope };
  });

  router.handle("agent/update", async (p) => {
    const params = extract<Partial<AgentDefinition> & { name: string; scope?: Scope }>(p, ["name"]);
    const { scope, ...rest } = params;
    const projectRoot = resolveProjectRoot();
    const existing = await app.agents.get(params.name, projectRoot);
    if (!existing) throw new RpcError(`Agent '${params.name}' not found`, ErrorCodes.NOT_FOUND);
    guardBuiltin(existing, "Agent", params.name, "edit");
    const merged: AgentDefinition = { ...existing, ...rest, name: params.name };
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    await app.agents.save(merged.name, merged, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok: true, name: merged.name, scope: resolvedScope };
  });

  router.handle("agent/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const projectRoot = resolveProjectRoot();
    const existing = await app.agents.get(name, projectRoot);
    if (!existing) throw new RpcError(`Agent '${name}' not found`, ErrorCodes.NOT_FOUND);
    guardBuiltin(existing, "Agent", name, "delete");
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    const ok = await app.agents.delete(name, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok };
  });

  router.handle("flow/list", async () => ({ flows: await app.flows.list() }));
  router.handle("flow/read", async (p) => {
    const { name } = extract<FlowReadParams>(p, ["name"]);
    const flow = await app.flows.get(name);
    if (!flow) throw new RpcError(`Flow '${name}' not found`, ErrorCodes.NOT_FOUND);
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
      throw new RpcError("flow/create requires at least one stage", ErrorCodes.INVALID_PARAMS);
    }
    const summary = (await app.flows.list()).find((f) => f.name === params.name);
    if (summary && summary.source !== "builtin") {
      throw new RpcError(`Flow '${params.name}' already exists.`, ErrorCodes.INVALID_PARAMS);
    }
    // The runtime FlowDefinition (core/services/flow.ts) is the right shape for
    // app.flows.save(); we cast through unknown because the protocol type
    // (types/flow.ts) is structurally compatible but not the same identity.
    const flow = {
      name: params.name,
      description: params.description,
      stages: params.stages,
    } as unknown as Parameters<typeof app.flows.save>[1];
    await app.flows.save(params.name, flow, params.scope ?? "global");
    return { ok: true, name: params.name };
  });

  router.handle("flow/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const summary = (await app.flows.list()).find((f) => f.name === name);
    if (!summary) throw new RpcError(`Flow '${name}' not found`, ErrorCodes.NOT_FOUND);
    // Flow summaries use `source` (not `_source`); adapt to the shared guard.
    guardBuiltin({ _source: summary.source }, "Flow", name, "delete");
    const ok = await app.flows.delete(name, scope ?? "global");
    return { ok };
  });

  router.handle("skill/list", async () => ({ skills: await app.skills.list() }));
  router.handle("skill/read", async (p) => {
    const { name } = extract<SkillReadParams>(p, ["name"]);
    return { skill: await app.skills.get(name) };
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
    if (!existing) throw new RpcError(`Skill '${name}' not found`, ErrorCodes.NOT_FOUND);
    guardBuiltin(existing, "Skill", name, "delete");
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    const ok = app.skills.delete(name, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok };
  });
  router.handle("runtime/list", async () => ({ runtimes: await app.runtimes.list() }));
  router.handle("runtime/read", async (p) => {
    const { name } = extract<RuntimeReadParams>(p, ["name"]);
    const runtime = await app.runtimes.get(name);
    if (!runtime) throw new RpcError(`Runtime '${name}' not found`, ErrorCodes.NOT_FOUND);
    return { runtime };
  });
  // Model catalog -- file-backed three-tier store. Exposed so the web UI can
  // populate the per-agent model selector from the same source of truth that
  // dispatch uses (no duplicated runtime.models list).
  router.handle("model/list", async () => {
    const projectRoot = resolveProjectRoot();
    return { models: app.models.list(projectRoot) };
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

  // Compute + compute-template + k8s-discover handlers live in the sibling
  // resource-compute.ts file -- they share a large code surface (provider
  // lifecycle, capability flags, zombie cleanup) that didn't fit the rest
  // of the resource CRUD pattern.
  registerComputeHandlers(router, app);
}
