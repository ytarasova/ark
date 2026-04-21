/**
 * TicketsClient -- trigger / connector / integration RPCs.
 *
 * These are the inbound-trigger + outbound-connector halves of the
 * unified integration framework. A ticket here just means an externally
 * sourced event that ends up firing a session.
 */

import type { RpcFn } from "./rpc.js";

export class TicketsClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Triggers (unified webhook / schedule / poll / event) ───────────────────

  async triggerList(tenant?: string): Promise<{ triggers: any[] }> {
    return this.rpc("trigger/list", { tenant });
  }

  async triggerGet(name: string, tenant?: string): Promise<{ trigger: any }> {
    return this.rpc("trigger/get", { name, tenant });
  }

  async triggerEnable(name: string, tenant?: string): Promise<void> {
    await this.rpc("trigger/enable", { name, tenant });
  }

  async triggerDisable(name: string, tenant?: string): Promise<void> {
    await this.rpc("trigger/disable", { name, tenant });
  }

  async triggerReload(): Promise<void> {
    await this.rpc("trigger/reload");
  }

  async triggerSources(): Promise<{
    sources: Array<{ name: string; label: string; status: string; secretEnvVar: string }>;
  }> {
    return this.rpc("trigger/sources");
  }

  async triggerTest(opts: {
    name: string;
    payload: unknown;
    headers?: Record<string, string>;
    tenant?: string;
    dryRun?: boolean;
  }): Promise<{ ok: boolean; fired: boolean; sessionId?: string; dryRun?: boolean; message?: string; event?: any }> {
    return this.rpc("trigger/test", opts);
  }

  // ── Connectors (outbound half of the integration framework) ────────────────

  async connectorsList(): Promise<{
    connectors: Array<{
      name: string;
      label: string;
      kind: "mcp" | "rest" | "context";
      status: "full" | "scaffolded" | "stub";
      auth: { kind: string; envVar?: string; secretsKey?: string } | null;
      mcp: { configName?: string; configPath?: string | null; hasInline: boolean } | null;
      rest: { baseUrl?: string; endpoints?: string[] } | null;
      hasContext: boolean;
    }>;
  }> {
    return this.rpc("connectors/list");
  }

  async connectorsGet(name: string): Promise<{ connector: any }> {
    return this.rpc("connectors/get", { name });
  }

  async connectorsTest(name: string): Promise<{ name: string; reachable: boolean; details: string }> {
    return this.rpc("connectors/test", { name });
  }

  // ── Integrations (unified trigger + connector catalog) ─────────────────────

  async integrationsList(): Promise<{
    integrations: Array<{
      name: string;
      label: string;
      status: "full" | "scaffolded" | "stub";
      has_trigger: boolean;
      has_connector: boolean;
      trigger_kind: string | null;
      connector_kind: string | null;
      auth: { envVar?: string; triggerSecretEnvVar?: string } | null;
    }>;
  }> {
    return this.rpc("integrations/list");
  }
}
