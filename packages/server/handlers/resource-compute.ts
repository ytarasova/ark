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
import type {
  Compute,
  ComputeKindName,
  IsolationKindName,
  ComputeNameParams,
  ComputeUpdateParams,
} from "../../types/index.js";

/**
 * Display-only helper -- compose a `${compute_kind}+${isolation_kind}` label
 * back into the legacy provider-name string the wire format used to carry.
 * Mirrors the (now-deleted) `pairToProvider` helper from compute/adapters/.
 */
function legacyProviderLabel(c: Pick<Compute, "compute_kind" | "isolation_kind">): string {
  const ck = c.compute_kind;
  const ik = c.isolation_kind;
  if (ck === "local") {
    if (ik === "direct") return "local";
    if (ik === "docker") return "docker";
    if (ik === "devcontainer") return "devcontainer";
  }
  if (ck === "ec2") {
    if (ik === "direct") return "ec2";
    if (ik === "docker") return "ec2-docker";
    if (ik === "devcontainer") return "ec2-devcontainer";
  }
  if (ck === "firecracker") return "firecracker";
  if (ck === "k8s") return "k8s";
  if (ck === "k8s-kata") return "k8s-kata";
  return ck;
}

/**
 * Reverse of legacyProviderLabel -- used only for back-compat handling of
 * RPC callers that still pass `{provider}` instead of `{compute, isolation}`.
 */
function legacyProviderToAxes(name: string): { compute_kind: ComputeKindName; isolation_kind: IsolationKindName } {
  switch (name) {
    case "local":
      return { compute_kind: "local", isolation_kind: "direct" };
    case "docker":
      return { compute_kind: "local", isolation_kind: "docker" };
    case "devcontainer":
      return { compute_kind: "local", isolation_kind: "devcontainer" };
    case "firecracker":
      return { compute_kind: "firecracker", isolation_kind: "direct" };
    case "ec2":
    case "remote-arkd":
    case "remote-worktree":
      return { compute_kind: "ec2", isolation_kind: "direct" };
    case "ec2-docker":
    case "remote-docker":
      return { compute_kind: "ec2", isolation_kind: "docker" };
    case "ec2-devcontainer":
    case "remote-devcontainer":
      return { compute_kind: "ec2", isolation_kind: "devcontainer" };
    case "k8s":
      return { compute_kind: "k8s", isolation_kind: "direct" };
    case "k8s-kata":
      return { compute_kind: "k8s-kata", isolation_kind: "direct" };
    default:
      return { compute_kind: "local", isolation_kind: "direct" };
  }
}

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
    if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
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
    // Wire-format back-compat: include the legacy `provider` label on each
    // row so existing clients keep rendering. Will be dropped once the web
    // UI moves to `${compute_kind}+${isolation_kind}` directly.
    return { targets: targets.map((t) => ({ ...t, provider: legacyProviderLabel(t) })) };
  });

  router.handle("compute/create", async (p) => {
    // Accept either legacy `{provider}` or new `{compute, isolation}`. The
    // legacy form maps to a (compute_kind, isolation_kind) pair via
    // `legacyProviderToAxes`; the new form is passed through verbatim.
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
      provider?: string;
      compute?: ComputeKindName;
      isolation?: IsolationKindName;
      config?: Partial<import("../../types/index.js").ComputeConfig>;
      is_template?: boolean;
      cloned_from?: string;
    }>(p, ["name"]);

    let effectiveCompute = computeKind;
    let effectiveIsolation = isolationKind;
    if (!effectiveCompute && !effectiveIsolation && provider) {
      const axes = legacyProviderToAxes(provider);
      effectiveCompute = axes.compute_kind;
      effectiveIsolation = axes.isolation_kind;
    }

    // K8s targets must specify context, namespace, image up-front -- fail at
    // create time rather than letting a misconfigured target provision pods
    // into the wrong cluster/namespace later. Match on the new compute kind
    // (preferred) and the legacy provider string (back-compat callers).
    const providerStr = String(provider ?? "");
    const isK8s =
      effectiveCompute === "k8s" ||
      effectiveCompute === "k8s-kata" ||
      providerStr === "k8s" ||
      providerStr === "k8s-kata";
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
      compute: effectiveCompute,
      isolation: effectiveIsolation,
      config,
      is_template,
      cloned_from,
    });
    // RPC wire format still carries `provider` for back-compat clients;
    // derive the legacy label from the (compute_kind, isolation_kind) axes.
    return { compute: { ...created, provider: legacyProviderLabel(created) } };
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
    return { compute: { ...compute, provider: legacyProviderLabel(compute) } };
  });

  /**
   * Authoritative capability flags for a compute target, sourced from the
   * registered Compute impl's `capabilities` block. UI consumers query this
   * so the Reboot / Destroy / Auth-prompt buttons are driven by Compute
   * metadata instead of hardcoded `provider === "local"` checks.
   */
  router.handle("compute/capabilities", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) {
      throw new RpcError(`Unknown compute kind: ${compute.compute_kind}`, ErrorCodes.NOT_FOUND);
    }
    const caps = computeImpl.capabilities;
    return {
      capabilities: {
        provider: legacyProviderLabel(compute),
        singleton: caps.singleton,
        canReboot: caps.canReboot,
        canDelete: caps.canDelete,
        needsAuth: caps.needsAuth,
        supportsWorktree: caps.supportsWorktree,
        initialStatus: caps.initialStatus,
        isolationModes: caps.isolationModes,
      },
    };
  });

  router.handle("compute/provision", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);

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
      const cloneImpl = app.getCompute(clone.compute_kind);
      if (!cloneImpl) {
        throw new RpcError(`Unknown compute kind: ${clone.compute_kind}`, ErrorCodes.NOT_FOUND);
      }
      await app.computes.update(clone.name, { status: "provisioning" });
      try {
        // Provision validates the environment + brings up the real instance.
        // The Compute interface fuses the legacy provision+start into a
        // single `provision()` call (returns a live handle) so we don't
        // need a separate start step here.
        const handle = await cloneImpl.provision({ config: (clone.config ?? {}) as Record<string, unknown> });
        await cloneImpl.start(handle).catch(() => undefined); // optional, idempotent
        await app.computes.update(clone.name, { status: "running" });
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

    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) {
      throw new RpcError(`Unknown compute kind: ${compute.compute_kind}`, ErrorCodes.NOT_FOUND);
    }
    await app.computes.update(compute.name, { status: "provisioning" });
    try {
      const handle = await computeImpl.provision({ config: (compute.config ?? {}) as Record<string, unknown> });
      await computeImpl.start(handle).catch(() => undefined);
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
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) {
      throw new RpcError(`Unknown compute kind: ${compute.compute_kind}`, ErrorCodes.NOT_FOUND);
    }
    const handle = computeImpl.attachExistingHandle?.({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (!handle) {
      // Compute hasn't been provisioned yet -- nothing to stop. Treat the
      // status flip as the only thing the user asked for.
      await app.computes.update(compute.name, { status: "stopped" });
      return { ok: true };
    }
    try {
      await computeImpl.stop(handle);
      await app.computes.update(compute.name, { status: "stopped" });
    } catch (e: any) {
      // checkStatus stays on the legacy registry until follow-up issue ports it.
      const provider = app.getProvider(compute.compute_kind);
      if (provider?.checkStatus) {
        const real = await provider.checkStatus(compute).catch((err) => {
          logDebug("compute", `compute/stop-instance: checkStatus probe failed (name=${compute.name})`, {
            name: compute.name,
            kind: compute.compute_kind,
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
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) {
      throw new RpcError(`Unknown compute kind: ${compute.compute_kind}`, ErrorCodes.NOT_FOUND);
    }
    const handle = computeImpl.attachExistingHandle?.({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (handle) {
      await computeImpl.start(handle);
    }
    await app.computes.update(compute.name, { status: "running" });
    return { ok: true };
  });

  router.handle("compute/destroy", async (p) => {
    const { name } = extract<ComputeNameParams>(p, ["name"]);
    const compute = await app.computes.get(name);
    if (!compute) throw new RpcError(`Unknown compute: ${name}`, ErrorCodes.NOT_FOUND);
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) {
      throw new RpcError(`Unknown compute kind: ${compute.compute_kind}`, ErrorCodes.NOT_FOUND);
    }
    // Capability-driven guard: reject destroy when the Compute declares
    // canDelete=false. Keeps the error surface clean (server refused vs
    // runtime failure) and matches what the UI queries via compute/capabilities.
    if (!computeImpl.capabilities.canDelete) {
      throw new RpcError(`Compute kind '${compute.compute_kind}' does not support destroy`, ErrorCodes.UNSUPPORTED);
    }
    const handle = computeImpl.attachExistingHandle?.({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (handle) {
      await computeImpl.destroy(handle);
    }
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
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) {
      throw new RpcError(`Unknown compute kind: ${compute.compute_kind}`, ErrorCodes.NOT_FOUND);
    }
    // Capability-driven guard -- canReboot may be false even when reboot() is
    // defined (a Compute impl might define reboot() that throws NotSupported).
    if (!computeImpl.capabilities.canReboot) {
      throw new RpcError(`Compute kind '${compute.compute_kind}' does not support reboot`, ErrorCodes.UNSUPPORTED);
    }
    // `reboot` lives on the legacy registry until a dedicated ComputeTarget
    // hook lands (filed as a follow-up issue). Look up by compute kind so
    // the matching legacy stub is reachable.
    const provider = app.getProvider(compute.compute_kind);
    if (!provider?.reboot) {
      throw new RpcError(
        `Compute kind '${compute.compute_kind}' declares canReboot but has no reboot() implementation`,
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
      const { ssmExec, ssmCheckInstance } = await import("../../core/compute/ec2/ssm.js");
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
      // Check provider status if SSM is offline. `checkStatus` lives on the
      // legacy registry until a dedicated ComputeTarget hook lands.
      const provider = app.getProvider(compute.compute_kind);
      if (provider?.checkStatus) {
        const real = await provider.checkStatus(compute).catch((err) => {
          logDebug("compute", `compute/ping: checkStatus probe failed (name=${compute.name})`, {
            name: compute.name,
            kind: compute.compute_kind,
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
    // DB rows carry the two-axis (compute, isolation) pair directly.
    // Config-defined rows still carry a legacy `provider` field; we map it
    // through `legacyProviderToAxes` here. Wire format includes the legacy
    // `provider` label so existing clients keep rendering.
    const dbWire = dbTemplates.map((t) => ({
      name: t.name,
      description: t.description,
      provider: legacyProviderLabel({ compute_kind: t.compute, isolation_kind: t.isolation }),
      compute: t.compute,
      isolation: t.isolation,
      config: t.config,
    }));
    const cfgWire = configTemplates
      .filter((t) => !dbNames.has(t.name))
      .map((t) => {
        const axes = legacyProviderToAxes(t.provider ?? "local");
        return {
          name: t.name,
          description: t.description ?? undefined,
          provider: t.provider,
          compute: axes.compute_kind,
          isolation: axes.isolation_kind,
          config: t.config,
        };
      });
    return { templates: [...dbWire, ...cfgWire] };
  });

  router.handle("compute/template/get", async (p) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    let tmpl: any = await app.computeTemplates.get(name);
    if (tmpl) {
      // Template view carries the two-axis pair; re-emit the legacy label
      // for back-compat clients that still key off it.
      tmpl = { ...tmpl, provider: legacyProviderLabel({ compute_kind: tmpl.compute, isolation_kind: tmpl.isolation }) };
    } else {
      const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === name);
      if (cfgTmpl) {
        const axes = legacyProviderToAxes(cfgTmpl.provider ?? "local");
        tmpl = {
          name: cfgTmpl.name,
          description: cfgTmpl.description,
          provider: cfgTmpl.provider,
          compute: axes.compute_kind,
          isolation: axes.isolation_kind,
          config: cfgTmpl.config,
        };
      }
    }
    return tmpl ?? null;
  });

  router.handle("compute/template/create", async (p) => {
    const {
      name,
      provider,
      compute: computeKind,
      isolation: isolationKind,
      config,
      description,
    } = extract<{
      name: string;
      provider?: string;
      compute?: ComputeKindName;
      isolation?: IsolationKindName;
      config?: Record<string, unknown>;
      description?: string;
    }>(p, ["name"]);
    let effectiveCompute = computeKind;
    let effectiveIsolation = isolationKind;
    if ((!effectiveCompute || !effectiveIsolation) && provider) {
      const axes = legacyProviderToAxes(provider);
      effectiveCompute = effectiveCompute ?? axes.compute_kind;
      effectiveIsolation = effectiveIsolation ?? axes.isolation_kind;
    }
    await app.computeTemplates.create({
      name,
      description: description ?? undefined,
      compute: (effectiveCompute ?? "local") as ComputeKindName,
      isolation: (effectiveIsolation ?? "direct") as IsolationKindName,
      config: (config ?? {}) as Record<string, unknown>,
      tenant_id: "default",
    });
    return { ok: true };
  });

  router.handle("compute/template/delete", async (p) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    await app.computeTemplates.delete(name);
    return { ok: true };
  });
}
