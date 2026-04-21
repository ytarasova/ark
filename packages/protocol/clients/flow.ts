/**
 * FlowClient -- flow / execution RPCs.
 *
 * Flow CRUD is a tiny surface today; this mixin exists so that future
 * flow + execution additions have an obvious home and the other mixins
 * don't grow.
 */

import type { FlowDefinition, FlowListResult, FlowReadResult } from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class FlowClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  async flowList(): Promise<FlowDefinition[]> {
    const { flows } = await this.rpc<FlowListResult>("flow/list");
    return flows;
  }

  async flowRead(name: string): Promise<FlowDefinition> {
    const { flow } = await this.rpc<FlowReadResult>("flow/read", { name });
    return flow;
  }

  async flowCreate(opts: {
    name: string;
    description?: string;
    stages: FlowDefinition["stages"];
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string }> {
    return this.rpc("flow/create", opts as unknown as Record<string, unknown>);
  }

  async flowDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("flow/delete", { name, scope });
  }
}
