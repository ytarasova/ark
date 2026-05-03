/**
 * Compute + compute-template + k8s-discover RPC handlers.
 *
 * Carved out of resource.ts to keep the resource-registry file focused on
 * declarative CRUD (agent / flow / skill / runtime / recipe / group) and
 * leave the imperative provider lifecycle (provision / start / stop /
 * destroy / ping / reboot) here alongside its capability-flag checks.
 *
 * Handlers register onto the passed Router; mechanics are unchanged vs
 * the pre-split registerResourceHandlers -- pure relocation.
 */
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { logDebug } from "../../core/observability/structured-log.js";
import { providerToPair, providerOf } from "../../compute/adapters/provider-map.js";
import type { ComputeNameParams, ComputeUpdateParams, ComputeProviderName } from "../../types/index.js";

/**
 * Kill tmux sessions for zombie ark sessions (no DB record or terminal status).
 * Exported so `compute/clean` + `compute/clean-zombies` share one impl.
 */
export async function cleanZombieSessions(app: AppContext): Promise<number> {
  const { listArkSessionsAsync, killSessionAsync } = await import("../../core/infra/tmux.js");
  const tmuxSessions = await listArkSessionsAsync();
  let cleaned = 0;
  for (const ts of tmuxSessions) {
    const sessionId = ts.name.replace("ark-", "");
    const dbSession = await app.sessions.get(sessionId);
    if (!dbSession || ["failed", "killed", "completed", "stopped"].includes(dbSession.status)) {
      await killSessionAsync(ts.name);
      if (dbSession) await app.sessions.update(dbSession.id, { session_id: null });
      cleaned++;
    }
  }
  return cleaned;
}

export function registerComputeHandlers(router: Router, app: AppContext): void {
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
    // Accept either legacy `{provider}` or new `{compute, isolation}`. When
    // only `provider` is given, the repo derives the pair via providerToPair.
    // When only the new axes are given, we reverse-map to the best-matching
    // legacy provider name so back-compat reads keep working.
    const {
      name,
      provider,
      compute: computeKind,
      isolation: isolationKind,
      config,
      is_template,
      cloned_from,
    } = extract<{
      name: string;
      provider?: import("../../types/index.js").ComputeProviderName;
      compute?: import("../../types/index.js").ComputeKindName;
      isolation?: import("../../types/index.js").IsolationKindName;
      config?: Partial<import("../../types/index.js").ComputeConfig>;
      is_template?: boolean;
      cloned_from?: string;
    }>(p, ["name"]);

    let effectiveProvider = provider;
    if (!effectiveProvider && computeKind && isolationKind) {
      const { pairToProvider } = await import("../../compute/adapters/provider-map.js");
      effectiveProvider = (pairToProvider({ compute: computeKind, isolation: isolationKind }) ??
        "local") as import("../../types/index.js").ComputeProviderName;
    }

    // K8s targets must specify context, namespace, image up-front -- fail at
    // create time rather than letting a misconfigured target provision pods
    // into the wrong cluster/namespace later. Match on the new compute kind
    // (preferred) and the legacy provider string (back-compat callers).
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
      isolation: isolationKind,
      config,
      is_template,
      cloned_from,
    });
    // RPC wire format still carries `provider` for back-compat clients; derive
    // it from the (compute_kind, isolation_kind) axes.
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

  // Surface registered Compute / Isolation kinds so the web UI can populate
  // dropdowns without duplicating our enum.
  router.handle("compute/kinds", async () => ({ kinds: app.listComputes() }));
  router.handle("runtime/kinds", async () => ({ kinds: app.listIsolations() }));

  router.handle("compute/update", async (p) => {
    const { name, fields } = extract<ComputeUpdateParams>(p, ["name", "fields"]);
    await app.computes.update(name, fields as Record<string, unknown>);
    return { ok: true };
  });

  router.handle("compute/read", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError("Compute not found", ErrorCodes.SESSION_NOT_FOUND);
    return { compute: { ...compute, provider: providerOf(compute) } };
  });

  /**
   * Authoritative capability flags for a compute target, sourced straight
   * from the provider instance. UI consumers query this so the Reboot /
   * Destroy / Auth-prompt buttons are driven by provider metadata instead
   * of hardcoded `provider === "local"` checks.
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

    // Template provision: clone the template into a named concrete row, then
    // provision the clone. Mirrors the session auto-clone path but triggered
    // manually so the user gets a long-lived instance they can attach to
    // outside of any session context.
    if (compute.is_template) {
      const cloneName = `${compute.name}-${Date.now().toString(36)}`;
      await app.computeService.create({
        name: cloneName,
        compute: compute.compute_kind,
        isolation: compute.isolation_kind,
        config: JSON.parse(JSON.stringify(compute.config ?? {})),
        is_template: false,
        cloned_from: compute.name,
      });
      const clone = (await app.computes.get(cloneName))!;
      const provider = getProvider(providerOf(clone));
      if (!provider) throw new RpcError(`Unknown provider: ${providerOf(clone)}`, ErrorCodes.NOT_FOUND);
      await app.computes.update(clone.name, { status: "provisioning" });
      try {
        // Provision validates the environment; Start brings up the real
        // instance. Template provision without Start would leave a clone
        // row with no backing infra, defeating the point of manual provision.
        await provider.provision(clone);
        await provider.start(clone);
        const started = (await app.computes.get(clone.name))!;
        return { ok: true, name: cloneName, cloned_from: compute.name, status: started.status };
      } catch (e: any) {
        // Record the failure so the row doesn't sit forever at
        // "provisioning". User can Destroy or retry Provision on the template.
        await app.computes.update(clone.name, { status: "failed" });
        throw new RpcError(
          `Failed to provision clone '${cloneName}' from template '${compute.name}': ${e?.message ?? e}`,
          ErrorCodes.INTERNAL_ERROR,
        );
      }
    }

    const provider = getProvider(providerOf(compute));
    if (!provider) throw new RpcError(`Unknown provider: ${providerOf(compute)}`, ErrorCodes.NOT_FOUND);
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
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new RpcError(`Unknown provider: ${providerOf(compute)}`, ErrorCodes.NOT_FOUND);
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
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new RpcError(`Unknown provider: ${providerOf(compute)}`, ErrorCodes.NOT_FOUND);
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
    // Capability-driven guard: reject destroy when the provider declares
    // canDelete=false instead of relying on the provider's destroy() to
    // throw. Keeps the error surface clean (server refused vs runtime
    // failure) and matches what the UI queries via compute/capabilities.
    if (!provider.canDelete) {
      throw new RpcError(`Provider '${provider.name}' does not support destroy`, ErrorCodes.UNSUPPORTED);
    }
    await provider.destroy(compute);
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
    // Capability-driven guard -- canReboot may be false even when reboot() is
    // defined (a provider might define reboot() that just throws NotSupported).
    if (!provider.canReboot) {
      throw new RpcError(`Provider '${provider.name}' does not support reboot`, ErrorCodes.UNSUPPORTED);
    }
    if (!provider.reboot) {
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
    const instanceId = cfg?.instance_id as string | undefined;
    if (!instanceId) return { reachable: false, message: "No instance_id configured" };
    try {
      const { ssmExec, ssmCheckInstance } = await import("../../compute/providers/ec2/ssm.js");
      const region = (cfg?.region as string | undefined) ?? "us-east-1";
      const awsProfile = cfg?.aws_profile as string | undefined;
      const online = await ssmCheckInstance({ instanceId, region, awsProfile });
      if (online) {
        const { stdout } = await ssmExec({
          instanceId,
          region,
          awsProfile,
          command: "echo ok && uptime",
          timeoutMs: 10_000,
        });
        return { reachable: true, message: stdout.trim() };
      }
      // Check provider status if SSM is offline.
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
        return { reachable: false, message: `Unreachable -- provider status: ${real ?? "unknown"}` };
      }
      return { reachable: false, message: "Unreachable -- SSM agent offline" };
    } catch {
      return { reachable: false, message: "Unreachable -- SSM connection failed" };
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
    // two-axis (compute, isolation) pair so web clients don't have to maintain
    // a duplicate provider-map table. Source of truth:
    // packages/compute/adapters/provider-map.ts.
    const withAxes = (t: { name: string; description?: string | null; provider: string; config: unknown }) => {
      const pair = providerToPair(t.provider);
      return {
        name: t.name,
        description: t.description ?? undefined,
        provider: t.provider,
        compute: pair.compute,
        isolation: pair.isolation,
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
}
