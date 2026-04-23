import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { instantiateRecipe } from "../../core/agent/recipe.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { guardBuiltin, projectArg, resolveProjectRoot, resolveScope, type Scope } from "./scope-helpers.js";
import { logDebug } from "../../core/observability/structured-log.js";
<<<<<<< HEAD
import { providerToPair } from "../../compute/adapters/provider-map.js";
=======
import { providerOf } from "../../compute/adapters/provider-map.js";
>>>>>>> 185cc6c5 (refactor(types): drop deprecated `provider` field from Compute + CreateComputeOpts)
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
    // The runtime FlowDefinition (core/state/flow.ts) is the right shape for
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
  router.handle("recipe/list", async () => ({ recipes: await app.recipes.list() }));
  router.handle("recipe/read", async (p) => {
    const { name } = extract<RecipeReadParams>(p, ["name"]);
    const recipe = await app.recipes.get(name);
    if (!recipe) throw new RpcError(`Recipe '${name}' not found`, ErrorCodes.NOT_FOUND);
    return { recipe };
  });

  router.handle("recipe/use", async (p) => {
    const { name, variables } = extract<RecipeUseParams>(p, ["name"]);
    const recipe = await app.recipes.get(name);
    if (!recipe) throw new RpcError(`Recipe '${name}' not found`, ErrorCodes.NOT_FOUND);
    const instance = instantiateRecipe(recipe, (variables ?? {}) as Record<string, string>);
    const session = await app.sessionService.start(instance);
    return { session };
  });

  router.handle("recipe/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const projectRoot = resolveProjectRoot();
    const existing = app.recipes.get(name, projectRoot);
    if (!existing) throw new RpcError(`Recipe '${name}' not found`, ErrorCodes.NOT_FOUND);
    guardBuiltin(existing, "Recipe", name, "delete");
    const resolvedScope = resolveScope(scope, existing, projectRoot);
    const ok = app.recipes.delete(name, resolvedScope, projectArg(resolvedScope, projectRoot));
    return { ok };
  });
  router.handle("compute/list", async (p) => {
    // `include` filters between concrete targets and template blueprints.
    // Default "all" preserves the pre-unification behaviour.
    const { include } = extract<{ include?: "all" | "concrete" | "template" }>(p ?? {}, []);
    let targets;
    if (include === "template") targets = await app.computes.listTemplates();
    else if (include === "concrete") targets = await app.computes.listConcrete();
    else targets = await app.computes.list();
    // Wire-format back-compat: include derived `provider` on each row.
    return { targets: targets.map((t) => ({ ...t, provider: providerOf(t) })) };
  });
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
      is_template,
      cloned_from,
    } = extract<{
      name: string;
      provider?: import("../../types/index.js").ComputeProviderName;
      compute?: import("../../types/index.js").ComputeKindName;
      runtime?: import("../../types/index.js").RuntimeKindName;
      config?: Partial<import("../../types/index.js").ComputeConfig>;
      is_template?: boolean;
      cloned_from?: string;
    }>(p, ["name"]);

    let effectiveProvider = provider;
    if (!effectiveProvider && computeKind && runtimeKind) {
      const { pairToProvider } = await import("../../compute/adapters/provider-map.js");
      effectiveProvider = (pairToProvider({ compute: computeKind, runtime: runtimeKind }) ??
        "local") as import("../../types/index.js").ComputeProviderName;
    }

    // K8s targets must specify context, namespace, image up-front -- fail
    // at create time rather than letting a misconfigured target provision
    // pods into the wrong cluster/namespace later. Match on the new compute
    // kind (preferred) and the legacy provider string (back-compat callers).
    const providerStr = String(effectiveProvider ?? "");
    const isK8s = computeKind === "k8s" || providerStr === "k8s" || providerStr === "k8s-kata";
    if (isK8s) {
      const cfg = (config ?? {}) as Record<string, unknown>;
      const missing = ["context", "namespace", "image"].filter((k) => !cfg[k]);
      if (missing.length) {
        throw new RpcError(
          `k8s compute requires ${missing.join(", ")} in config -- missing values would silently default to the kubeconfig current-context / "ark" namespace / ubuntu image`,
          ErrorCodes.INVALID_PARAMS,
        );
      }
      // Tenant policy gate: lock down which clusters this tenant can target.
      // Empty allowed_k8s_contexts means "no restriction".
      if (app.tenantPolicyManager && app.tenantId) {
        const allowed = await app.tenantPolicyManager.isK8sContextAllowed(app.tenantId, cfg.context as string);
        if (!allowed) {
          throw new RpcError(
            `Tenant "${app.tenantId}" is not permitted to target k8s context "${cfg.context}"`,
            ErrorCodes.INVALID_PARAMS,
          );
        }
      }
    }

    const created = await app.computeService.create({
      name,
      provider: effectiveProvider,
      compute: computeKind,
      runtime: runtimeKind,
      config,
      is_template,
      cloned_from,
    });
    // RPC wire format still carries `provider` for back-compat clients; derive
    // it from the (compute_kind, runtime_kind) axes.
    return { compute: { ...created, provider: providerOf(created) } };
  });

  // Discover available k8s contexts + namespaces from the local kubeconfig
  // (or in-cluster service-account). Powers the compute-create UI / CLI
  // pickers so users don't have to type cluster names from memory.
  router.handle("k8s/discover", async (p) => {
    const { kubeconfig, includeNamespaces } = extract<{ kubeconfig?: string; includeNamespaces?: boolean }>(p, []);
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    if (kubeconfig) kc.loadFromFile(kubeconfig);
    else kc.loadFromDefault();
    const contexts = kc.getContexts().map((c) => ({ name: c.name, cluster: c.cluster, user: c.user }));
    const current = kc.getCurrentContext();
    const result: { contexts: typeof contexts; current: string; namespacesByContext?: Record<string, string[]> } = {
      contexts,
      current,
    };
    if (includeNamespaces) {
      const namespacesByContext: Record<string, string[]> = {};
      for (const ctx of contexts) {
        try {
          const scoped = new k8s.KubeConfig();
          if (kubeconfig) scoped.loadFromFile(kubeconfig);
          else scoped.loadFromDefault();
          scoped.setCurrentContext(ctx.name);
          const api = scoped.makeApiClient(k8s.CoreV1Api);
          const { items } = await api.listNamespace();
          namespacesByContext[ctx.name] = (items || []).map((n: any) => n.metadata?.name).filter(Boolean) as string[];
        } catch {
          // Context may be unreachable from this machine (no VPN / wrong
          // creds / cluster down). Skip silently -- the picker just won't
          // show namespaces for it.
          namespacesByContext[ctx.name] = [];
        }
      }
      result.namespacesByContext = namespacesByContext;
    }
    return result;
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
    // Wire-format back-compat: include derived `provider`.
    return { compute: { ...compute, provider: providerOf(compute) } };
  });
  /**
   * Return authoritative capability flags for a compute target, sourced
   * straight from the provider instance. UI consumers query this so the
   * Reboot / Destroy / Auth-prompt buttons are driven by provider metadata
   * instead of hardcoded `provider === "local"` checks. See P1-1 in
   * docs/2026-04-21-architectural-audit-hardcoded-rules.md.
   */
  router.handle("compute/capabilities", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const provider = app.getProvider(providerOf(compute));
    if (!provider) throw new RpcError(`Unknown provider: ${providerOf(compute)}`, ErrorCodes.NOT_FOUND);
    return {
      capabilities: {
        provider: provider.name,
        singleton: provider.singleton ?? false,
        canReboot: provider.canReboot,
        canDelete: provider.canDelete,
        needsAuth: provider.needsAuth,
        supportsWorktree: provider.supportsWorktree,
        initialStatus: provider.initialStatus,
        isolationModes: provider.isolationModes,
      },
    };
  });
  router.handle("compute/provision", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const { getProvider } = await import("../../compute/index.js");

    // Template provision: clone the template into a named concrete row,
    // then provision the clone. This mirrors the session auto-clone path
    // (see resolveComputeForStage in core/services/dispatch.ts) but triggered
    // manually by the user so they get a long-lived instance they can attach
    // to outside of any session context.
    if (compute.is_template) {
      const cloneName = `${compute.name}-${Date.now().toString(36)}`;
      await app.computeService.create({
        name: cloneName,
        compute: compute.compute_kind,
        runtime: compute.runtime_kind,
        config: JSON.parse(JSON.stringify(compute.config ?? {})),
        is_template: false,
        cloned_from: compute.name,
      });
      const clone = (await app.computes.get(cloneName))!;
<<<<<<< HEAD
      const provider = getProvider(clone.provider);
      if (!provider) throw new RpcError(`Unknown provider: ${clone.provider}`, ErrorCodes.NOT_FOUND);
=======
      const provider = getProvider(providerOf(clone));
      if (!provider) throw new Error(`Provider '${providerOf(clone)}' not found`);
>>>>>>> 185cc6c5 (refactor(types): drop deprecated `provider` field from Compute + CreateComputeOpts)
      await app.computes.update(clone.name, { status: "provisioning" });
      try {
        // Provision validates the environment (namespace exists, config
        // sane), then Start brings up the real instance pod / container /
        // VM. Template provision without Start would leave a clone row
        // with no backing infra, which defeats the purpose of manual
        // provision.
        await provider.provision(clone);
        await provider.start(clone);
        // provider.start sets status=running; re-read to be safe.
        const started = (await app.computes.get(clone.name))!;
        return { ok: true, name: cloneName, cloned_from: compute.name, status: started.status };
      } catch (e: any) {
        // Record the failure so the row doesn't sit forever at
        // "provisioning" with no actions. User can Destroy from the UI
        // or retry Provision on the template.
        await app.computes.update(clone.name, { status: "failed" });
        throw new RpcError(
          `Failed to provision clone '${cloneName}' from template '${compute.name}': ${e?.message ?? e}`,
          ErrorCodes.INTERNAL_ERROR,
        );
      }
    }

<<<<<<< HEAD
    const provider = getProvider(compute.provider);
    if (!provider) throw new RpcError(`Unknown provider: ${compute.provider}`, ErrorCodes.NOT_FOUND);
=======
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new Error(`Provider '${providerOf(compute)}' not found`);
>>>>>>> 185cc6c5 (refactor(types): drop deprecated `provider` field from Compute + CreateComputeOpts)
    await app.computes.update(compute.name, { status: "provisioning" });
    try {
      await provider.provision(compute);
      await app.computes.update(compute.name, { status: "running" });
      return { ok: true, name: compute.name };
    } catch (e: any) {
      await app.computes.update(compute.name, { status: "failed" });
      throw new RpcError(`Failed to provision '${compute.name}': ${e?.message ?? e}`, ErrorCodes.INTERNAL_ERROR);
    }
  });
  router.handle("compute/stop-instance", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const { getProvider } = await import("../../compute/index.js");
<<<<<<< HEAD
    const provider = getProvider(compute.provider);
    if (!provider) throw new RpcError(`Unknown provider: ${compute.provider}`, ErrorCodes.NOT_FOUND);
=======
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new Error(`Provider '${providerOf(compute)}' not found`);
>>>>>>> 185cc6c5 (refactor(types): drop deprecated `provider` field from Compute + CreateComputeOpts)
    try {
      await provider.stop(compute);
      await app.computes.update(compute.name, { status: "stopped" });
    } catch (e: any) {
      if (provider.checkStatus) {
        const real = await provider.checkStatus(compute).catch((err) => {
          logDebug("compute", `compute/stop-instance: checkStatus probe failed (name=${compute.name})`, {
            name: compute.name,
            provider: providerOf(compute),
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
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
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const { getProvider } = await import("../../compute/index.js");
<<<<<<< HEAD
    const provider = getProvider(compute.provider);
    if (!provider) throw new RpcError(`Unknown provider: ${compute.provider}`, ErrorCodes.NOT_FOUND);
=======
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new Error(`Provider '${providerOf(compute)}' not found`);
>>>>>>> 185cc6c5 (refactor(types): drop deprecated `provider` field from Compute + CreateComputeOpts)
    await provider.start(compute);
    await app.computes.update(compute.name, { status: "running" });
    return { ok: true };
  });
  router.handle("compute/destroy", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new RpcError(`Unknown provider: ${providerOf(compute)}`, ErrorCodes.NOT_FOUND);
    // Capability-driven guard: reject destroy up front when the provider
    // declares canDelete=false, instead of relying on the provider's
    // `destroy()` to throw. Keeps the error surface clean (server refused
    // vs. runtime failure) and matches what the UI can now query via
    // `compute/capabilities`.
    if (!provider.canDelete) {
      throw new RpcError(`Provider '${provider.name}' does not support destroy`, ErrorCodes.UNSUPPORTED);
    }
    await provider.destroy(compute);
    // destroy cascades to the DB row. There is no "destroyed but still
    // listed" state -- if a user asks for destroy, they want it gone.
    await app.computes.delete(compute.name);
    return { ok: true };
  });
  router.handle("compute/clean", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const cleaned = await cleanZombieSessions(app);
    return { ok: true, cleaned };
  });
  router.handle("compute/reboot", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new RpcError(`Unknown provider: ${providerOf(compute)}`, ErrorCodes.NOT_FOUND);
    // Capability-driven guard: consult provider.canReboot explicitly rather
    // than relying on method presence (a provider might define `reboot()`
    // that simply throws NotSupported). Matches the flag the UI queries via
    // `compute/capabilities`.
    if (!provider.canReboot) {
      throw new RpcError(`Provider '${provider.name}' does not support reboot`, ErrorCodes.UNSUPPORTED);
    }
    if (!provider.reboot) {
      // canReboot=true but no method wired -- treat as a provider bug.
      throw new RpcError(
        `Provider '${provider.name}' declares canReboot but has no reboot() implementation`,
        ErrorCodes.INTERNAL_ERROR,
      );
    }
    await provider.reboot(compute);
    return { ok: true };
  });
  router.handle("compute/ping", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
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
      const provider = getProvider(providerOf(compute));
      if (provider?.checkStatus) {
        const real = await provider.checkStatus(compute).catch((err) => {
          logDebug("compute", `compute/ping: checkStatus probe failed (name=${compute.name})`, {
            name: compute.name,
            provider: providerOf(compute),
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
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
    // Every template carries both the legacy provider name AND the new
    // two-axis (compute, runtime) pair so web clients don't have to
    // maintain a duplicate provider-map table. Source of truth:
    // packages/compute/adapters/provider-map.ts.
    const withAxes = (t: { name: string; description?: string | null; provider: string; config: unknown }) => {
      const pair = providerToPair(t.provider);
      return {
        name: t.name,
        description: t.description ?? undefined,
        provider: t.provider,
        compute: pair.compute,
        runtime: pair.runtime,
        config: t.config,
      };
    };
    const merged = [...dbTemplates.map(withAxes), ...configTemplates.filter((t) => !dbNames.has(t.name)).map(withAxes)];
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
