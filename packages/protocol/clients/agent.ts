/**
 * AgentClient -- agent / skill / runtime resource RPCs.
 *
 * Carries the agent-C block (YAML-driven create/edit/copy) -- see markers
 * below.
 */

import type {
  AgentDefinition,
  AgentListResult,
  AgentReadResult,
  SkillListResult,
  SkillReadResult,
  RuntimeListResult,
  RuntimeReadResult,
  SkillDefinition,
  RuntimeDefinition,
} from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class AgentClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  async agentList(): Promise<AgentDefinition[]> {
    const { agents } = await this.rpc<AgentListResult>("agent/list");
    return agents;
  }

  async agentRead(name: string): Promise<AgentDefinition> {
    const { agent } = await this.rpc<AgentReadResult>("agent/read", { name });
    return agent;
  }

  async agentSave(
    agent: Partial<AgentDefinition> & { name: string },
    opts?: { scope?: "global" | "project"; update?: boolean },
  ): Promise<{ ok: boolean; name: string; scope: string }> {
    const method = opts?.update ? "agent/update" : "agent/create";
    return this.rpc(method, { ...agent, scope: opts?.scope });
  }

  async agentDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("agent/delete", { name, scope });
  }

  async skillList(): Promise<SkillDefinition[]> {
    const { skills } = await this.rpc<SkillListResult>("skill/list");
    return skills;
  }

  async skillRead(name: string): Promise<SkillDefinition> {
    const { skill } = await this.rpc<SkillReadResult>("skill/read", { name });
    return skill;
  }

  async skillSave(
    skill: Partial<SkillDefinition> & { name: string },
    opts?: { scope?: "global" | "project" },
  ): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("skill/save", { ...skill, scope: opts?.scope });
  }

  async skillDelete(name: string, scope?: "global" | "project"): Promise<{ ok: boolean }> {
    return this.rpc("skill/delete", { name, scope });
  }

  async runtimeList(): Promise<RuntimeDefinition[]> {
    const { runtimes } = await this.rpc<RuntimeListResult>("runtime/list");
    return runtimes;
  }

  async runtimeRead(name: string): Promise<RuntimeDefinition> {
    const { runtime } = await this.rpc<RuntimeReadResult>("runtime/read", { name });
    return runtime;
  }

  // --- BEGIN agent-C: resource CRUD methods ---

  /**
   * Create a new agent from a full YAML string. The daemon parses the YAML,
   * validates it, and writes it to the resource store. Scope defaults to
   * `global` unless `project` is requested (and a project root resolves).
   */
  async agentCreate(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("agent/create", opts as unknown as Record<string, unknown>);
  }

  /**
   * Overwrite an existing agent's YAML. Returns a 404-equivalent error if
   * the agent doesn't exist; refuses to edit builtin agents (copy first).
   */
  async agentEdit(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("agent/edit", opts as unknown as Record<string, unknown>);
  }

  /**
   * Duplicate an agent under a new name. Source may be any scope (including
   * builtin); destination is written at the requested scope.
   */
  async agentCopy(opts: {
    from: string;
    to: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("agent/copy", opts as unknown as Record<string, unknown>);
  }

  // `agentDelete` already exists on this class (legacy shape) and hits the
  // same `agent/delete` RPC method our new handler responds to. Re-adding
  // it would collide as a duplicate class member, so we reuse it.

  /**
   * Create a new skill from a full YAML string. Same shape as `agentCreate`.
   */
  async skillCreate(opts: {
    name: string;
    yaml: string;
    scope?: "global" | "project";
  }): Promise<{ ok: boolean; name: string; scope: string }> {
    return this.rpc("skill/create", opts as unknown as Record<string, unknown>);
  }

  // `skillDelete` already exists on this class and hits the same `skill/delete`
  // RPC method our new handler responds to.

  // --- END agent-C ---
}
