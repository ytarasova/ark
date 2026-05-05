/**
 * Resource CRUD handlers -- YAML-aware agent/skill/recipe mutation.
 *
 * This module is the daemon-side home for `ark agent {create,edit,delete,copy}`,
 * `ark skill {create,delete}`, and `ark recipe {create,delete}`. The CLI used
 * to run these against a local `AppContext` via `getInProcessApp()`; the
 * resource store actually lives in the daemon (`app.agents`, `app.skills`,
 * `app.recipes`), so the CLI now POSTs rendered YAML over JSON-RPC and these
 * handlers persist it. That lets the same CLI work identically against a
 * remote control plane.
 *
 * Shape contract:
 *   - `{create,edit,copy}` accept a `yaml` string containing the full
 *     definition. The handler parses it, validates the `name` matches, and
 *     writes via `app.<store>.save()`.
 *   - For back-compat with the older structured-field handlers in
 *     `resource.ts` (which the web UI still calls), every handler also
 *     accepts the legacy structured shape when `yaml` is absent.
 *   - Writes are tenant-member operations, not admin gates. `admin/*`
 *     handlers still guard tenant/team/user/secret mutations.
 */

import YAML from "yaml";
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { guardBuiltin, projectArg, resolveProjectRoot, resolveScope, type Scope } from "./scope-helpers.js";
import type { AgentDefinition, SkillDefinition } from "../../types/index.js";

const AGENT_DEFAULTS: Omit<AgentDefinition, "name"> = {
  description: "",
  model: "sonnet",
  max_turns: 200,
  system_prompt: "",
  tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  mcp_servers: [],
  skills: [],
  memories: [],
  context: [],
  permission_mode: "bypassPermissions",
  env: {},
};

function parseYaml(yaml: string, kind: string): Record<string, unknown> {
  if (typeof yaml !== "string" || yaml.trim().length === 0) {
    throw new RpcError(`${kind} yaml must be a non-empty string`, ErrorCodes.INVALID_PARAMS);
  }
  try {
    const doc = YAML.parse(yaml);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new RpcError(`${kind} yaml must parse to an object`, ErrorCodes.INVALID_PARAMS);
    }
    return doc as Record<string, unknown>;
  } catch (e: any) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(`Malformed ${kind} yaml: ${e?.message ?? e}`, ErrorCodes.INVALID_PARAMS);
  }
}

function requireName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RpcError("name must be a non-empty string", ErrorCodes.INVALID_PARAMS);
  }
  return name.trim();
}

function buildAgent(name: string, body: Partial<AgentDefinition>): AgentDefinition {
  return {
    name,
    description: body.description ?? AGENT_DEFAULTS.description,
    model: body.model ?? AGENT_DEFAULTS.model,
    max_turns: body.max_turns ?? AGENT_DEFAULTS.max_turns,
    system_prompt: body.system_prompt ?? AGENT_DEFAULTS.system_prompt,
    tools: body.tools ?? [...AGENT_DEFAULTS.tools],
    mcp_servers: body.mcp_servers ?? [],
    skills: body.skills ?? [],
    memories: body.memories ?? [],
    context: body.context ?? [],
    permission_mode: body.permission_mode ?? AGENT_DEFAULTS.permission_mode,
    env: body.env ?? {},
    ...(body.runtime ? { runtime: body.runtime } : {}),
    ...(body.command ? { command: body.command } : {}),
    ...(body.task_delivery ? { task_delivery: body.task_delivery } : {}),
    ...(body.recipe ? { recipe: body.recipe } : {}),
    ...(body.sub_recipes ? { sub_recipes: body.sub_recipes } : {}),
  };
}

function buildSkill(name: string, body: Partial<SkillDefinition>): SkillDefinition {
  return {
    name,
    description: body.description ?? "",
    prompt: body.prompt ?? "",
    tags: body.tags ?? [],
  };
}

/**
 * Register YAML-aware resource CRUD handlers. Intentionally registers the
 * same method names as `registerResourceHandlers`; callers mount this AFTER
 * the shared bundle so these handlers win for agent/skill/recipe CRUD. The
 * new handlers still accept the legacy structured-field shape so existing
 * web forms and tests keep working.
 */
export function registerResourceCrudHandlers(router: Router, app: AppContext): void {
  // ── Agents ────────────────────────────────────────────────────────────

  // `resource-crud.ts` intentionally overrides the YAML-naive handlers
  // registered earlier by `resource.ts`. `register.ts` orders the two so
  // this file runs second, and the { override: true } flag keeps the
  // Router's duplicate-registration assertion quiet. Agent/skill/recipe
  // create + delete variants replace existing entries; the other methods
  // (agent/edit, agent/copy, skill/create, recipe/create) are net-new
  // and don't need the flag but it's safe to always pass -- simplifies
  // reasoning at the register site.
  const handle: typeof router.handle = (method, h) => router.handle(method, h, { override: true });

  handle("agent/create", async (p) => {
    const params = extract<{ name: string; yaml?: string; scope?: Scope } & Partial<AgentDefinition>>(p, ["name"]);
    const name = requireName(params.name);
    const projectRoot = resolveProjectRoot();

    const existing = await app.agents.get(name, projectRoot);
    if (existing && existing._source !== "builtin") {
      throw new RpcError(`Agent '${name}' already exists. Use agent/edit to modify it.`, ErrorCodes.INVALID_PARAMS);
    }

    let body: Partial<AgentDefinition>;
    if (typeof params.yaml === "string") {
      const parsed = parseYaml(params.yaml, "agent");
      if (parsed.name && parsed.name !== name) {
        throw new RpcError(
          `yaml name '${parsed.name}' does not match request name '${name}'`,
          ErrorCodes.INVALID_PARAMS,
        );
      }
      body = parsed as Partial<AgentDefinition>;
    } else {
      // Legacy structured shape -- strip control fields + name before merging.
      const { yaml: _yaml, scope: _scope, name: _name, ...rest } = params;
      body = rest as Partial<AgentDefinition>;
    }

    const agent = buildAgent(name, body);
    const resolved = resolveScope(params.scope, null, projectRoot);
    await app.agents.save(agent.name, agent, resolved, projectArg(resolved, projectRoot));
    return { ok: true, name: agent.name, scope: resolved };
  });

  handle("agent/edit", async (p) => {
    const params = extract<{ name: string; yaml?: string; scope?: Scope } & Partial<AgentDefinition>>(p, ["name"]);
    const name = requireName(params.name);
    const projectRoot = resolveProjectRoot();

    const existing = await app.agents.get(name, projectRoot);
    if (!existing) throw new RpcError(`Agent '${name}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    guardBuiltin(existing, "Agent", name, "edit");

    let body: Partial<AgentDefinition>;
    if (typeof params.yaml === "string") {
      const parsed = parseYaml(params.yaml, "agent");
      if (parsed.name && parsed.name !== name) {
        throw new RpcError(
          `yaml name '${parsed.name}' does not match request name '${name}'`,
          ErrorCodes.INVALID_PARAMS,
        );
      }
      body = parsed as Partial<AgentDefinition>;
    } else {
      const { yaml: _yaml, scope: _scope, name: _name, ...rest } = params;
      body = rest as Partial<AgentDefinition>;
    }

    // Edit = overwrite. Preserve existing fields only if the incoming body
    // omits them -- matches the CLI's "dump YAML, reopen in $EDITOR" flow
    // where the user sees and edits every field.
    const merged: AgentDefinition =
      typeof params.yaml === "string" ? buildAgent(name, body) : { ...existing, ...body, name };
    const resolved = resolveScope(params.scope, existing, projectRoot);
    await app.agents.save(merged.name, merged, resolved, projectArg(resolved, projectRoot));
    return { ok: true, name: merged.name, scope: resolved };
  });

  handle("agent/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const resolvedName = requireName(name);
    const projectRoot = resolveProjectRoot();
    const existing = await app.agents.get(resolvedName, projectRoot);
    if (!existing) throw new RpcError(`Agent '${resolvedName}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    guardBuiltin(existing, "Agent", resolvedName, "delete");
    const resolved = resolveScope(scope, existing, projectRoot);
    const ok = await app.agents.delete(resolvedName, resolved, projectArg(resolved, projectRoot));
    return { ok };
  });

  handle("agent/copy", async (p) => {
    const { from, to, scope } = extract<{ from: string; to: string; scope?: Scope }>(p, ["from", "to"]);
    const fromName = requireName(from);
    const toName = requireName(to);
    if (fromName === toName) {
      throw new RpcError("agent/copy requires distinct source and destination names", ErrorCodes.INVALID_PARAMS);
    }
    const projectRoot = resolveProjectRoot();
    const src = await app.agents.get(fromName, projectRoot);
    if (!src) throw new RpcError(`Agent '${fromName}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    const dstExisting = await app.agents.get(toName, projectRoot);
    if (dstExisting && dstExisting._source !== "builtin") {
      throw new RpcError(`Agent '${toName}' already exists`, ErrorCodes.INVALID_PARAMS);
    }
    // Strip source/path metadata so the clone is a clean YAML file.
    const { _source, _path, ...clean } = src;
    const clone = { ...clean, name: toName } as AgentDefinition;
    const resolved = resolveScope(scope, null, projectRoot);
    await app.agents.save(clone.name, clone, resolved, projectArg(resolved, projectRoot));
    return { ok: true, name: clone.name, scope: resolved };
  });

  // ── Skills ────────────────────────────────────────────────────────────

  handle("skill/create", async (p) => {
    const params = extract<{ name: string; yaml?: string; scope?: Scope } & Partial<SkillDefinition>>(p, ["name"]);
    const name = requireName(params.name);
    const projectRoot = resolveProjectRoot();
    const existing = app.skills.get(name, projectRoot);
    if (existing && existing._source !== "builtin") {
      throw new RpcError(`Skill '${name}' already exists`, ErrorCodes.INVALID_PARAMS);
    }

    let body: Partial<SkillDefinition>;
    if (typeof params.yaml === "string") {
      const parsed = parseYaml(params.yaml, "skill");
      if (parsed.name && parsed.name !== name) {
        throw new RpcError(
          `yaml name '${parsed.name}' does not match request name '${name}'`,
          ErrorCodes.INVALID_PARAMS,
        );
      }
      body = parsed as Partial<SkillDefinition>;
    } else {
      const { yaml: _yaml, scope: _scope, name: _name, ...rest } = params;
      body = rest as Partial<SkillDefinition>;
    }

    const skill = buildSkill(name, body);
    const resolved = resolveScope(params.scope, null, projectRoot);
    app.skills.save(skill.name, skill, resolved, projectArg(resolved, projectRoot));
    return { ok: true, name: skill.name, scope: resolved };
  });

  handle("skill/delete", async (p) => {
    const { name, scope } = extract<{ name: string; scope?: Scope }>(p, ["name"]);
    const resolvedName = requireName(name);
    const projectRoot = resolveProjectRoot();
    const existing = app.skills.get(resolvedName, projectRoot);
    if (!existing) throw new RpcError(`Skill '${resolvedName}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    guardBuiltin(existing, "Skill", resolvedName, "delete");
    const resolved = resolveScope(scope, existing, projectRoot);
    const ok = app.skills.delete(resolvedName, resolved, projectArg(resolved, projectRoot));
    return { ok };
  });

}
