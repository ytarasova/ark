/**
 * ComputeClient -- compute / template / cluster / group / k8s RPCs.
 *
 * Also carries the agent-G block (cluster list + tenant compute-config
 * YAML) because those calls share the compute/dispatch surface.
 */

import type {
  Compute,
  ComputeSnapshot,
  ComputeCreateResult,
  ComputeListResult,
  ComputeReadResult,
  ComputePingResult,
  ComputeCleanZombiesResult,
  MetricsSnapshotResult,
  GroupListResult,
  GroupCreateResult,
} from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class ComputeClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  async computeList(opts?: { include?: "all" | "concrete" | "template" }): Promise<Compute[]> {
    const { targets } = await this.rpc<ComputeListResult>("compute/list", opts ?? {});
    return targets;
  }

  /**
   * Discover k8s contexts (and optionally namespaces) from the server's
   * kubeconfig. Powers interactive pickers in the CLI and web UI.
   */
  async k8sDiscover(opts?: { kubeconfig?: string; includeNamespaces?: boolean }): Promise<{
    contexts: Array<{ name: string; cluster?: string; user?: string }>;
    current: string;
    namespacesByContext?: Record<string, string[]>;
  }> {
    return this.rpc("k8s/discover", opts ?? {});
  }

  async computeCreate(opts: Record<string, unknown>): Promise<Compute> {
    const { compute } = await this.rpc<ComputeCreateResult>("compute/create", opts);
    return compute;
  }

  async computeUpdate(name: string, fields: Record<string, unknown>): Promise<void> {
    await this.rpc("compute/update", { name, fields });
  }

  async computeRead(name: string): Promise<Compute> {
    const { compute } = await this.rpc<ComputeReadResult>("compute/read", { name });
    return compute;
  }

  async computeProvision(name: string): Promise<void> {
    await this.rpc("compute/provision", { name });
  }

  async computeStopInstance(name: string): Promise<void> {
    await this.rpc("compute/stop-instance", { name });
  }

  async computeStartInstance(name: string): Promise<void> {
    await this.rpc("compute/start-instance", { name });
  }

  async computeDestroy(name: string): Promise<void> {
    await this.rpc("compute/destroy", { name });
  }

  async computeClean(name: string): Promise<void> {
    await this.rpc("compute/clean", { name });
  }

  async computeReboot(name: string): Promise<void> {
    await this.rpc("compute/reboot", { name });
  }

  async computePing(name: string): Promise<ComputePingResult> {
    return this.rpc<ComputePingResult>("compute/ping", { name });
  }

  async computeCleanZombies(): Promise<ComputeCleanZombiesResult> {
    return this.rpc<ComputeCleanZombiesResult>("compute/clean-zombies");
  }

  async computeTemplateList(): Promise<{
    templates: Array<{
      name: string;
      description?: string;
      provider: string;
      compute?: string;
      runtime?: string;
      config: Record<string, unknown>;
    }>;
  }> {
    return this.rpc("compute/template/list");
  }

  async computeTemplateGet(
    name: string,
  ): Promise<{ name: string; description?: string; provider: string; config: Record<string, unknown> } | null> {
    return this.rpc("compute/template/get", { name });
  }

  async groupList(): Promise<Array<{ name: string; created_at: string }>> {
    const { groups } = await this.rpc<GroupListResult>("group/list");
    return groups;
  }

  async groupCreate(name: string): Promise<{ name: string; created_at: string }> {
    const { group } = await this.rpc<GroupCreateResult>("group/create", { name });
    return group;
  }

  async groupDelete(name: string): Promise<void> {
    await this.rpc("group/delete", { name });
  }

  async metricsSnapshot(computeName?: string): Promise<ComputeSnapshot | null> {
    const { snapshot } = await this.rpc<MetricsSnapshotResult>("metrics/snapshot", { computeName });
    return snapshot;
  }

  // --- BEGIN agent-G: cluster + tenant compute config methods ---

  /**
   * List the effective cluster list for the current tenant. Returns each
   * cluster's name / kind / apiEndpoint / defaultNamespace (auth blocks are
   * never surfaced over the wire).
   */
  async clusterList(): Promise<
    Array<{
      name: string;
      kind: "k8s" | "k8s-kata";
      apiEndpoint: string;
      defaultNamespace?: string;
    }>
  > {
    const { clusters } = await this.rpc<{
      clusters: Array<{
        name: string;
        kind: "k8s" | "k8s-kata";
        apiEndpoint: string;
        defaultNamespace?: string;
      }>;
    }>("cluster/list");
    return clusters;
  }

  /** Fetch a tenant's compute-config YAML blob (admin only). */
  async tenantComputeConfigGet(tenantId: string): Promise<string | null> {
    const { yaml } = await this.rpc<{ yaml: string | null }>("admin/tenant/config/get-compute", {
      tenant_id: tenantId,
    });
    return yaml;
  }

  /**
   * Write a tenant's compute-config YAML blob (admin only). The server
   * validates the YAML shape before persisting.
   */
  async tenantComputeConfigSet(tenantId: string, yaml: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/config/set-compute", {
      tenant_id: tenantId,
      yaml,
    });
    return ok;
  }

  /** Clear a tenant's compute-config YAML blob (admin only). */
  async tenantComputeConfigClear(tenantId: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/config/clear-compute", {
      tenant_id: tenantId,
    });
    return ok;
  }

  // --- END agent-G ---
}
