export interface RecipeVariable {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface RecipeParameter {
  key: string;
  type: "string" | "number" | "boolean" | "select" | "file";
  description?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

export interface SubRecipeRef {
  name: string;
  recipe: string;
  values?: Record<string, string>;
}

export interface RecipeDefinition {
  name: string;
  description: string;
  repo?: string;
  flow: string;
  agent?: string;
  compute?: string;
  group?: string;
  variables: RecipeVariable[];
  parameters?: RecipeParameter[];
  defaults?: Record<string, string>;
  sub_recipes?: SubRecipeRef[];
  _source?: "builtin" | "project" | "global";
}

export type GateType = "auto" | "manual" | "condition" | "review";

export interface FlowEdgeDefinition {
  from: string;
  to: string;
  condition?: string; // JS expression evaluated against session data
  label?: string;
}

export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork";
  agent?: string;
  action?: string;
  task?: string;
  gate: GateType;
  autonomy?: "full" | "execute" | "edit" | "read-only";
  on_failure?: string;
  /**
   * Outcome-based routing. Maps outcome labels reported by the agent
   * to target stage names. When an agent completes with an `outcome`
   * field, the flow advances to the mapped stage instead of the linear next.
   *
   * Example:
   *   on_outcome:
   *     approved: deploy
   *     rejected: revise
   *     needs_info: clarify
   *
   * If the outcome doesn't match any key, falls back to linear next stage.
   */
  on_outcome?: Record<string, string>;
  optional?: boolean;
  model?: string;
  /** Scripts that must pass before stage completion. */
  verify?: string[];
  /**
   * Per-stage compute target.
   *
   * Two flavours, mutually exclusive:
   * - `compute`: name of an existing compute target (ref). The stage
   *   dispatches onto that target as-is. Best for shared, long-lived
   *   targets (`local`, `ec2`).
   * - `compute_template`: name of a `ComputeTemplate`. The dispatcher
   *   provisions a fresh compute row from the template if one doesn't
   *   already exist with that name. For template-lifecycle kinds
   *   (k8s, docker, firecracker, ...) the row is auto-cleaned when no
   *   sessions reference it anymore.
   *
   * Either field overrides the session's default compute for the
   * duration of this stage. Switching between stages is a real
   * handoff: cleanupSession on the prior compute, launch on the new.
   */
  compute?: string;
  compute_template?: string;
  /**
   * Runtime isolation mode for this stage.
   * - "fresh" (default): each stage gets a fresh runtime -- no --resume from prior stage.
   *   Context is passed structurally via task prompt (PLAN.md, git log, events).
   * - "continue": preserve the previous stage's claude_session_id so the next
   *   dispatch resumes the same conversation. Useful for stages that refine
   *   the same agent's output (e.g. review -> fixup).
   */
  isolation?: "fresh" | "continue";
  /**
   * Rework-on-reject behaviour for `gate: "review"` / `"manual"` stages.
   *
   * When a reviewer rejects the gate via `gate/reject`, the rendered `prompt`
   * is appended to the next dispatch of the same stage so the agent knows
   * what to fix. Supports `{{rejection_reason}}` plus every variable the
   * normal task template supports (see `template.ts`).
   *
   * Example:
   *   on_reject:
   *     prompt: |
   *       The reviewer rejected this change. Feedback:
   *       {{rejection_reason}}
   *       Please address the feedback and rework the stage.
   *     max_rejections: 3
   */
  on_reject?: {
    /** Template appended to the next dispatch. Supports `{{rejection_reason}}`. */
    prompt?: string;
    /**
     * Cap rework cycles. Default: unlimited. When the session's
     * `rejection_count` hits this value, the session is marked `failed` with
     * reason "max_rejections exceeded" instead of being re-dispatched.
     */
    max_rejections?: number;
  };
  /**
   * Idle timeout (minutes) for `for_each + mode:spawn` child iterations.
   * The deadline resets every time the child's `updated_at` advances, so a
   * child that's actively tool-calling or streaming model output never times
   * out -- this is the cap on a *silent* child. Default 60 minutes.
   */
  child_timeout_minutes?: number;
  // Fork-specific
  strategy?: string;
  max_parallel?: number;
  subtasks?: { name: string; task: string }[];
  /**
   * Names of secrets to resolve (via `app.secrets`) and inject as env vars
   * into the session at dispatch time. Names must match the secrets-name
   * regex `[A-Z0-9_]+` because they land verbatim in the executor env.
   *
   * Resolution order if the same key is also set in the agent's static
   * `env` block or the runtime's `env` block: `secrets` > runtime env >
   * agent env > session env. Secrets always win so an operator that
   * rotates a value in the secrets backend takes effect on the next
   * dispatch without re-editing any YAML.
   *
   * A missing secret fails the dispatch immediately with a clear error
   * instead of silently dropping the env var.
   */
  secrets?: string[];
}

/** Declarative description of a file input slot a flow requires. */
export interface FlowFileInput {
  /** User-facing description of what this file is for. */
  description?: string;
  /** Whether dispatch is blocked without this input. Default false. */
  required?: boolean;
  /** Comma-separated list of suggested file extensions (".yaml,.yml"). UI hint. */
  accept?: string;
}

/** Declarative description of a param input a flow requires. */
export interface FlowParamInput {
  description?: string;
  required?: boolean;
  /** Default value if user does not supply one. */
  default?: string;
  /** Optional regex the submitted value must match. */
  pattern?: string;
}

/**
 * Declarative input for a single flow input (flat-bag shape). Drives
 * the dispatch-time form in the web UI and the CLI validator.
 *
 * The value stored in `inputs[<key>]` at dispatch time is either a bare
 * scalar / array / object or a tagged rich-content object with a `$type`
 * discriminator (see `rpc-schemas.ts` `sessionInputsSchema` for the full
 * set of tags -- `file`, `blob`, `image`, `text`).
 */
export interface FlowInputDef {
  /** Native type hint ("string" / "array" / "object" / "file" / ...). */
  type?: string;
  description?: string;
  required?: boolean;
  /** Default applied when the caller doesn't supply the key. */
  default?: unknown;
  /** Optional regex the submitted string value must match. */
  pattern?: string;
  /** UI hint -- accepted file extensions (only used when type = "file"). */
  accept?: string;
}

/**
 * Declarative inputs contract for a flow.
 *
 * Two shapes are accepted, for back-compat:
 *
 * 1. Flat bag (preferred): `{ <key>: FlowInputDef | <bare-default> }`.
 *    Each key is a top-level input. A bare value (string / array / object)
 *    is interpreted as a default with no further constraints.
 *
 * 2. Legacy nested: `{ files: Record<string, FlowFileInput>, params: ... }`.
 *    Still honored by the CLI validator and server-side ingest. Inputs land
 *    at `inputs.files.<role>` / `inputs.params.<key>` and the template
 *    engine's compat shim also resolves them via the flat-bag short form.
 *
 * Dispatch always accepts additional ad-hoc keys beyond what is declared
 * here. Only required-without-default entries block dispatch.
 */
export type FlowInputsSchema =
  | { files?: Record<string, FlowFileInput>; params?: Record<string, FlowParamInput> }
  | Record<string, FlowInputDef | unknown>;

export interface FlowDefinition {
  name: string;
  description?: string;
  stages: StageDefinition[];
  edges?: FlowEdgeDefinition[];
  inputs?: FlowInputsSchema;
  /**
   * Named connectors (by registry key) that every stage in this flow
   * inherits. Each connector can contribute an MCP server or prefill
   * context; resolution lives in `packages/core/connectors/`. Runtime
   * and session-level opt-ins still apply on top -- connectors here
   * merge additively with runtime mcp_servers + session --with-mcp.
   */
  connectors?: string[];
  source?: "builtin" | "user";
}
