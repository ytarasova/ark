/**
 * Agent resolution for dispatch.
 *
 * Dispatch accepts either a string name (looked up via the agent store) or an
 * inline AgentSpec object (built in-place). After resolution we also apply the
 * stage-level model override and the model-catalog slug normalisation.
 *
 * All side-effects (logging) are routed through the caller-supplied `log`.
 */

import type { DispatchDeps } from "./types.js";
import type { AgentDefinition } from "../../agent/agent.js";
import type { Session } from "../../../types/index.js";
import type { StageDefinition } from "../../state/flow.js";
import { sessionAsVars } from "../task-builder.js";

export type AgentRef = StageDefinition["agent"];

export interface ResolvedAgent {
  agent: AgentDefinition;
  agentName: string;
}

/**
 * Resolve an agent reference. Inline specs are built via buildInlineAgent;
 * named refs go through the agent registry, with a fallback to the server's
 * cwd project root (web-UI-created agents save relative to server cwd, which
 * may differ from the session's workdir).
 */
export async function resolveDispatchAgent(
  deps: Pick<DispatchDeps, "getApp" | "resolveAgent">,
  session: Session,
  agentRef: AgentRef,
  projectRoot: string | undefined,
  log: (msg: string) => void,
): Promise<{ ok: true; resolved: ResolvedAgent } | { ok: false; message: string }> {
  if (typeof agentRef === "object" && agentRef !== null) {
    // Inline agent: build AgentDefinition in-place, apply runtime merge via
    // buildInlineAgent so runtime defaults (model, env, etc.) are respected
    // the same way as stored agents.
    const { buildInlineAgent } = await import("../../agent/agent.js");
    const agent = buildInlineAgent(deps.getApp(), agentRef, sessionAsVars(session));
    const agentName = agent?.name ?? "inline";
    if (!agent) return { ok: false, message: `Inline agent build failed (missing runtime or system_prompt?)` };
    return { ok: true, resolved: { agent, agentName } };
  }

  const agentName = agentRef!;
  log(`Resolving agent: ${agentName}`);
  let agent = deps.resolveAgent(agentName, sessionAsVars(session), { projectRoot }) as AgentDefinition | null;
  if (!agent) {
    const { findProjectRoot } = await import("../../agent/agent.js");
    const serverRoot = findProjectRoot(process.cwd()) ?? undefined;
    if (serverRoot && serverRoot !== projectRoot) {
      agent = deps.resolveAgent(agentName, sessionAsVars(session), {
        projectRoot: serverRoot,
      }) as AgentDefinition | null;
    }
  }
  if (!agent) return { ok: false, message: `Agent '${agentName}' not found` };
  return { ok: true, resolved: { agent, agentName } };
}

/**
 * Apply stage-level model override and resolve the catalog slug.
 *
 * - Stage.model overrides agent.model when set (legacy field).
 * - Model catalog then maps (agent.model, runtime.compat) to the concrete
 *   provider slug the runtime should send. Null means "catalog doesn't know
 *   this id"; we leave the model untouched so explicit out-of-band slugs still
 *   pass through.
 */
export function applyStageModelAndResolveSlug(
  deps: Pick<DispatchDeps, "models" | "runtimes">,
  agent: AgentDefinition,
  stageDef: StageDefinition | null,
  projectRoot: string | undefined,
  log: (msg: string) => void,
): void {
  // Stage-level model override (legacy stage.model field) still wins if set.
  if (stageDef?.model) {
    agent.model = stageDef.model;
  }

  // `compat` is a runtime concern, not an agent concern -- look it up off
  // the resolved runtime definition. If the agent's runtime points at a
  // name we can't resolve, treat compat as empty (the resolver falls back
  // to anthropic-direct).
  if (agent.model && deps.models) {
    const runtimeName = agent.runtime;
    const runtimeDef = runtimeName ? deps.runtimes.get(runtimeName) : null;
    const runtimeCompat = runtimeDef?.compat ?? [];
    const resolved = deps.models.resolveSlug(agent.model, runtimeCompat, projectRoot);
    if (resolved && resolved !== agent.model) {
      log(`Catalog: ${agent.model} -> ${resolved} (compat: [${runtimeCompat.join(",")}])`);
      agent.model = resolved;
    }
  }
}
